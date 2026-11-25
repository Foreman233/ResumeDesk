CREATE TABLE skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    category TEXT NOT NULL
);
CREATE TABLE skill_aliases (
    skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    alias TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY(skill_id, alias)
);
CREATE TABLE job_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    file_hash TEXT NOT NULL REFERENCES files(hash),
    original_name TEXT NOT NULL,
    imported_at INTEGER NOT NULL,
    extracted_text TEXT NOT NULL,
    parse_status TEXT NOT NULL CHECK (parse_status IN ('complete','partial','empty','failed')),
    UNIQUE(job_id, file_hash)
);
CREATE TABLE job_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('manual','local','ai')),
    status TEXT NOT NULL CHECK (status IN ('draft','confirmed')),
    based_on INTEGER REFERENCES job_profiles(id) ON DELETE SET NULL,
    summary TEXT NOT NULL,
    insights TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(job_id, version)
);
CREATE TABLE job_profile_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES job_profiles(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('jd','resume','sample')),
    resume_id INTEGER REFERENCES resumes(id) ON DELETE CASCADE,
    sample_id INTEGER REFERENCES job_samples(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    usable INTEGER NOT NULL CHECK (usable IN (0,1)),
    UNIQUE(profile_id, ordinal),
    CHECK ((kind='jd' AND resume_id IS NULL AND sample_id IS NULL)
        OR (kind='resume' AND resume_id IS NOT NULL AND sample_id IS NULL)
        OR (kind='sample' AND resume_id IS NULL AND sample_id IS NOT NULL))
);
CREATE INDEX profile_sources_resume ON job_profile_sources(resume_id);
CREATE INDEX profile_sources_sample ON job_profile_sources(sample_id);
CREATE TABLE job_profile_skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES job_profiles(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    classification TEXT NOT NULL CHECK (classification IN ('required','preferred','reference')),
    suggestion TEXT NOT NULL CHECK (suggestion IN ('required','preferred','reference')),
    explanation TEXT NOT NULL
);
CREATE INDEX profile_skills_profile ON job_profile_skills(profile_id, id);
CREATE TABLE job_profile_evidence (
    skill_id INTEGER NOT NULL REFERENCES job_profile_skills(id) ON DELETE CASCADE,
    source_id INTEGER NOT NULL REFERENCES job_profile_sources(id) ON DELETE CASCADE,
    quote TEXT NOT NULL,
    PRIMARY KEY(skill_id, source_id)
);

-- Delete entire derived versions when a personal source is removed. Summary and
-- user-reviewed prose can contain personal data beyond the evidence snippets.
CREATE TRIGGER resume_remove_profiles BEFORE DELETE ON resumes BEGIN
    DELETE FROM job_profiles WHERE id IN (SELECT profile_id FROM job_profile_sources WHERE resume_id=OLD.id);
END;
CREATE TRIGGER sample_remove_profiles BEFORE DELETE ON job_samples BEGIN
    DELETE FROM job_profiles WHERE id IN (SELECT profile_id FROM job_profile_sources WHERE sample_id=OLD.id);
END;
