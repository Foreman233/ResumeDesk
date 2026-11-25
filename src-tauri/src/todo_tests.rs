use crate::model::{CandidateInput, JobInput, JobStatus};

use super::*;

fn input(title: &str, at: Option<i64>) -> TodoInput {
    TodoInput {
        id: None,
        title: title.into(),
        description: "虚构工作记录".into(),
        priority: "normal".into(),
        category: if at.is_some() {
            "interview".into()
        } else {
            "general".into()
        },
        due_at: None,
        candidate_id: None,
        job_id: None,
        application_id: None,
        stage: None,
        interview_at: at,
        reminder_minutes: Some(10),
        meeting_mode: None,
        meeting_link: String::new(),
        location: String::new(),
        notes: String::new(),
    }
}

fn app(store: &mut Store) -> (i64, i64, i64) {
    let candidate = store
        .save_candidate(CandidateInput {
            id: None,
            name: "虚构候选".into(),
            headline: String::new(),
            email: String::new(),
            phone: String::new(),
            favorite: false,
            tags: Vec::new(),
        })
        .unwrap();
    let job = store
        .save_job(JobInput {
            id: None,
            title: "虚构岗位".into(),
            department: String::new(),
            jd: String::new(),
            status: JobStatus::Open,
        })
        .unwrap();
    let application = store.link_application(candidate, job).unwrap();
    (candidate, job, application)
}

#[test]
fn todo_crud_fetches_real_links_and_keeps_completion_timestamp() {
    let folder = tempfile::tempdir().unwrap();
    let mut store = Store::open(folder.path()).unwrap();
    let (candidate, job, application) = app(&mut store);
    let mut item = input("联络候选人", Some(10_000));
    item.application_id = Some(application);
    item.meeting_mode = Some("online".into());
    item.meeting_link = "https://meeting.example.invalid/interview".into();
    let row = save(&store.db, item).unwrap();
    assert_eq!(row.candidate_id, Some(candidate));
    assert_eq!(row.job_id, Some(job));
    assert_eq!(row.stage, Some(Stage::New));
    assert_eq!(row.candidate_name.as_deref(), Some("虚构候选"));
    assert_eq!(row.due_at, Some(10_000));
    assert_eq!(row.remind_at, Some(9_400));
    let mut mismatched = input("无效关联", None);
    mismatched.application_id = Some(application);
    mismatched.job_id = Some(i64::MAX);
    assert!(save(&store.db, mismatched).is_err());
    let filtered = list(
        &store.db,
        Filter {
            job_id: Some(job),
            query: Some("虚构候选".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(filtered.len(), 1);
    let completed = set_status(&store.db, row.id, "completed").unwrap();
    assert!(completed.completed_at.is_some());
    assert_eq!(
        set_status(&store.db, row.id, "completed")
            .unwrap()
            .completed_at,
        completed.completed_at
    );
    assert!(claim_due(&mut store, 20_000).unwrap().is_empty());
    assert_eq!(
        set_status(&store.db, row.id, "cancelled")
            .unwrap()
            .completed_at,
        None
    );
    assert!(claim_due(&mut store, 20_000).unwrap().is_empty());
    dispatch(&mut store, Command::Delete { id: row.id }).unwrap();
    assert!(list(&store.db, Filter::default()).unwrap().is_empty());
}

#[test]
fn enabled_stage_rule_only_creates_one_todo_per_stage_and_application() {
    let folder = tempfile::tempdir().unwrap();
    let mut store = Store::open(folder.path()).unwrap();
    let (_, _, application) = app(&mut store);
    assert!(rules(&store.db).unwrap().iter().all(|rule| !rule.enabled));
    store
        .save_application(application, Stage::Screened, "")
        .unwrap();
    assert!(list(&store.db, Filter::default()).unwrap().is_empty());
    save_rule(&store.db, Stage::Interview, true).unwrap();
    store
        .save_application(application, Stage::Interview, "")
        .unwrap();
    store
        .save_application(application, Stage::Interview, "另存备注")
        .unwrap();
    let tasks = list(&store.db, Filter::default()).unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].title, "安排面试");
    assert_eq!(tasks[0].stage, Some(Stage::Interview));
    dispatch(&mut store, Command::Delete { id: tasks[0].id }).unwrap();
    store
        .save_application(application, Stage::Screened, "")
        .unwrap();
    store
        .save_application(application, Stage::Interview, "")
        .unwrap();
    assert!(list(&store.db, Filter::default()).unwrap().is_empty());
}

#[test]
fn due_reminders_recover_after_restart_and_do_not_repeat_successes() {
    let folder = tempfile::tempdir().unwrap();
    let mut store = Store::open(folder.path()).unwrap();
    let first = save(&store.db, input("同时面试一", Some(2_000_000))).unwrap();
    let second = save(&store.db, input("同时面试二", Some(2_000_000))).unwrap();
    let due = first.remind_at.unwrap();
    assert!(claim_due(&mut store, due - 1).unwrap().is_empty());
    let claimed = claim_due(&mut store, due).unwrap();
    assert_eq!(
        claimed
            .iter()
            .map(|reminder| reminder.id)
            .collect::<Vec<_>>(),
        vec![first.id, second.id]
    );
    assert!(claim_due(&mut store, due + 1).unwrap().is_empty());
    assert!(finish_reminder(&store, &claimed[0], due, true).unwrap());
    assert!(finish_reminder(&store, &claimed[1], due, false).unwrap());
    assert!(get(&store.db, second.id).unwrap().reminder_error.is_some());
    drop(store);

    let mut store = Store::open(folder.path()).unwrap();
    assert!(
        claim_due(&mut store, due + REMINDER_RETRY - 1)
            .unwrap()
            .is_empty()
    );
    let next = claim_due(&mut store, due + REMINDER_RETRY).unwrap();
    assert_eq!(next.len(), 1);
    assert_eq!(next[0].id, second.id);
    assert!(
        !finish_reminder(&store, &claimed[1], due + REMINDER_RETRY, true).unwrap(),
        "old lease may not acknowledge a new delivery"
    );
    assert!(finish_reminder(&store, &next[0], due + REMINDER_RETRY, true).unwrap());
    assert!(claim_due(&mut store, due + 100_000).unwrap().is_empty());

    let mut rescheduled = input("改期面试", Some(2_100_000));
    rescheduled.id = Some(first.id);
    let row = save(&store.db, rescheduled).unwrap();
    assert_eq!(row.notified_at, None);
    assert_eq!(
        claim_due(&mut store, row.remind_at.unwrap()).unwrap()[0].id,
        first.id
    );
    drop(store);
    let mut store = Store::open(folder.path()).unwrap();
    assert_eq!(
        claim_due(&mut store, row.remind_at.unwrap() + REMINDER_LEASE).unwrap()[0].id,
        first.id
    );
}
