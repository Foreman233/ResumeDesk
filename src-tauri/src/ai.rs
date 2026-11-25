use std::{collections::HashMap, sync::LazyLock, time::Duration};

use regex::{Regex, RegexBuilder};
use reqwest::{StatusCode, header::HeaderValue};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use url::{Host, Url};
use zeroize::Zeroizing;

use crate::{
    credential::{self, Credential},
    model::*,
    store::Store,
};

#[cfg(test)]
#[path = "ai_tests.rs"]
mod tests;

const RESPONSE_LIMIT: usize = 384 * 1024;
const CONNECT_TIMEOUT_SECONDS: u64 = 15;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct AISettings {
    pub base_url: String,
    pub model: String,
    pub timeout_seconds: u64,
}

impl Default for AISettings {
    fn default() -> Self {
        Self {
            base_url: String::new(),
            model: String::new(),
            timeout_seconds: 120,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsInput {
    pub settings: AISettings,
    pub api_key: Option<String>,
    #[serde(default)]
    pub remove_key: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub settings: AISettings,
    pub has_key: bool,
    pub verified: bool,
    pub credential_error: bool,
}

impl AISettings {
    pub fn endpoint(&self) -> Result<Url> {
        let mut url =
            Url::parse(self.base_url.trim()).map_err(|_| message("请填写有效的 API Base URL。"))?;
        let local = match url.host() {
            Some(Host::Ipv4(ip)) => ip.is_loopback(),
            Some(Host::Ipv6(ip)) => ip.is_loopback(),
            Some(Host::Domain("localhost")) => true,
            _ => false,
        };
        if (url.scheme() != "https" && !(local && url.scheme() == "http"))
            || url.host().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(message(
                "API 地址必须使用 HTTPS，或使用本机 HTTP 地址。请移除地址中的凭据、查询参数和片段。",
            ));
        }
        let path = url.path().trim_end_matches('/');
        if !path.ends_with("/chat/completions") {
            let mut segments = url
                .path_segments_mut()
                .map_err(|_| message("API 路径无效。"))?;
            segments.pop_if_empty().extend(["chat", "completions"]);
        } else if url.path().ends_with('/') {
            url.path_segments_mut()
                .map_err(|_| message("API 路径无效。"))?
                .pop_if_empty();
        }
        Ok(url)
    }

    fn validate(&mut self) -> Result<()> {
        self.base_url = bounded(&self.base_url, 600, "API Base URL", false)?;
        self.model = bounded(&self.model, 180, "模型名称", false)?;
        if !self.base_url.is_empty() {
            self.endpoint()?;
        }
        if !(5..=600).contains(&self.timeout_seconds) {
            return Err(message("API 超时须在 5 至 600 秒之间。"));
        }
        Ok(())
    }
}

pub fn settings_view(store: &Store) -> Result<SettingsView> {
    let settings: AISettings = store.get_setting("ai")?;
    let stored = credential::load(&store.root);
    let matches = stored
        .as_ref()
        .ok()
        .and_then(|entry| entry.as_ref())
        .filter(|entry| {
            settings
                .endpoint()
                .is_ok_and(|url| url.as_str() == entry.endpoint)
        });
    Ok(SettingsView {
        verified: matches.is_some_and(|entry| entry.verified && entry.model == settings.model),
        has_key: matches.is_some(),
        credential_error: stored.is_err(),
        settings,
    })
}

pub fn save_settings(store: &Store, mut input: SettingsInput) -> Result<SettingsView> {
    input.settings.validate()?;
    let previous: AISettings = store.get_setting("ai")?;
    let new_secret = input
        .api_key
        .take()
        .map(Zeroizing::new)
        .filter(|key| !key.trim().is_empty());
    let old = credential::load(&store.root);
    if input.remove_key {
        credential::save(&store.root, None)?;
    } else if let Some(key) = &new_secret {
        let endpoint = input.settings.endpoint()?.to_string();
        let trimmed = key.trim();
        if trimmed.len() > 2048 || !trimmed.bytes().all(|b| b.is_ascii_graphic()) {
            return Err(message("API Key 格式无效。"));
        }
        credential::save(
            &store.root,
            Some(&Credential {
                endpoint,
                model: input.settings.model.clone(),
                key: trimmed.to_owned(),
                verified: false,
            }),
        )?;
    } else if let Ok(Some(old)) = &old {
        if previous.endpoint().ok() != input.settings.endpoint().ok() {
            credential::save(&store.root, None)?;
        } else if old.model != input.settings.model {
            credential::save(
                &store.root,
                Some(&Credential {
                    endpoint: old.endpoint.clone(),
                    key: old.key.clone(),
                    model: input.settings.model.clone(),
                    verified: false,
                }),
            )?;
        }
    }
    let saved = (|| -> Result<()> {
        let tx = store.db.unchecked_transaction()?;
        store.set_setting("ai", &input.settings)?;
        if previous.endpoint().ok() != input.settings.endpoint().ok() || input.remove_key {
            crate::consent::ConsentManager::new(&tx).reset(None)?;
        }
        tx.commit()?;
        Ok(())
    })();
    if let Err(error) = saved {
        if let Ok(old) = &old {
            let _ = credential::save(&store.root, old.as_ref());
        }
        return Err(error);
    }

    settings_view(store)
}

pub struct ConnectionSettings {
    pub public: AISettings,
    pub endpoint: Url,
    pub credential: Credential,
}

pub fn connection_settings(store: &Store, require_verified: bool) -> Result<ConnectionSettings> {
    let public: AISettings = store.get_setting("ai")?;
    let endpoint = public
        .endpoint()
        .map_err(|_| message("请先配置 AI Base URL、模型名称和 API Key。"))?;
    if public.model.is_empty() {
        return Err(message("请在设置中填写模型名称。"));
    }
    let credential = credential::load(&store.root)?
        .filter(|key| key.endpoint == endpoint.as_str())
        .ok_or_else(|| message("请保存此 API 地址对应的 API Key。"))?;
    if require_verified && (!credential.verified || credential.model != public.model) {
        return Err(message("发送前请先在设置中测试 AI 连接。"));
    }
    Ok(ConnectionSettings {
        public,
        endpoint,
        credential,
    })
}

pub fn mark_verified(store: &Store, tested: &ConnectionSettings) -> Result<()> {
    let mut current = connection_settings(store, false)?;
    if current.public != tested.public || current.credential.key != tested.credential.key {
        return Err(message("AI 配置已更改，请重新测试连接。"));
    }
    current.credential.model.clone_from(&current.public.model);
    current.credential.verified = true;
    credential::save(&store.root, Some(&current.credential))
}

#[derive(Default)]
pub struct AiState {
    running: Option<(String, CancellationToken)>,
    pub(crate) chats: HashMap<String, crate::chat::PreparedChat>,
    pub(crate) active_chat: Option<(String, i64)>,
    pub(crate) interviews: HashMap<String, crate::interview_ai::Prepared>,
    pub(crate) active_interview: Option<String>,
}

impl AiState {
    pub fn invalidate_chats(&mut self) {
        self.chats.clear();
        if let Some((request, _)) = &self.active_chat {
            self.cancel(request);
        }
    }

    pub fn invalidate_interviews(&mut self) {
        self.interviews.clear();
        if let Some(request) = &self.active_interview {
            self.cancel(request);
        }
    }

    pub fn begin(&mut self, id: &str) -> Result<CancellationToken> {
        if id.is_empty() || id.len() > 80 {
            return Err(message("请求标识无效。"));
        }
        if self.running.is_some() {
            return Err(message("已有 AI 请求在进行，请稍后重试。"));
        }
        let token = CancellationToken::new();
        self.running = Some((id.to_owned(), token.clone()));
        Ok(token)
    }

    pub fn cancel(&self, id: &str) {
        if let Some((running, token)) = &self.running
            && running == id
        {
            token.cancel();
        }
    }

    pub fn finish(&mut self, id: &str) {
        if self
            .running
            .as_ref()
            .is_some_and(|(running, _)| running == id)
        {
            self.running = None;
        }
        if self
            .active_chat
            .as_ref()
            .is_some_and(|(active, _)| active == id)
        {
            self.active_chat = None;
        }
        if self.active_interview.as_deref() == Some(id) {
            self.active_interview = None;
        }
    }

    pub fn invalidate(&mut self) {
        self.chats.clear();
        self.interviews.clear();
        if let Some((_, token)) = &self.running {
            token.cancel();
        }
    }
}

static EMAIL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)[a-z0-9.!#$%&'*+/=?^_{}|~-]+@[a-z0-9.-]+\.[a-z]{2,24}").unwrap()
});
static PHONE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u:\b)(?:(?:\+?86[ -]?)?1[3-9][0-9][ -]?[0-9]{4}[ -]?[0-9]{4}|[0-9]{3,4}[- ][0-9]{7,8}|[0-9]{3}[- ][0-9]{3}[- ][0-9]{4})(?-u:\b)").unwrap()
});
static PERSONAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?im)^[ \t]*(?:姓[ \t]*名|个人姓名|name|full name|住址|家庭住址|现住址|通讯地址|地址|home address|address|手机号码|手机号|手机|电话|联系方式|phone|tel|mobile|证件号码|身份证号|年龄|性别|出生日期|date of birth|gender)[ \t]*[:：][^\r\n]*").unwrap()
});
static INLINE_PHONE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:手机|电话|phone|mobile|tel)[ \t]*[:：][ \t]*\+?[0-9][0-9() .-]{6,23}[0-9]")
        .unwrap()
});
static NAME_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\p{Han}·]{2,4}$").unwrap());
static ADDRESS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"[\p{Han}]{2,12}(?:省|市)[\p{Han}]{1,15}(?:区|县)[^\r\n，。；]{1,35}(?:号|室|栋|单元)",
    )
    .unwrap()
});

