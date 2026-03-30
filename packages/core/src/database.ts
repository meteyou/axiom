import BetterSqlite3 from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'

export type Database = BetterSqlite3.Database

let db: Database | null = null

const SCHEMA = `
CREATE TABLE IF NOT EXISTS token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost REAL NOT NULL DEFAULT 0.0,
  session_id TEXT
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  session_id TEXT,
  tool_name TEXT NOT NULL,
  input TEXT,
  output TEXT,
  duration_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'success' CHECK(status IN ('success', 'error'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  telegram_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER,
  source TEXT NOT NULL DEFAULT 'web',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  summary_written INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS health_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  provider TEXT,
  status TEXT NOT NULL CHECK(status IN ('healthy', 'degraded', 'down', 'unconfigured')),
  latency_ms INTEGER,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_token_usage_timestamp ON token_usage(timestamp);
CREATE INDEX IF NOT EXISTS idx_token_usage_provider ON token_usage(provider);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_timestamp ON tool_calls(timestamp);
CREATE INDEX IF NOT EXISTS idx_tool_calls_tool_name ON tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_health_checks_timestamp ON health_checks(timestamp);
CREATE INDEX IF NOT EXISTS idx_health_checks_provider ON health_checks(provider);
CREATE INDEX IF NOT EXISTS idx_health_checks_status ON health_checks(status);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  user_id INTEGER,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'tool', 'system')),
  content TEXT NOT NULL,
  metadata TEXT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS telegram_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT NOT NULL UNIQUE,
  telegram_username TEXT,
  telegram_display_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
  user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_user ON chat_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_timestamp ON chat_messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_telegram_users_telegram_id ON telegram_users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_telegram_users_status ON telegram_users(status);
`

export function initDatabase(dbPath?: string): Database {
  const resolvedPath = dbPath ?? path.join(
    process.env.DATA_DIR ?? '/data',
    'db',
    'openagent.db'
  )

  // Ensure directory exists
  const dir = path.dirname(resolvedPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  db = new BetterSqlite3(resolvedPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)

  // Migration: add status column to tool_calls if missing
  const cols = db.prepare("PRAGMA table_info(tool_calls)").all() as { name: string }[]
  if (!cols.find(c => c.name === 'status')) {
    db.exec("ALTER TABLE tool_calls ADD COLUMN status TEXT NOT NULL DEFAULT 'success' CHECK(status IN ('success', 'error'))")
  }

  // Migration: add metadata column and tool role to chat_messages if missing
  const chatCols = db.prepare("PRAGMA table_info(chat_messages)").all() as { name: string }[]
  if (!chatCols.find(c => c.name === 'metadata')) {
    db.exec("ALTER TABLE chat_messages ADD COLUMN metadata TEXT")
  }
  // Recreate table if CHECK constraint doesn't include 'system' role
  // SQLite doesn't support ALTER CHECK, so we test by inserting
  try {
    db.exec("INSERT INTO chat_messages (session_id, user_id, role, content) VALUES ('__migration_test__', NULL, 'system', 'test')")
    db.exec("DELETE FROM chat_messages WHERE session_id = '__migration_test__'")
  } catch {
    // CHECK constraint failed — need to recreate table with updated roles
    db.exec(`
      ALTER TABLE chat_messages RENAME TO chat_messages_old;
      CREATE TABLE chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        user_id INTEGER,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'tool', 'system')),
        content TEXT NOT NULL,
        metadata TEXT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      INSERT INTO chat_messages (id, session_id, user_id, role, content, timestamp)
        SELECT id, session_id, user_id, role, content, timestamp FROM chat_messages_old;
      DROP TABLE chat_messages_old;
    `)
  }

  // Create tasks table
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running', 'paused', 'completed', 'failed')),
      trigger_type TEXT NOT NULL CHECK(trigger_type IN ('user', 'agent', 'cronjob')),
      trigger_source_id TEXT,
      provider TEXT,
      model TEXT,
      max_duration_minutes INTEGER,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost REAL NOT NULL DEFAULT 0.0,
      tool_call_count INTEGER NOT NULL DEFAULT 0,
      result_summary TEXT,
      result_status TEXT CHECK(result_status IS NULL OR result_status IN ('completed', 'failed', 'question')),
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      session_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_trigger_type ON tasks(trigger_type);
    CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_session_id ON tasks(session_id);
  `)

  // Create scheduled_tasks table
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule TEXT NOT NULL,
      provider TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      tools_override TEXT,
      skills_override TEXT,
      system_prompt_override TEXT,
      last_run_at TEXT,
      last_run_task_id TEXT,
      last_run_status TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  // Migration: add action_type column to scheduled_tasks
  const scheduledCols = db.prepare("PRAGMA table_info(scheduled_tasks)").all() as { name: string }[]
  if (!scheduledCols.find(c => c.name === 'action_type')) {
    db.exec("ALTER TABLE scheduled_tasks ADD COLUMN action_type TEXT NOT NULL DEFAULT 'task'")
  }

  // Migration: add 'paused' to tasks status CHECK constraint
  // Test by inserting a paused row — if CHECK fails, recreate the table
  try {
    db.exec("INSERT INTO tasks (id, name, prompt, status, trigger_type) VALUES ('__migration_test_paused__', 'test', 'test', 'paused', 'user')")
    db.exec("DELETE FROM tasks WHERE id = '__migration_test_paused__'")
  } catch {
    db.exec(`
      ALTER TABLE tasks RENAME TO tasks_old;
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running', 'paused', 'completed', 'failed')),
        trigger_type TEXT NOT NULL CHECK(trigger_type IN ('user', 'agent', 'cronjob')),
        trigger_source_id TEXT,
        provider TEXT,
        model TEXT,
        max_duration_minutes INTEGER,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost REAL NOT NULL DEFAULT 0.0,
        tool_call_count INTEGER NOT NULL DEFAULT 0,
        result_summary TEXT,
        result_status TEXT CHECK(result_status IS NULL OR result_status IN ('completed', 'failed', 'question')),
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        started_at TEXT,
        completed_at TEXT,
        session_id TEXT
      );
      INSERT INTO tasks SELECT * FROM tasks_old;
      DROP TABLE tasks_old;
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_trigger_type ON tasks(trigger_type);
      CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_session_id ON tasks(session_id);
    `)
  }

  return db
}

export function getDatabase(): Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.')
  }
  return db
}
