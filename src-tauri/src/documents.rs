use std::{
    collections::HashSet,
    io::{Cursor, Read, Write},
    sync::LazyLock,
};

use quick_xml::{Reader, events::Event};
use regex::Regex;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    model::*,
    store::{Store, touch_candidate},
};

pub const MAX_FILE: usize = 25 * 1024 * 1024;
pub const MAX_TEXT: usize = 180_000;
const MAX_METADATA: usize = 2 * 1024 * 1024;
const MAX_XML: u64 = 10 * 1024 * 1024;
const MAX_CANDIDATES_PER_FILE: usize = 100;

#[derive(Deserialize, Clone, Copy)]
#[serde(tag = "kind", content = "id", rename_all = "lowercase")]
pub enum ImportTarget {
    New,
    Candidate(i64),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportMeta {
    pub name: String,
    pub target: ImportTarget,
    #[serde(default)]
    pub text: String,
    pub status: ParseStatus,
    #[serde(default)]
    pub candidate_options: Option<CandidateOptions>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CandidateOptions {
    job_id: Option<i64>,
    auto_parse: bool,
    candidates: Option<Vec<CandidateEdit>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CandidateEdit {
    section: Option<usize>,
    name: String,
    #[serde(default)]
    headline: String,
    #[serde(default)]
    email: String,
    #[serde(default)]
    phone: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    candidates: Vec<PreviewCandidate>,
    parse_status: ParseStatus,
}

#[derive(Debug, Serialize)]
struct PreviewCandidate {
    section: usize,
    #[serde(flatten)]
    fields: Fields,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOwner {
    document_id: i64,
    owner_id: i64,
    owner_name: String,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "state",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum ImportResult {
    Imported {
        document_id: i64,
        owner_id: i64,
        owner_name: String,
        parse_status: ParseStatus,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        candidates: Vec<ImportOwner>,
    },
    Duplicate {
        document_id: i64,
        owner_id: i64,
        owner_name: String,
    },
}

pub fn unpack(packet: &[u8]) -> Result<(ImportMeta, &[u8])> {
    unpack_attachment(packet)
}

pub fn unpack_attachment<T: serde::de::DeserializeOwned>(packet: &[u8]) -> Result<(T, &[u8])> {
    let size = packet
        .get(..4)
        .ok_or_else(|| message("文件导入数据不完整。"))?;
    let length = u32::from_le_bytes(size.try_into().unwrap()) as usize;
    if length > MAX_METADATA || packet.len() <= length + 4 || packet.len() - length - 4 > MAX_FILE {
        return Err(message("文件导入数据超出限制。单份文件最多 25 MB。"));
    }
    let meta = serde_json::from_slice(&packet[4..4 + length])?;
    Ok((meta, &packet[4 + length..]))
}

impl Store {
    pub fn import(&mut self, meta: ImportMeta, bytes: &[u8]) -> Result<ImportResult> {
        let (name, format) = identify_file(&meta.name, bytes)?;
        let new = matches!(meta.target, ImportTarget::New);
        if !new && meta.candidate_options.is_some() {
            return Err(message("只有新建候选人导入可以设置候选人选项。"));
        }
        let hash = hex::encode(Sha256::digest(bytes));
        let duplicate = self.db.query_row(
            "SELECT r.id,c.id,c.name FROM resumes r JOIN candidates c ON c.id=r.candidate_id WHERE file_hash=?1 ORDER BY r.section LIMIT 1",
            [&hash], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).optional()?;
        if let Some((document_id, owner_id, owner_name)) = duplicate {
            return Ok(ImportResult::Duplicate {
                document_id,
                owner_id,
                owner_name,
            });
        }

        let parse = meta
            .candidate_options
            .as_ref()
            .is_none_or(|options| options.auto_parse);
        let (text, status) = file_text(format, bytes, meta.text, meta.status, parse)?;
        let mut job_id = None;
        let mut scopes = Vec::new();
        if new {
            let options = meta.candidate_options.unwrap_or(CandidateOptions {
                job_id: None,
                auto_parse: true,
                candidates: None,
            });
            if let Some(id) = options.job_id {
                self.job(id)?;
                job_id = Some(id);
            }
            scopes = candidate_imports(&name, &text, options)?;
        }
        let candidate = match meta.target {
            ImportTarget::Candidate(id) => Some(self.candidate(id)?.candidate.name),
            ImportTarget::New => None,
        };
        let fresh = self.persist_attachment(&hash, format.as_str(), bytes)?;
        let saved = self.record_import(ImportPlan {
            target: meta.target,
            owner: candidate,
            name: &name,
            hash: &hash,
            format,
            length: bytes.len(),
            text,
            status,
            job_id,
            scopes,
        });
        if fresh && saved.is_err() {
            let _ = self.remove_attachment_if_unused(&hash, format.as_str());
        }
        saved
    }

    pub fn persist_attachment(&self, hash: &str, format: &str, bytes: &[u8]) -> Result<bool> {
        let path = self.attachment_path(hash, format, false)?;
        if path.exists() {
            return Ok(false);
        }
        let mut temp = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
        temp.write_all(bytes)?;
        temp.as_file().sync_all()?;
        temp.persist_noclobber(&path).map_err(|e| e.error)?;
        Ok(true)
    }

    fn record_import(&mut self, plan: ImportPlan<'_>) -> Result<ImportResult> {
        let ImportPlan {
            target,
            owner,
            name,
            hash,
            format,
            length,
            text,
            status,
            job_id,
            scopes,
        } = plan;
        let tx = self.db.transaction()?;
        tx.execute(
            "INSERT OR IGNORE INTO files(hash,format,byte_size) VALUES(?1,?2,?3)",
            params![hash, format.as_str(), length],
        )?;
        let stamp = now();
        let mut candidates = Vec::new();
        let first = match target {
            ImportTarget::New => {
                for scope in scopes {
                    let fields = scope.fields;
                    tx.execute(
                        "INSERT INTO candidates(name,headline,email,phone,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?5)",
                        params![fields.name, fields.headline, fields.email, fields.phone, stamp],
                    )?;
                    let owner_id = tx.last_insert_rowid();
                    tx.execute(
                        "INSERT INTO resumes(candidate_id,file_hash,original_name,imported_at,extracted_text,parse_status,section) VALUES(?1,?2,?3,?4,?5,?6,?7)",
                        params![owner_id, hash, name, stamp, scope.text, status.as_str(), scope.section],
                    )?;
                    let document_id = tx.last_insert_rowid();
                    if let Some(job_id) = job_id {
                        tx.execute(
                            "INSERT INTO applications(candidate_id,job_id,stage,created_at,updated_at) VALUES(?1,?2,'new',?3,?3)",
                            params![owner_id, job_id, stamp],
                        )?;
                    }
                    candidates.push(ImportOwner {
                        document_id,
                        owner_id,
                        owner_name: fields.name,
                    });
                }
                let first = candidates
                    .first()
                    .ok_or_else(|| message("请选择至少一位候选人。"))?;
                (first.document_id, first.owner_id, first.owner_name.clone())
            }
            ImportTarget::Candidate(id) => {
                touch_candidate(&tx, id)?;
                tx.execute(
                    "INSERT INTO resumes(candidate_id,file_hash,original_name,imported_at,extracted_text,parse_status) VALUES(?1,?2,?3,?4,?5,?6)",
                    params![id, hash, name, stamp, text.replace('\u{c}', "\n"), status.as_str()],
                )?;
                (tx.last_insert_rowid(), id, owner.unwrap_or_default())
            }
        };
        tx.commit()?;
        Ok(ImportResult::Imported {
            document_id: first.0,
            owner_id: first.1,
            owner_name: first.2,
            parse_status: status,
            candidates,
        })
    }
}

struct ImportPlan<'a> {
    target: ImportTarget,
    owner: Option<String>,
    name: &'a str,
    hash: &'a str,
    format: FileFormat,
    length: usize,
    text: String,
    status: ParseStatus,
    job_id: Option<i64>,
    scopes: Vec<CandidateScope>,
}

pub fn preview_import(meta: ImportMeta, bytes: &[u8]) -> Result<ImportPreview> {
    if !matches!(meta.target, ImportTarget::New) {
        return Err(message("只有新建候选人导入支持预览候选人。"));
    }
    let (name, format) = identify_file(&meta.name, bytes)?;
    let (text, parse_status) = file_text(format, bytes, meta.text, meta.status, true)?;
    let candidates = identify_sections(&text, &name)?
        .into_iter()
        .enumerate()
        .map(|(section, scope)| PreviewCandidate {
            section,
            fields: scope.fields,
        })
        .collect();
    Ok(ImportPreview {
        candidates,
        parse_status,
    })
}

pub(crate) fn identify_file(raw: &str, bytes: &[u8]) -> Result<(String, FileFormat)> {
    if bytes.is_empty() || bytes.len() > MAX_FILE {
        return Err(message("请导入不超过 25 MB 的非空文件。"));
    }
    let name = bounded(raw, 250, "文件名", true)?;
    if name.contains(['/', '\\', ':']) || name.chars().any(char::is_control) {
        return Err(message("文件名包含无效字符。"));
    }
    let extension = name
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase());
    let format = match extension.as_deref() {
        Some("pdf")
            if bytes[..bytes.len().min(1024)]
                .windows(5)
                .any(|b| b == b"%PDF-") =>
        {
            FileFormat::Pdf
        }
        Some("docx") if bytes.starts_with(b"PK\x03\x04") => FileFormat::Docx,
        Some("pdf" | "docx") => return Err(message("文件内容和扩展名不匹配。")),
        _ => return Err(message("只支持 PDF 和 DOCX 文件。")),
    };
    Ok((name, format))
}

pub(crate) fn file_text(
    format: FileFormat,
    bytes: &[u8],
    pdf_text: String,
    pdf_status: ParseStatus,
    parse: bool,
) -> Result<(String, ParseStatus)> {
    let (raw, status) = match format {
        FileFormat::Pdf if !parse => (String::new(), ParseStatus::Empty),
        FileFormat::Pdf => (pdf_text, pdf_status),
        FileFormat::Docx => docx_text(bytes, parse)?,
    };
    let normalized = raw.replace('\0', "");
    let truncated = normalized.chars().count() > MAX_TEXT;
    let text: String = normalized.trim().chars().take(MAX_TEXT).collect();
    let status = if truncated {
        ParseStatus::Partial
    } else if text.is_empty() && status != ParseStatus::Failed {
        ParseStatus::Empty
    } else if !text.is_empty() && status != ParseStatus::Complete {
        ParseStatus::Partial
    } else {
        status
    };
    Ok((text, status))
}

fn docx_text(bytes: &[u8], parse: bool) -> Result<(String, ParseStatus)> {
    let malformed = || message("无法识别此 DOCX 文件，文件可能损坏或不是标准 Word 文档。");
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| malformed())?;
    if archive.len() > 4096 {
        return Err(message("DOCX 压缩包包含过多内容。"));
    }
    if archive
        .file_names()
        .any(|name| name.to_ascii_lowercase().contains("vbaproject"))
    {
        return Err(message("不支持包含宏的 Word 文档。"));
    }
    let mut types = String::new();
    archive
        .by_name("[Content_Types].xml")
        .map_err(|_| malformed())?
        .take(256 * 1024)
        .read_to_string(&mut types)
        .map_err(|_| malformed())?;
    if !types.contains(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    ) || types.to_ascii_lowercase().contains("macroenabled")
    {
        return Err(malformed());
    }
    let file = archive
        .by_name("word/document.xml")
        .map_err(|_| malformed())?;
    if !parse {
        return Ok((String::new(), ParseStatus::Empty));
    }
    if file.size() > MAX_XML {
        return Ok((String::new(), ParseStatus::Failed));
    }
    let mut xml = Vec::new();
    if file.take(MAX_XML + 1).read_to_end(&mut xml).is_err() || xml.len() as u64 > MAX_XML {
        return Ok((String::new(), ParseStatus::Failed));
    }
    Ok(match read_word_xml(&xml) {
        Ok(text) => (text, ParseStatus::Complete),
        Err(()) => (String::new(), ParseStatus::Failed),
    })
}

fn read_word_xml(xml: &[u8]) -> std::result::Result<String, ()> {
    let mut reader = Reader::from_reader(xml);
    let mut text = String::new();
    let mut in_text = false;
    loop {
        match reader.read_event().map_err(|_| ())? {
            Event::Start(e) if e.local_name().as_ref() == b"t" => in_text = true,
            Event::End(e) if e.local_name().as_ref() == b"t" => in_text = false,
            Event::End(e) if e.local_name().as_ref() == b"p" => text.push('\n'),
            Event::Empty(e) if e.local_name().as_ref() == b"tab" => text.push('\t'),
            Event::Empty(e) if matches!(e.local_name().as_ref(), b"br" | b"cr") => {
                let page = e.attributes().flatten().any(|attribute| {
                    attribute.key.local_name().as_ref() == b"type"
                        && attribute.value.as_ref() == b"page"
                });
                text.push_str(if page { "\n\u{c}\n" } else { "\n" });
            }
            Event::Empty(e) if e.local_name().as_ref() == b"lastRenderedPageBreak" => {
                text.push_str("\n\u{c}\n")
            }
            Event::Text(e) if in_text => text.push_str(&e.xml_content().map_err(|_| ())?),
            Event::CData(e) if in_text => text.push_str(&e.decode().map_err(|_| ())?),
            Event::GeneralRef(e) if in_text => {
                if let Some(ch) = e.resolve_char_ref().map_err(|_| ())? {
                    text.push(ch);
                } else {
                    let entity = e.decode().map_err(|_| ())?;
                    text.push_str(quick_xml::escape::resolve_predefined_entity(&entity).ok_or(())?);
                }
            }
            Event::DocType(_) => return Err(()),
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(text)
}

static EMAIL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)[a-z0-9.!#$%&'*+/=?^_{}|~-]+@[a-z0-9.-]+\.[a-z]{2,24}").unwrap()
});
static MOBILE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u:\b)(?:\+?86[ -]?)?1[3-9]\d[ -]?\d{4}[ -]?\d{4}(?-u:\b)").unwrap()
});
static PHONE_LABEL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?im)^\s*(?:手机|电话|联系方式|phone|mobile|tel)\s*[:：]\s*(\+?[\d][\d() .-]{6,23}[\d])",
    )
    .unwrap()
});
static NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?im)^[ \t]*(?:候选人姓名|姓[ \t]*名|(?:full[ \t]+|candidate[ \t]+)?name|(?:候选人|candidate)[ \t]*(?:[0-9]+|[一二三四五六七八九十]+|[a-z]))[ \t]*[:：][ \t]*([^\r\n\x0C|,，;；]{2,85})").unwrap()
});
static NAME_TAIL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)[ \t]+(?:邮箱|电子邮件|手机(?:号码)?|电话|联系方式|岗位|职位|email|e-mail|phone|mobile|tel|role)[ \t]*[:：]").unwrap()
});
static HEADLINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?im)^[ \t]*(?:求职意向|当前职位|现任职位|current (?:role|title))[ \t]*[:：][ \t]*([^\r\n]{2,120})").unwrap()
});
static SHORT_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\p{Han}·]{2,4}$").unwrap());
static LATIN_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\p{Latin}[\p{Latin}'’.-]{0,27}(?:[ \t]+\p{Latin}[\p{Latin}'’.-]{0,27}){1,4}$")
        .unwrap()
});

