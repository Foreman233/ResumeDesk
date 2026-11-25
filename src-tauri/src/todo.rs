use rusqlite::{Connection, OptionalExtension, Row, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, to_value};

use crate::{
    model::{Result, Stage, bounded, message, now},
    store::Store,
};

const CATEGORIES: &[&str] = &["general", "screening", "interview", "follow_up"];
const STATUSES: &[&str] = &["pending", "completed", "cancelled"];
const PRIORITIES: &[&str] = &["low", "normal", "high"];
const MODES: &[&str] = &["online", "onsite"];
const REMINDER_LEASE: i64 = 60;
const REMINDER_RETRY: i64 = 90;

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Command {
    Summary {
        day_end: i64,
    },
    Get {
        id: i64,
    },
    List {
        #[serde(default)]
        filter: Filter,
    },
    Save {
        input: TodoInput,
    },
    SetStatus {
        id: i64,
        status: String,
    },
    Delete {
        id: i64,
    },
    Rules,
    SaveRule {
        stage: Stage,
        enabled: bool,
    },
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Filter {
    pub status: Option<String>,
    pub category: Option<String>,
    pub candidate_id: Option<i64>,
    pub job_id: Option<i64>,
    pub application_id: Option<i64>,
    pub query: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TodoInput {
    pub id: Option<i64>,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub priority: String,
    pub category: String,
    pub due_at: Option<i64>,
    pub candidate_id: Option<i64>,
    pub job_id: Option<i64>,
    pub application_id: Option<i64>,
    pub stage: Option<Stage>,
    pub interview_at: Option<i64>,
    pub reminder_minutes: Option<i64>,
    pub meeting_mode: Option<String>,
    #[serde(default)]
    pub meeting_link: String,
    #[serde(default)]
    pub location: String,
    #[serde(default)]
    pub notes: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    pub id: i64,
    pub title: String,
    pub description: String,
    pub priority: String,
    pub category: String,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub due_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub candidate_id: Option<i64>,
    pub candidate_name: Option<String>,
    pub job_id: Option<i64>,
    pub job_title: Option<String>,
    pub application_id: Option<i64>,
    pub stage: Option<Stage>,
    pub interview_at: Option<i64>,
    pub reminder_minutes: Option<i64>,
    pub remind_at: Option<i64>,
    pub meeting_mode: Option<String>,
    pub meeting_link: String,
    pub location: String,
    pub notes: String,
    pub notified_at: Option<i64>,
    pub reminder_error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Rule {
    pub stage: Stage,
    pub enabled: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DueReminder {
    pub id: i64,
    pub title: String,
    pub remind_at: i64,
    pub interview_at: i64,
    pub lease_until: i64,
}

pub fn dispatch(store: &mut Store, command: Command) -> Result<Value> {
    Ok(match command {
        Command::Summary { day_end } => to_value(summary(&store.db, now(), day_end)?)?,
        Command::Get { id } => to_value(get(&store.db, id)?)?,
        Command::List { filter } => to_value(list(&store.db, filter)?)?,
        Command::Save { input } => to_value(save(&store.db, input)?)?,
        Command::SetStatus { id, status } => to_value(set_status(&store.db, id, &status)?)?,
        Command::Delete { id } => {
            if store.db.execute("DELETE FROM todos WHERE id=?1", [id])? == 0 {
                return Err(message("找不到此待办。"));
            }
            Value::Null
        }
        Command::Rules => to_value(rules(&store.db)?)?,
        Command::SaveRule { stage, enabled } => to_value(save_rule(&store.db, stage, enabled)?)?,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SummaryItem {
    id: i64,
    title: String,
    scheduled_at: i64,
    group: String,
}

fn summary(db: &Connection, stamp: i64, day_end: i64) -> Result<Vec<SummaryItem>> {
    let mut statement = db.prepare(
        "WITH tasks AS (
             SELECT id,title,coalesce(due_at,interview_at) AS scheduled_at
             FROM todos WHERE status='pending' AND coalesce(due_at,interview_at) IS NOT NULL
         ), buckets AS (
             SELECT *, CASE WHEN scheduled_at < ?1 THEN 'overdue'
                            WHEN scheduled_at < ?2 THEN 'today' ELSE 'upcoming' END AS bucket
             FROM tasks
         ), ranked AS (
             SELECT *,row_number() OVER(PARTITION BY bucket ORDER BY scheduled_at,id) AS rank
             FROM buckets
         )
         SELECT id,title,scheduled_at,bucket FROM ranked WHERE rank<=3 ORDER BY scheduled_at,id",
    )?;
    Ok(statement
        .query_map(params![stamp, day_end.max(stamp)], |row| {
            Ok(SummaryItem {
                id: row.get(0)?,
                title: row.get(1)?,
                scheduled_at: row.get(2)?,
                group: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

const TODO_SELECT: &str = "SELECT
    t.id,t.title,t.description,t.priority,t.category,t.status,t.created_at,t.updated_at,t.due_at,t.completed_at,
    t.candidate_id,c.name,t.job_id,j.title,t.application_id,t.stage,t.interview_at,t.reminder_minutes,t.remind_at,
    t.meeting_mode,t.meeting_link,t.location,t.notes,t.notified_at,t.reminder_error
    FROM todos t LEFT JOIN candidates c ON c.id=t.candidate_id LEFT JOIN jobs j ON j.id=t.job_id";

fn read_todo(row: &Row<'_>) -> rusqlite::Result<Todo> {
    Ok(Todo {
        id: row.get(0)?,
        title: row.get(1)?,
        description: row.get(2)?,
        priority: row.get(3)?,
        category: row.get(4)?,
        status: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
        due_at: row.get(8)?,
        completed_at: row.get(9)?,
        candidate_id: row.get(10)?,
        candidate_name: row.get(11)?,
        job_id: row.get(12)?,
        job_title: row.get(13)?,
        application_id: row.get(14)?,
        stage: row
            .get::<_, Option<String>>(15)?
            .map(Stage::from_sql)
            .transpose()?,
        interview_at: row.get(16)?,
        reminder_minutes: row.get(17)?,
        remind_at: row.get(18)?,
        meeting_mode: row.get(19)?,
        meeting_link: row.get(20)?,
        location: row.get(21)?,
        notes: row.get(22)?,
        notified_at: row.get(23)?,
        reminder_error: row.get(24)?,
    })
}

fn list(db: &Connection, filter: Filter) -> Result<Vec<Todo>> {
    let query = bounded(
        filter.query.as_deref().unwrap_or_default(),
        200,
        "搜索内容",
        false,
    )?;
    check(filter.status.as_deref(), STATUSES, "待办状态")?;
    check(filter.category.as_deref(), CATEGORIES, "待办分类")?;
    let mut statement = db.prepare(&format!("{TODO_SELECT}
        WHERE (?1 IS NULL OR t.status=?1) AND (?2 IS NULL OR t.category=?2)
          AND (?3 IS NULL OR t.candidate_id=?3) AND (?4 IS NULL OR t.job_id=?4)
          AND (?5 IS NULL OR t.application_id=?5)
          AND (?6='' OR instr(lower(t.title),lower(?6))>0 OR instr(lower(t.description),lower(?6))>0
           OR instr(lower(coalesce(c.name,'')),lower(?6))>0 OR instr(lower(coalesce(j.title,'')),lower(?6))>0)
        ORDER BY t.status='pending' DESC, t.due_at IS NULL, t.due_at, t.updated_at DESC, t.id DESC"))?;
    Ok(statement
        .query_map(
            params![
                filter.status,
                filter.category,
                filter.candidate_id,
                filter.job_id,
                filter.application_id,
                query
            ],
            read_todo,
        )?
        .collect::<rusqlite::Result<_>>()?)
}

fn get(db: &Connection, id: i64) -> Result<Todo> {
    db.query_row(&format!("{TODO_SELECT} WHERE t.id=?1"), [id], read_todo)
        .optional()?
        .ok_or_else(|| message("找不到此待办。"))
}

fn check(value: Option<&str>, allowed: &[&str], field: &str) -> Result<()> {
    if value.is_some_and(|value| !allowed.contains(&value)) {
        return Err(message(format!("{field}无效。")));
    }
    Ok(())
}

fn validate_time(value: Option<i64>, field: &str) -> Result<()> {
    if value.is_some_and(|value| !(1..=253_402_300_799).contains(&value)) {
        return Err(message(format!("{field}无效。")));
    }
    Ok(())
}

fn save(db: &Connection, mut input: TodoInput) -> Result<Todo> {
    let title = bounded(&input.title, 160, "标题", true)?;
    let description = bounded(&input.description, 4000, "描述", false)?;
    check(Some(&input.priority), PRIORITIES, "优先级")?;
    check(Some(&input.category), CATEGORIES, "待办分类")?;
    check(input.meeting_mode.as_deref(), MODES, "面试方式")?;
    validate_time(input.due_at, "截止时间")?;
    validate_time(input.interview_at, "面试时间")?;
    let (meeting_link, location, notes) = match input.category.as_str() {
        "interview" => {
            let link = bounded(&input.meeting_link, 1500, "会议链接", false)?;
            if !link.is_empty() {
                let valid = url::Url::parse(&link).is_ok_and(|url| {
                    matches!(url.scheme(), "https" | "http")
                        && url.host().is_some()
                        && url.username().is_empty()
                        && url.password().is_none()
                });
                if !valid {
                    return Err(message("会议链接须为有效的 HTTP 或 HTTPS 地址。"));
                }
            }
            (
                link,
                bounded(&input.location, 500, "面试地点", false)?,
                bounded(&input.notes, 4000, "面试备注", false)?,
            )
        }
        _ => {
            input.interview_at = None;
            input.reminder_minutes = None;
            input.meeting_mode = None;
            (String::new(), String::new(), String::new())
        }
    };
    let (minutes, remind_at) = if let Some(start) = input.interview_at {
        let minutes = input.reminder_minutes.unwrap_or(30);
        if !(0..=10_080).contains(&minutes) {
            return Err(message("提前提醒时间须在 0 至 10080 分钟之间。"));
        }
        (Some(minutes), Some((start - minutes * 60).max(1)))
    } else {
        (None, None)
    };
    if let Some(application) = input.application_id {
        let (candidate, job, stage) = db
            .query_row(
                "SELECT candidate_id,job_id,stage FROM applications WHERE id=?1",
                [application],
                |row| Ok((row.get(0)?, row.get(1)?, Stage::from_sql(row.get(2)?)?)),
            )
            .optional()?
            .ok_or_else(|| message("找不到所关联的岗位申请。"))?;
        if input.candidate_id.is_some_and(|id| id != candidate)
            || input.job_id.is_some_and(|id| id != job)
        {
            return Err(message("待办关联的候选人或岗位与申请不一致。"));
        }
        input.candidate_id = Some(candidate);
        input.job_id = Some(job);
        input.stage = input.stage.or(Some(stage));
    }
    validate_link(
        db,
        input.candidate_id,
        "SELECT 1 FROM candidates WHERE id=?1",
        "候选人",
    )?;
    validate_link(db, input.job_id, "SELECT 1 FROM jobs WHERE id=?1", "岗位")?;
    let stamp = now();
    let stage = input.stage.map(Stage::as_str);
    let due_at = input.due_at.or(input.interview_at);
    let id = if let Some(id) = input.id {
        let changed = db.execute(
            "UPDATE todos SET title=?1,description=?2,priority=?3,category=?4,updated_at=?5,due_at=?6,
                candidate_id=?7,job_id=?8,application_id=?9,stage=?10,interview_at=?11,
                reminder_minutes=?12,remind_at=?13,meeting_mode=?14,meeting_link=?15,location=?16,notes=?17,
                notified_at=CASE WHEN interview_at IS ?11 AND remind_at IS ?13 THEN notified_at ELSE NULL END,
                reminder_error=CASE WHEN interview_at IS ?11 AND remind_at IS ?13 THEN reminder_error ELSE NULL END,
                reminder_lease_until=CASE WHEN interview_at IS ?11 AND remind_at IS ?13 THEN reminder_lease_until ELSE NULL END,
                reminder_retry_after=CASE WHEN interview_at IS ?11 AND remind_at IS ?13 THEN reminder_retry_after ELSE NULL END
             WHERE id=?18",
            params![title,description,input.priority,input.category,stamp,due_at,input.candidate_id,input.job_id,input.application_id,
                stage,input.interview_at,minutes,remind_at,input.meeting_mode,meeting_link,location,notes,id],
        )?;
        if changed == 0 {
            return Err(message("找不到此待办。"));
        }
        id
    } else {
        db.execute(
            "INSERT INTO todos(title,description,priority,category,created_at,updated_at,due_at,candidate_id,job_id,application_id,
               stage,interview_at,reminder_minutes,remind_at,meeting_mode,meeting_link,location,notes)
             VALUES (?1,?2,?3,?4,?5,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
            params![title,description,input.priority,input.category,stamp,due_at,input.candidate_id,input.job_id,input.application_id,
                stage,input.interview_at,minutes,remind_at,input.meeting_mode,meeting_link,location,notes],
        )?;
        db.last_insert_rowid()
    };
    get(db, id)
}

fn validate_link(db: &Connection, id: Option<i64>, sql: &str, label: &str) -> Result<()> {
    if let Some(id) = id
        && db
            .query_row(sql, [id], |r| r.get::<_, i64>(0))
            .optional()?
            .is_none()
    {
        return Err(message(format!("找不到所关联的{label}。")));
    }
    Ok(())
}

fn set_status(db: &Connection, id: i64, status: &str) -> Result<Todo> {
    check(Some(status), STATUSES, "待办状态")?;
    let changed = db.execute(
        "UPDATE todos SET status=?1,updated_at=?2,
            completed_at=CASE WHEN ?1='completed' THEN coalesce(completed_at,?2) ELSE NULL END,
            reminder_lease_until=CASE WHEN ?1='pending' THEN reminder_lease_until ELSE NULL END
         WHERE id=?3",
        params![status, now(), id],
    )?;
    if changed == 0 {
        return Err(message("找不到此待办。"));
    }
    get(db, id)
}

fn rules(db: &Connection) -> Result<Vec<Rule>> {
    let mut query = db.prepare(
        "SELECT stage,enabled FROM todo_rules
        ORDER BY CASE stage WHEN 'screened' THEN 1 WHEN 'interview' THEN 2 ELSE 3 END",
    )?;
    Ok(query
        .query_map([], |r| {
            Ok(Rule {
                stage: Stage::from_sql(r.get(0)?)?,
                enabled: r.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

fn save_rule(db: &Connection, stage: Stage, enabled: bool) -> Result<Rule> {
    if db.execute(
        "UPDATE todo_rules SET enabled=?1 WHERE stage=?2",
        params![enabled, stage.as_str()],
    )? == 0
    {
        return Err(message("此招聘阶段没有可配置的待办规则。"));
    }
    Ok(Rule { stage, enabled })
}

pub fn claim_due(store: &mut Store, stamp: i64) -> Result<Vec<DueReminder>> {
    let lease_until = stamp + REMINDER_LEASE;
    let tx = store
        .db
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    let reminders = {
        let mut query = tx.prepare(
            "SELECT id,title,remind_at,interview_at FROM todos
            WHERE status='pending' AND notified_at IS NULL AND remind_at<=?1
              AND (reminder_retry_after IS NULL OR reminder_retry_after<=?1)
              AND (reminder_lease_until IS NULL OR reminder_lease_until<=?1)
            ORDER BY remind_at,id LIMIT 64",
        )?;
        query
            .query_map([stamp], |r| {
                Ok(DueReminder {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    remind_at: r.get(2)?,
                    interview_at: r.get(3)?,
                    lease_until,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    for reminder in &reminders {
        tx.execute(
            "UPDATE todos SET reminder_lease_until=?1 WHERE id=?2",
            params![lease_until, reminder.id],
        )?;
    }
    tx.commit()?;
    Ok(reminders)
}

pub fn finish_reminder(
    store: &Store,
    reminder: &DueReminder,
    stamp: i64,
    delivered: bool,
) -> Result<bool> {
    let notified = delivered.then_some(stamp);
    let error = (!delivered).then_some("系统通知未送达，ResumeDesk 会重试。");
    let retry = (!delivered).then_some(stamp + REMINDER_RETRY);
    let changed = store.db.execute(
        "UPDATE todos SET notified_at=?1,reminder_error=?2,reminder_retry_after=?3,reminder_lease_until=NULL
         WHERE id=?4 AND reminder_lease_until=?5 AND remind_at=?6 AND interview_at=?7
           AND status='pending' AND notified_at IS NULL",
        params![notified,error,retry,reminder.id,reminder.lease_until,reminder.remind_at,reminder.interview_at],
    )?;
    Ok(changed != 0)
}

#[cfg(test)]
#[path = "todo_tests.rs"]
mod tests;
