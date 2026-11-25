use std::{fs, sync::Mutex};

use rusqlite::Connection;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::*;
use crate::{
    dashboard::{self, Surface},
    documents::{ImportMeta, ImportResult, ImportTarget},
    interview::{GuideInput, Question},
    model::{JobInput, JobStatus, ParseStatus},
    store::{ATTACHMENTS_DIR, DB_NAME, MIGRATIONS, STORE_DIR, apply_migration},
};

fn config() -> Config {
    serde_json::from_value(json!({"total":2,"allocations":[{"category":"technical","count":1},{"category":"experience","count":1}],
        "difficulty":"mixed","language":"zh","minutes":30,"focus":"询问指标定义","followUp":true,"evaluationPoints":true,"referenceAnswer":false})).unwrap()
}

fn import(store: &mut Store, target: ImportTarget, marker: &str, text: &str) -> (i64, i64) {
    let result = store
        .import(
            ImportMeta {
                name: format!("{marker}.pdf"),
                target,
                text: text.into(),
                status: ParseStatus::Complete,
                candidate_options: None,
            },
            format!("%PDF-1.6\n% {marker}\n%%EOF").as_bytes(),
        )
        .unwrap();
    let ImportResult::Imported {
        document_id,
        owner_id,
        ..
    } = result
    else {
        panic!("fixture must be imported");
    };
    (document_id, owner_id)
}

fn scenario(store: &mut Store) -> Selection {
    let (resume, person) = import(
        store,
        ImportTarget::New,
        "candidate-old",
        "姓名：林演示\n邮箱：lin@example.invalid\n电话：13800000000\n职务：分析师\n使用 SQL 进行留存指标分析",
    );
    import(
        store,
        ImportTarget::Candidate(person),
        "candidate-new",
        "另一版简历描述 Tableau 项目",
    );
    import(
        store,
        ImportTarget::New,
        "other-candidate",
        "姓名：其他人\n无关简历内容",
    );
    let job = store
        .save_job(JobInput {
            id: None,
            title: "数据分析师".into(),
            department: "示例".into(),
            jd: "构建 Power BI 业务看板".into(),
            status: JobStatus::Open,
        })
        .unwrap();
    let application = store.link_application(person, job).unwrap();
    Selection {
        candidate_id: Some(person),
        job_id: Some(job),
        application_id: Some(application),
        resume_id: Some(resume),
        ..Default::default()
    }
}

fn question(category: &str, difficulty: &str, text: &str, kind: &str, evidence: &str) -> Value {
    json!({"category":category,"difficulty":difficulty,"question":text,"competency":"岗位相关能力","source":{"kind":kind,"evidence":evidence},"followUp":"可以举一个例子吗？","evaluationPoints":"思路清楚","referenceAnswer":"参考"})
}

#[test]
fn v10_upgrade_preserves_existing_records_and_appends_visible_interview_card() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join(STORE_DIR);
    fs::create_dir_all(workspace.join(ATTACHMENTS_DIR)).unwrap();
    let mut db = Connection::open(workspace.join(DB_NAME)).unwrap();
    for (index, sql) in MIGRATIONS.iter().take(10).enumerate() {
        apply_migration(&mut db, index + 1, sql).unwrap();
    }
    db.execute_batch("INSERT INTO tool_hub_layout(id,version,widgets) VALUES(1,1,'[{\"id\":\"knowledge\",\"width\":4,\"height\":2,\"visible\":true},{\"id\":\"todos\",\"width\":2,\"height\":3,\"visible\":false}]');
        INSERT INTO candidates(id,name,created_at,updated_at) VALUES(30,'旧候选人',1,1);
        INSERT INTO jobs(id,title,jd,status,created_at,updated_at) VALUES(70,'旧岗位','旧 JD','open',1,1);
        INSERT INTO applications(candidate_id,job_id,stage,created_at,updated_at) VALUES(30,70,'new',1,1);").unwrap();
    drop(db);
    let store = Store::open(root.path()).unwrap();
    let version: usize = store
        .db
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, 11);
    assert_eq!(store.candidate(30).unwrap().applications[0].job_id, 70);
    assert_eq!(store.job(70).unwrap().jd, "旧 JD");
    let layout = serde_json::to_value(dashboard::layout(&store, Surface::Tools).unwrap()).unwrap();
    assert_eq!(layout["widgets"][0]["width"], 4);
    assert_eq!(layout["widgets"][1]["visible"], false);
    assert_eq!(layout["widgets"][2]["id"], "interview");
    assert_eq!(layout["widgets"][2]["visible"], true);
    assert_eq!(
        store
            .db
            .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
}

