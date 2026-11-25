use std::{collections::HashSet, path::PathBuf};

use rusqlite::{OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use url::Url;

use crate::{
    documents::{self, MAX_FILE, MAX_TEXT},
    model::{ParseStatus, Result, bounded, message, now},
    store::Store,
    value,
};

pub const INDEX_VERSION: i64 = 1;
const CHUNK_LENGTH: usize = 880;
const MAX_SELECTION: usize = 24;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Upload {
    pub name: String,
    pub category_id: Option<i64>,
    pub replace_id: Option<i64>,
    pub parse_status: Option<ParseStatus>,
    #[serde(default)]
    pub pdf_pages: Vec<PdfPage>,
}

#[derive(Deserialize)]
pub struct PdfPage {
    page: i64,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadResult {
    id: i64,
    duplicate: bool,
    cleanup_pending: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub id: i64,
    pub name: String,
    pub format: String,
    pub byte_size: i64,
    pub category_id: Option<i64>,
    pub uploaded_at: i64,
    pub updated_at: i64,
    pub parse_status: ParseStatus,
    pub ai_allowed: bool,
    pub index_version: i64,
    pub revision: i64,
    pub tags: Vec<String>,
    #[serde(flatten)]
    pub validity: Validity,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Validity {
    #[serde(default)]
    pub region: String,
    #[serde(default)]
    pub issuer: String,
    #[serde(default)]
    pub published_on: String,
    #[serde(default)]
    pub effective_on: String,
    #[serde(default)]
    pub expires_on: String,
    #[serde(default)]
    pub source_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentEdit {
    id: i64,
    name: String,
    category_id: Option<i64>,
    tags: Vec<String>,
    ai_allowed: bool,
    #[serde(flatten)]
    validity: Validity,
}

#[derive(Clone, Serialize)]
pub struct Chunk {
    pub ordinal: i64,
    pub page: Option<i64>,
    pub text: String,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Filter {
    query: String,
    category_id: Option<i64>,
    uncategorized: bool,
    tag: Option<String>,
    ai_only: bool,
    offset: i64,
    limit: Option<i64>,
}

#[derive(Serialize)]
struct Category {
    id: i64,
    name: String,
    count: i64,
}

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Command {
    Facets,
    Summary,
    List { filter: Filter },
    Detail { id: i64 },
    Save { edit: DocumentEdit },
    Delete { id: i64 },
    SaveCategory { id: Option<i64>, name: String },
    DeleteCategory { id: i64 },
}

const DOCUMENT_SELECT: &str =
    "SELECT d.id,d.name,d.format,d.byte_size,d.category_id,d.uploaded_at,d.updated_at,
            d.parse_status,d.ai_allowed,d.index_version,d.revision,d.region,d.issuer,
            d.published_on,d.effective_on,d.expires_on,d.source_url FROM knowledge_documents d";

fn document(row: &Row<'_>) -> rusqlite::Result<Document> {
    Ok(Document {
        id: row.get(0)?,
        name: row.get(1)?,
        format: row.get(2)?,
        byte_size: row.get(3)?,
        category_id: row.get(4)?,
        uploaded_at: row.get(5)?,
        updated_at: row.get(6)?,
        parse_status: ParseStatus::from_sql(row.get(7)?)?,
        ai_allowed: row.get(8)?,
        index_version: row.get(9)?,
        revision: row.get(10)?,
        tags: Vec::new(),
        validity: Validity {
            region: row.get(11)?,
            issuer: row.get(12)?,
            published_on: row.get(13)?,
            effective_on: row.get(14)?,
            expires_on: row.get(15)?,
            source_url: row.get(16)?,
        },
    })
}

fn chunk(row: &Row<'_>, offset: usize) -> rusqlite::Result<Chunk> {
    Ok(Chunk {
        ordinal: row.get(offset)?,
        page: row.get(offset + 1)?,
        text: row.get(offset + 2)?,
    })
}

fn tags(store: &Store, id: i64) -> Result<Vec<String>> {
    let mut statement = store.db.prepare(
        "SELECT t.name FROM knowledge_document_tags dt JOIN knowledge_tags t ON t.id=dt.tag_id
         WHERE dt.document_id=?1 ORDER BY t.name COLLATE NOCASE",
    )?;
    Ok(statement
        .query_map([id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?)
}

pub fn get(store: &Store, id: i64) -> Result<Document> {
    let mut item = store
        .db
        .query_row(&format!("{DOCUMENT_SELECT} WHERE d.id=?1"), [id], document)
        .optional()?
        .ok_or_else(|| message("资料库中找不到此文件。"))?;
    item.tags = tags(store, id)?;
    Ok(item)
}

fn list(store: &Store, filter: Filter) -> Result<Value> {
    let query = bounded(&filter.query, 180, "搜索词", false)?.to_ascii_lowercase();
    let tag = filter
        .tag
        .as_deref()
        .map(|t| bounded(t, 35, "标签", true))
        .transpose()?;
    let filter_sql = "
        WHERE (?2 IS NULL OR d.category_id=?2) AND (NOT ?3 OR d.category_id IS NULL)
          AND (NOT ?5 OR d.ai_allowed=1 AND d.parse_status IN ('complete','partial'))
          AND (?4 IS NULL OR EXISTS(SELECT 1 FROM knowledge_document_tags dt JOIN knowledge_tags t ON t.id=dt.tag_id
               WHERE dt.document_id=d.id AND t.name=?4 COLLATE NOCASE))
          AND (?1='' OR instr(lower(d.name),?1)>0 OR instr(lower(d.region),?1)>0 OR instr(lower(d.issuer),?1)>0
               OR EXISTS(SELECT 1 FROM knowledge_chunks k WHERE k.document_id=d.id AND instr(lower(k.text),?1)>0))";
    let total: i64 = store.db.query_row(
        &format!("SELECT count(*) FROM knowledge_documents d {filter_sql}"),
        params![
            query,
            filter.category_id,
            filter.uncategorized,
            tag,
            filter.ai_only
        ],
        |r| r.get(0),
    )?;
    let mut statement = store.db.prepare(&format!(
        "{DOCUMENT_SELECT} {filter_sql} ORDER BY d.uploaded_at DESC,d.id DESC LIMIT ?6 OFFSET ?7"
    ))?;
    let mut items = statement
        .query_map(
            params![
                query,
                filter.category_id,
                filter.uncategorized,
                tag,
                filter.ai_only,
                filter.limit.unwrap_or(60).clamp(1, 60),
                filter.offset.max(0)
            ],
            document,
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for item in &mut items {
        item.tags = tags(store, item.id)?;
    }
    value(serde_json::json!({ "items": items, "total":total }))
}

pub fn recent(store: &Store) -> Result<Vec<Document>> {
    let mut stmt = store.db.prepare(&format!(
        "{DOCUMENT_SELECT} ORDER BY d.uploaded_at DESC,d.id DESC LIMIT 5"
    ))?;
    Ok(stmt
        .query_map([], document)?
        .collect::<rusqlite::Result<_>>()?)
}

fn facets(store: &Store) -> Result<Value> {
    let mut categories = store.db.prepare(
        "SELECT c.id,c.name,count(d.id) FROM knowledge_categories c LEFT JOIN knowledge_documents d ON d.category_id=c.id
         GROUP BY c.id ORDER BY c.name COLLATE NOCASE,c.id",
    )?;
    let categories = categories
        .query_map([], |r| {
            Ok(Category {
                id: r.get(0)?,
                name: r.get(1)?,
                count: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut tags = store.db.prepare("SELECT t.name FROM knowledge_tags t WHERE EXISTS(SELECT 1 FROM knowledge_document_tags dt WHERE dt.tag_id=t.id) ORDER BY t.name COLLATE NOCASE")?;
    let tags = tags
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    value(serde_json::json!({ "categories": categories, "tags": tags }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecentFile {
    id: i64,
    name: String,
    format: String,
    uploaded_at: i64,
    viewed_at: Option<i64>,
    can_ask: bool,
}

fn recent_files(store: &Store, order: &str) -> Result<Vec<RecentFile>> {
    let mut stmt = store.db.prepare(&format!(
        "SELECT d.id,d.name,d.format,d.uploaded_at,v.viewed_at,
           d.ai_allowed=1 AND d.parse_status IN ('complete','partial')
         FROM knowledge_documents d LEFT JOIN knowledge_views v ON v.document_id=d.id {order} LIMIT 5",
    ))?;
    Ok(stmt
        .query_map([], |row| {
            Ok(RecentFile {
                id: row.get(0)?,
                name: row.get(1)?,
                format: row.get(2)?,
                uploaded_at: row.get(3)?,
                viewed_at: row.get(4)?,
                can_ask: row.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

fn summary(store: &Store) -> Result<Value> {
    let mut stmt = store.db.prepare(
        "SELECT c.id,c.name,count(d.id) FROM knowledge_categories c LEFT JOIN knowledge_documents d ON d.category_id=c.id
         GROUP BY c.id ORDER BY count(d.id) DESC,c.name COLLATE NOCASE,c.id LIMIT 8",
    )?;
    let categories = stmt
        .query_map([], |row| {
            Ok(Category {
                id: row.get(0)?,
                name: row.get(1)?,
                count: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    value(serde_json::json!({
        "categories": categories,
        "uploaded": recent_files(store, "ORDER BY d.uploaded_at DESC,d.id DESC")?,
        "viewed": recent_files(store, "WHERE v.viewed_at IS NOT NULL ORDER BY v.viewed_at DESC,d.id DESC")?,
    }))
}

pub fn record_view(store: &Store, id: i64) -> Result<()> {
    store.db.execute(
        "INSERT INTO knowledge_views(document_id,viewed_at) SELECT id,?2 FROM knowledge_documents WHERE id=?1
         ON CONFLICT(document_id) DO UPDATE SET viewed_at=excluded.viewed_at",
        params![id, now()],
    )?;
    Ok(())
}

fn validate_category(store: &Store, id: Option<i64>) -> Result<()> {
    if let Some(id) = id
        && !store.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM knowledge_categories WHERE id=?1)",
            [id],
            |r| r.get(0),
        )?
    {
        return Err(message("所选分类已移除。"));
    }
    Ok(())
}

pub fn source_url(raw: &str) -> Option<Url> {
    let url = Url::parse(raw.trim()).ok()?;
    (matches!(url.scheme(), "http" | "https")
        && url.host().is_some()
        && url.username().is_empty()
        && url.password().is_none())
    .then_some(url)
}

fn date_field(text: &str) -> Result<String> {
    let date = bounded(text, 10, "资料日期", false)?;
    if date.is_empty() {
        return Ok(date);
    }
    let mut parts = date.split('-').map(|part| part.parse::<u32>().ok());
    let valid = match (
        parts.next().flatten(),
        parts.next().flatten(),
        parts.next().flatten(),
        parts.next(),
    ) {
        (Some(year @ 1..=9999), Some(month @ 1..=12), Some(day), None) => {
            let leap =
                year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
            let length = [
                31,
                if leap { 29 } else { 28 },
                31,
                30,
                31,
                30,
                31,
                31,
                30,
                31,
                30,
                31,
            ][month as usize - 1];
            day > 0 && day <= length && date == format!("{year:04}-{month:02}-{day:02}")
        }
        _ => false,
    };
    if !valid {
        return Err(message("日期应为有效的 YYYY-MM-DD。"));
    }
    Ok(date)
}

fn save(store: &mut Store, edit: DocumentEdit) -> Result<()> {
    validate_category(store, edit.category_id)?;
    let name = bounded(&edit.name, 250, "文件名称", true)?;
    let validity = edit.validity;
    let region = bounded(&validity.region, 100, "适用地区", false)?;
    let issuer = bounded(&validity.issuer, 160, "发布机构", false)?;
    let published = date_field(&validity.published_on)?;
    let effective = date_field(&validity.effective_on)?;
    let expires = date_field(&validity.expires_on)?;
    if !effective.is_empty() && !expires.is_empty() && expires < effective {
        return Err(message("失效日期不能早于生效日期。"));
    }
    let link = bounded(&validity.source_url, 1500, "来源网址", false)?;
    if !link.is_empty() && source_url(&link).is_none() {
        return Err(message("来源网址须为有效的 HTTP 或 HTTPS 地址。"));
    }
    if edit.tags.len() > 16 {
        return Err(message("每份文件最多 16 个标签。"));
    }
    let tx = store.db.transaction()?;
    if tx.execute(
        "UPDATE knowledge_documents SET name=?2,category_id=?3,ai_allowed=?4,region=?5,issuer=?6,
            published_on=?7,effective_on=?8,expires_on=?9,source_url=?10,updated_at=?11,
            revision=revision+CASE WHEN ai_allowed<>?4 OR region<>?5 OR issuer<>?6 OR published_on<>?7 OR effective_on<>?8 OR expires_on<>?9 THEN 1 ELSE 0 END
         WHERE id=?1",
        params![edit.id, name, edit.category_id, edit.ai_allowed, region, issuer, published, effective, expires, link, now()],
    )? == 0 {
        return Err(message("资料库中找不到此文件。"));
    }
    tx.execute(
        "DELETE FROM knowledge_document_tags WHERE document_id=?1",
        [edit.id],
    )?;
    for input in edit.tags {
        let tag = bounded(&input, 35, "标签", false)?;
        if tag.is_empty() {
            continue;
        }
        tx.execute(
            "INSERT OR IGNORE INTO knowledge_tags(name) VALUES(?1)",
            [&tag],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO knowledge_document_tags(document_id,tag_id)
             SELECT ?1,id FROM knowledge_tags WHERE name=?2 COLLATE NOCASE",
            params![edit.id, tag],
        )?;
    }
    tx.execute("DELETE FROM knowledge_tags WHERE NOT EXISTS(SELECT 1 FROM knowledge_document_tags WHERE tag_id=knowledge_tags.id)", [])?;
    tx.commit()?;
    Ok(())
}

pub fn dispatch(store: &mut Store, command: Command) -> Result<Value> {
    match command {
        Command::Facets => facets(store),
        Command::Summary => summary(store),
        Command::List { filter } => list(store, filter),
        Command::Detail { id } => {
            let document = get(store, id)?;
            let mut stmt = store.db.prepare("SELECT ordinal,page,text FROM knowledge_chunks WHERE document_id=?1 ORDER BY ordinal")?;
            let chunks = stmt
                .query_map([id], |row| chunk(row, 0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            record_view(store, id)?;
            value(serde_json::json!({ "document":document, "chunks":chunks }))
        }
        Command::Save { edit } => {
            save(store, edit)?;
            Ok(Value::Null)
        }
        Command::Delete { id } => {
            let (hash, format) = file_identity(store, id)?;
            store
                .db
                .execute("DELETE FROM knowledge_documents WHERE id=?1", [id])?;
            value(store.remove_attachment_if_unused(&hash, &format)?)
        }
        Command::SaveCategory { id, name } => {
            let name = bounded(&name, 60, "分类名称", true)?;
            let duplicate: bool = store.db.query_row(
                "SELECT EXISTS(SELECT 1 FROM knowledge_categories WHERE name=?1 COLLATE NOCASE AND (?2 IS NULL OR id<>?2))",
                params![name, id], |r| r.get(0),
            )?;
            if duplicate {
                return Err(message("已存在同名分类。"));
            }
            if let Some(id) = id {
                if store.db.execute(
                    "UPDATE knowledge_categories SET name=?2 WHERE id=?1",
                    params![id, name],
                )? == 0
                {
                    return Err(message("所选分类已移除。"));
                }
                value(id)
            } else {
                store
                    .db
                    .execute("INSERT INTO knowledge_categories(name) VALUES(?1)", [name])?;
                value(store.db.last_insert_rowid())
            }
        }
        Command::DeleteCategory { id } => {
            store
                .db
                .execute("DELETE FROM knowledge_categories WHERE id=?1", [id])?;
            Ok(Value::Null)
        }
    }
}

fn file_identity(store: &Store, id: i64) -> Result<(String, String)> {
    store
        .db
        .query_row(
            "SELECT file_hash,format FROM knowledge_documents WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| message("资料库中找不到此文件。"))
}

pub fn original(store: &Store, id: i64) -> Result<PathBuf> {
    let (hash, format) = file_identity(store, id)?;
    store.attachment_path(&hash, &format, true)
}

fn text_file(bytes: &[u8]) -> Option<String> {
    if let Some(rest) = bytes
        .strip_prefix(&[0xff, 0xfe])
        .or_else(|| bytes.strip_prefix(&[0xfe, 0xff]))
    {
        if !rest.len().is_multiple_of(2) {
            return None;
        }
        let little_endian = bytes[0] == 0xff;
        let units = rest
            .chunks_exact(2)
            .map(|pair| {
                let bytes = [pair[0], pair[1]];
                if little_endian {
                    u16::from_le_bytes(bytes)
                } else {
                    u16::from_be_bytes(bytes)
                }
            })
            .collect::<Vec<_>>();
        return String::from_utf16(&units).ok();
    }
    std::str::from_utf8(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes))
        .ok()
        .filter(|s| !s.contains('\0'))
        .map(str::to_owned)
}

fn index_parts(meta: Upload, format: &str, bytes: &[u8]) -> Result<(Vec<Chunk>, ParseStatus)> {
    let mut parts = Vec::new();
    let mut status = ParseStatus::Complete;
    if format == "pdf" {
        if meta.pdf_pages.len() > 100 {
            return Err(message("PDF 索引页数超过限制。"));
        }
        status = meta.parse_status.unwrap_or(ParseStatus::Failed);
        let mut previous = 0;
        for page in meta.pdf_pages {
            if page.page <= previous || page.page > 100 {
                return Err(message("PDF 片段的页序无效。"));
            }
            previous = page.page;
            parts.push((Some(page.page), page.text));
        }
    } else if format == "docx" {
        let (text, outcome) = documents::file_text(
            crate::model::FileFormat::Docx,
            bytes,
            String::new(),
            ParseStatus::Empty,
            true,
        )?;
        parts.push((None, text));
        status = outcome;
    } else if let Some(text) = text_file(bytes) {
        parts.push((None, text));
    } else {
        status = ParseStatus::Failed;
    }

    let mut chunks = Vec::new();
    let mut remaining = MAX_TEXT;
    for (page, text) in parts {
        let cleaned = text.replace(['\0', '\u{feff}'], "");
        let text = cleaned.trim();
        let chars = text.chars().take(remaining + 1).collect::<Vec<_>>();
        if chars.len() > remaining {
            status = ParseStatus::Partial;
        }
        let limit = chars.len().min(remaining);
        remaining -= limit;
        let mut cursor = 0;
        while cursor < limit {
            let mut end = (cursor + CHUNK_LENGTH).min(limit);
            if end < limit
                && let Some(break_at) = chars[end - 150..end]
                    .iter()
                    .rposition(|c| matches!(c, '\n' | '。' | '；' | '.' | '!' | '?'))
            {
                end = end - 150 + break_at + 1;
            }
            let text = chars[cursor..end].iter().collect::<String>();
            if !text.trim().is_empty() {
                chunks.push(Chunk {
                    ordinal: chunks.len() as i64 + 1,
                    page,
                    text: text.trim().to_owned(),
                });
            }
            cursor = end;
        }
    }
    let status = match (chunks.is_empty(), status) {
        (true, ParseStatus::Failed) => ParseStatus::Failed,
        (true, _) => ParseStatus::Empty,
        (false, ParseStatus::Complete) => ParseStatus::Complete,
        (false, _) => ParseStatus::Partial,
    };
    Ok((chunks, status))
}

pub fn upload(store: &mut Store, meta: Upload, bytes: &[u8]) -> Result<UploadResult> {
    if bytes.is_empty() || bytes.len() > MAX_FILE {
        return Err(message("请导入不超过 25 MB 的非空文件。"));
    }
    let name = bounded(&meta.name, 250, "文件名", true)?;
    if name.contains(['/', '\\', ':']) || name.chars().any(char::is_control) {
        return Err(message("文件名包含无效字符。"));
    }
    let format = name
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default();
    match format.as_str() {
        "pdf" | "docx" => {
            documents::identify_file(&name, bytes)?;
        }
        "txt" | "md" | "csv" => {}
        _ => return Err(message("资料库支持 PDF、DOCX、TXT、Markdown 和 CSV。")),
    }
    validate_category(store, meta.category_id)?;
    let previous = meta
        .replace_id
        .map(|id| file_identity(store, id))
        .transpose()?;
    let hash = hex::encode(Sha256::digest(bytes));
    let duplicate: Option<i64> = store.db.query_row(
        "SELECT id FROM knowledge_documents WHERE file_hash=?1 AND format=?2 AND (?3 IS NULL OR id<>?3)",
        params![hash, format, meta.replace_id], |r| r.get(0),
    ).optional()?;
    if let Some(id) = duplicate {
        return Ok(UploadResult {
            id,
            duplicate: true,
            cleanup_pending: false,
        });
    }
    let replace = meta.replace_id;
    let category = meta.category_id;
    let (chunks, status) = index_parts(meta, &format, bytes)?;
    let fresh = store.persist_attachment(&hash, &format, bytes)?;
    let saved = (|| -> Result<i64> {
        let tx = store.db.transaction()?;
        let uploaded = now();
        let id = if let Some(id) = replace {
            tx.execute(
                "DELETE FROM chat_conversations WHERE id IN
                 (SELECT m.conversation_id FROM chat_messages m JOIN chat_reference_sources s ON s.message_id=m.id WHERE s.document_id=?1)",
                [id],
            )?;
            tx.execute("DELETE FROM knowledge_chunks WHERE document_id=?1", [id])?;
            tx.execute(
                "UPDATE knowledge_documents SET file_hash=?2,format=?3,byte_size=?4,parse_status=?5,index_version=?6,
                   updated_at=?7,revision=revision+1,ai_allowed=0 WHERE id=?1",
                params![id, hash, format, bytes.len(), status.as_str(), INDEX_VERSION, uploaded],
            )?;
            id
        } else {
            tx.execute(
                "INSERT INTO knowledge_documents(file_hash,format,byte_size,name,category_id,uploaded_at,updated_at,parse_status,index_version)
                 VALUES(?1,?2,?3,?4,?5,?6,?6,?7,?8)",
                params![hash, format, bytes.len(), name, category, uploaded, status.as_str(), INDEX_VERSION],
            )?;
            tx.last_insert_rowid()
        };
        {
            let mut insert = tx.prepare(
                "INSERT INTO knowledge_chunks(document_id,ordinal,page,text) VALUES(?1,?2,?3,?4)",
            )?;
            for chunk in chunks {
                insert.execute(params![id, chunk.ordinal, chunk.page, chunk.text])?;
            }
        }
        tx.commit()?;
        Ok(id)
    })();
    if fresh && saved.is_err() {
        let _ = store.remove_attachment_if_unused(&hash, &format);
    }
    let id = saved?;
    let mut cleanup_pending = false;
    if let Some((hash, format)) = previous {
        cleanup_pending = !store
            .remove_attachment_if_unused(&hash, &format)
            .unwrap_or(false);
    }
    Ok(UploadResult {
        id,
        duplicate: false,
        cleanup_pending,
    })
}

pub struct Match {
    pub document: Document,
    pub chunk: Chunk,
}

pub type Scope = Vec<(i64, i64)>;

pub fn scope(store: &Store, selection: &[i64]) -> Result<Scope> {
    if selection.len() > MAX_SELECTION
        || selection.iter().copied().collect::<HashSet<_>>().len() != selection.len()
    {
        return Err(message("一次最多可指定 24 个不重复的资料文件。"));
    }
    let json = serde_json::to_string(selection)?;
    let mut stmt = store.db.prepare(
        "SELECT d.id,d.revision FROM knowledge_documents d WHERE d.ai_allowed=1
         AND d.parse_status IN ('complete','partial')
         AND (?1='[]' OR d.id IN (SELECT value FROM json_each(?1))) ORDER BY d.id",
    )?;
    let scope: Scope = stmt
        .query_map([json], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    if !selection.is_empty() && scope.len() != selection.len() {
        return Err(message("所选资料已移除、尚无正文索引或未允许 AI 引用。"));
    }
    Ok(scope)
}

pub fn verify_scope(store: &Store, selected: &Scope) -> Result<()> {
    let mut stmt = store
        .db
        .prepare("SELECT revision,ai_allowed FROM knowledge_documents WHERE id=?1")?;
    for (id, revision) in selected {
        if stmt
            .query_row([id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?
            != Some((*revision, true))
        {
            return Err(message("所选资料或引用权限已变更，请重新准备发送。"));
        }
    }
    Ok(())
}

fn terms(question: &str) -> Vec<(String, i64)> {
    let mut words = Vec::new();
    let mut seen = HashSet::new();
    let mut add = |term: String, weight: i64| {
        if words.len() < 52 && seen.insert(term.clone()) {
            words.push((term, weight));
        }
    };
    let mut simplified = question.to_lowercase();
    for phrase in [
        "请根据",
        "根据",
        "资料库",
        "本地文件",
        "文件中",
        "上传的",
        "告诉我",
        "请问",
        "说明",
        "总结",
        "内容",
        "什么",
        "哪些",
        "如何",
        "规定",
        "要求",
        "最新的",
        "目前的",
        "是否",
        "情况",
    ] {
        simplified = simplified.replace(phrase, " ");
    }
    for word in simplified.split(|c: char| !c.is_alphanumeric() && c != '_') {
        let chars = word.chars().collect::<Vec<_>>();
        if chars.len() < 2
            || [
                "the",
                "what",
                "with",
                "about",
                "from",
                "documents",
                "according",
                "and",
                "how",
                "for",
                "does",
                "tell",
            ]
            .contains(&word)
        {
            continue;
        }
        if !word.is_ascii() && chars.len() > 3 {
            for window in chars.windows(3) {
                add(window.iter().collect(), 4);
            }
            for window in chars.windows(2) {
                add(window.iter().collect(), 2);
            }
        } else if chars.len() <= 60 {
            add(
                word.to_owned(),
                if word.is_ascii() {
                    5
                } else {
                    chars.len() as i64 + 1
                },
            );
        }
    }
    words
}

pub fn retrieve(store: &Store, selected: &Scope, question: &str) -> Result<Vec<Match>> {
    if selected.is_empty() {
        return Ok(Vec::new());
    }
    let phrase = question.trim().trim_end_matches(['?', '？', '。', '！']);
    if let [(id, _)] = selected.as_slice()
        && matches!(
            phrase,
            "请总结这份资料" | "总结这份资料" | "概括这份文件" | "这份资料讲了什么"
        )
    {
        let document = get(store, *id)?;
        let mut stmt = store.db.prepare(
            "SELECT ordinal,page,text FROM knowledge_chunks WHERE document_id=?1 ORDER BY ordinal LIMIT 4",
        )?;
        return Ok(stmt
            .query_map([id], |r| chunk(r, 0))?
            .map(|row| {
                Ok(Match {
                    document: document.clone(),
                    chunk: row?,
                })
            })
            .collect::<rusqlite::Result<Vec<_>>>()?);
    }
    let terms = terms(question);
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let ids = selected.iter().map(|(id, _)| *id).collect::<Vec<_>>();
    let terms = serde_json::to_string(&terms)?;
    let ids = serde_json::to_string(&ids)?;
    let mut stmt = store.db.prepare(
        "WITH terms AS (SELECT json_extract(value,'$[0]') AS term,json_extract(value,'$[1]') AS weight FROM json_each(?1)),
         ranked AS (
           SELECT k.document_id,k.ordinal,k.page,k.text,
             sum(CASE WHEN instr(lower(k.text),t.term)>0 THEN t.weight ELSE 0 END) AS body_score,
             sum(CASE WHEN instr(lower(d.name),t.term)>0 THEN t.weight ELSE 0 END) AS title_score
           FROM knowledge_chunks k JOIN knowledge_documents d ON d.id=k.document_id CROSS JOIN terms t
           WHERE d.ai_allowed=1 AND k.document_id IN (SELECT value FROM json_each(?2))
           GROUP BY k.document_id,k.ordinal HAVING body_score>=3
         )
         SELECT document_id,ordinal,page,text FROM (
           SELECT *,row_number() OVER (PARTITION BY document_id ORDER BY body_score+title_score DESC,ordinal) AS per_file
           FROM ranked
         ) WHERE per_file<=2 ORDER BY per_file,body_score+title_score DESC,document_id,ordinal LIMIT 6",
    )?;
    let rows = stmt.query_map(params![terms, ids], |r| {
        Ok((r.get::<_, i64>(0)?, chunk(r, 1)?))
    })?;
    let mut matches = Vec::new();
    for row in rows {
        let (id, chunk) = row?;
        matches.push(Match {
            document: get(store, id)?,
            chunk,
        });
    }
    Ok(matches)
}
