use std::collections::HashSet;

use rusqlite::{OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    model::{Result, bounded, message, now},
    store::{Scope, Store},
    value,
};

pub const MAX_QUESTIONS: usize = 50;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    Background,
    Experience,
    Technical,
    Project,
    Scenario,
    Star,
    Collaboration,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Basic,
    Medium,
    Advanced,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Difficulty {
    Basic,
    Medium,
    Advanced,
    Mixed,
}

impl Difficulty {
    pub fn level(self, index: usize) -> Level {
        match self {
            Self::Basic => Level::Basic,
            Self::Medium => Level::Medium,
            Self::Advanced => Level::Advanced,
            Self::Mixed => [Level::Basic, Level::Medium, Level::Advanced][index % 3],
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    Zh,
    En,
    Bilingual,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SourceKind {
    Resume,
    Jd,
    Focus,
    General,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    pub kind: SourceKind,
    #[serde(default)]
    pub evidence: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Question {
    pub category: Category,
    pub difficulty: Level,
    pub question: String,
    pub competency: String,
    pub source: Source,
    #[serde(default)]
    pub follow_up: String,
    #[serde(default)]
    pub evaluation_points: String,
    #[serde(default)]
    pub reference_answer: String,
    #[serde(default)]
    pub interviewer_notes: String,
    #[serde(default)]
    pub answer_summary: String,
    #[serde(default)]
    pub verification: String,
}

impl Question {
    pub fn validate(&mut self) -> Result<()> {
        self.question = bounded(&self.question, 1600, "面试问题", true)?;
        self.competency = bounded(&self.competency, 420, "考察能力", false)?;
        self.source.evidence = bounded(&self.source.evidence, 600, "原文依据", false)?;
        self.follow_up = bounded(&self.follow_up, 1000, "追问", false)?;
        self.evaluation_points = bounded(&self.evaluation_points, 1200, "考察要点", false)?;
        self.reference_answer = bounded(&self.reference_answer, 1600, "参考回答思路", false)?;
        self.interviewer_notes = bounded(&self.interviewer_notes, 2400, "面试官备注", false)?;
        self.answer_summary = bounded(&self.answer_summary, 3600, "回答摘要", false)?;
        self.verification = bounded(&self.verification, 2000, "待核实事项", false)?;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct Allocation {
    pub category: Category,
    pub count: u8,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub total: u8,
    pub allocations: Vec<Allocation>,
    pub difficulty: Difficulty,
    pub language: Language,
    pub minutes: Option<u16>,
    pub focus: String,
    pub follow_up: bool,
    pub evaluation_points: bool,
    pub reference_answer: bool,
}

impl Config {
    pub fn validate(&mut self) -> Result<()> {
        let mut categories = HashSet::new();
        let sum: usize = self
            .allocations
            .iter()
            .map(|item| usize::from(item.count))
            .sum();
        if !(1..=MAX_QUESTIONS).contains(&usize::from(self.total))
            || sum != usize::from(self.total)
            || self.allocations.len() > 7
            || !self
                .allocations
                .iter()
                .all(|item| item.count > 0 && categories.insert(item.category))
        {
            return Err(message(
                "请选择题目类型，各类题数之和须等于 1–50 的目标题数。",
            ));
        }
        if self
            .minutes
            .is_some_and(|value| !(5..=480).contains(&value))
        {
            return Err(message("参考时长须在 5–480 分钟之间。"));
        }
        self.focus = bounded(&self.focus, 1200, "面试关注重点", false)?;
        Ok(())
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub candidate_id: Option<i64>,
    pub job_id: Option<i64>,
    pub application_id: Option<i64>,
    pub resume_id: Option<i64>,
    pub job_title: String,
    pub temporary_jd: String,
}

pub fn resolve(store: &Store, selection: &mut Selection) -> Result<()> {
    if let Some(candidate_id) = selection.candidate_id {
        if store
            .db
            .query_row(
                "SELECT id FROM candidates WHERE id=?1",
                [candidate_id],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
            .is_none()
        {
            return Err(message("候选人已不存在，请重新选择。"));
        }
        if let Some(resume_id) = selection.resume_id
            && !store
                .documents(Scope::Candidate(candidate_id))?
                .iter()
                .any(|resume| resume.id == resume_id)
        {
            return Err(message("所选简历不属于此候选人，或原件已移除。"));
        }
    } else if selection.resume_id.is_some() || selection.application_id.is_some() {
        return Err(message("请选择简历和岗位申请对应的候选人。"));
    }
    if let Some(id) = selection.job_id {
        selection.job_title = store.job(id)?.title;
        selection.temporary_jd.clear();
    } else {
        selection.job_title = bounded(&selection.job_title, 120, "面试岗位", true)?;
        selection.temporary_jd = bounded(&selection.temporary_jd, 18_000, "临时岗位 JD", false)?;
    }
    if let Some(id) = selection.application_id {
        if selection.job_id.is_none()
            || !store
                .applications(selection.job_id, selection.candidate_id)?
                .iter()
                .any(|app| app.id == id)
        {
            return Err(message("所选申请与候选人和岗位不匹配。"));
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideInput {
    pub title: String,
    pub selection: Selection,
    pub interview_date: String,
    pub config: Config,
    pub questions: Vec<Question>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub id: i64,
    pub title: String,
    pub candidate_id: Option<i64>,
    pub candidate_name: Option<String>,
    pub job_id: Option<i64>,
    pub job_title: String,
    pub question_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Guide {
    pub id: i64,
    pub revision: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub input: GuideInput,
}

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Command {
    List {
        candidate_id: Option<i64>,
        job_id: Option<i64>,
        query: Option<String>,
        offset: Option<u32>,
        limit: Option<u8>,
    },
    Get {
        id: i64,
    },
    Save {
        id: Option<i64>,
        revision: Option<i64>,
        input: GuideInput,
    },
    Delete {
        id: i64,
        revision: i64,
    },
}

pub fn dispatch(store: &mut Store, operation: Command) -> Result<Value> {
    match operation {
        Command::List {
            candidate_id,
            job_id,
            query,
            offset,
            limit,
        } => value(list(
            store,
            candidate_id,
            job_id,
            query.as_deref().unwrap_or(""),
            offset.unwrap_or(0),
            limit.unwrap_or(30),
        )?),
        Command::Get { id } => value(get(store, id)?),
        Command::Save {
            id,
            revision,
            input,
        } => value(save(store, id, revision, input)?),
        Command::Delete { id, revision } => value(delete(store, id, revision)?),
    }
}

fn summary(row: &Row<'_>) -> rusqlite::Result<Summary> {
    Ok(Summary {
        id: row.get(0)?,
        title: row.get(1)?,
        candidate_id: row.get(2)?,
        candidate_name: row.get(3)?,
        job_id: row.get(4)?,
        job_title: row.get(5)?,
        question_count: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

pub fn list(
    store: &Store,
    candidate_id: Option<i64>,
    job_id: Option<i64>,
    query: &str,
    offset: u32,
    limit: u8,
) -> Result<Vec<Summary>> {
    let query = bounded(query, 180, "搜索词", false)?;
    let mut statement = store.db.prepare(
        "SELECT g.id,g.title,g.candidate_id,c.name,g.job_id,g.job_title,
            (SELECT count(*) FROM interview_questions q WHERE q.guide_id=g.id),g.created_at,g.updated_at
         FROM interview_guides g LEFT JOIN candidates c ON c.id=g.candidate_id
         WHERE (?1 IS NULL OR g.candidate_id=?1) AND (?2 IS NULL OR g.job_id=?2)
           AND (?3='' OR instr(lower(g.title),lower(?3))>0 OR instr(lower(g.job_title),lower(?3))>0
                      OR instr(lower(coalesce(c.name,'')),lower(?3))>0)
         ORDER BY g.updated_at DESC,g.id DESC LIMIT ?4 OFFSET ?5",
    )?;
    Ok(statement
        .query_map(
            params![candidate_id, job_id, query, limit.clamp(1, 60), offset],
            summary,
        )?
        .collect::<rusqlite::Result<_>>()?)
}

pub fn get(store: &Store, id: i64) -> Result<Guide> {
    let (revision, created_at, updated_at, title, selection, interview_date, config): (i64, i64, i64, String, Selection, String, String) = store.db.query_row(
        "SELECT revision,created_at,updated_at,title,candidate_id,job_id,application_id,resume_id,job_title,temporary_jd,interview_date,generation_config
         FROM interview_guides WHERE id=?1", [id], |row| {
            Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,Selection { candidate_id: row.get(4)?, job_id: row.get(5)?, application_id: row.get(6)?, resume_id: row.get(7)?, job_title: row.get(8)?, temporary_jd: row.get(9)? },row.get(10)?,row.get(11)?))
        },
    ).optional()?.ok_or_else(|| message("找不到这份面试提纲。"))?;
    let mut statement = store
        .db
        .prepare("SELECT details FROM interview_questions WHERE guide_id=?1 ORDER BY sort_order")?;
    let mut questions = Vec::new();
    for details in statement.query_map([id], |row| row.get::<_, String>(0))? {
        questions.push(serde_json::from_str(&details?)?);
    }
    Ok(Guide {
        id,
        revision,
        created_at,
        updated_at,
        input: GuideInput {
            title,
            selection,
            interview_date,
            config: serde_json::from_str(&config)?,
            questions,
        },
    })
}

pub fn validate_date(text: &str) -> Result<String> {
    let date = text.trim();
    let parts = date.split('-').collect::<Vec<_>>();
    if date.is_empty() {
        return Ok(String::new());
    }
    if let [year, month, day] = parts.as_slice()
        && year.len() == 4
        && month.len() == 2
        && day.len() == 2
        && date
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'-')
        && let (Ok(year), Ok(month), Ok(day)) = (
            year.parse::<u16>(),
            month.parse::<usize>(),
            day.parse::<u8>(),
        )
        && year > 0
        && let Some(days) = [
            31,
            28 + u8::from(year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)),
            31,
            30,
            31,
            30,
            31,
            31,
            30,
            31,
            30,
            31,
        ]
        .get(month.wrapping_sub(1))
        && (1..=*days).contains(&day)
    {
        return Ok(date.to_owned());
    }
    Err(message("请输入有效的面试日期。"))
}

pub fn save(
    store: &mut Store,
    id: Option<i64>,
    revision: Option<i64>,
    mut input: GuideInput,
) -> Result<Guide> {
    input.title = bounded(&input.title, 180, "提纲名称", true)?;
    input.interview_date = validate_date(&input.interview_date)?;
    input.config.validate()?;
    resolve(store, &mut input.selection)?;
    if input.questions.len() > MAX_QUESTIONS {
        return Err(message("每份面试提纲最多保存 50 道题。"));
    }
    for question in &mut input.questions {
        question.validate()?;
    }
    let settings = serde_json::to_string(&input.config)?;
    let selection = &input.selection;
    let stamp = now();
    let tx = store.db.transaction()?;
    let id = if let Some(id) = id {
        let affected = tx.execute(
            "UPDATE interview_guides SET title=?1,candidate_id=?2,job_id=?3,application_id=?4,resume_id=?5,
                job_title=?6,temporary_jd=?7,interview_date=?8,generation_config=?9,updated_at=?10,revision=revision+1
             WHERE id=?11 AND revision=?12",
            params![input.title,selection.candidate_id,selection.job_id,selection.application_id,selection.resume_id,
                selection.job_title,selection.temporary_jd,input.interview_date,settings,stamp,id,revision],
        )?;
        if affected == 0 {
            return Err(message("此提纲已更改或移除，请重新打开后保存。"));
        }
        tx.execute("DELETE FROM interview_questions WHERE guide_id=?1", [id])?;
        id
    } else {
        tx.execute(
            "INSERT INTO interview_guides(title,candidate_id,job_id,application_id,resume_id,job_title,temporary_jd,
                interview_date,generation_config,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10)",
            params![input.title,selection.candidate_id,selection.job_id,selection.application_id,selection.resume_id,
                selection.job_title,selection.temporary_jd,input.interview_date,settings,stamp],
        )?;
        tx.last_insert_rowid()
    };
    {
        let mut insert = tx.prepare(
            "INSERT INTO interview_questions(guide_id,sort_order,details) VALUES(?1,?2,?3)",
        )?;
        for (order, question) in input.questions.iter().enumerate() {
            insert.execute(params![id, order as i64, serde_json::to_string(question)?])?;
        }
    }
    tx.commit()?;
    get(store, id)
}

fn delete(store: &Store, id: i64, revision: i64) -> Result<()> {
    if store.db.execute(
        "DELETE FROM interview_guides WHERE id=?1 AND revision=?2",
        params![id, revision],
    )? == 0
    {
        return Err(message("此提纲已更改或移除，请刷新历史。"));
    }
    Ok(())
}
