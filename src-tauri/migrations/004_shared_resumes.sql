CREATE TABLE resumes_v4 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    file_hash TEXT NOT NULL REFERENCES files(hash),
    original_name TEXT NOT NULL,
    imported_at INTEGER NOT NULL,
    extracted_text TEXT NOT NULL,
    parse_status TEXT NOT NULL CHECK (parse_status IN ('complete','partial','empty','failed')),
    section INTEGER NOT NULL DEFAULT 0 CHECK (section >= 0),
    UNIQUE(file_hash, section)
);
INSERT INTO resumes_v4(id,candidate_id,file_hash,original_name,imported_at,extracted_text,parse_status)
SELECT id,candidate_id,file_hash,original_name,imported_at,extracted_text,parse_status FROM resumes;

-- Preserve the ID high-water mark even if the newest records were deleted.
INSERT INTO sqlite_sequence(name,seq)
SELECT 'resumes_v4',0 WHERE NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='resumes_v4');
UPDATE sqlite_sequence SET seq=max(seq,coalesce((SELECT seq FROM sqlite_sequence WHERE name='resumes'),0))
WHERE name='resumes_v4';

DROP TRIGGER resume_remove_profiles;
DROP TABLE resumes;
ALTER TABLE resumes_v4 RENAME TO resumes;
CREATE INDEX resumes_candidate ON resumes(candidate_id, imported_at DESC);
CREATE TRIGGER resume_remove_profiles BEFORE DELETE ON resumes BEGIN
    DELETE FROM job_profiles WHERE id IN (SELECT profile_id FROM job_profile_sources WHERE resume_id=OLD.id);
END;
