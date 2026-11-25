use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{self, BufReader, Read, Write},
    path::{Path, PathBuf},
};

use age::{Decryptor, Encryptor, Identity, secrecy::SecretString};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{
    documents::MAX_FILE,
    model::{Result, message},
    store::{
        APP_ID, ATTACHMENTS_DIR, DB_NAME, MIGRATIONS, PREVIOUS_DIR, Store, attachment_name,
        open_db, reject_link, remove_recovery_dir,
    },
};

const MAGIC: &[u8; 8] = b"RDESK1\0\0";
const MAX_TOTAL: u64 = 4 * 1024 * 1024 * 1024;
const MAX_DB: u64 = 768 * 1024 * 1024;
const MAX_COUNT: u32 = 25_000;
const ATTACHMENT_FORMATS: &[&str] = &["pdf", "docx", "txt", "md", "csv"];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummary {
    pub attachments: usize,
    pub cleanup_pending: bool,
}

#[derive(PartialEq, Eq, Hash)]
struct Attachment {
    hash: String,
    format: String,
    length: u64,
}

impl Store {
    pub fn backup(&self, path: &Path, passphrase: String) -> Result<BackupSummary> {
        let secret = password(passphrase)?;
        let path = authorized_path(&self.root, path)?;
        let db_path = self.data_dir().join(DB_NAME);
        let db = File::open(db_path)?;
        let db_size = db.metadata()?.len();
        let files = attachment_rows(&self.db)?;
        if db_size == 0
            || db_size > MAX_DB
            || files.len() > MAX_COUNT as usize
            || db_size.saturating_add(files.iter().map(|f| f.length).sum::<u64>()) > MAX_TOTAL
        {
            return Err(message("资料库超出当前版本的单个备份上限（4 GiB）。"));
        }
        let mut temp = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
        {
            let mut output =
                Encryptor::with_user_passphrase(secret).wrap_output(temp.as_file_mut())?;
            output.write_all(MAGIC)?;
            output.write_all(&(files.len() as u32).to_le_bytes())?;
            output.write_all(&db_size.to_le_bytes())?;
            copy_exact(db, &mut output, db_size)?;
            for file in &files {
                let original = File::open(self.attachment_path(&file.hash, &file.format, true)?)?;
                if original.metadata()?.len() != file.length {
                    return Err(message("发现损坏的附件，无法创建完整备份。"));
                }
                output.write_all(file.hash.as_bytes())?;
                let format = ATTACHMENT_FORMATS
                    .iter()
                    .position(|value| *value == file.format)
                    .ok_or_else(|| message("备份附件格式无效。"))?;
                output.write_all(&[format as u8])?;
                output.write_all(&file.length.to_le_bytes())?;
                let mut digest = Sha256::new();
                let mut tee = WithDigest {
                    writer: &mut output,
                    digest: &mut digest,
                };
                copy_exact(original, &mut tee, file.length)?;
                if hex::encode(digest.finalize()) != file.hash {
                    return Err(message("发现损坏的附件，无法创建完整备份。"));
                }
            }
            output.finish()?;
        }
        temp.as_file().sync_all()?;
        temp.persist(path).map_err(|e| e.error)?;
        Ok(BackupSummary {
            attachments: files.len(),
            cleanup_pending: false,
        })
    }

