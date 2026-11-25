use std::{fs, path::Path};

use rusqlite::{Connection, params};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

use crate::{
    consent::{Capability, ConsentManager, Grant, fingerprint},
    dashboard, knowledge,
    model::{CandidateFilter, Stage},
    store::{DB_NAME, MIGRATIONS, STORE_DIR, Store, apply_migration},
    web_search::{self, BraveSearch, WebSearchProvider},
};

fn add(store: &mut Store, meta: Value, bytes: &[u8]) -> i64 {
    let upload = knowledge::upload(store, serde_json::from_value(meta).unwrap(), bytes).unwrap();
    serde_json::to_value(upload).unwrap()["id"]
        .as_i64()
        .unwrap()
}

fn command(store: &mut Store, operation: Value) -> Value {
    knowledge::dispatch(store, serde_json::from_value(operation).unwrap()).unwrap()
}

fn edit(store: &mut Store, id: i64, allowed: bool, category: Option<i64>) {
    let name = knowledge::get(store, id).unwrap().name;
    command(
        store,
        json!({"action":"save", "edit": {
            "id":id, "name":name, "aiAllowed":allowed,"categoryId":category,
            "tags":["核对","政策"],"region":"北京市","issuer":"验收机构",
            "publishedOn":"2024-02-29","effectiveOn":"2024-03-01","expiresOn":"2024-12-31",
            "sourceUrl":"https://example.invalid/policy",
        }}),
    );
}

#[test]
fn knowledge_permissions_ranking_precise_pages_and_replacement_are_consistent() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path()).unwrap();
    let category = command(
        &mut store,
        json!({"action":"save_category","name":"历史政策"}),
    )
    .as_i64()
    .unwrap();
    let pdf = add(
        &mut store,
        json!({"name":"合成政策.pdf","categoryId":category,"parseStatus":"complete","pdfPages":[
            {"page":1,"text":"假设地区的技术培训记录。"},{"page":3,"text":"北京市特殊社保缴费基数：例示条目。"}
        ]}),
        b"%PDF-1.7\nfixture",
    );
    let draft = add(
        &mut store,
        json!({"name":"未授权的政策.txt"}),
        "北京市特殊社保缴费基数：不公开内容。".as_bytes(),
    );
    assert_eq!(knowledge::scope(&store, &[]).unwrap().len(), 0);
    assert!(knowledge::scope(&store, &[draft]).is_err());
    edit(&mut store, pdf, true, Some(category));
    let scope = knowledge::scope(&store, &[]).unwrap();
    let hit = knowledge::retrieve(&store, &scope, "请根据资料库说明北京市社保缴费基数").unwrap();
    assert_eq!(hit.len(), 1);
    assert_eq!(hit[0].document.id, pdf);
    assert_eq!(hit[0].chunk.page, Some(3));
    assert_eq!(hit[0].document.validity.expires_on, "2024-12-31");
    assert_eq!(
        knowledge::retrieve(&store, &scope, "请总结这份资料")
            .unwrap()
            .len(),
        2
    );
    assert!(
        knowledge::retrieve(&store, &scope, "新加坡冷链包装认证")
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        command(
            &mut store,
            json!({"action":"list","filter":{"query":"特殊社保缴费","tag":"核对"}})
        )["total"],
        1
    );
    let old = knowledge::original(&store, pdf).unwrap();
    let replaced = add(
        &mut store,
        json!({"name":"最新版.md","replaceId":pdf}),
        "完全不同的合同条款。".as_bytes(),
    );
    assert_eq!(replaced, pdf);
    assert!(!old.exists());
    assert!(knowledge::verify_scope(&store, &scope).is_err());
    assert!(!knowledge::get(&store, pdf).unwrap().ai_allowed);
    assert_eq!(
        command(
            &mut store,
            json!({"action":"list","filter":{"query":"特殊社保缴费","categoryId":category}})
        )["total"],
        0
    );
    assert_eq!(
        command(
            &mut store,
            json!({"action":"list","filter":{"query":"合同条款"}})
        )["total"],
        1
    );
    command(
        &mut store,
        json!({"action":"delete_category","id":category}),
    );
    assert!(knowledge::get(&store, pdf).unwrap().category_id.is_none());
    command(&mut store, json!({"action":"delete","id":pdf}));
    assert_eq!(
        command(
            &mut store,
            json!({"action":"list","filter":{"query":"合同条款"}})
        )["total"],
        0
    );
}

