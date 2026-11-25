CREATE TABLE candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    headline TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0,1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE files (
    hash TEXT PRIMARY KEY CHECK (length(hash)=64 AND hash NOT GLOB '*[^0-9a-f]*'),
    format TEXT NOT NULL CHECK (format IN ('pdf','docx')),
    byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 26214400)
);
CREATE TABLE resumes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    file_hash TEXT NOT NULL UNIQUE REFERENCES files(hash),
    original_name TEXT NOT NULL,
    imported_at INTEGER NOT NULL,
    extracted_text TEXT NOT NULL,
    parse_status TEXT NOT NULL CHECK (parse_status IN ('complete','partial','empty','failed'))
);
CREATE INDEX resumes_candidate ON resumes(candidate_id, imported_at DESC);
CREATE TABLE jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    department TEXT NOT NULL DEFAULT '',
    jd TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('open','paused','closed')),
    profile_sequence INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    stage TEXT NOT NULL CHECK (stage IN ('new','screened','interview','interviewed','hired','rejected','withdrawn')),
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(candidate_id, job_id)
);
CREATE INDEX applications_job_stage ON applications(job_id, stage);
CREATE INDEX applications_stage ON applications(stage);
CREATE TABLE tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE candidate_tags (
    candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY(candidate_id, tag_id)
);
CREATE TABLE notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX notes_candidate ON notes(candidate_id, created_at DESC);
CREATE TABLE app_settings (
    key TEXT PRIMARY KEY CHECK (key IN ('ai','privacy')),
    value TEXT NOT NULL
);
