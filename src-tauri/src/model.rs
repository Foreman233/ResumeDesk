use serde::{Deserialize, Serialize};

#[derive(Debug)]
pub enum Error {
    Message(String),
    Sql(rusqlite::Error),
    Io(std::io::Error),
    Json(serde_json::Error),
}

impl std::fmt::Display for Error {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Message(message) => out.write_str(message),
            Self::Sql(error) => {
                let _ = error;
                out.write_str("读取或保存本地数据库失败。")
            }
            Self::Io(error) => {
                let _ = error;
                out.write_str("无法访问本地文件，请检查位置、权限或文件占用。")
            }
            Self::Json(error) => {
                let _ = error;
                out.write_str("数据格式无效。")
            }
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Message(_) => None,
            Self::Sql(e) => Some(e),
            Self::Io(e) => Some(e),
            Self::Json(e) => Some(e),
        }
    }
}

impl From<rusqlite::Error> for Error {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sql(error)
    }
}
impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}
impl From<serde_json::Error> for Error {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

pub type Result<T> = std::result::Result<T, Error>;
pub fn message(text: impl Into<String>) -> Error {
    Error::Message(text.into())
}
pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

pub fn bounded(value: &str, max: usize, label: &str, required: bool) -> Result<String> {
    let value = value.trim();
    if (required && value.is_empty()) || value.chars().count() > max || value.contains('\0') {
        return Err(message(format!(
            "{label}{}，最多 {max} 个字符。",
            if required {
                "不能为空"
            } else {
                "格式不正确"
            }
        )));
    }
    Ok(value.to_owned())
}

macro_rules! string_enum {
    ($type:ident { $($variant:ident => $str:literal),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
        pub enum $type { $(#[serde(rename = $str)] $variant),+ }
        impl $type {
            pub fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $str),+ }
            }
            pub fn from_sql(value: String) -> rusqlite::Result<Self> {
                match value.as_str() { $($str => Ok(Self::$variant),)+ _ => Err(rusqlite::Error::InvalidQuery) }
            }
        }
    };
}

string_enum!(JobStatus { Open => "open", Paused => "paused", Closed => "closed" });
string_enum!(Stage {
    New => "new", Screened => "screened", Interview => "interview", Interviewed => "interviewed",
    Hired => "hired", Rejected => "rejected", Withdrawn => "withdrawn"
});
string_enum!(FileFormat { Pdf => "pdf", Docx => "docx" });
string_enum!(ParseStatus { Complete => "complete", Partial => "partial", Empty => "empty", Failed => "failed" });

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateFilter {
    pub query: Option<String>,
    pub job_id: Option<i64>,
    pub tag: Option<String>,
    pub stage: Option<Stage>,
    pub favorite: Option<bool>,
    pub stale: Option<bool>,
    pub offset: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub id: i64,
    pub name: String,
    pub headline: String,
    pub email: String,
    pub phone: String,
    pub favorite: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub tags: Vec<String>,
    pub resume_count: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateInput {
    pub id: Option<i64>,
    pub name: String,
    #[serde(default)]
    pub headline: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub phone: String,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidatePage {
    pub items: Vec<CandidateRow>,
    pub total: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateRow {
    #[serde(flatten)]
    pub candidate: Candidate,
    pub applications: Vec<ApplicationState>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationState {
    pub id: i64,
    pub job_id: i64,
    pub job_title: String,
    pub stage: Stage,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateDetail {
    #[serde(flatten)]
    pub candidate: Candidate,
    pub resumes: Vec<Document>,
    pub applications: Vec<Application>,
    pub notes: Vec<Note>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: i64,
    pub body: String,
    pub created_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: i64,
    pub title: String,
    pub department: String,
    pub jd: String,
    pub status: JobStatus,
    pub updated_at: i64,
    pub application_count: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobInput {
    pub id: Option<i64>,
    pub title: String,
    #[serde(default)]
    pub department: String,
    #[serde(default)]
    pub jd: String,
    pub status: JobStatus,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Application {
    pub id: i64,
    pub candidate_id: i64,
    pub candidate_name: String,
    pub job_id: i64,
    pub job_title: String,
    pub stage: Stage,
    pub note: String,
    pub updated_at: i64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub id: i64,
    pub owner_id: i64,
    pub owner_name: String,
    pub original_name: String,
    pub format: FileFormat,
    pub byte_size: i64,
    pub imported_at: i64,
    pub parse_status: ParseStatus,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    pub candidates: i64,
    pub open_jobs: i64,
    pub screening: i64,
    pub stale: i64,
    pub recent: Vec<Document>,
    pub progress: Vec<StageCount>,
    pub viewed: Vec<RecentCandidate>,
}

#[derive(Debug, Serialize)]
pub struct StageCount {
    pub stage: Stage,
    pub count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentCandidate {
    pub id: i64,
    pub name: String,
    pub headline: String,
    pub viewed_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash)]
#[serde(tag = "kind", content = "id", rename_all = "lowercase")]
pub enum ResumeRef {
    Resume(i64),
}
impl ResumeRef {
    pub fn id(self) -> i64 {
        let Self::Resume(id) = self;
        id
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Privacy {
    pub retention_days: u32,
    pub redact_by_default: bool,
}
impl Default for Privacy {
    fn default() -> Self {
        Self {
            retention_days: 0,
            redact_by_default: true,
        }
    }
}
