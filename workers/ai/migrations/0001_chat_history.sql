-- Chat history. `owner` is "live:<tenant domain>:<user id>" for signed-in
-- users or "guest:<random visitor id>" for guests; every query filters on it.
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX conversations_owner_updated ON conversations (owner, updated_at DESC);
CREATE INDEX conversations_updated ON conversations (updated_at);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  visuals TEXT, -- JSON array of chart/table visuals shown with an answer
  created_at INTEGER NOT NULL
);
CREATE INDEX messages_conversation ON messages (conversation_id, id);