#[test]
fn knowledge_originals_and_index_survive_restart_and_encrypted_backup() {
    let parent = tempfile::tempdir().unwrap();
    let root = parent.path().join("store");
    let archive = parent.path().join("knowledge.rdbackup");
    let content = "项目,金额\n供餐补贴,30\n";
    let mut store = Store::open(&root).unwrap();
    let csv = add(&mut store, json!({"name":"津贴.csv"}), content.as_bytes());
    let scan = add(
        &mut store,
        json!({"name":"扫描件.pdf","parseStatus":"empty"}),
        b"%PDF-1.4\nfixture",
    );
    assert!(!knowledge::get(&store, scan).unwrap().ai_allowed);
    assert_eq!(
        command(&mut store, json!({"action":"detail","id":scan}))["chunks"],
        json!([])
    );
    store.backup(&archive, "fixture-password".into()).unwrap();
    command(&mut store, json!({"action":"delete","id":csv}));
    store.restore(&archive, "fixture-password".into()).unwrap();
    drop(store);
    let mut store = Store::open(&root).unwrap();
    assert_eq!(
        fs::read(knowledge::original(&store, csv).unwrap()).unwrap(),
        content.as_bytes()
    );
    assert_eq!(
        command(
            &mut store,
            json!({"action":"list","filter":{"query":"供餐补贴"}})
        )["total"],
        1
    );
}

fn prior_workspace(root: &Path) {
    let workspace = root.join(STORE_DIR);
    fs::create_dir(&workspace).unwrap();
    let mut db = Connection::open(workspace.join(DB_NAME)).unwrap();
    for (index, migration) in MIGRATIONS.iter().take(8).enumerate() {
        apply_migration(&mut db, index + 1, migration).unwrap();
    }
    db.execute_batch(
        "INSERT INTO candidates(id,name,created_at,updated_at) VALUES(4,'旧候选人',1,1);
         INSERT INTO jobs(id,title,status,created_at,updated_at) VALUES(8,'旧岗位','open',1,1);
         INSERT INTO applications(id,candidate_id,job_id,stage,note,created_at,updated_at) VALUES(3,4,8,'interview','旧备注',1,1);
         INSERT INTO todos(id,title,priority,category,status,created_at,updated_at,interview_at,reminder_minutes,remind_at)
            VALUES(2,'旧提醒','normal','interview','pending',1,1,3000,1,2940);
         INSERT INTO chat_conversations(id,title,mode,created_at,updated_at) VALUES(7,'旧会话','workspace',1,1);
         INSERT INTO chat_messages(id,conversation_id,role,body,scope_key,created_at) VALUES(9,7,'assistant','原来的回答','prior',1);
         INSERT INTO chat_message_sources(message_id,ordinal,label,candidate_id) VALUES(9,1,'旧候选人',4);
         INSERT INTO widget_settings(key,value) VALUES('controls','{\"todoVisible\":true,\"confirmAiSend\":false}');",
    ).unwrap();
}

