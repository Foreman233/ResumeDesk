CREATE TABLE interview_guides (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    candidate_id INTEGER REFERENCES candidates(id) ON DELETE CASCADE,
    job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
    application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL,
    resume_id INTEGER REFERENCES resumes(id) ON DELETE SET NULL,
    job_title TEXT NOT NULL,
    temporary_jd TEXT NOT NULL,
    interview_date TEXT NOT NULL,
    generation_config TEXT NOT NULL CHECK (json_valid(generation_config)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX interview_guides_recent ON interview_guides(updated_at DESC, id DESC);
CREATE INDEX interview_guides_candidate ON interview_guides(candidate_id);
CREATE INDEX interview_guides_job ON interview_guides(job_id);

CREATE TABLE interview_questions (
    guide_id INTEGER NOT NULL REFERENCES interview_guides(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL CHECK (sort_order BETWEEN 0 AND 49),
    details TEXT NOT NULL CHECK (json_valid(details)),
    PRIMARY KEY (guide_id, sort_order)
);

UPDATE tool_hub_layout
SET widgets = json_insert(widgets, '$[#]',
    json_object('id', 'interview', 'width', 2, 'height', 3, 'visible', json('true')))
WHERE version = 1 AND CASE WHEN json_valid(widgets) THEN json_type(widgets) = 'array' ELSE 0 END
  AND NOT EXISTS (
      SELECT 1 FROM json_each(CASE WHEN json_valid(widgets) THEN widgets ELSE '[]' END)
      WHERE CASE WHEN type = 'object' THEN json_extract(value, '$.id') = 'interview' ELSE 0 END
  );
