CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL, completion_tokens INTEGER NOT NULL,
  created_at TEXT NOT NULL, usage_missing INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_usage_user_created ON usage(user_id,created_at);
CREATE TABLE IF NOT EXISTS quotas(user_id TEXT PRIMARY KEY,monthly_tokens INTEGER NOT NULL);