#[derive(Debug, Clone, Serialize)]
struct Fields {
    name: String,
    headline: String,
    email: String,
    phone: String,
}

struct CandidateScope {
    section: usize,
    fields: Fields,
    text: String,
}

fn candidate_imports(
    filename: &str,
    text: &str,
    options: CandidateOptions,
) -> Result<Vec<CandidateScope>> {
    let mut scopes = identify_sections(text, filename)?;
    let Some(edits) = options.candidates else {
        return Ok(scopes);
    };
    if edits.is_empty() || edits.len() > scopes.len() {
        return Err(message("请选择有效的候选人记录。"));
    }
    let mut reviewed = Vec::with_capacity(edits.len());
    let mut seen = HashSet::new();
    for edit in edits {
        let section = match (options.auto_parse, edit.section, scopes.len()) {
            (false, None | Some(0), 1) => 0,
            (true, Some(section), _) => section,
            (true, None, 1) => 0,
            _ => return Err(message("候选人记录与解析预览不匹配，请重新解析。")),
        };
        if !seen.insert(section) {
            return Err(message("同一候选人分段不能重复导入。"));
        }
        let scope = scopes
            .get_mut(section)
            .ok_or_else(|| message("候选人记录与解析预览不匹配，请重新解析。"))?;
        reviewed.push(CandidateScope {
            section: scope.section,
            text: std::mem::take(&mut scope.text),
            fields: Fields {
                name: bounded(&edit.name, 90, "姓名", true)?,
                headline: bounded(&edit.headline, 160, "当前职位", false)?,
                email: bounded(&edit.email, 180, "邮箱", false)?,
                phone: bounded(&edit.phone, 64, "电话", false)?,
            },
        });
    }
    Ok(reviewed)
}

