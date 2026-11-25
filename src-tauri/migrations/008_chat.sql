CREATE TABLE chat_conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('general','workspace')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user','assistant')),
    body TEXT NOT NULL,
    scope_key TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);
CREATE INDEX chat_messages_conversation ON chat_messages(conversation_id, id);
CREATE TABLE chat_message_sources (
    message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    label TEXT NOT NULL,
    candidate_id INTEGER REFERENCES candidates(id) ON DELETE CASCADE,
    job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
    resume_id INTEGER REFERENCES resumes(id) ON DELETE CASCADE,
    PRIMARY KEY(message_id, ordinal),
    CHECK (candidate_id IS NOT NULL OR job_id IS NOT NULL)
);
CREATE INDEX chat_sources_candidate ON chat_message_sources(candidate_id);
CREATE INDEX chat_sources_job ON chat_message_sources(job_id);
CREATE INDEX chat_sources_resume ON chat_message_sources(resume_id);
CREATE TRIGGER chat_remove_candidate_context BEFORE DELETE ON candidates BEGIN
    DELETE FROM chat_conversations WHERE id IN (
        SELECT m.conversation_id FROM chat_messages m JOIN chat_message_sources s ON s.message_id=m.id
        WHERE s.candidate_id=OLD.id
    );
END;
CREATE TRIGGER chat_remove_job_context BEFORE DELETE ON jobs BEGIN
    DELETE FROM chat_conversations WHERE id IN (
        SELECT m.conversation_id FROM chat_messages m JOIN chat_message_sources s ON s.message_id=m.id
        WHERE s.job_id=OLD.id
    );
END;
CREATE TRIGGER chat_remove_resume_context BEFORE DELETE ON resumes BEGIN
    DELETE FROM chat_conversations WHERE id IN (
        SELECT m.conversation_id FROM chat_messages m JOIN chat_message_sources s ON s.message_id=m.id
        WHERE s.resume_id=OLD.id
    );
END;
