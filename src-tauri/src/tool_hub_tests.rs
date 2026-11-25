use std::fs;

use rusqlite::{Connection, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{
    dashboard::{self, Surface},
    knowledge,
    model::now,
    store::{ATTACHMENTS_DIR, DB_NAME, MIGRATIONS, STORE_DIR, Store, apply_migration},
    todo,
};

#[test]
fn upgrade_keeps_retired_profiles_and_attachments_while_layouts_are_independent() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join(STORE_DIR);
    fs::create_dir_all(workspace.join(ATTACHMENTS_DIR)).unwrap();
    let mut old = Connection::open(workspace.join(DB_NAME)).unwrap();
    for (index, sql) in MIGRATIONS.iter().take(9).enumerate() {
        apply_migration(&mut old, index + 1, sql).unwrap();
    }
    let sample = b"%PDF-1.4\narchived fixture";
    let hash = hex::encode(Sha256::digest(sample));
    let attachment = workspace.join(ATTACHMENTS_DIR).join(format!("{hash}.pdf"));
    fs::write(&attachment, sample).unwrap();
    old.execute(
        "INSERT INTO files(hash,format,byte_size) VALUES(?1,'pdf',?2)",
        params![hash, sample.len()],
    )
    .unwrap();
    old.execute_batch(
        "INSERT INTO jobs(id,title,status,created_at,updated_at,jd) VALUES(1,'旧招聘岗位','open',1,1,'仅用于测试的旧 JD');
         INSERT INTO candidates(id,name,created_at,updated_at) VALUES(1,'测试候选人',1,1);
         INSERT INTO applications(id,candidate_id,job_id,stage,created_at,updated_at) VALUES(1,1,1,'interview',1,1);
         INSERT INTO job_profiles(id,job_id,version,origin,status,summary,insights,created_at)
            VALUES(1,1,1,'local','confirmed','旧画像记录','{}',1);
         INSERT INTO job_profile_skills(id,profile_id,name,category,classification,suggestion,explanation)
            VALUES(1,1,'SQL','示例','reference','reference','历史记录');",
    ).unwrap();
    old.execute(
        "INSERT INTO job_samples(id,job_id,file_hash,original_name,imported_at,extracted_text,parse_status)
         VALUES(1,1,?1,'sample.pdf',1,'用于旧画像的 SQL 文本','complete')", [&hash],
    ).unwrap();
    old.execute_batch(
        "INSERT INTO job_profile_sources(id,profile_id,ordinal,kind,sample_id,label,usable)
            VALUES(1,1,1,'sample',1,'sample.pdf',1);
         INSERT INTO job_profile_evidence(skill_id,source_id,quote) VALUES(1,1,'SQL');
         INSERT INTO dashboard_layout(id,version,widgets) VALUES(1,1,'[
             {\"id\":\"jobs\",\"width\":2,\"height\":3,\"visible\":true},
             {\"id\":\"profiles\",\"width\":4,\"height\":2,\"visible\":true},
             {\"id\":\"overview\",\"width\":1,\"height\":1,\"visible\":false}
         ]');",
    )
    .unwrap();
    drop(old);

    let to_json = |store: &Store, surface| {
        serde_json::to_value(dashboard::layout(store, surface).unwrap()).unwrap()
    };
    let store = Store::open(root.path()).unwrap();
    let current = to_json(&store, Surface::Dashboard);
    assert_eq!(current["widgets"].as_array().unwrap().len(), 2);
    assert_eq!(current["widgets"][0]["id"], "jobs");
    assert_eq!(current["widgets"][1]["visible"], false);
    assert_eq!(to_json(&store, Surface::Tools), Value::Null);
    assert_eq!(store.candidate(1).unwrap().applications.len(), 1);
    assert_eq!(store.job(1).unwrap().jd, "仅用于测试的旧 JD");
    assert_eq!(
        store
            .db
            .query_row("SELECT quote FROM job_profile_evidence", [], |row| row
                .get::<_, String>(
                0
            ))
            .unwrap(),
        "SQL"
    );
    assert_eq!(fs::read(attachment).unwrap(), sample);

    let widgets = json!({"version":1,"widgets":[{"id":"knowledge","width":4,"height":3,"visible":true},
        {"id":"todos","width":2,"height":2,"visible":false}]});
    dashboard::save(
        &store,
        Surface::Tools,
        serde_json::from_value(widgets.clone()).unwrap(),
    )
    .unwrap();
    drop(store);
    let store = Store::open(root.path()).unwrap();
    assert_eq!(to_json(&store, Surface::Dashboard), current);
    assert_eq!(to_json(&store, Surface::Tools), widgets);
    assert!(
        dashboard::save(
            &store,
            Surface::Tools,
            serde_json::from_value(current).unwrap()
        )
        .is_err()
    );
}

#[test]
fn todo_summary_limits_related_results_to_pending_dated_tasks() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path()).unwrap();
    let stamp = now();
    for (label, due_at, status) in [
        ("overdue", Some(stamp - 120), "pending"),
        ("today", Some(stamp + 120), "pending"),
        ("upcoming", Some(stamp + 86000), "pending"),
        ("cancelled", Some(stamp + 200), "cancelled"),
        ("undated", None, "pending"),
    ] {
        store.db.execute(
            "INSERT INTO todos(title,category,priority,status,due_at,created_at,updated_at) VALUES(?1,'general','normal',?2,?3,1,1)",
            params![label,status,due_at],
        ).unwrap();
    }
    let reply = todo::dispatch(
        &mut store,
        todo::Command::Summary {
            day_end: stamp + 3600,
        },
    )
    .unwrap();
    assert_eq!(reply.as_array().unwrap().len(), 3);
    assert_eq!(reply[0]["group"], "overdue");
    assert_eq!(reply[1]["group"], "today");
    assert_eq!(reply[2]["group"], "upcoming");
}

#[test]
fn knowledge_summary_tracks_views_separately_from_uploads() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path()).unwrap();
    let input = serde_json::from_value(json!({"name":"测试工具资料.txt"})).unwrap();
    let stored = serde_json::to_value(
        knowledge::upload(&mut store, input, "正文索引关键字".as_bytes()).unwrap(),
    )
    .unwrap();
    let id = stored["id"].as_i64().unwrap();
    let first = knowledge::dispatch(&mut store, knowledge::Command::Summary).unwrap();
    assert_eq!(first["uploaded"][0]["id"], id);
    assert_eq!(first["uploaded"][0]["canAsk"], false);
    assert_eq!(first["viewed"], json!([]));
    knowledge::dispatch(&mut store, knowledge::Command::Detail { id }).unwrap();
    drop(store);
    let mut store = Store::open(root.path()).unwrap();
    let viewed = knowledge::dispatch(&mut store, knowledge::Command::Summary).unwrap();
    assert_eq!(viewed["viewed"][0]["id"], id);
    assert!(viewed["viewed"][0]["viewedAt"].as_i64().is_some());
    knowledge::dispatch(&mut store, knowledge::Command::Delete { id }).unwrap();
    let deleted = knowledge::dispatch(&mut store, knowledge::Command::Summary).unwrap();
    assert_eq!(deleted["viewed"], json!([]));
    assert_eq!(deleted["uploaded"], json!([]));
}