#[test]
fn guide_relationships_sorting_notes_and_revisions_survive_reopen_without_ai() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path()).unwrap();
    let selection = scenario(&mut store);
    let first: Question = serde_json::from_value(question(
        "technical",
        "basic",
        "如何使用 SQL 复核？",
        "general",
        "",
    ))
    .unwrap();
    let second: Question = serde_json::from_value(question(
        "experience",
        "medium",
        "如何定义留存？",
        "general",
        "",
    ))
    .unwrap();
    let input = GuideInput {
        title: "结构化面试".into(),
        selection: selection.clone(),
        config: config(),
        questions: vec![first, second],
        interview_date: "2028-02-29".into(),
    };
    let mut invalid = input.clone();
    invalid.selection.candidate_id = Some(selection.candidate_id.unwrap() + 1);
    assert!(interview::save(&mut store, None, None, invalid).is_err());
    let guide = interview::save(&mut store, None, None, input.clone()).unwrap();
    let mut edit = guide.input;
    edit.questions.reverse();
    edit.questions[0].answer_summary = "示例回答摘要".into();
    edit.questions[0].verification = "核实指标口径".into();
    let saved = interview::save(&mut store, Some(guide.id), Some(guide.revision), edit).unwrap();
    assert!(interview::save(&mut store, Some(guide.id), Some(guide.revision), input).is_err());
    drop(store);
    let mut store = Store::open(root.path()).unwrap();
    let reopened = interview::get(&store, saved.id).unwrap();
    assert_eq!(
        reopened.input.selection.application_id,
        selection.application_id
    );
    assert_eq!(reopened.input.selection.resume_id, selection.resume_id);
    assert_eq!(reopened.input.questions[0].question, "如何定义留存？");
    assert_eq!(reopened.input.questions[0].answer_summary, "示例回答摘要");
    assert_eq!(reopened.input.questions[0].verification, "核实指标口径");
    assert_eq!(
        interview::list(
            &store,
            selection.candidate_id,
            selection.job_id,
            "林演示",
            0,
            18
        )
        .unwrap()
        .len(),
        1
    );
    interview::dispatch(
        &mut store,
        interview::Command::Delete {
            id: saved.id,
            revision: saved.revision,
        },
    )
    .unwrap();
    assert!(interview::get(&store, saved.id).is_err());
    assert_eq!(
        store
            .candidate(selection.candidate_id.unwrap())
            .unwrap()
            .resumes
            .len(),
        2
    );
}

#[test]
fn validates_allocation_and_rejects_fabricated_evidence_and_non_json() {
    let context = Context {
        role: "数据分析师".into(),
        resume: "使用 SQL 进行留存指标分析".into(),
        jd: "构建 Power BI 业务看板".into(),
        focus: String::new(),
        truncated: false,
    };
    let mut config = config();
    config.allocations[0].count = 3;
    assert!(config.validate().is_err());
    config.allocations[0].count = 1;
    let expected = slots(&config);
    let valid = question(
        "technical",
        "basic",
        "你如何使用 SQL 定义留存指标？",
        "resume",
        "SQL 进行留存指标分析",
    );
    let (partial, adjusted) = parse(
        &json!({"questions":[valid.clone()]}).to_string(),
        &context,
        &config,
        &expected,
        &mut HashSet::new(),
    )
    .unwrap();
    assert_eq!(partial.len(), 1);
    assert!(adjusted);
    assert!(partial[0].reference_answer.is_empty());
    assert!(
        parse(
            "服务器不可用",
            &context,
            &config,
            &expected,
            &mut HashSet::new()
        )
        .is_err()
    );
    let mut claimed = valid.clone();
    claimed["source"]["evidence"] = json!("从未出现的云项目");
    assert!(
        parse(
            &json!({"questions":[claimed]}).to_string(),
            &context,
            &config,
            &expected,
            &mut HashSet::new()
        )
        .is_err()
    );
    let (deduplicated, adjusted) = parse(
        &json!({"questions":[valid.clone(),valid]}).to_string(),
        &context,
        &config,
        &expected,
        &mut HashSet::new(),
    )
    .unwrap();
    assert_eq!(deduplicated.len(), 1);
    assert!(adjusted);
}

