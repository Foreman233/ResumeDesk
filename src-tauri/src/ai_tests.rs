use super::*;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

fn config(url: &str, model: &str, timeout_seconds: u64) -> ConnectionSettings {
    let public = AISettings {
        base_url: url.into(),
        model: model.into(),
        timeout_seconds,
    };
    let endpoint = public.endpoint().unwrap();
    let credential = Credential {
        endpoint: endpoint.to_string(),
        model: model.into(),
        key: "fixture-only".into(),
        verified: true,
    };
    ConnectionSettings {
        public,
        endpoint,
        credential,
    }
}

#[test]
fn deepseek_options_are_scoped_to_supported_official_endpoint() {
    let official = config("https://api.deepseek.com/v1", "deepseek-flash", 120);
    let assistant = chat_options(&official, ChatPurpose::Assistant);
    assert_eq!(
        assistant,
        serde_json::json!({
            "stream": false, "thinking": {"type":"disabled"},
            "max_tokens":3000
        })
    );
    assert_eq!(
        chat_options(&official, ChatPurpose::Test),
        serde_json::json!({"stream":false,"thinking":{"type":"disabled"},"max_tokens":32})
    );
    for (url, model) in [
        (
            "https://api.deepseek.com.example.invalid/v1",
            "deepseek-flash",
        ),
        ("https://api.deepseek.com/custom", "deepseek-flash"),
        ("https://api.deepseek.com", "unknown-model"),
    ] {
        assert_eq!(
            chat_options(&config(url, model, 120), ChatPurpose::Assistant),
            serde_json::json!({"stream":false})
        );
    }
}

#[test]
fn upgrade_increases_existing_deepseek_timeout_once_without_changing_model() {
    let db = rusqlite::Connection::open_in_memory().unwrap();
    db.execute_batch(crate::store::MIGRATIONS[0]).unwrap();
    let save = |base: &str, timeout_seconds| {
        let a = AISettings {
            base_url: base.into(),
            model: "deepseek-flash".into(),
            timeout_seconds,
        };
        db.execute(
            "INSERT OR REPLACE INTO app_settings VALUES('ai',?1)",
            [serde_json::to_string(&a).unwrap()],
        )
        .unwrap();
    };
    let upgrade = || {
        db.execute_batch(include_str!("../migrations/005_ai_timeout.sql"))
            .unwrap();
        let json: String = db
            .query_row("SELECT value FROM app_settings WHERE key='ai'", [], |r| {
                r.get(0)
            })
            .unwrap();
        serde_json::from_str::<AISettings>(&json).unwrap()
    };
    let origin = "https://api.deepseek.com/v1/";
    save(origin, 20);
    let result = upgrade();
    assert_eq!(result.timeout_seconds, 120);
    assert_eq!(result.base_url, origin);
    assert_eq!(result.model, "deepseek-flash");
    save(origin, 240);
    assert_eq!(upgrade().timeout_seconds, 240);
    save("https://alt.example.invalid/v1", 20);
    assert_eq!(upgrade().timeout_seconds, 20);
}

async fn quiet_service(headers: bool) -> String {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0; 8192];
        assert!(socket.read(&mut request).await.unwrap() > 0);
        if headers {
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n\n").await.unwrap();
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    });
    let error = ChatCompletions
        .test_connection(&config(&url, "mock", 1))
        .await
        .unwrap_err();
    server.abort();
    error.to_string()
}

#[tokio::test]
async fn waiting_for_headers_and_reading_the_response_have_distinct_timeout_messages() {
    let (header, body) = tokio::join!(quiet_service(false), quiet_service(true));
    assert!(header.contains("等待 AI 服务响应超时（1 秒）"), "{header}");
    assert!(body.contains("读取 AI 响应超时（1 秒）"), "{body}");
}
