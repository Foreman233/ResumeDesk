CREATE TABLE knowledge_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE knowledge_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_hash TEXT NOT NULL CHECK (length(file_hash)=64 AND file_hash NOT GLOB '*[^0-9a-f]*'),
    format TEXT NOT NULL CHECK (format IN ('pdf','docx','txt','md','csv')),
    byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 26214400),
    name TEXT NOT NULL,
    category_id INTEGER REFERENCES knowledge_categories(id) ON DELETE SET NULL,
    uploaded_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    parse_status TEXT NOT NULL CHECK (parse_status IN ('complete','partial','empty','failed')),
    ai_allowed INTEGER NOT NULL DEFAULT 0 CHECK (ai_allowed IN (0,1)),
    index_version INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    region TEXT NOT NULL DEFAULT '',
    issuer TEXT NOT NULL DEFAULT '',
    published_on TEXT NOT NULL DEFAULT '',
    effective_on TEXT NOT NULL DEFAULT '',
    expires_on TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL DEFAULT '',
    UNIQUE(file_hash,format)
);
CREATE INDEX knowledge_by_category ON knowledge_documents(category_id,uploaded_at DESC);

CREATE TABLE knowledge_chunks (
    document_id INTEGER NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    page INTEGER CHECK (page BETWEEN 1 AND 100),
    text TEXT NOT NULL,
    PRIMARY KEY(document_id,ordinal)
);
CREATE TABLE knowledge_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE knowledge_document_tags (
    document_id INTEGER NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES knowledge_tags(id) ON DELETE CASCADE,
    PRIMARY KEY(document_id,tag_id)
);
CREATE INDEX knowledge_by_tag ON knowledge_document_tags(tag_id,document_id);

ALTER TABLE chat_message_sources ADD COLUMN evidence TEXT NOT NULL DEFAULT '';
CREATE TABLE chat_reference_sources (
    message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    label TEXT NOT NULL,
    evidence TEXT NOT NULL,
    document_id INTEGER REFERENCES knowledge_documents(id) ON DELETE SET NULL,
    page INTEGER CHECK (page BETWEEN 1 AND 100),
    chunk_ordinal INTEGER,
    url TEXT,
    retrieved_at INTEGER,
    PRIMARY KEY(message_id,ordinal),
    CHECK (url IS NULL OR (document_id IS NULL AND retrieved_at IS NOT NULL))
);
CREATE INDEX chat_reference_document ON chat_reference_sources(document_id);
CREATE TRIGGER knowledge_remove_chat_context BEFORE DELETE ON knowledge_documents BEGIN
    DELETE FROM chat_conversations WHERE id IN (
        SELECT m.conversation_id FROM chat_messages m JOIN chat_reference_sources s ON s.message_id=m.id
        WHERE s.document_id=OLD.id
    );
END;

CREATE TABLE ai_consents (
    provider TEXT NOT NULL,
    capability TEXT NOT NULL CHECK (capability IN ('general','recruiting','knowledge','web')),
    scope_key TEXT NOT NULL,
    description TEXT NOT NULL,
    granted_at INTEGER NOT NULL,
    PRIMARY KEY(provider,capability,scope_key)
);
CREATE INDEX ai_consents_recent ON ai_consents(granted_at DESC);

CREATE TABLE web_search_settings (
    id INTEGER PRIMARY KEY CHECK (id=1),
    endpoint TEXT NOT NULL,
    timeout_seconds INTEGER NOT NULL CHECK (timeout_seconds BETWEEN 5 AND 60)
);

CREATE TABLE candidate_views (
    candidate_id INTEGER PRIMARY KEY REFERENCES candidates(id) ON DELETE CASCADE,
    viewed_at INTEGER NOT NULL
);
CREATE TABLE dashboard_layout (
    id INTEGER PRIMARY KEY CHECK (id=1),
    version INTEGER NOT NULL,
    widgets TEXT NOT NULL
);