static IDENTIFIER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?-u:\b)[0-9]{17}[0-9x](?-u:\b)").unwrap());

pub(crate) fn has_private_data(text: &str) -> bool {
    [
        &*PERSONAL,
        &*EMAIL,
        &*PHONE,
        &*INLINE_PHONE,
        &*ADDRESS,
        &*IDENTIFIER,
    ]
    .iter()
    .any(|pattern| pattern.is_match(text))
}

pub(crate) fn redact_contacts(text: &str, known: Option<&str>) -> String {
    let lines = PERSONAL.replace_all(text, "[已移除个人信息]");
    let emails = EMAIL.replace_all(&lines, "[已移除邮箱]");
    let phones = PHONE.replace_all(&emails, "[已移除电话]");
    let phones = INLINE_PHONE.replace_all(&phones, "[已移除电话]");
    let addresses = ADDRESS.replace_all(&phones, "[已移除住址]");
    let mut value = IDENTIFIER
        .replace_all(&addresses, "[已移除证件号码]")
        .into_owned();
    if let Some(name) = known.filter(|name| name.trim().chars().count() >= 2)
        && let Ok(pattern) = RegexBuilder::new(&regex::escape(name.trim()))
            .case_insensitive(true)
            .build()
    {
        value = pattern.replace_all(&value, "[已移除姓名]").into_owned();
    }
    value
}

