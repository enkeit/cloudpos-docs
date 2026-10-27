-- Files attached to chat messages (bytes in the R2 bucket under uploads/<id>).
-- `owner` matches conversations.owner; reads always filter on it.
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'pdf')),
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  pages INTEGER,
  text TEXT, -- a PDF's text (Workers AI toMarkdown), given to the model
  created_at INTEGER NOT NULL
);
CREATE INDEX attachments_owner ON attachments (owner, created_at);
CREATE INDEX attachments_created ON attachments (created_at);

-- JSON array of {id, kind, name, size, pages} sent with a user message.
ALTER TABLE messages ADD COLUMN attachments TEXT;