    pub fn restore(&mut self, path: &Path, passphrase: String) -> Result<BackupSummary> {
        let secret = password(passphrase)?;
        let path = authorized_path(&self.root, path)?;
        let file = File::open(path)?;
        if file.metadata()?.len() > MAX_TOTAL + 16 * 1024 * 1024 {
            return Err(message("备份超过允许大小。"));
        }
        let bad_archive =
            || message("备份无法解密或校验失败，请核对口令和备份文件。当前资料库未被替换。");
        let mut identity = age::scrypt::Identity::new(secret);
        identity.set_max_work_factor(21);
        let decryptor = Decryptor::new_buffered(BufReader::new(file)).map_err(|_| bad_archive())?;
        if !decryptor.is_scrypt() {
            return Err(bad_archive());
        }
        let mut input = decryptor
            .decrypt(std::iter::once(&identity as &dyn Identity))
            .map_err(|_| bad_archive())?;
        let magic: [u8; 8] = read_array(&mut input).map_err(|_| bad_archive())?;
        let count = u32::from_le_bytes(read_array(&mut input).map_err(|_| bad_archive())?);
        let db_size = u64::from_le_bytes(read_array(&mut input).map_err(|_| bad_archive())?);
        if &magic != MAGIC || count > MAX_COUNT || db_size == 0 || db_size > MAX_DB {
            return Err(bad_archive());
        }
        let staging = tempfile::Builder::new()
            .prefix(".resumedesk-restore-")
            .tempdir_in(&self.root)?;
        let attachments = staging.path().join(ATTACHMENTS_DIR);
        fs::create_dir(&attachments)?;
        let mut db_output = new_file(&staging.path().join(DB_NAME))?;
        copy_exact(&mut input, &mut db_output, db_size).map_err(|_| bad_archive())?;
        db_output.sync_all()?;
        drop(db_output);

        let mut listed = HashSet::new();
        let mut total = db_size;
        for _ in 0..count {
            let raw_hash: [u8; 64] = read_array(&mut input).map_err(|_| bad_archive())?;
            let hash = String::from_utf8(raw_hash.to_vec()).map_err(|_| bad_archive())?;
            let index = read_array::<1>(&mut input).map_err(|_| bad_archive())?[0] as usize;
            let format = *ATTACHMENT_FORMATS.get(index).ok_or_else(bad_archive)?;
            let length = u64::from_le_bytes(read_array(&mut input).map_err(|_| bad_archive())?);
            total = total.saturating_add(length);
            if length == 0 || length > MAX_FILE as u64 || total > MAX_TOTAL {
                return Err(bad_archive());
            }
            let output_path =
                attachments.join(attachment_name(&hash, format).map_err(|_| bad_archive())?);
            let mut output = new_file(&output_path)?;
            let mut digest = Sha256::new();
            let mut tee = WithDigest {
                writer: &mut output,
                digest: &mut digest,
            };
            copy_exact(&mut input, &mut tee, length).map_err(|_| bad_archive())?;
            output.sync_all()?;
            if hex::encode(digest.finalize()) != hash {
                return Err(bad_archive());
            }
            listed.insert(Attachment {
                hash,
                format: format.into(),
                length,
            });
        }
        if input.read(&mut [0]).map_err(|_| bad_archive())? != 0 {
            return Err(bad_archive());
        }

        validate_db(staging.path())?;
        let restored = open_db(staging.path())?;
        if attachment_rows(&restored)?
            .into_iter()
            .collect::<HashSet<_>>()
            != listed
        {
            return Err(message("备份中的附件与数据库记录不匹配。"));
        }
        drop(restored);
        let cleanup_pending = self.swap_workspace(staging.path())?;
        Ok(BackupSummary {
            attachments: count as usize,
            cleanup_pending,
        })
    }

    fn swap_workspace(&mut self, staging: &Path) -> Result<bool> {
        let live = self.data_dir();
        let previous = self.root.join(PREVIOUS_DIR);
        reject_link(&previous)?;
        if previous.exists() {
            remove_recovery_dir(&self.root, &previous)?;
        }
        let placeholder = Connection::open_in_memory()?;
        drop(std::mem::replace(&mut self.db, placeholder));
        if let Err(error) = fs::rename(&live, &previous) {
            self.db = open_db(&live)?;
            return Err(error.into());
        }
        let attempt = fs::rename(staging, &live)
            .map_err(crate::model::Error::from)
            .and_then(|()| open_db(&live));
        match attempt {
            Ok(connection) => self.db = connection,
            Err(error) => {
                if live.exists() {
                    fs::rename(&live, staging)?;
                }
                fs::rename(&previous, &live)?;
                self.db = open_db(&live)?;
                return Err(error);
            }
        }
        Ok(remove_recovery_dir(&self.root, &previous).is_err())
    }
}

