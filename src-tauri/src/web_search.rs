use std::{collections::HashSet, sync::LazyLock, time::Duration};

use async_trait::async_trait;
use regex::Regex;
use reqwest::{StatusCode, header::HeaderValue};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use url::{Host, Url};
use zeroize::Zeroizing;

use crate::{
    ai,
    consent::{Capability, ConsentManager},
    credential::{self, Credential},
    knowledge::source_url,
    model::{Result, bounded, message, now},
    store::Store,
};

const DEFAULT_ENDPOINT: &str = "https://api.search.brave.com/res/v1/web/search";
const MAX_BODY: usize = 480 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub endpoint: Option<String>,
    timeout_seconds: u64,
    has_key: bool,
    credential_error: bool,
    default_endpoint: &'static str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsInput {
    endpoint: String,
    timeout_seconds: u64,
    api_key: Option<String>,
    #[serde(default)]
    remove_key: bool,
}

pub struct Connection {
    pub endpoint: Url,
    pub timeout_seconds: u64,
    credential: Credential,
}

fn endpoint(raw: &str) -> Result<Url> {
    let url = Url::parse(raw.trim()).map_err(|_| message("请填写有效的联网搜索 API 地址。"))?;
    let loopback = match url.host() {
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        Some(Host::Domain("localhost")) => true,
        _ => false,
    };
    if !((url.scheme() == "https" || loopback && url.scheme() == "http")
        && url.host().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none())
    {
        return Err(message(
            "联网搜索地址需要 HTTPS 或本机 HTTP，且不得包含凭据、查询参数或页面锚点。",
        ));
    }
    Ok(url)
}