pub(crate) fn redact_text(text: &str, known: Option<&str>) -> String {
    let mut value = redact_contacts(text, known);
    if let Some(first) = value.lines().find(|line| !line.trim().is_empty())
        && NAME_LINE.is_match(first.trim())
        && !matches!(
            first.trim(),
            "简历"
                | "个人简历"
                | "岗位描述"
                | "岗位职责"
                | "任职要求"
                | "工作经历"
                | "示例简历"
                | "求职简历"
        )
    {
        value = value.replacen(first, "[已移除姓名]", 1);
    }
    value
}

pub struct ChatCompletions;

#[derive(Clone, Copy)]
enum ChatPurpose {
    Test,
    Assistant,
    Interview,
}

fn chat_options(config: &ConnectionSettings, purpose: ChatPurpose) -> serde_json::Value {
    let mut options = serde_json::json!({ "stream": false });
    if config.endpoint.scheme() == "https"
        && config.endpoint.host_str() == Some("api.deepseek.com")
        && config.endpoint.port().is_none()
        && matches!(
            config.endpoint.path(),
            "/chat/completions" | "/v1/chat/completions"
        )
        && matches!(
            config.public.model.as_str(),
            "deepseek-flash" | "deepseek-v4-pro"
        )
    {
        options["thinking"] = serde_json::json!({ "type": "disabled" });
        match purpose {
            ChatPurpose::Test => options["max_tokens"] = serde_json::json!(32),
            ChatPurpose::Assistant => options["max_tokens"] = serde_json::json!(3000),
            ChatPurpose::Interview => options["max_tokens"] = serde_json::json!(6000),
        }
    }
    options
}