fn password(passphrase: String) -> Result<SecretString> {
    let secret = zeroize::Zeroizing::new(passphrase);
    if !(10..=200).contains(&secret.chars().count()) || secret.trim().is_empty() {
        return Err(message("备份口令须包含 10 至 200 个字符。"));
    }
    Ok(SecretString::from(secret.as_str().to_owned()))
}

fn authorized_path(root: &Path, path: &Path) -> Result<PathBuf> {
    if !path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("rdbackup"))
    {
        return Err(message("请选择扩展名为 .rdbackup 的备份文件。"));
    }
    let parent = path
        .parent()
        .ok_or_else(|| message("备份位置无效。"))?
        .canonicalize()?;
    let path = parent.join(path.file_name().ok_or_else(|| message("备份名称无效。"))?);
    reject_link(&path)?;
    if parent.starts_with(root) {
        return Err(message("请在应用数据目录之外选择备份文件。"));
    }
    Ok(path)
}

fn new_file(path: &Path) -> io::Result<File> {
    OpenOptions::new().write(true).create_new(true).open(path)
}
fn read_array<const N: usize>(reader: &mut impl Read) -> io::Result<[u8; N]> {
    let mut bytes = [0_u8; N];
    reader.read_exact(&mut bytes)?;
    Ok(bytes)
}
fn copy_exact(input: impl Read, writer: &mut impl Write, length: u64) -> io::Result<()> {
    if io::copy(&mut input.take(length), writer)? != length {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "archive record truncated",
        ));
    }
    Ok(())
}

struct WithDigest<'a, W> {
    writer: &'a mut W,
    digest: &'a mut Sha256,
}
impl<W: Write> Write for WithDigest<'_, W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let written = self.writer.write(bytes)?;
        self.digest.update(&bytes[..written]);
        Ok(written)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.writer.flush()
    }
}

fn attachment_rows(db: &Connection) -> Result<Vec<Attachment>> {
    let mut statement = db.prepare(
        "SELECT hash,format,byte_size FROM files
         UNION SELECT file_hash,format,byte_size FROM knowledge_documents ORDER BY 1,2",
    )?;
    Ok(statement
        .query_map([], |r| {
            Ok(Attachment {
                hash: r.get(0)?,
                format: r.get(1)?,
                length: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

fn validate_db(staging: &Path) -> Result<()> {
    let db = Connection::open_with_flags(staging.join(DB_NAME), OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    db.execute_batch("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;")?;
    let version: usize = db.pragma_query_value(None, "user_version", |r| r.get(0))?;
    let id: i64 = db.pragma_query_value(None, "application_id", |r| r.get(0))?;
    if id != APP_ID || !(1..=MIGRATIONS.len()).contains(&version) {
        return Err(message("备份的数据库版本与 ResumeDesk 不兼容。"));
    }
    let mut expected = Connection::open_in_memory()?;
    for (offset, sql) in MIGRATIONS[..version].iter().enumerate() {
        crate::store::apply_migration(&mut expected, offset + 1, sql)?;
    }
    let schema =
        |connection: &Connection| -> rusqlite::Result<Vec<(String, String, Option<String>)>> {
            let mut q = connection.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name")?;
            q.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect()
        };
    if schema(&db)? != schema(&expected)? {
        return Err(message("备份的数据库结构与官方迁移不匹配。"));
    }
    let integrity: String = db.query_row("PRAGMA integrity_check(1)", [], |r| r.get(0))?;
    let bad_relation: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_foreign_key_check)",
        [],
        |r| r.get(0),
    )?;
    if integrity != "ok" || bad_relation {
        return Err(message("备份数据库未通过完整性校验。"));
    }
    Ok(())
}