#[test]
fn migrating_v8_preserves_recruiting_reminder_history_and_preferences() {
    let root = tempfile::tempdir().unwrap();
    prior_workspace(root.path());
    let store = Store::open(root.path()).unwrap();
    assert_eq!(
        store
            .db
            .pragma_query_value(None, "user_version", |r| r.get::<_, usize>(0))
            .unwrap(),
        MIGRATIONS.len()
    );
    assert_eq!(store.candidate(4).unwrap().applications[0].note, "旧备注");
    assert_eq!(
        store
            .db
            .query_row("SELECT remind_at FROM todos WHERE id=2", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        2940
    );
    assert_eq!(store.db.query_row(
        "SELECT m.body||s.label||s.evidence FROM chat_messages m JOIN chat_message_sources s ON s.message_id=m.id WHERE m.id=9",[],|r|r.get::<_,String>(0),
    ).unwrap(),"原来的回答旧候选人");
    assert!(!store.quick_controls().unwrap().confirm_ai_send);
    assert!(
        ConsentManager::new(&store.db)
            .needs_confirmation(&[Grant::new(
                Capability::General,
                "普通提问".into(),
                "https://api.example",
                "fresh"
            )])
            .unwrap()
    );
}

#[test]
fn quick_application_updates_only_selected_job_and_preserves_notes_and_single_reminder_rule() {
    let root = tempfile::tempdir().unwrap();
    prior_workspace(root.path());
    let mut store = Store::open(root.path()).unwrap();
    store.db.execute_batch(
        "INSERT INTO jobs(id,title,status,created_at,updated_at) VALUES(9,'另一岗位','open',1,1);
         INSERT INTO applications(id,candidate_id,job_id,stage,note,created_at,updated_at) VALUES(5,4,9,'new','另一备注',1,1);
         UPDATE todo_rules SET enabled=1 WHERE stage='screened';",
    ).unwrap();
    store.set_application_stage(3, Stage::Screened).unwrap();
    store.set_application_stage(3, Stage::Screened).unwrap();
    assert!(store.set_application_stage(999, Stage::Screened).is_err());
    let filtered = store
        .candidate_page(&CandidateFilter {
            job_id: Some(8),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(filtered.items[0].applications.len(), 1);
    assert_eq!(filtered.items[0].applications[0].stage, Stage::Screened);
    let detail = store.candidate(4).unwrap();
    assert!(
        detail
            .applications
            .iter()
            .any(|app| app.id == 3 && app.note == "旧备注")
    );
    assert!(
        detail
            .applications
            .iter()
            .any(|app| app.id == 5 && app.stage == Stage::New && app.note == "另一备注")
    );
    assert_eq!(
        store
            .db
            .query_row(
                "SELECT count(*) FROM todos WHERE application_id=3",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    store.record_candidate_view(4).unwrap();
    let summary = store.dashboard().unwrap();
    assert_eq!(summary.viewed[0].id, 4);
    assert!(
        summary
            .progress
            .iter()
            .any(|group| group.stage == Stage::Screened && group.count == 1)
    );
}

#[test]
fn consent_is_scoped_by_recipient_and_capability_and_layout_ignores_obsolete_modules() {
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path()).unwrap();
    let create = |capability, scope: &[i64], provider| {
        Grant::new(
            capability,
            "配置范围".into(),
            provider,
            &fingerprint(&scope).unwrap(),
        )
    };
    let provider = "https://api.example/chat/completions";
    let first = create(Capability::Knowledge, &[1], provider);
    let second = create(Capability::Knowledge, &[1, 2], provider);
    let separate = create(Capability::Recruiting, &[1], provider);
    let changed = create(
        Capability::Knowledge,
        &[1],
        "https://other.example/chat/completions",
    );
    let manager = ConsentManager::new(&store.db);
    assert!(
        manager
            .needs_confirmation(std::slice::from_ref(&first))
            .unwrap()
    );
    manager.remember(std::slice::from_ref(&first)).unwrap();
    for other in [second, separate, changed] {
        assert!(manager.needs_confirmation(&[other]).unwrap());
    }
    let selected =
        json!({"version":1,"widgets":[{"id":"overview","width":2,"height":3,"visible":false}]});
    dashboard::save(
        &store,
        dashboard::Surface::Dashboard,
        serde_json::from_value(selected.clone()).unwrap(),
    )
    .unwrap();
    drop(store);
    let store = Store::open(root.path()).unwrap();
    let manager = ConsentManager::new(&store.db);
    assert!(
        !manager
            .needs_confirmation(std::slice::from_ref(&first))
            .unwrap()
    );
    manager.reset(Some(Capability::Knowledge)).unwrap();
    assert!(manager.needs_confirmation(&[first]).unwrap());
    assert_eq!(
        serde_json::to_value(
            dashboard::layout(&store, dashboard::Surface::Dashboard)
                .unwrap()
                .unwrap()
        )
        .unwrap(),
        selected
    );
    store.db.execute("UPDATE dashboard_layout SET widgets=?1 WHERE id=1",
        params![json!([selected["widgets"][0],{"id":"removed","width":2,"height":3,"visible":true},{"bad":0}]).to_string()],
    ).unwrap();
    assert_eq!(
        serde_json::to_value(
            dashboard::layout(&store, dashboard::Surface::Dashboard)
                .unwrap()
                .unwrap()
        )
        .unwrap(),
        selected
    );
}

#[tokio::test]
async fn brave_compatible_http_request_sends_only_public_query_and_keeps_safe_sources() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path()).unwrap();
    store.db.execute(
        "INSERT INTO candidates(name,email,phone,created_at,updated_at) VALUES('测试人','private@example.invalid','13812345678',1,1)",[],
    ).unwrap();
    for query in [
        "测试 人 的政策",
        "T private@example.invalid",
        "１３８１２３４５６７８ 社保",
    ] {
        assert!(web_search::public_query(&store, query).is_err(), "{query}");
    }
    let query = web_search::public_query(&store, "北京市 公开社保缴费政策").unwrap();
    assert!(web_search::connection(&store).is_err());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!(
        "http://{}/res/v1/web/search",
        listener.local_addr().unwrap()
    );
    let input = serde_json::from_value(
        json!({"endpoint":endpoint,"timeoutSeconds":5,"apiKey":"fixture-search-key"}),
    )
    .unwrap();
    web_search::save_settings(&mut store, input).unwrap();
    assert!(
        !fs::read(store.root.join("web-search-key.dpapi"))
            .unwrap()
            .windows(18)
            .any(|window| window == b"fixture-search-key")
    );
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            request.push(stream.read_u8().await.unwrap());
        }
        let headers = String::from_utf8(request).unwrap();
        assert!(
            headers
                .to_ascii_lowercase()
                .contains("x-subscription-token: fixture-search-key")
        );
        assert!(!headers.contains("private") && !headers.contains("candidate_ids"));
        let uri = headers
            .lines()
            .next()
            .unwrap()
            .split_ascii_whitespace()
            .nth(1)
            .unwrap();
        let url = url::Url::parse(&format!("http://localhost{uri}")).unwrap();
        let sent = url.query_pairs().find(|(key, _)| key == "q").unwrap().1;
        assert_eq!(sent, "北京市 公开社保缴费政策");
        let reply = json!({"type":"search","web":{"results":[
            {"title":"普通网页","url":"https://example.invalid/a","description":"普通的摘要。"},
            {"title":"<em>政府来源</em>","url":"https://www.beijing.gov.cn/example#anchor","description":"<strong>整理</strong> &amp; 发布","extra_snippets":["第二个片段"]},
            {"title":"无效来源","url":"javascript:alert(0)","description":"应被舍弃"},
        ]}}).to_string();
        stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",reply.len(),reply).as_bytes()).await.unwrap();
    });
    let hits = BraveSearch
        .search(&web_search::connection(&store).unwrap(), &query)
        .await
        .unwrap();
    server.await.unwrap();
    assert_eq!(hits.len(), 2);
    assert!(hits[0].official);
    assert_eq!(hits[0].title, "政府来源");
    assert_eq!(hits[0].url, "https://www.beijing.gov.cn/example");
    assert_eq!(hits[0].text, "整理 & 发布 第二个片段");
    assert!(hits[0].retrieved_at > 0);
}