impl ChatCompletions {
    pub async fn test_connection(&self, config: &ConnectionSettings) -> Result<()> {
        let text = self
            .complete(
                config,
                "You are a connection test. Reply with OK.",
                "OK?",
                ChatPurpose::Test,
            )
            .await?;
        if text.trim().is_empty() {
            return Err(message("API 连接成功，但模型没有返回可识别的正文。"));
        }
        Ok(())
    }
    async fn complete(
        &self,
        config: &ConnectionSettings,
        system: &str,
        user: &str,
        purpose: ChatPurpose,
    ) -> Result<String> {
        let mut request = chat_options(config, purpose);
        request["model"] = serde_json::json!(config.public.model);
        request["messages"] =
            serde_json::json!([{"role":"system","content":system}, {"role":"user","content":user}]);
        let response = self.post_request(config, &request).await?;
        Self::read_completion(config, response).await
    }

    pub(crate) async fn interview(
        &self,
        config: &ConnectionSettings,
        system: &str,
        user: &str,
    ) -> Result<String> {
        let mut request = chat_options(config, ChatPurpose::Interview);
        request["model"] = serde_json::json!(config.public.model);
        request["messages"] =
            serde_json::json!([{"role":"system","content":system}, {"role":"user","content":user}]);
        request["response_format"] = serde_json::json!({ "type": "json_object" });
        let mut response = self.post_request(config, &request).await?;
        if matches!(
            response.status(),
            StatusCode::BAD_REQUEST
                | StatusCode::UNSUPPORTED_MEDIA_TYPE
                | StatusCode::UNPROCESSABLE_ENTITY
        ) {
            request
                .as_object_mut()
                .expect("Chat Completions request object")
                .remove("response_format");
            response = self.post_request(config, &request).await?;
        }
        Self::read_completion(config, response).await
    }

    pub(crate) async fn assistant(
        &self,
        config: &ConnectionSettings,
        messages: &[serde_json::Value],
        mut emit: impl FnMut(&str),
    ) -> Result<String> {
        let mut request = chat_options(config, ChatPurpose::Assistant);
        request["model"] = serde_json::json!(config.public.model);
        request["messages"] = serde_json::json!(messages);
        request["stream"] = serde_json::json!(true);
        let mut response = self.post_request(config, &request).await?;
        // Some compatible gateways reject streaming. Retry once before showing any output.
        if matches!(
            response.status(),
            StatusCode::BAD_REQUEST
                | StatusCode::UNSUPPORTED_MEDIA_TYPE
                | StatusCode::UNPROCESSABLE_ENTITY
        ) {
            request["stream"] = serde_json::json!(false);
            response = self.post_request(config, &request).await?;
        }
        check_response(response.status())?;
        let events = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                value
                    .split(';')
                    .next()
                    .is_some_and(|kind| kind.trim().eq_ignore_ascii_case("text/event-stream"))
            });
        if !events {
            return Self::read_completion(config, response).await;
        }
        let timeout = config.public.timeout_seconds;
        let mut pending = Vec::new();
        let mut count = 0;
        let mut parser = ChatEvents::default();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| network_error(e, timeout, timeout.min(CONNECT_TIMEOUT_SECONDS), true))?
        {
            count += chunk.len();
            if count > RESPONSE_LIMIT {
                return Err(message("AI 返回的数据超出长度限制。"));
            }
            pending.extend_from_slice(&chunk);
            let mut start = 0;
            while let Some(index) = pending[start..].iter().position(|byte| *byte == b'\n') {
                let end = start + index;
                if parser.line(&pending[start..end], &mut emit)? {
                    return parser.finish();
                }
                start = end + 1;
            }
            pending.drain(..start);
        }
        if !pending.is_empty() {
            parser.line(&pending, &mut emit)?;
        }
        parser.flush(&mut emit)?;
        parser.finish()
    }

    async fn post_request(
        &self,
        config: &ConnectionSettings,
        request: &serde_json::Value,
    ) -> Result<reqwest::Response> {
        let timeout = config.public.timeout_seconds;
        let connect_timeout = timeout.min(CONNECT_TIMEOUT_SECONDS);
        let builder = reqwest::Client::builder()
            .timeout(Duration::from_secs(timeout))
            .connect_timeout(Duration::from_secs(connect_timeout))
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy();
        let client = if config.endpoint.host_str() == Some("localhost") {
            builder
                .resolve("localhost", std::net::SocketAddr::from(([127, 0, 0, 1], 0)))
                .build()
        } else {
            builder.build()
        }
        .map_err(|_| message("无法初始化 AI 连接。"))?;
        let bearer = Zeroizing::new(format!("Bearer {}", config.credential.key));
        let mut authorization =
            HeaderValue::from_str(&bearer).map_err(|_| message("API Key 格式无效。"))?;
        authorization.set_sensitive(true);
        client
            .post(config.endpoint.clone())
            .header(reqwest::header::AUTHORIZATION, authorization)
            .json(request)
            .send()
            .await
            .map_err(|error| network_error(error, timeout, connect_timeout, false))
    }

    async fn read_completion(
        config: &ConnectionSettings,
        mut response: reqwest::Response,
    ) -> Result<String> {
        check_response(response.status())?;
        let timeout = config.public.timeout_seconds;
        let connect_timeout = timeout.min(CONNECT_TIMEOUT_SECONDS);
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| network_error(error, timeout, connect_timeout, true))?
        {
            if bytes.len() + chunk.len() > RESPONSE_LIMIT {
                return Err(message("AI 返回的数据超出长度限制。"));
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|_| message("AI 服务没有返回有效的 Chat Completions JSON。"))?;
        let choice = value
            .get("choices")
            .and_then(|v| v.get(0))
            .ok_or_else(|| message("AI 返回缺少 choices，请检查协议兼容性。"))?;
        check_finish(
            choice
                .get("finish_reason")
                .and_then(|reason| reason.as_str()),
        )?;
        choice
            .pointer("/message/content")
            .and_then(|v| v.as_str())
            .filter(|text| !text.trim().is_empty())
            .map(str::to_owned)
            .ok_or_else(no_chat_text)
    }
}

