CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS expenses_user_occurred
  ON expenses (user_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS pending_expenses (
  user_id TEXT PRIMARY KEY,
  amount INTEGER NOT NULL CHECK (amount > 0),
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_expense_deletions (
  user_id TEXT PRIMARY KEY,
  expense_id INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_line_events (
  event_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pending_expense_edits (
  user_id TEXT PRIMARY KEY,
  expense_id INTEGER NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_expense_edit_targets (
  user_id TEXT PRIMARY KEY,
  expense_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS expense_undo (
  user_id TEXT PRIMARY KEY,
  expense_id INTEGER NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS monthly_budgets (
  user_id TEXT NOT NULL,
  month TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  alert_80_sent INTEGER NOT NULL DEFAULT 0 CHECK (alert_80_sent IN (0, 1)),
  alert_100_sent INTEGER NOT NULL DEFAULT 0 CHECK (alert_100_sent IN (0, 1)),
  PRIMARY KEY (user_id, month)
);

CREATE TABLE IF NOT EXISTS bot_model_status (
  user_id TEXT PRIMARY KEY,
  available INTEGER NOT NULL CHECK (available IN (0, 1)),
  checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS expense_query_sessions (
  user_id TEXT PRIMARY KEY,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  category TEXT,
  page INTEGER NOT NULL DEFAULT 0 CHECK (page >= 0)
);

CREATE TABLE IF NOT EXISTS monthly_expense_list_sessions (
  user_id TEXT PRIMARY KEY,
  page INTEGER NOT NULL DEFAULT 0 CHECK (page >= 0)
);

CREATE TABLE IF NOT EXISTS gemini_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  total_tokens INTEGER NOT NULL CHECK (total_tokens >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS gemini_usage_user_created
  ON gemini_usage (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS unanswered_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS unanswered_questions_created
  ON unanswered_questions (created_at DESC);

CREATE TABLE IF NOT EXISTS quick_expense_sessions (
  user_id TEXT PRIMARY KEY,
  step TEXT NOT NULL CHECK (step IN ('amount', 'category', 'description', 'date')),
  amount INTEGER CHECK (amount IS NULL OR amount > 0),
  category TEXT,
  description TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS line_rich_menu_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  rich_menu_id TEXT NOT NULL,
  image_uploaded INTEGER NOT NULL DEFAULT 0 CHECK (image_uploaded IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
