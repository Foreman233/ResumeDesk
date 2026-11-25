CREATE TABLE widget_settings (
    key TEXT PRIMARY KEY CHECK (key IN ('controls','window')),
    value TEXT NOT NULL
);