fn check_response(status: StatusCode) -> Result<()> {
    if status.is_success() {
        return Ok(());
    }
    Err(message(match status {
        StatusCode::UNAUTHORIZED => "API 拒绝了凭据（401），请核对 API Key。".to_owned(),
        StatusCode::PAYMENT_REQUIRED => {
            "AI 服务报告余额不足或计费受限（402），请检查服务商账户。".to_owned()
        }
        StatusCode::FORBIDDEN => "API 拒绝访问（403），请核对模型和账户权限。".to_owned(),
        StatusCode::NOT_FOUND => {
            "未找到 API 路径或模型（404），请检查 Base URL 和模型名称。".to_owned()
        }
        StatusCode::TOO_MANY_REQUESTS => "AI 服务限流或额度不足（429），请稍后重试。".to_owned(),
        StatusCode::REQUEST_TIMEOUT | StatusCode::GATEWAY_TIMEOUT => format!(
            "AI 服务端超时（{}）。可减少分析材料，稍后重试。",
            status.as_u16()
        ),
        status if status.is_redirection() => "API 返回重定向，请配置最终 HTTPS 地址。".to_owned(),
        status => format!(
            "AI 服务返回 HTTP {}，请检查供应商配置或稍后重试。",
            status.as_u16()
        ),
    }))
}

fn check_finish(reason: Option<&str>) -> Result<()> {
    match reason {
        Some("length") => Err(message(
            "模型输出被截断。请缩短材料或使用输出额度更大的模型。",
        )),
        Some("content_filter") => Err(message("AI 服务过滤了本次输出。")),
        _ => Ok(()),
    }
}

fn no_chat_text() -> Error {
    message("AI 返回缺少文本正文。请确认使用了支持 Chat Completions 的文本模型。")
}

#[derive(Default)]
struct ChatEvents {
    data: Vec<u8>,
    text: String,
    finished: bool,
}

impl ChatEvents {
    fn line(&mut self, line: &[u8], emit: &mut impl FnMut(&str)) -> Result<bool> {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.is_empty() {
            return self.flush(emit);
        }
        if let Some(data) = line.strip_prefix(b"data:") {
            if !self.data.is_empty() {
                self.data.push(b'\n');
            }
            self.data
                .extend_from_slice(data.strip_prefix(b" ").unwrap_or(data));
        }
        Ok(false)
    }

    fn flush(&mut self, emit: &mut impl FnMut(&str)) -> Result<bool> {
        let data = std::mem::take(&mut self.data);
        if data.is_empty() {
            return Ok(false);
        }
        if data == b"[DONE]" {
            self.finished = true;
            return Ok(true);
        }
        let value: serde_json::Value =
            serde_json::from_slice(&data).map_err(|_| message("AI 流式响应格式无效。"))?;
        if value.get("error").is_some() {
            return Err(message("AI 服务在回复过程中报告了错误。"));
        }
        if let Some(choice) = value.pointer("/choices/0") {
            let reason = choice
                .get("finish_reason")
                .and_then(|reason| reason.as_str());
            check_finish(reason)?;
            if let Some(text) = choice
                .pointer("/delta/content")
                .and_then(|content| content.as_str())
            {
                emit(text);
                self.text.push_str(text);
            }
            self.finished |= reason.is_some();
        }
        Ok(false)
    }