fn configuration(store: &Store) -> Result<Option<(String, u64)>> {
    Ok(store
        .db
        .query_row(
            "SELECT endpoint,timeout_seconds FROM web_search_settings WHERE id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?)
}

pub fn settings(store: &Store) -> Result<Settings> {
    let config = configuration(store)?;
    let stored = credential::load_search(&store.root);
    let has_key = config.as_ref().is_some_and(|(endpoint, _)| {
        stored
            .as_ref()
            .ok()
            .and_then(|entry| entry.as_ref())
            .is_some_and(|key| &key.endpoint == endpoint)
    });
    Ok(Settings {
        endpoint: config.as_ref().map(|pair| pair.0.clone()),
        timeout_seconds: config.map_or(15, |pair| pair.1),
        has_key,
        credential_error: stored.is_err(),
        default_endpoint: DEFAULT_ENDPOINT,
    })
}

pub fn save_settings(store: &mut Store, input: SettingsInput) -> Result<Settings> {
    let raw = bounded(&input.endpoint, 600, "联网搜索端点", false)?;
    let address = if raw.is_empty() {
        None
    } else {
        Some(endpoint(&raw)?.to_string())
    };
    if !(5..=60).contains(&input.timeout_seconds) {
        return Err(message("联网搜索超时须在 5 至 60 秒之间。"));
    }
    let existing = configuration(store)?;
    let endpoint_changed = existing.as_ref().map(|row| &row.0) != address.as_ref();
    let key = input.api_key.map(Zeroizing::new);
    let key = key
        .as_deref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());
    let old = credential::load_search(&store.root);
    if let Some(key) = key
        && (address.is_none()
            || key.len() > 2048
            || !key.bytes().all(|byte| byte.is_ascii_graphic()))
    {
        return Err(message("请填写联网搜索端点和有效的 API Key。"));
    }
    if input.remove_key || address.is_none() || key.is_none() && endpoint_changed {
        credential::save_search(&store.root, None)?;
    } else if let (Some(key), Some(endpoint)) = (key, &address) {
        credential::save_search(
            &store.root,
            Some(&Credential {
                endpoint: endpoint.clone(),
                model: "brave-web".into(),
                key: key.to_owned(),
                verified: false,
            }),
        )?;
    }
    let changed = (|| -> Result<()> {
        let tx = store.db.transaction()?;
        if let Some(address) = address {
            tx.execute(
                "INSERT INTO web_search_settings(id,endpoint,timeout_seconds) VALUES(1,?1,?2)
                 ON CONFLICT(id) DO UPDATE SET endpoint=excluded.endpoint,timeout_seconds=excluded.timeout_seconds",
                params![address,input.timeout_seconds],
            )?;
        } else {
            tx.execute("DELETE FROM web_search_settings WHERE id=1", [])?;
        }
        if endpoint_changed || input.remove_key {
            ConsentManager::new(&tx).reset(Some(Capability::Web))?;
        }
        tx.commit()?;
        Ok(())
    })();
    if let Err(error) = changed {
        if let Ok(old) = &old {
            let _ = credential::save_search(&store.root, old.as_ref());
        }
        return Err(error);
    }
    settings(store)
}

pub fn connection(store: &Store) -> Result<Connection> {
    let (address, timeout_seconds) = configuration(store)?
        .ok_or_else(|| message("联网搜索不可用或尚未配置。请在 AI 设置中配置搜索服务。"))?;
    let credential = credential::load_search(&store.root)?
        .filter(|key| key.endpoint == address)
        .ok_or_else(|| message("联网搜索不可用或尚未配置。请保存此地址的搜索 API Key。"))?;
    Ok(Connection {
        endpoint: endpoint(&address)?,
        timeout_seconds,
        credential,
    })
}

fn identity_key(text: &str) -> String {
    text.chars()
        .filter_map(|ch| {
            let normalized = if ('\u{ff01}'..='\u{ff5e}').contains(&ch) {
                char::from_u32(ch as u32 - 0xfee0).unwrap_or(ch)
            } else {
                ch
            };
            normalized
                .is_alphanumeric()
                .then(|| normalized.to_ascii_lowercase())
        })
        .collect()
}

pub fn public_query(store: &Store, raw: &str) -> Result<String> {
    let query = bounded(raw, 180, "公开搜索词", true)?;
    if query.chars().any(char::is_control)
        || ai::has_private_data(&query)
        || ai::has_private_data(&identity_key(&query))
    {
        return Err(message(
            "搜索词包含联系方式、标识号码或不适合联网发送的内容，请改用公开主题。",
        ));
    }
    let compact = identity_key(&query);
    let mut stmt = store
        .db
        .prepare("SELECT name,email,phone FROM candidates")?;
    let rows = stmt.query_map([], |r| Ok([r.get::<_, String>(0)?, r.get(1)?, r.get(2)?]))?;
    for row in rows {
        for known in row? {
            let known = identity_key(&known);
            if known.chars().count() >= 2 && compact.contains(&known) {
                return Err(message(
                    "搜索词包含本地候选人姓名或联系方式，请改用公开主题。",
                ));
            }
        }
    }
    Ok(query)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub title: String,
    pub url: String,
    pub text: String,
    pub retrieved_at: i64,
    pub official: bool,
}

#[async_trait]
pub trait WebSearchProvider {
    async fn search(&self, settings: &Connection, query: &str) -> Result<Vec<Evidence>>;
}

pub struct BraveSearch;

#[derive(Deserialize)]
struct Reply {
    web: Option<Rows>,
    #[serde(default)]
    #[serde(rename = "type")]
    kind: Option<String>,
}

#[derive(Deserialize)]
struct Rows {
    results: Vec<Hit>,
}

#[derive(Deserialize)]
struct Hit {
    title: String,
    url: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    extra_snippets: Vec<String>,
}

fn plain(raw: &str, limit: usize) -> String {
    static TAGS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<[^>]*>").unwrap());
    let stripped = TAGS.replace_all(raw, " ");
    let decoded = quick_xml::escape::unescape(&stripped);
    let decoded = decoded.as_deref().unwrap_or(&stripped);
    decoded
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .filter(|ch| {
            !ch.is_control() && !matches!(ch, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .take(limit)
        .collect()
}

fn government(host: &str) -> bool {
    [
        "gov.cn",
        "gov",
        "gov.uk",
        "europa.eu",
        "gouv.fr",
        "gov.au",
        "gc.ca",
        "gov.hk",
    ]
    .iter()
    .any(|suffix| {
        host == *suffix
            || host
                .strip_suffix(suffix)
                .is_some_and(|prefix| prefix.ends_with('.'))
    })
}

#[async_trait]
impl WebSearchProvider for BraveSearch {
    async fn search(&self, settings: &Connection, query: &str) -> Result<Vec<Evidence>> {
        let mut secret = HeaderValue::from_str(&settings.credential.key)
            .map_err(|_| message("联网搜索 API Key 无效。"))?;
        secret.set_sensitive(true);
        let timeout = Duration::from_secs(settings.timeout_seconds);
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(timeout.min(Duration::from_secs(10)))
            .timeout(timeout)
            .build()
            .map_err(|_| message("无法初始化联网搜索。"))?;
        let network_error = |error: reqwest::Error| {
            if error.is_timeout() {
                message("联网搜索超时，请重试或关闭联网搜索。")
            } else {
                message("无法连接联网搜索服务，请检查网络和搜索端点。")
            }
        };
        let mut response = client
            .get(settings.endpoint.clone())
            .header("X-Subscription-Token", secret)
            .header("Accept", "application/json")
            .query(&[
                ("q", query),
                ("count", "10"),
                ("text_decorations", "false"),
                ("extra_snippets", "true"),
            ])
            .send()
            .await
            .map_err(network_error)?;
        let status = response.status();
        if !status.is_success() {
            return Err(match status {
                StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                    message("联网搜索服务拒绝访问，请检查搜索 API Key 或服务权限。")
                }
                StatusCode::TOO_MANY_REQUESTS => message("联网搜索服务已限流，请稍后重试。"),
                _ => message(format!("联网搜索服务不可用（HTTP {}）。", status.as_u16())),
            });
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(network_error)? {
            if bytes.len() + chunk.len() > MAX_BODY {
                return Err(message("联网搜索响应过大。"));
            }
            bytes.extend_from_slice(&chunk);
        }
        let reply: Reply = serde_json::from_slice(&bytes)
            .map_err(|_| message("联网搜索返回格式异常，请检查服务兼容性。"))?;
        if reply.web.is_none() && reply.kind.as_deref() != Some("search") {
            return Err(message("联网搜索返回格式异常，请检查服务兼容性。"));
        }
        let retrieved_at = now();
        let mut seen = HashSet::new();
        let mut results = Vec::new();
        for hit in reply.web.into_iter().flat_map(|rows| rows.results) {
            let Some(mut url) = source_url(&hit.url) else {
                continue;
            };
            url.set_fragment(None);
            if url.as_str().len() > 1500 || !seen.insert(url.to_string()) {
                continue;
            }
            let official = url.host_str().is_some_and(government);
            let text = plain(
                &std::iter::once(hit.description)
                    .chain(hit.extra_snippets.into_iter().take(2))
                    .collect::<Vec<_>>()
                    .join("\n"),
                720,
            );
            if text.is_empty() {
                continue;
            }
            let title = plain(&hit.title, 180);
            results.push(Evidence {
                title,
                url: url.to_string(),
                text,
                retrieved_at,
                official,
            });
        }
        results.sort_by_key(|item| !item.official);
        results.truncate(5);
        Ok(results)
    }
}