#[cfg(windows)]
#[tokio::test]
async fn model_request_reuses_verified_provider_and_remembers_only_exact_redacted_scope() {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path()).unwrap();
    let selection = scenario(&mut store);
    ai::save_settings(
        &store,
        ai::SettingsInput {
            settings: AISettings {
                base_url: format!("http://{}/v1", listener.local_addr().unwrap()),
                model: "fixture-model".into(),
                timeout_seconds: 5,
            },
            api_key: Some("fixture-key".into()),
            remove_key: false,
        },
    )
    .unwrap();
    ai::mark_verified(&store, &ai::connection_settings(&store, false).unwrap()).unwrap();
    desktop::allow_remembered_consents(&store.db).unwrap();
    let engine = Engine {
        store: Mutex::new(store),
        ai: Mutex::new(ai::AiState::default()),
        desktop: Default::default(),
    };
    let preview = |options: Config| {
        prepare(
            &engine,
            &engine.local().unwrap(),
            selection.clone(),
            options,
        )
        .unwrap()
    };
    let denied = preview(config());
    assert!(denied.confirmation_required);
    assert!(
        execute(
            &engine,
            Send {
                id: denied.id,
                confirmed: false,
                remember: false
            }
        )
        .await
        .is_err()
    );

    let outbound = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut received = Vec::new();
        let mut block = [0; 1024];
        let request = loop {
            let bytes = socket.read(&mut block).await.unwrap();
            assert!(bytes > 0);
            received.extend_from_slice(&block[..bytes]);
            if let Some(end) = received.windows(4).position(|part| part == b"\r\n\r\n") {
                let header = String::from_utf8_lossy(&received[..end]);
                let size: usize = header
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length: "))
                    .unwrap()
                    .parse()
                    .unwrap();
                if received.len() >= end + 4 + size {
                    assert!(header.starts_with("POST /v1/chat/completions "));
                    break serde_json::from_slice::<Value>(&received[end + 4..end + 4 + size])
                        .unwrap();
                }
            }
        };
        assert_eq!(request["model"], "fixture-model");
        assert_eq!(request["response_format"]["type"], "json_object");
        let raw = request["messages"][1]["content"].as_str().unwrap();
        let input: Value = serde_json::from_str(raw).unwrap();
        assert_eq!(input["count"], 2);
        assert_eq!(input["language"], "zh");
        assert!(raw.contains("SQL") && raw.contains("Power BI"));
        for private in [
            "林演示",
            "@example.invalid",
            "13800000000",
            "Tableau",
            "无关简历",
            "candidate-old.pdf",
        ] {
            assert!(!raw.contains(private), "unapproved source {private}");
        }
        let result = json!({"questions":[
            question("technical", "basic", "如何用 SQL 计算留存？", "resume", "SQL 进行留存指标分析"),
            question("experience", "medium", "你是否搭建过 Power BI 看板？", "jd", "构建 Power BI 业务看板"),
        ]});
        let body =
            json!({"choices":[{"finish_reason":"stop","message":{"content":result.to_string()}}]})
                .to_string();
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
    });
    let approved = preview(config());
    assert!(!approved.high_risk);
    let output = execute(
        &engine,
        Send {
            id: approved.id,
            confirmed: true,
            remember: true,
        },
    )
    .await
    .unwrap();
    outbound.await.unwrap();
    assert_eq!(output.questions.len(), 2);
    assert!(!output.adjusted);
    assert!(
        interview::list(&engine.local().unwrap(), None, None, "", 0, 30)
            .unwrap()
            .is_empty()
    );
    assert!(!preview(config()).confirmation_required);
    let mut new_focus = config();
    new_focus.focus = "考察数据库设计".to_owned();
    assert!(preview(new_focus).confirmation_required);
}