    fn finish(self) -> Result<String> {
        if !self.finished {
            return Err(message("AI 流式响应提前断开，未保存不完整的回复。"));
        }
        if self.text.trim().is_empty() {
            return Err(no_chat_text());
        }
        Ok(self.text)
    }
}

#[cfg(test)]
mod chat_stream_tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    #[test]
    fn assistant_stream_emits_content_and_ignores_reasoning() {
        let mut events = ChatEvents::default();
        let mut output = String::new();
        let mut emit = |text: &str| output.push_str(text);
        for line in [
            ": keep-alive",
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"隐藏推理\"}}]}",
            "",
            "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\r",
            "\r",
            "data: {\"choices\":[{\"delta\":{\"content\":\"，招聘工作台\"},\"finish_reason\":\"stop\"}]}",
            "",
            "data: [DONE]",
        ] {
            assert!(!events.line(line.as_bytes(), &mut emit).unwrap());
        }
        assert!(events.line(b"", &mut emit).unwrap());
        assert_eq!(events.finish().unwrap(), "你好，招聘工作台");
        assert_eq!(output, "你好，招聘工作台");
    }

    #[test]
    fn incomplete_stream_is_rejected() {
        let events = ChatEvents {
            text: "partial".to_owned(),
            ..Default::default()
        };
        assert!(
            events
                .finish()
                .unwrap_err()
                .to_string()
                .contains("提前断开")
        );
    }

    #[tokio::test]
    async fn assistant_requests_streaming_and_receives_local_server_deltas() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let public = AISettings {
            base_url: format!("http://{}/v1", listener.local_addr().unwrap()),
            timeout_seconds: 5,
            model: "test".to_owned(),
        };
        let endpoint = public.endpoint().unwrap();
        let config = ConnectionSettings {
            credential: Credential {
                endpoint: endpoint.to_string(),
                model: public.model.clone(),
                key: "mock-key".to_owned(),
                verified: true,
            },
            public,
            endpoint,
        };
        let mock = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buf = [0_u8; 1024];
            loop {
                let n = socket.read(&mut buf).await.unwrap();
                assert!(n > 0);
                request.extend_from_slice(&buf[..n]);
                if let Some(head) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = std::str::from_utf8(&request[..head]).unwrap();
                    let length: usize = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length: "))
                        .unwrap()
                        .parse()
                        .unwrap();
                    if request.len() >= head + 4 + length {
                        assert!(headers.starts_with("POST /v1/chat/completions "));
                        let json: serde_json::Value =
                            serde_json::from_slice(&request[head + 4..head + 4 + length]).unwrap();
                        assert_eq!(json["stream"], true);
                        assert_eq!(json["messages"][0]["content"], "问题");
                        break;
                    }
                }
            }
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
            socket
                .write_all("data: {\"choices\":[{\"delta\":{\"content\":\"答\"}}]}\n\n".as_bytes())
                .await
                .unwrap();
            socket.write_all("data: {\"choices\":[{\"delta\":{\"content\":\"复\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n".as_bytes()).await.unwrap();
        });
        let mut deltas = Vec::new();
        let response = ChatCompletions
            .assistant(
                &config,
                &[serde_json::json!({"role":"user","content":"问题"})],
                |delta| deltas.push(delta.to_owned()),
            )
            .await
            .unwrap();
        mock.await.unwrap();
        assert_eq!(response, "答复");
        assert_eq!(deltas, ["答", "复"]);
    }
}

fn network_error(
    error: reqwest::Error,
    timeout: u64,
    connect_timeout: u64,
    reading: bool,
) -> Error {
    if error.is_timeout() && error.is_connect() {
        message(format!(
            "连接 AI 服务超时（{connect_timeout} 秒）。请检查当前网络能否访问所配置的 API 地址。"
        ))
    } else if error.is_timeout() {
        let phase = if reading {
            "读取 AI 响应"
        } else {
            "等待 AI 服务响应"
        };
        message(format!(
            "{phase}超时（{timeout} 秒）。可在设置中延长超时，或减少本次材料后重试。"
        ))
    } else if error.is_connect() {
        message("无法连接 AI 服务，请检查网络、地址和服务状态。")
    } else if reading {
        message("AI 服务在返回正文时中断了连接，可稍后重试。")
    } else {
        message("AI 请求失败，请检查网络或服务协议。")
    }
}
