CREATE TABLE tasks (
    id              TEXT PRIMARY KEY,
    source          TEXT NOT NULL CHECK (source IN ('manual', 'whatsapp')),
    text            TEXT NOT NULL,
    priority        TEXT NOT NULL DEFAULT 'medium',
    category        TEXT NOT NULL DEFAULT 'personal',
    due_at          TEXT,
    has_time        INTEGER NOT NULL DEFAULT 0,
    completed       INTEGER NOT NULL DEFAULT 0,
    completed_at    TEXT,
    message_id      TEXT UNIQUE,
    chat_id         TEXT,
    group_name      TEXT,
    pusher_name     TEXT,
    content         TEXT,
    reminded        INTEGER NOT NULL DEFAULT 0,
    reminded_at     TEXT,
    notified_complete_at TEXT,
    display_order   INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX idx_tasks_source_created ON tasks(source, created_at DESC);
CREATE INDEX idx_tasks_due_pending ON tasks(due_at) WHERE completed = 0 AND reminded = 0 AND due_at IS NOT NULL;
CREATE INDEX idx_tasks_message_id ON tasks(message_id);

CREATE TABLE task_assignees (
    task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    wa_id       TEXT NOT NULL,
    number      TEXT NOT NULL,
    name        TEXT NOT NULL,
    PRIMARY KEY (task_id, wa_id)
);

CREATE TABLE seen_messages (
    message_id  TEXT PRIMARY KEY,
    seen_at     TEXT NOT NULL
);
