use std::{
    fs,
    io::{Cursor, Write},
};
use tempfile::TempDir;

use crate::{
    ai::{self, AISettings, SettingsInput},
    documents::{ImportMeta, ImportResult, ImportTarget, preview_import},
    model::*,
    store::{APP_ID, ATTACHMENTS_DIR, MIGRATIONS, Store, attachment_name},
};

fn fresh() -> (TempDir, Store) {
    let folder = tempfile::tempdir().unwrap();
    let store = Store::open(&folder.path().join("library")).unwrap();
    (folder, store)
}

fn job(store: &Store, title: &str, jd: &str) -> i64 {
    store
        .save_job(JobInput {
            id: None,
            title: title.into(),
            department: "演示部门".into(),
            jd: jd.into(),
            status: JobStatus::Open,
        })
        .unwrap()
}

fn pdf(store: &mut Store, name: &str, text: &str, target: ImportTarget, id: u32) -> ImportResult {
    // This exercises backend import metadata. The desktop suite generates real multi-page PDFs.
    let bytes = format!("%PDF-1.6\n% fixture {id}\n%%EOF");
    store
        .import(
            ImportMeta {
                name: name.into(),
                target,
                text: text.into(),
                status: ParseStatus::Complete,
                candidate_options: None,
            },
            bytes.as_bytes(),
        )
        .unwrap()
}

fn ids(result: ImportResult) -> (i64, i64) {
    match result {
        ImportResult::Imported {
            document_id,
            owner_id,
            ..
        } => (document_id, owner_id),
        _ => panic!("expected an import"),
    }
}

#[test]
fn durable_library_dedup_search_and_independent_applications() {
    let (folder, mut store) = fresh();
    assert_eq!(store.dashboard().unwrap().candidates, 0);
    assert!(!ai::settings_view(&store).unwrap().has_key);
    assert!(ai::connection_settings(&store, false).is_err());
    assert_eq!(
        store
            .db
            .pragma_query_value(None, "application_id", |r| r.get::<_, i64>(0))
            .unwrap(),
        APP_ID
    );
    assert_eq!(
        store
            .db
            .pragma_query_value(None, "user_version", |r| r.get::<_, usize>(0))
            .unwrap(),
        MIGRATIONS.len()
    );
    assert!(
        Store::open(&store.root).is_err(),
        "same workspace is locked"
    );

    let (resume, candidate) = ids(pdf(
        &mut store,
        "示例一.pdf",
        "姓名：许示例\n当前职位：指标分析师\n候选数据平台 Python SQL\nfixture@example.invalid\n电话：138 0000 0000",
        ImportTarget::New,
        1,
    ));
    assert!(
        matches!(pdf(&mut store, "重新命名.PDF", "任意文字", ImportTarget::New, 1),
        ImportResult::Duplicate { document_id, owner_id, .. } if document_id == resume && owner_id == candidate)
    );
    ids(pdf(
        &mut store,
        "版本二.pdf",
        "可视化 Tableau",
        ImportTarget::Candidate(candidate),
        2,
    ));
    ids(pdf(
        &mut store,
        "另一候选.pdf",
        "Name: Demo Other\n市场营销",
        ImportTarget::New,
        3,
    ));
    let first = store.candidate(candidate).unwrap();
    assert_eq!(first.candidate.name, "许示例");
    assert_eq!(first.candidate.email, "fixture@example.invalid");
    assert_eq!(first.candidate.phone, "138 0000 0000");
    assert_eq!(first.resumes.len(), 2);
    assert!(
        store
            .document_file(ResumeRef::Resume(resume))
            .unwrap()
            .is_file()
    );

    store
        .save_candidate(CandidateInput {
            id: Some(candidate),
            name: first.candidate.name,
            headline: first.candidate.headline,
            email: first.candidate.email,
            phone: first.candidate.phone,
            tags: vec!["跟进".into(), "数据岗位".into()],
            favorite: true,
        })
        .unwrap();
    store.add_note(candidate, "虚构沟通记录").unwrap();
    let a = job(&store, "数据岗位", "");
    let b = job(&store, "研发岗位", "");
    let first = store.link_application(candidate, a).unwrap();
    let other = store.link_application(candidate, b).unwrap();
    assert_eq!(store.link_application(candidate, a).unwrap(), first);
    store
        .save_application(first, Stage::Interview, "约下周")
        .unwrap();
    store
        .save_application(other, Stage::Screened, "补充信息")
        .unwrap();
    drop(store);

    let mut store = Store::open(&folder.path().join("library")).unwrap();
    for text in ["数据平台", "PYTHON", "数据平台 SQL", "Tableau"] {
        assert_eq!(
            store
                .candidate_page(&CandidateFilter {
                    query: Some(text.into()),
                    ..Default::default()
                })
                .unwrap()
                .total,
            1
        );
    }
    assert_eq!(
        store
            .candidate_page(&CandidateFilter {
                query: Some("' OR 1=1 --".into()),
                ..Default::default()
            })
            .unwrap()
            .total,
        0
    );
    assert_eq!(
        store
            .candidate_page(&CandidateFilter {
                job_id: Some(a),
                stage: Some(Stage::Screened),
                ..Default::default()
            })
            .unwrap()
            .total,
        0
    );
    assert_eq!(
        store
            .candidate_page(&CandidateFilter {
                job_id: Some(b),
                stage: Some(Stage::Screened),
                tag: Some("跟进".into()),
                favorite: Some(true),
                ..Default::default()
            })
            .unwrap()
            .total,
        1
    );
    let detail = store.candidate(candidate).unwrap();
    assert_eq!(detail.notes[0].body, "虚构沟通记录");
    assert_eq!(detail.applications.len(), 2);
    assert!(
        detail
            .applications
            .iter()
            .any(|app| app.job_id == a && app.stage == Stage::Interview && app.note == "约下周")
    );
    let attachment = store.document_file(ResumeRef::Resume(resume)).unwrap();
    assert!(store.delete_candidate(candidate).unwrap());
    assert!(!attachment.exists());
    assert!(store.candidate(candidate).is_err());
    assert!(store.applications(Some(a), None).unwrap().is_empty());
    assert!(store.tags(None).unwrap().is_empty());
    assert_eq!(store.dashboard().unwrap().candidates, 1);
    assert!(attachment_name("../outside", "pdf").is_err());
}

