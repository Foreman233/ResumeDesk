CREATE TABLE tool_hub_layout (
    id INTEGER PRIMARY KEY CHECK (id=1),
    version INTEGER NOT NULL,
    widgets TEXT NOT NULL
);

CREATE TABLE knowledge_views (
    document_id INTEGER PRIMARY KEY REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    viewed_at INTEGER NOT NULL
);
CREATE INDEX knowledge_views_recent ON knowledge_views(viewed_at DESC);