fn identify_sections(text: &str, filename: &str) -> Result<Vec<CandidateScope>> {
    let mut boundaries = Vec::new();
    let mut page_offset = 0;
    for page in text.split('\u{c}') {
        let mut count = 0;
        for occurrence in NAME.captures_iter(page) {
            let range = occurrence.get(0).unwrap();
            let name = name_value(occurrence.get(1).unwrap().as_str());
            if name.chars().count() >= 2 && !generic_heading(name) {
                // A bare title immediately before a matching labelled name also
                // belongs to this candidate, especially in PDF text.
                let before = page[..range.start()].trim_end_matches(['\n', '\r', ' ', '\t']);
                let prior = before.rsplit('\n').next().unwrap_or_default().trim();
                let start = if !prior.is_empty() && name_key(prior) == name_key(name) {
                    before.rfind('\n').map_or(0, |line| line + 1)
                } else {
                    range.start()
                };
                boundaries.push((page_offset + start, name.to_owned()));
                count += 1;
            }
        }
        if count == 0
            && let Some(name) = page_name(page)
        {
            boundaries.push((page_offset, name.to_owned()));
        }
        page_offset += page.len() + 1;
    }
    if boundaries.is_empty() {
        return Ok(vec![CandidateScope {
            section: 0,
            fields: identify(text, filename),
            text: text.replace('\u{c}', "\n"),
        }]);
    }
    let mut scopes: Vec<CandidateScope> = Vec::new();
    for (index, (_, name)) in boundaries.iter().enumerate() {
        let start = if index == 0 { 0 } else { boundaries[index].0 };
        let end = boundaries
            .get(index + 1)
            .map_or(text.len(), |entry| entry.0);
        let section_text = text[start..end].replace('\u{c}', "\n");
        let mut fields = identify(&section_text, filename);
        fields.name.clone_from(name);
        if let Some(previous) = scopes
            .iter_mut()
            .find(|scope| same_person(&scope.fields, &fields))
        {
            previous.text.push_str("\n\n");
            previous.text.push_str(section_text.trim());
            if previous.fields.email.is_empty() {
                previous.fields.email = fields.email;
            }
            if previous.fields.phone.is_empty() {
                previous.fields.phone = fields.phone;
            }
            if previous.fields.headline.is_empty() {
                previous.fields.headline = fields.headline;
            }
        } else {
            if scopes.len() >= MAX_CANDIDATES_PER_FILE {
                return Err(message("单个文件最多导入 100 位候选人，请拆分文件。"));
            }
            scopes.push(CandidateScope {
                section: scopes.len() + 1,
                fields,
                text: section_text.trim().to_owned(),
            });
        }
    }
    if scopes.len() == 1 {
        scopes[0].section = 0;
    }
    Ok(scopes)
}