#[test]
fn docx_reads_unicode_entities_and_rejects_other_archives() {
    let (_folder, mut store) = fresh();
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let entry = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    zip.start_file("[Content_Types].xml", entry).unwrap();
    zip.write_all(br#"<Types><Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#).unwrap();
    zip.start_file("word/document.xml", entry).unwrap();
    zip.write_all(r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
        <w:p><w:r><w:t>姓名：测试员</w:t></w:r></w:p>
        <w:p><w:r><w:t>技术 &amp; 数据可视化&#x3002;</w:t></w:r></w:p>
        </w:body></w:document>"#.as_bytes()).unwrap();
    let bytes = zip.finish().unwrap().into_inner();
    let (id, candidate) = ids(store
        .import(
            ImportMeta {
                name: "虚构.docx".into(),
                target: ImportTarget::New,
                text: "untrusted text".into(),
                status: ParseStatus::Empty,
                candidate_options: None,
            },
            &bytes,
        )
        .unwrap());
    assert_eq!(store.candidate(candidate).unwrap().candidate.name, "测试员");
    assert!(
        store
            .document_text(ResumeRef::Resume(id))
            .unwrap()
            .contains("技术 & 数据可视化。")
    );
    assert!(
        store
            .import(
                ImportMeta {
                    name: "../../其他.docx".into(),
                    target: ImportTarget::New,
                    text: String::new(),
                    status: ParseStatus::Empty,
                    candidate_options: None,
                },
                &bytes
            )
            .is_err()
    );
    assert!(
        store
            .import(
                ImportMeta {
                    name: "假文件.docx".into(),
                    target: ImportTarget::New,
                    text: String::new(),
                    status: ParseStatus::Empty,
                    candidate_options: None,
                },
                b"PK\x03\x04garbage"
            )
            .is_err()
    );
}

fn combined_import_meta(text: &str, options: serde_json::Value) -> ImportMeta {
    serde_json::from_value(serde_json::json!({
        "target": {"kind": "new"},
        "name": "合并简历.pdf",
        "text": text,
        "status": "complete",
        "candidateOptions": options,
    }))
    .unwrap()
}

#[test]
fn combined_import_reviews_scopes_links_job_and_shares_a_single_original() {
    let (_folder, mut store) = fresh();
    let job_id = job(&store, "招聘岗位", "");
    let content = concat!(
        "张示例\n邮箱：first@example.invalid\n参与 SQL pipeline。\n\u{c}\n",
        "姓名：张示例\n邮箱：first@example.invalid\n后续项目和学习经历。\n\u{c}\n",
        "NAME: Jamie Example\nEmail: second@example.invalid\n开发 Vue 工作台。",
    );
    let bytes = b"%PDF-1.7 combined fixture %%EOF";
    let preview = preview_import(
        combined_import_meta(content, serde_json::Value::Null),
        bytes,
    )
    .unwrap();
    let candidates = serde_json::to_value(preview).unwrap()["candidates"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(candidates.len(), 2);
    assert_eq!(candidates[0]["name"], "张示例");
    assert_eq!(candidates[1]["email"], "second@example.invalid");
    assert_eq!(
        store.dashboard().unwrap().candidates,
        0,
        "preview writes nothing"
    );
    let result = store.import(combined_import_meta(content, serde_json::json!({
        "jobId": job_id,
        "autoParse": true,
        "candidates": [
            {"section": candidates[0]["section"], "name": "张已审核", "email": "first@example.invalid"},
            candidates[1]
        ]
    })), bytes).unwrap();
    let result = serde_json::to_value(result).unwrap();
    assert_eq!(result["state"], "imported");
    let created = result["candidates"].as_array().unwrap();
    assert_eq!(created.len(), 2);
    assert_eq!(created[0]["ownerName"], "张已审核");
    let first = ResumeRef::Resume(created[0]["documentId"].as_i64().unwrap());
    let second = ResumeRef::Resume(created[1]["documentId"].as_i64().unwrap());
    let first_text = store.document_text(first).unwrap();
    let second_text = store.document_text(second).unwrap();
    assert!(first_text.contains("后续项目和学习经历"));
    assert!(!first_text.contains("second@example.invalid") && !first_text.contains('\u{c}'));
    assert!(second_text.contains("Vue 工作台") && !second_text.contains("first@example.invalid"));
    assert_eq!(
        store.document_file(first).unwrap(),
        store.document_file(second).unwrap()
    );
    assert_eq!(store.applications(Some(job_id), None).unwrap().len(), 2);
    assert!(matches!(
        store
            .import(
                combined_import_meta(content, serde_json::Value::Null),
                bytes
            )
            .unwrap(),
        ImportResult::Duplicate { .. }
    ));
    let first_candidate = created[0]["ownerId"].as_i64().unwrap();
    let second_candidate = created[1]["ownerId"].as_i64().unwrap();
    let attachment = store.document_file(second).unwrap();
    assert!(store.delete_candidate(first_candidate).unwrap() && attachment.is_file());
    assert!(store.delete_candidate(second_candidate).unwrap() && !attachment.is_file());
}

#[test]
fn manual_import_does_not_read_candidates_and_bad_job_changes_nothing() {
    let (_folder, mut store) = fresh();
    let content = "姓名：戴示例\n姓名：另示例\nexample@example.invalid";
    let bytes = b"%PDF-1.7 manual fixture %%EOF";
    assert!(store.import(combined_import_meta(content, serde_json::json!({
        "jobId": i64::MAX, "autoParse": false, "candidates": [{"name": "我填写的姓名"}]
    })), bytes).is_err());
    assert_eq!(store.dashboard().unwrap().candidates, 0);
    let (resume, candidate) = ids(store
        .import(
            combined_import_meta(
                content,
                serde_json::json!({
                    "autoParse": false, "candidates": [{"name": "我填写的姓名"}]
                }),
            ),
            bytes,
        )
        .unwrap());
    assert_eq!(
        store.candidate(candidate).unwrap().candidate.name,
        "我填写的姓名"
    );
    assert_eq!(store.document_text(ResumeRef::Resume(resume)).unwrap(), "");
    assert_eq!(store.dashboard().unwrap().candidates, 1);
    assert!(
        store
            .document_file(ResumeRef::Resume(resume))
            .unwrap()
            .is_file()
    );
}

#[test]
fn upgrade_v3_retains_resume_ids_and_profile_evidence() {
    let mut db = rusqlite::Connection::open_in_memory().unwrap();
    db.pragma_update(None, "foreign_keys", true).unwrap();
    for (offset, sql) in MIGRATIONS[..3].iter().enumerate() {
        crate::store::apply_migration(&mut db, offset + 1, sql).unwrap();
    }
    db.execute_batch(
        "INSERT INTO candidates(id,name,created_at,updated_at) VALUES(1,'fixture',1,1);
         INSERT INTO files(hash,format,byte_size) VALUES(printf('%064d',1),'pdf',1);
         INSERT INTO resumes(id,candidate_id,file_hash,original_name,imported_at,extracted_text,parse_status)
           VALUES(5,1,printf('%064d',1),'fixture.pdf',1,'SQL','complete');
         UPDATE sqlite_sequence SET seq=22 WHERE name='resumes';
         INSERT INTO jobs(id,title,status,created_at,updated_at) VALUES(1,'fixture','open',1,1);
         INSERT INTO job_profiles(id,job_id,version,origin,status,summary,insights,created_at)
           VALUES(1,1,1,'local','confirmed','','{}',1);
         INSERT INTO job_profile_sources(id,profile_id,ordinal,kind,resume_id,label,usable)
           VALUES(1,1,1,'resume',5,'fixture.pdf',1);
         INSERT INTO job_profile_skills(id,profile_id,name,category,classification,suggestion,explanation)
           VALUES(1,1,'SQL','skill','reference','reference','');
         INSERT INTO job_profile_evidence(skill_id,source_id,quote) VALUES(1,1,'SQL');",
    ).unwrap();
    crate::store::migrate(&mut db).unwrap();
    assert_eq!(db.query_row(
        "SELECT e.quote FROM job_profile_evidence e JOIN job_profile_sources s ON s.id=e.source_id
         JOIN resumes r ON r.id=s.resume_id WHERE r.id=5 AND r.section=0",
        [], |r| r.get::<_, String>(0),
    ).unwrap(), "SQL");
    assert_eq!(
        db.query_row(
            "SELECT seq FROM sqlite_sequence WHERE name='resumes'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        22
    );
    assert!(
        db.pragma_query_value(None, "foreign_keys", |r| r.get::<_, bool>(0))
            .unwrap()
    );
    db.execute("DELETE FROM resumes WHERE id=5", []).unwrap();
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM job_profiles", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn encrypted_backup_restores_database_and_files_and_refuses_bad_password() {
    let (folder, mut store) = fresh();
    let (_, id) = ids(pdf(
        &mut store,
        "示例.pdf",
        "姓名：虚构候选\nSQL",
        ImportTarget::New,
        55,
    ));
    let destination = folder.path().join("library.rdbackup");
    let password = "fictional backup password".to_owned();
    assert_eq!(
        store
            .backup(&destination, password.clone())
            .unwrap()
            .attachments,
        1
    );
    assert!(
        fs::read(&destination)
            .unwrap()
            .starts_with(b"age-encryption.org/v1")
    );
    store.delete_candidate(id).unwrap();
    assert_eq!(
        fs::read_dir(store.data_dir().join(ATTACHMENTS_DIR))
            .unwrap()
            .count(),
        0
    );
    assert!(
        store
            .restore(&destination, "wrong backup password".into())
            .is_err()
    );
    assert_eq!(store.dashboard().unwrap().candidates, 0);
    store.restore(&destination, password.clone()).unwrap();
    let entry = store.candidate(id).unwrap();
    let restored = store
        .document_file(ResumeRef::Resume(entry.resumes[0].id))
        .unwrap();
    assert!(fs::read(restored).unwrap().starts_with(b"%PDF-"));
    let mut bytes = fs::read(&destination).unwrap();
    bytes.pop();
    fs::write(&destination, bytes).unwrap();
    assert!(store.restore(&destination, password).is_err());
    assert_eq!(store.dashboard().unwrap().candidates, 1);
}

#[cfg(windows)]
#[test]
fn windows_key_is_encrypted_and_scoped_to_endpoint() {
    let (_folder, store) = fresh();
    let mut public = AISettings {
        base_url: "http://127.0.0.1:9901/v1".into(),
        model: "test-model".into(),
        timeout_seconds: 5,
    };
    let saved = ai::save_settings(
        &store,
        SettingsInput {
            settings: public.clone(),
            api_key: Some("fictional-only-key".into()),
            remove_key: false,
        },
    )
    .unwrap();
    assert!(saved.has_key && !saved.verified);
    assert!(ai::connection_settings(&store, true).is_err());
    let protected = fs::read(store.root.join("ai-key.dpapi")).unwrap();
    assert!(
        !protected
            .windows("fictional-only-key".len())
            .any(|bytes| bytes == b"fictional-only-key")
    );
    assert!(
        !fs::read(store.data_dir().join(crate::store::DB_NAME))
            .unwrap()
            .windows("fictional-only-key".len())
            .any(|bytes| bytes == b"fictional-only-key")
    );
    ai::mark_verified(&store, &ai::connection_settings(&store, false).unwrap()).unwrap();
    assert!(ai::settings_view(&store).unwrap().verified);
    public.base_url = "https://other.example.invalid/v1".into();
    ai::save_settings(
        &store,
        SettingsInput {
            settings: public,
            api_key: None,
            remove_key: false,
        },
    )
    .unwrap();
    assert!(!ai::settings_view(&store).unwrap().has_key);
}
