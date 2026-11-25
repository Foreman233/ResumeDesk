CREATE TABLE todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL CHECK (priority IN ('low','normal','high')),
    category TEXT NOT NULL CHECK (category IN ('general','screening','interview','follow_up')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','cancelled')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    due_at INTEGER,
    completed_at INTEGER,
    candidate_id INTEGER REFERENCES candidates(id) ON DELETE SET NULL,
    job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
    application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL,
    stage TEXT CHECK (stage IN ('new','screened','interview','interviewed','hired','rejected','withdrawn')),
    interview_at INTEGER,
    reminder_minutes INTEGER CHECK (reminder_minutes BETWEEN 0 AND 10080),
    remind_at INTEGER,
    meeting_mode TEXT CHECK (meeting_mode IN ('online','onsite')),
    meeting_link TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    notified_at INTEGER,
    reminder_error TEXT,
    reminder_lease_until INTEGER,
    reminder_retry_after INTEGER,
    CHECK ((status='completed') = (completed_at IS NOT NULL)),
    CHECK ((interview_at IS NULL) = (remind_at IS NULL)),
    CHECK ((interview_at IS NULL) = (reminder_minutes IS NULL)),
    CHECK (interview_at IS NULL OR category='interview')
);
CREATE INDEX todos_due ON todos(status,due_at,id);
CREATE INDEX todos_reminders ON todos(remind_at,id) WHERE status='pending' AND notified_at IS NULL;
CREATE INDEX todos_candidate ON todos(candidate_id);
CREATE INDEX todos_job ON todos(job_id);
CREATE INDEX todos_application ON todos(application_id);

CREATE TABLE todo_rules (
    stage TEXT PRIMARY KEY CHECK (stage IN ('screened','interview','interviewed')),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1))
);
INSERT INTO todo_rules(stage) VALUES ('screened'),('interview'),('interviewed');

CREATE TABLE todo_rule_events (
    stage TEXT NOT NULL REFERENCES todo_rules(stage) ON DELETE CASCADE,
    application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    PRIMARY KEY(stage,application_id)
);

CREATE TRIGGER todos_application_stage_rule
AFTER UPDATE OF stage ON applications
WHEN OLD.stage <> NEW.stage
  AND EXISTS(SELECT 1 FROM todo_rules WHERE stage=NEW.stage AND enabled=1)
  AND NOT EXISTS(SELECT 1 FROM todo_rule_events WHERE stage=NEW.stage AND application_id=NEW.id)
BEGIN
    INSERT INTO todo_rule_events(stage,application_id) VALUES (NEW.stage,NEW.id);
    INSERT INTO todos(title,priority,category,created_at,updated_at,candidate_id,job_id,application_id,stage)
    VALUES (
        CASE NEW.stage WHEN 'screened' THEN '邀约面试' WHEN 'interview' THEN '安排面试' ELSE '收集面试反馈' END,
        'normal','follow_up',NEW.updated_at,NEW.updated_at,NEW.candidate_id,NEW.job_id,NEW.id,NEW.stage
    );
END;