fn name_value(raw: &str) -> &str {
    let end = NAME_TAIL.find(raw).map_or(raw.len(), |tail| tail.start());
    raw[..end].trim()
}

fn name_key(name: &str) -> String {
    name.chars()
        .filter(|character| !character.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}

fn generic_heading(line: &str) -> bool {
    matches!(
        line,
        "简历"
            | "个人简历"
            | "求职简历"
            | "个人履历"
            | "个人信息"
            | "基本信息"
            | "工作经历"
            | "教育经历"
            | "工作经验"
            | "教育背景"
            | "技能专长"
            | "联系方式"
            | "专业技能"
            | "项目经验"
            | "项目经历"
            | "自我评价"
            | "技术能力"
            | "个人资料"
            | "个人简介"
            | "个人概况"
            | "软件开发"
            | "招聘专员"
            | "岗位职责"
    ) || matches!(
        line.to_ascii_lowercase().as_str(),
        "resume"
            | "résumé"
            | "curriculum vitae"
            | "cv"
            | "profile"
            | "personal profile"
            | "personal information"
            | "contact information"
            | "professional summary"
            | "work experience"
            | "professional experience"
            | "cover letter"
            | "technical skills"
            | "software engineer"
            | "data analyst"
            | "product manager"
            | "data scientist"
    )
}

fn page_name(page: &str) -> Option<&str> {
    let mut lines = page.lines().map(str::trim).filter(|line| !line.is_empty());
    let head = lines.by_ref().take(5).find(|line| !generic_heading(line))?;
    if !(SHORT_NAME.is_match(head) || LATIN_NAME.is_match(head)) {
        return None;
    }
    let contact_lines = lines.take(7).collect::<Vec<_>>().join("\n");
    (EMAIL.is_match(&contact_lines)
        || PHONE_LABEL.is_match(&contact_lines)
        || MOBILE.is_match(&contact_lines))
    .then_some(head)
}

fn same_person(a: &Fields, b: &Fields) -> bool {
    if name_key(&a.name) != name_key(&b.name) {
        return false;
    }
    let phone_key = |value: &str| {
        value
            .chars()
            .filter(|c| c.is_ascii_digit())
            .collect::<String>()
    };
    let same_email = !a.email.is_empty() && a.email.eq_ignore_ascii_case(&b.email);
    let same_phone = !a.phone.is_empty() && phone_key(&a.phone) == phone_key(&b.phone);
    let different_email = !a.email.is_empty() && !b.email.is_empty() && !same_email;
    let different_phone = !a.phone.is_empty() && !b.phone.is_empty() && !same_phone;
    same_email || same_phone || !(different_email || different_phone)
}

fn identify(text: &str, filename: &str) -> Fields {
    let stem = filename
        .rsplit_once('.')
        .map_or(filename, |(stem, _)| stem)
        .trim();
    let first = text
        .lines()
        .map(str::trim)
        .find(|s| !s.is_empty() && !generic_heading(s))
        .unwrap_or("");
    let captured = |pattern: &Regex| {
        pattern
            .captures(text)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().trim().to_owned())
    };
    let name = captured(&NAME)
        .map(|raw| name_value(&raw).to_owned())
        .or_else(|| page_name(text).map(str::to_owned))
        .or_else(|| SHORT_NAME.is_match(first).then(|| first.to_owned()))
        .unwrap_or_else(|| {
            if stem.is_empty() {
                "未命名候选人".into()
            } else {
                stem.chars().take(90).collect()
            }
        });
    Fields {
        name,
        headline: captured(&HEADLINE).unwrap_or_default(),
        email: EMAIL
            .find(text)
            .map(|m| m.as_str().chars().take(180).collect())
            .unwrap_or_default(),
        phone: captured(&PHONE_LABEL)
            .or_else(|| MOBILE.find(text).map(|m| m.as_str().into()))
            .unwrap_or_default(),
    }
}
