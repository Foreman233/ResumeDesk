use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    time::Duration,
};

use rusqlite::{Connection, OptionalExtension, Row, params, params_from_iter, types::Value};
use serde::{Serialize, de::DeserializeOwned};

use crate::model::*;

pub const DB_NAME: &str = "workspace.sqlite3";
pub const STORE_DIR: &str = "workspace";
pub const PREVIOUS_DIR: &str = "workspace.previous";
pub const ATTACHMENTS_DIR: &str = "attachments";
pub const APP_ID: i64 = 0x5244_534b;
pub const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/001_workspace.sql"),
    include_str!("../migrations/002_profiles.sql"),
    include_str!("../migrations/003_seed_dictionary.sql"),
    include_str!("../migrations/004_shared_resumes.sql"),
    include_str!("../migrations/005_ai_timeout.sql"),
    include_str!("../migrations/006_todos.sql"),
    include_str!("../migrations/007_quick_controls.sql"),
    include_str!("../migrations/008_chat.sql"),
    include_str!("../migrations/009_knowledge_workspace.sql"),
    include_str!("../migrations/010_tool_hub.sql"),
];

pub struct Store {
    pub root: PathBuf,
    pub db: Connection,
    _lock: File,
}

impl Store {
    pub fn open(root: &Path) -> Result<Self> {
        fs::create_dir_all(root)?;
        let root = root.canonicalize()?;
        let lock_path = root.join("session.lock");
        reject_link(&lock_path)?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)?;
        lock.try_lock()
            .map_err(|_| message("此数据目录正在被另一个 ResumeDesk 窗口使用。"))?;
        let data = root.join(STORE_DIR);
        let previous = root.join(PREVIOUS_DIR);
        reject_link(&data)?;
        reject_link(&previous)?;
        if data.exists() {
            assert_inside(&root, &data)?;
        }
        if !data.exists() && previous.is_dir() {
            assert_inside(&root, &previous)?;
            fs::rename(&previous, &data)?;
        }
        fs::create_dir_all(data.join(ATTACHMENTS_DIR))?;
        assert_inside(&root, &data.join(ATTACHMENTS_DIR))?;
        let db = open_db(&data)?;
        let store = Self {
            root,
            db,
            _lock: lock,
        };
        store.collect_files()?;
        if previous.is_dir() {
            let _ = remove_recovery_dir(&store.root, &previous);
        }
        Ok(store)
    }

    pub fn data_dir(&self) -> PathBuf {
        self.root.join(STORE_DIR)
    }

    pub fn get_setting<T: DeserializeOwned + Default>(&self, key: &str) -> Result<T> {
        let json: Option<String> = self
            .db
            .query_row(
                "SELECT value FROM app_settings WHERE key=?1",
                [key],
                |row| row.get(0),
            )
            .optional()?;
        match json {
            Some(value) => Ok(serde_json::from_str(&value)?),
            None => Ok(T::default()),
        }
    }

    pub fn set_setting(&self, key: &str, value: &impl Serialize) -> Result<()> {
        self.db.execute(
            "INSERT INTO app_settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, serde_json::to_string(value)?],
        )?;
        Ok(())
    }

    pub fn privacy(&self) -> Result<Privacy> {
        self.get_setting("privacy")
    }

    pub fn save_privacy(&self, value: &Privacy) -> Result<()> {
        if value.retention_days > 3650 {
            return Err(message("保留期限可设为 0 至 3650 天。"));
        }
        self.set_setting("privacy", value)
    }

    pub fn dashboard(&self) -> Result<Dashboard> {
        let (candidates, open_jobs, screening, stale) = self.db.query_row(
            "SELECT (SELECT count(*) FROM candidates),
                    (SELECT count(*) FROM jobs WHERE status='open'),
                    (SELECT count(*) FROM applications WHERE stage='new'),
                    (SELECT count(*) FROM candidates WHERE updated_at < ?1)",
            [self.retention_cutoff()?],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
        let recent = self.documents(Scope::Recent)?;
        let mut stages = self
            .db
            .prepare("SELECT stage,count(*) FROM applications GROUP BY stage")?;
        let progress = stages
            .query_map([], |r| {
                Ok(StageCount {
                    stage: Stage::from_sql(r.get(0)?)?,
                    count: r.get(1)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut views = self.db.prepare(
            "SELECT c.id,c.name,c.headline,v.viewed_at FROM candidate_views v JOIN candidates c ON c.id=v.candidate_id ORDER BY v.viewed_at DESC,v.candidate_id DESC LIMIT 7",
        )?;
        let viewed = views
            .query_map([], |r| {
                Ok(RecentCandidate {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    headline: r.get(2)?,
                    viewed_at: r.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Dashboard {
            candidates,
            open_jobs,
            screening,
            stale,
            recent,
            progress,
            viewed,
        })
    }

    pub fn record_candidate_view(&self, id: i64) -> Result<()> {
        self.db.execute(
            "INSERT INTO candidate_views(candidate_id,viewed_at) SELECT id,?2 FROM candidates WHERE id=?1
             ON CONFLICT(candidate_id) DO UPDATE SET viewed_at=excluded.viewed_at",
            params![id, now()],
        )?;
        Ok(())
    }

    fn retention_cutoff(&self) -> Result<i64> {
        let days = self.privacy()?.retention_days;
        Ok(if days == 0 {
            0
        } else {
            now() - i64::from(days) * 86_400
        })
    }

    pub fn candidate_page(&self, input: &CandidateFilter) -> Result<CandidatePage> {
        let mut where_sql = String::from(" WHERE 1=1");
        let mut args = Vec::<Value>::new();
        let query = bounded(
            input.query.as_deref().unwrap_or(""),
            180,
            "搜索关键词",
            false,
        )?;
        for token in query.split_whitespace().take(12) {
            args.push(Value::Text(token.to_ascii_lowercase()));
            let arg = format!("?{}", args.len());
            where_sql.push_str(&format!(
                " AND (instr(lower(c.name),{arg})>0 OR instr(lower(c.headline),{arg})>0
                  OR instr(lower(c.email),{arg})>0 OR instr(lower(c.phone),{arg})>0
                  OR EXISTS(SELECT 1 FROM candidate_tags ct JOIN tags t ON t.id=ct.tag_id
                       WHERE ct.candidate_id=c.id AND instr(lower(t.name),{arg})>0)
                  OR EXISTS(SELECT 1 FROM resumes r WHERE r.candidate_id=c.id
                      AND (instr(lower(r.extracted_text),{arg})>0 OR instr(lower(r.original_name),{arg})>0)))"
            ));
        }
        if input.job_id.is_some() || input.stage.is_some() {
            where_sql
                .push_str(" AND EXISTS(SELECT 1 FROM applications a WHERE a.candidate_id=c.id");
            if let Some(id) = input.job_id {
                args.push(Value::Integer(id));
                where_sql.push_str(&format!(" AND a.job_id=?{}", args.len()));
            }
            if let Some(stage) = input.stage {
                args.push(Value::Text(stage.as_str().into()));
                where_sql.push_str(&format!(" AND a.stage=?{}", args.len()));
            }
            where_sql.push(')');
        }
        if let Some(tag) = &input.tag {
            args.push(Value::Text(bounded(tag, 35, "标签", true)?));
            where_sql.push_str(&format!(
                " AND EXISTS(SELECT 1 FROM candidate_tags ct JOIN tags t ON t.id=ct.tag_id
                  WHERE ct.candidate_id=c.id AND t.name=?{} COLLATE NOCASE)",
                args.len()
            ));
        }
        if input.favorite == Some(true) {
            where_sql.push_str(" AND c.favorite=1");
        }
        if input.stale == Some(true) {
            args.push(Value::Integer(self.retention_cutoff()?));
            where_sql.push_str(&format!(" AND c.updated_at<?{}", args.len()));
        }
        let total = self.db.query_row(
            &format!("SELECT count(*) FROM candidates c{where_sql}"),
            params_from_iter(args.iter()),
            |r| r.get(0),
        )?;
        args.push(Value::Integer(input.offset.unwrap_or(0).max(0)));
        let mut statement = self.db.prepare(&format!(
            "{CANDIDATE_SQL}{where_sql} ORDER BY c.updated_at DESC,c.id DESC LIMIT 60 OFFSET ?{}",
            args.len()
        ))?;
        let candidates = statement
            .query_map(params_from_iter(args.iter()), map_candidate)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut applications = self.db.prepare(
            "SELECT a.id,a.job_id,j.title,a.stage FROM applications a JOIN jobs j ON j.id=a.job_id
             WHERE a.candidate_id=?1 AND (?2 IS NULL OR a.job_id=?2)
             ORDER BY j.title COLLATE NOCASE,a.id",
        )?;
        let mut items = Vec::with_capacity(candidates.len());
        for mut candidate in candidates {
            candidate.tags = self.tags(Some(candidate.id))?;
            let states = applications
                .query_map(params![candidate.id, input.job_id], |r| {
                    Ok(ApplicationState {
                        id: r.get(0)?,
                        job_id: r.get(1)?,
                        job_title: r.get(2)?,
                        stage: Stage::from_sql(r.get(3)?)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            items.push(CandidateRow {
                candidate,
                applications: states,
            });
        }
        Ok(CandidatePage { items, total })
    }

    pub fn tags(&self, candidate_id: Option<i64>) -> Result<Vec<String>> {
        let mut statement = self.db.prepare(
            "SELECT t.name FROM tags t JOIN candidate_tags ct ON ct.tag_id=t.id
             WHERE ?1 IS NULL OR ct.candidate_id=?1 GROUP BY t.id ORDER BY t.name COLLATE NOCASE",
        )?;
        Ok(statement
            .query_map([candidate_id], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub fn candidate(&self, id: i64) -> Result<CandidateDetail> {
        let mut candidate = self
            .db
            .query_row(
                &format!("{CANDIDATE_SQL} WHERE c.id=?1"),
                [id],
                map_candidate,
            )
            .optional()?
            .ok_or_else(|| message("找不到此候选人。"))?;
        candidate.tags = self.tags(Some(id))?;
        let resumes = self.documents(Scope::Candidate(id))?;
        let applications = self.applications(None, Some(id))?;
        let mut statement = self.db.prepare(
            "SELECT id,body,created_at FROM notes WHERE candidate_id=?1 ORDER BY id DESC",
        )?;
        let notes = statement
            .query_map([id], |r| {
                Ok(Note {
                    id: r.get(0)?,
                    body: r.get(1)?,
                    created_at: r.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(CandidateDetail {
            candidate,
            resumes,
            applications,
            notes,
        })
    }

    pub fn save_candidate(&mut self, input: CandidateInput) -> Result<i64> {
        let name = bounded(&input.name, 90, "姓名", true)?;
        let headline = bounded(&input.headline, 160, "当前职位", false)?;
        let email = bounded(&input.email, 180, "邮箱", false)?;
        let phone = bounded(&input.phone, 64, "电话", false)?;
        if input.tags.len() > 30 {
            return Err(message("每位候选人最多可设置 30 个标签。"));
        }
        let tags = input
            .tags
            .iter()
            .map(|tag| bounded(tag, 35, "标签", true))
            .collect::<Result<Vec<_>>>()?;
        let tx = self.db.transaction()?;
        let stamp = now();
        let id = match input.id {
            Some(id) => {
                if tx.execute(
                    "UPDATE candidates SET name=?1,headline=?2,email=?3,phone=?4,favorite=?5,updated_at=?6 WHERE id=?7",
                    params![name, headline, email, phone, input.favorite, stamp, id],
                )? == 0 { return Err(message("找不到此候选人。")); }
                id
            }
            None => {
                tx.execute(
                    "INSERT INTO candidates(name,headline,email,phone,favorite,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?6)",
                    params![name, headline, email, phone, input.favorite, stamp],
                )?;
                tx.last_insert_rowid()
            }
        };
        tx.execute("DELETE FROM candidate_tags WHERE candidate_id=?1", [id])?;
        for tag in tags {
            tx.execute("INSERT OR IGNORE INTO tags(name) VALUES(?1)", [&tag])?;
            tx.execute(
                "INSERT OR IGNORE INTO candidate_tags SELECT ?1,id FROM tags WHERE name=?2 COLLATE NOCASE",
                params![id, tag],
            )?;
        }
        prune_tags(&tx)?;
        tx.commit()?;
        Ok(id)
    }

    pub fn set_favorite(&self, id: i64, favorite: bool) -> Result<()> {
        self.db.execute(
            "UPDATE candidates SET favorite=?1 WHERE id=?2",
            params![favorite, id],
        )?;
        Ok(())
    }

    pub fn delete_candidate(&mut self, id: i64) -> Result<bool> {
        let tx = self.db.transaction()?;
        tx.execute("DELETE FROM candidates WHERE id=?1", [id])?;
        prune_tags(&tx)?;
        tx.commit()?;
        self.collect_files()
    }

    pub fn add_note(&mut self, candidate_id: i64, body: &str) -> Result<()> {
        let body = bounded(body, 4000, "备注", true)?;
        let tx = self.db.transaction()?;
        touch_candidate(&tx, candidate_id)?;
        tx.execute(
            "INSERT INTO notes(candidate_id,body,created_at) VALUES(?1,?2,?3)",
            params![candidate_id, body, now()],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn delete_note(&self, id: i64, candidate_id: i64) -> Result<()> {
        self.db.execute(
            "DELETE FROM notes WHERE id=?1 AND candidate_id=?2",
            params![id, candidate_id],
        )?;
        Ok(())
    }

    pub fn jobs(&self) -> Result<Vec<Job>> {
        let mut statement = self.db.prepare(&format!(
            "{JOB_SQL} ORDER BY j.status='open' DESC,j.updated_at DESC,j.id DESC"
        ))?;
        Ok(statement
            .query_map([], map_job)?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub fn job(&self, id: i64) -> Result<Job> {
        self.db
            .query_row(&format!("{JOB_SQL} WHERE j.id=?1"), [id], map_job)
            .optional()?
            .ok_or_else(|| message("找不到此岗位。"))
    }

    pub fn save_job(&self, input: JobInput) -> Result<i64> {
        let title = bounded(&input.title, 120, "岗位名称", true)?;
        let department = bounded(&input.department, 100, "招聘部门", false)?;
        let jd = bounded(&input.jd, 24_000, "岗位描述", false)?;
        if let Some(id) = input.id {
            if self.db.execute(
                "UPDATE jobs SET title=?1,department=?2,jd=?3,status=?4,updated_at=?5 WHERE id=?6",
                params![title, department, jd, input.status.as_str(), now(), id],
            )? == 0
            {
                return Err(message("找不到此岗位。"));
            }
            Ok(id)
        } else {
            self.db.execute(
                "INSERT INTO jobs(title,department,jd,status,updated_at,created_at) VALUES(?1,?2,?3,?4,?5,?5)",
                params![title, department, jd, input.status.as_str(), now()]
            )?;
            Ok(self.db.last_insert_rowid())
        }
    }

    pub fn delete_job(&self, id: i64) -> Result<bool> {
        self.db.execute("DELETE FROM jobs WHERE id=?1", [id])?;
        self.collect_files()
    }

    pub fn applications(
        &self,
        job: Option<i64>,
        candidate: Option<i64>,
    ) -> Result<Vec<Application>> {
        let mut statement = self.db.prepare(
            "SELECT a.id,a.candidate_id,c.name,a.job_id,j.title,a.stage,a.note,a.updated_at
             FROM applications a JOIN candidates c ON c.id=a.candidate_id JOIN jobs j ON j.id=a.job_id
             WHERE (?1 IS NULL OR a.job_id=?1) AND (?2 IS NULL OR a.candidate_id=?2) ORDER BY a.updated_at DESC,a.id DESC",
        )?;
        Ok(statement
            .query_map(params![job, candidate], |r| {
                Ok(Application {
                    id: r.get(0)?,
                    candidate_id: r.get(1)?,
                    candidate_name: r.get(2)?,
                    job_id: r.get(3)?,
                    job_title: r.get(4)?,
                    stage: Stage::from_sql(r.get(5)?)?,
                    note: r.get(6)?,
                    updated_at: r.get(7)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub fn link_application(&mut self, candidate_id: i64, job_id: i64) -> Result<i64> {
        self.job(job_id)?;
        let tx = self.db.transaction()?;
        touch_candidate(&tx, candidate_id)?;
        tx.execute(
            "INSERT INTO applications(candidate_id,job_id,stage,created_at,updated_at)
             VALUES(?1,?2,'new',?3,?3) ON CONFLICT(candidate_id,job_id) DO NOTHING",
            params![candidate_id, job_id, now()],
        )?;
        let id = tx.query_row(
            "SELECT id FROM applications WHERE candidate_id=?1 AND job_id=?2",
            params![candidate_id, job_id],
            |r| r.get(0),
        )?;
        tx.commit()?;
        Ok(id)
    }

    pub fn save_application(&mut self, id: i64, stage: Stage, note: &str) -> Result<()> {
        let note = bounded(note, 4000, "申请备注", false)?;
        self.update_application(id, stage, Some(&note))
    }

    pub fn set_application_stage(&mut self, id: i64, stage: Stage) -> Result<()> {
        self.update_application(id, stage, None)
    }

    fn update_application(&mut self, id: i64, stage: Stage, note: Option<&str>) -> Result<()> {
        let tx = self.db.transaction()?;
        let candidate: i64 = tx
            .query_row(
                "SELECT candidate_id FROM applications WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| message("找不到此岗位申请。"))?;
        tx.execute(
            "UPDATE applications SET stage=?1,note=coalesce(?2,note),updated_at=?3 WHERE id=?4",
            params![stage.as_str(), note, now(), id],
        )?;
        touch_candidate(&tx, candidate)?;
        tx.commit()?;
        Ok(())
    }

    pub fn unlink_application(&self, id: i64) -> Result<()> {
        self.db
            .execute("DELETE FROM applications WHERE id=?1", [id])?;
        Ok(())
    }

    pub fn documents(&self, scope: Scope) -> Result<Vec<Document>> {
        let (sql, id) = match scope {
            Scope::Candidate(id) => (
                format!("{RESUME_SQL} WHERE r.candidate_id=?1 ORDER BY r.id DESC"),
                Some(id),
            ),
            Scope::Recent => (format!("{RESUME_SQL} ORDER BY r.id DESC LIMIT 7"), None),
        };
        let mut statement = self.db.prepare(&sql)?;
        let args = id.into_iter().collect::<Vec<_>>();
        Ok(statement
            .query_map(params_from_iter(args), map_document)?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub fn document_text(&self, document: ResumeRef) -> Result<String> {
        self.db
            .query_row(
                "SELECT extracted_text FROM resumes WHERE id=?1",
                [document.id()],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| message("找不到此简历。"))
    }

    pub fn document_file(&self, document: ResumeRef) -> Result<PathBuf> {
        let (hash, format): (String, String) = self.db.query_row(
            "SELECT f.hash,f.format FROM resumes r JOIN files f ON f.hash=r.file_hash WHERE r.id=?1",
            [document.id()], |r| Ok((r.get(0)?, r.get(1)?)),
        ).optional()?.ok_or_else(|| message("找不到此简历。"))?;
        self.attachment_path(&hash, &format, true)
    }

    pub fn attachment_path(&self, hash: &str, format: &str, exists: bool) -> Result<PathBuf> {
        let dir = self.data_dir().join(ATTACHMENTS_DIR);
        assert_inside(&self.root, &dir)?;
        let path = dir.join(attachment_name(hash, format)?);
        reject_link(&path)?;
        if exists {
            assert_inside(&dir, &path)?;
            if !path.is_file() {
                return Err(message("原始文件已丢失，可尝试从备份恢复。"));
            }
        }
        Ok(path)
    }

    pub fn delete_document(&self, document: ResumeRef) -> Result<bool> {
        self.db
            .execute("DELETE FROM resumes WHERE id=?1", [document.id()])?;
        self.collect_files()
    }

    pub fn remove_attachment_if_unused(&self, hash: &str, format: &str) -> Result<bool> {
        let path = self.attachment_path(hash, format, false)?;
        let used: bool = self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM files WHERE hash=?1 AND format=?2)
                OR EXISTS(SELECT 1 FROM knowledge_documents WHERE file_hash=?1 AND format=?2)",
            params![hash, format],
            |r| r.get(0),
        )?;
        Ok(used || !path.exists() || fs::remove_file(path).is_ok())
    }

    /// Returns false when Windows still has an orphan file open.
    pub fn collect_files(&self) -> Result<bool> {
        // Retired job samples still own their original files for backup and recovery.
        self.db.execute(
            "DELETE FROM files WHERE NOT EXISTS(SELECT 1 FROM resumes r WHERE r.file_hash=files.hash)
             AND NOT EXISTS(SELECT 1 FROM job_samples j WHERE j.file_hash=files.hash)",
            [],
        )?;
        let dir = self.data_dir().join(ATTACHMENTS_DIR);
        assert_inside(&self.root, &dir)?;
        let mut complete = true;
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some((hash, format)) = name.to_str().and_then(|s| s.split_once('.')) else {
                continue;
            };
            if attachment_name(hash, format).is_err() || !entry.file_type()?.is_file() {
                continue;
            }
            if !self.remove_attachment_if_unused(hash, format)? {
                complete = false;
            }
        }
        Ok(complete)
    }
}

pub enum Scope {
    Candidate(i64),
    Recent,
}

const CANDIDATE_SQL: &str =
    "SELECT c.id,c.name,c.headline,c.email,c.phone,c.favorite,c.created_at,c.updated_at,
     (SELECT count(*) FROM resumes r WHERE r.candidate_id=c.id) FROM candidates c";
const JOB_SQL: &str = "SELECT j.id,j.title,j.department,j.jd,j.status,j.updated_at,
     (SELECT count(*) FROM applications a WHERE a.job_id=j.id) FROM jobs j";
const RESUME_SQL: &str =
    "SELECT r.id,r.candidate_id,c.name,r.original_name,f.format,f.byte_size,r.imported_at,r.parse_status
     FROM resumes r JOIN files f ON r.file_hash=f.hash JOIN candidates c ON c.id=r.candidate_id";

fn map_candidate(r: &Row<'_>) -> rusqlite::Result<Candidate> {
    Ok(Candidate {
        id: r.get(0)?,
        name: r.get(1)?,
        headline: r.get(2)?,
        email: r.get(3)?,
        phone: r.get(4)?,
        favorite: r.get(5)?,
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
        tags: Vec::new(),
        resume_count: r.get(8)?,
    })
}

fn map_job(r: &Row<'_>) -> rusqlite::Result<Job> {
    Ok(Job {
        id: r.get(0)?,
        title: r.get(1)?,
        department: r.get(2)?,
        jd: r.get(3)?,
        status: JobStatus::from_sql(r.get(4)?)?,
        updated_at: r.get(5)?,
        application_count: r.get(6)?,
    })
}

fn map_document(r: &Row<'_>) -> rusqlite::Result<Document> {
    Ok(Document {
        id: r.get(0)?,
        owner_id: r.get(1)?,
        owner_name: r.get(2)?,
        original_name: r.get(3)?,
        format: FileFormat::from_sql(r.get(4)?)?,
        byte_size: r.get(5)?,
        imported_at: r.get(6)?,
        parse_status: ParseStatus::from_sql(r.get(7)?)?,
    })
}

pub fn touch_candidate(db: &Connection, id: i64) -> Result<()> {
    if db.execute(
        "UPDATE candidates SET updated_at=?1 WHERE id=?2",
        params![now(), id],
    )? == 0
    {
        return Err(message("找不到此候选人。"));
    }
    Ok(())
}

fn prune_tags(db: &Connection) -> Result<()> {
    db.execute("DELETE FROM tags WHERE NOT EXISTS(SELECT 1 FROM candidate_tags ct WHERE ct.tag_id=tags.id)", [])?;
    Ok(())
}

pub fn open_db(dir: &Path) -> Result<Connection> {
    let path = dir.join(DB_NAME);
    reject_link(&path)?;
    let mut db = Connection::open(path)?;
    db.busy_timeout(Duration::from_secs(4))?;
    db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON;")?;
    migrate(&mut db)?;
    Ok(db)
}

pub fn migrate(db: &mut Connection) -> Result<()> {
    let version: usize = db.pragma_query_value(None, "user_version", |r| r.get(0))?;
    let app_id: i64 = db.pragma_query_value(None, "application_id", |r| r.get(0))?;
    if (app_id != APP_ID && (app_id != 0 || version != 0)) || version > MIGRATIONS.len() {
        return Err(message("数据库版本不兼容，请使用对应版本的 ResumeDesk。"));
    }
    for (offset, sql) in MIGRATIONS.iter().enumerate().skip(version) {
        apply_migration(db, offset + 1, sql)?;
    }
    Ok(())
}

pub(crate) fn apply_migration(db: &mut Connection, version: usize, sql: &str) -> Result<()> {
    // Rebuilding resumes must retain rows in job_profile_sources and their evidence.
    // SQLite applies ON DELETE CASCADE when a referenced table is dropped with FKs enabled.
    let rebuild = version == 4;
    let foreign_keys: bool = db.pragma_query_value(None, "foreign_keys", |r| r.get(0))?;
    if rebuild && foreign_keys {
        db.pragma_update(None, "foreign_keys", false)?;
    }
    let result = (|| -> Result<()> {
        let tx = db.transaction()?;
        tx.execute_batch(sql)?;
        if rebuild
            && tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_foreign_key_check)",
                [],
                |r| r.get::<_, bool>(0),
            )?
        {
            return Err(message("升级简历库时发现关联记录不一致，升级已回滚。"));
        }
        tx.pragma_update(None, "application_id", APP_ID)?;
        tx.pragma_update(None, "user_version", version)?;
        tx.commit()?;
        Ok(())
    })();
    if rebuild && foreign_keys {
        db.pragma_update(None, "foreign_keys", true)?;
    }
    result
}

pub fn attachment_name(hash: &str, format: &str) -> Result<String> {
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || !matches!(format, "pdf" | "docx" | "txt" | "md" | "csv")
    {
        return Err(message("附件标识无效。"));
    }
    Ok(format!("{hash}.{format}"))
}

pub fn reject_link(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(info) if is_link(&info) => Err(message("应用数据目录中包含不受支持的链接。")),
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

fn is_link(info: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const REPARSE_POINT: u32 = 0x400;
        info.file_attributes() & REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        info.file_type().is_symlink()
    }
}

pub fn assert_inside(root: &Path, path: &Path) -> Result<()> {
    if !path.canonicalize()?.starts_with(root.canonicalize()?) {
        return Err(message("应用数据路径超出了允许范围。"));
    }
    Ok(())
}

pub fn remove_recovery_dir(root: &Path, path: &Path) -> Result<()> {
    assert_inside(root, path)?;
    if path.parent() != Some(root)
        || path.file_name().and_then(|v| v.to_str()) != Some(PREVIOUS_DIR)
    {
        return Err(message("恢复目录路径无效。"));
    }
    fs::remove_dir_all(path)?;
    Ok(())
}
