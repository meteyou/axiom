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
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  session_id TEXT,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'session',
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  embedding BLOB,
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
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);
CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp);
CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
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

function tableExists(db: Database, tableName: string): boolean {
  const row = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(tableName)
  return !!row
}

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
      INSERT INTO chat_messages (id, session_id, user_id, role, content, metadata, timestamp)
        SELECT id, session_id, user_id, role, content, metadata, timestamp FROM chat_messages_old;
      DROP TABLE chat_messages_old;
    `)
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_user ON chat_messages(user_id);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_timestamp ON chat_messages(timestamp);
  `)

  const memoriesFtsExists = tableExists(db, 'memories_fts')
  const chatMessagesFtsExists = tableExists(db, 'chat_messages_fts')

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      content=memories,
      content_rowid=id,
      tokenize="unicode61 remove_diacritics 2"
    );

    CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE OF content ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END;
  `)

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts USING fts5(
      content,
      content=chat_messages,
      content_rowid=id,
      tokenize="unicode61 remove_diacritics 2"
    );

    CREATE TRIGGER IF NOT EXISTS chat_messages_fts_insert AFTER INSERT ON chat_messages BEGIN
      INSERT INTO chat_messages_fts(rowid, content) VALUES (new.id, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS chat_messages_fts_delete AFTER DELETE ON chat_messages BEGIN
      INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content) VALUES('delete', old.id, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS chat_messages_fts_update AFTER UPDATE OF content ON chat_messages BEGIN
      INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content) VALUES('delete', old.id, old.content);
      INSERT INTO chat_messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
  `)

  // Backfill external-content FTS indexes only when the virtual table is first
  // created during migration. Rebuilding on every boot rescans the full dataset
  // and can significantly slow startup on larger installations.
  if (!memoriesFtsExists) {
    db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')")
  }
  if (!chatMessagesFtsExists) {
    db.exec("INSERT INTO chat_messages_fts(chat_messages_fts) VALUES('rebuild')")
  }

  // Create tasks table
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running', 'paused', 'completed', 'failed')),
      trigger_type TEXT NOT NULL CHECK(trigger_type IN ('user', 'agent', 'cronjob', 'heartbeat', 'consolidation')),
      trigger_source_id TEXT,
      provider TEXT,
      model TEXT,
      max_duration_minutes INTEGER,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost REAL NOT NULL DEFAULT 0.0,
      tool_call_count INTEGER NOT NULL DEFAULT 0,
      result_summary TEXT,
      result_status TEXT CHECK(result_status IS NULL OR result_status IN ('completed', 'failed', 'question', 'silent')),
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
        trigger_type TEXT NOT NULL CHECK(trigger_type IN ('user', 'agent', 'cronjob', 'heartbeat', 'consolidation')),
        trigger_source_id TEXT,
        provider TEXT,
        model TEXT,
        max_duration_minutes INTEGER,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost REAL NOT NULL DEFAULT 0.0,
        tool_call_count INTEGER NOT NULL DEFAULT 0,
        result_summary TEXT,
        result_status TEXT CHECK(result_status IS NULL OR result_status IN ('completed', 'failed', 'question', 'silent')),
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

  // Migration: add 'silent' to tasks result_status CHECK constraint
  // Test by inserting a silent row — if CHECK fails, recreate the table
  try {
    db.exec("INSERT INTO tasks (id, name, prompt, status, trigger_type, result_status) VALUES ('__migration_test_silent__', 'test', 'test', 'completed', 'user', 'silent')")
    db.exec("DELETE FROM tasks WHERE id = '__migration_test_silent__'")
  } catch {
    db.exec(`
      ALTER TABLE tasks RENAME TO tasks_old;
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running', 'paused', 'completed', 'failed')),
        trigger_type TEXT NOT NULL CHECK(trigger_type IN ('user', 'agent', 'cronjob', 'heartbeat', 'consolidation')),
        trigger_source_id TEXT,
        provider TEXT,
        model TEXT,
        max_duration_minutes INTEGER,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost REAL NOT NULL DEFAULT 0.0,
        tool_call_count INTEGER NOT NULL DEFAULT 0,
        result_summary TEXT,
        result_status TEXT CHECK(result_status IS NULL OR result_status IN ('completed', 'failed', 'question', 'silent')),
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

  // Migration: add 'heartbeat' to tasks trigger_type CHECK constraint
  // Test by inserting a heartbeat row — if CHECK fails, recreate the table
  try {
    db.exec("INSERT INTO tasks (id, name, prompt, status, trigger_type) VALUES ('__migration_test_heartbeat__', 'test', 'test', 'running', 'heartbeat')")
    db.exec("DELETE FROM tasks WHERE id = '__migration_test_heartbeat__'")
  } catch {
    db.exec(`
      ALTER TABLE tasks RENAME TO tasks_old;
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running', 'paused', 'completed', 'failed')),
        trigger_type TEXT NOT NULL CHECK(trigger_type IN ('user', 'agent', 'cronjob', 'heartbeat', 'consolidation')),
        trigger_source_id TEXT,
        provider TEXT,
        model TEXT,
        max_duration_minutes INTEGER,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost REAL NOT NULL DEFAULT 0.0,
        tool_call_count INTEGER NOT NULL DEFAULT 0,
        result_summary TEXT,
        result_status TEXT CHECK(result_status IS NULL OR result_status IN ('completed', 'failed', 'question', 'silent')),
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

  // Migration: add 'consolidation' to tasks trigger_type CHECK constraint
  try {
    db.exec("INSERT INTO tasks (id, name, prompt, status, trigger_type) VALUES ('__migration_test_consolidation__', 'test', 'test', 'running', 'consolidation')")
    db.exec("DELETE FROM tasks WHERE id = '__migration_test_consolidation__'")
  } catch {
    db.exec(`
      ALTER TABLE tasks RENAME TO tasks_old;
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running', 'paused', 'completed', 'failed')),
        trigger_type TEXT NOT NULL CHECK(trigger_type IN ('user', 'agent', 'cronjob', 'heartbeat', 'consolidation')),
        trigger_source_id TEXT,
        provider TEXT,
        model TEXT,
        max_duration_minutes INTEGER,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost REAL NOT NULL DEFAULT 0.0,
        tool_call_count INTEGER NOT NULL DEFAULT 0,
        result_summary TEXT,
        result_status TEXT CHECK(result_status IS NULL OR result_status IN ('completed', 'failed', 'question', 'silent')),
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

  // Migration: add last_activity, session_user, and token columns to sessions table
  const sessionCols = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]
  if (!sessionCols.find(c => c.name === 'last_activity')) {
    db.exec("ALTER TABLE sessions ADD COLUMN last_activity TEXT")
  }
  if (!sessionCols.find(c => c.name === 'session_user')) {
    db.exec("ALTER TABLE sessions ADD COLUMN session_user TEXT")
  }
  if (!sessionCols.find(c => c.name === 'prompt_tokens')) {
    db.exec("ALTER TABLE sessions ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0")
  }
  if (!sessionCols.find(c => c.name === 'completion_tokens')) {
    db.exec("ALTER TABLE sessions ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0")
  }

  db.exec(`
    UPDATE sessions SET
      prompt_tokens = COALESCE((
        SELECT SUM(prompt_tokens) FROM token_usage WHERE token_usage.session_id = sessions.id
      ), 0),
      completion_tokens = COALESCE((
        SELECT SUM(completion_tokens) FROM token_usage WHERE token_usage.session_id = sessions.id
      ), 0)
    WHERE prompt_tokens = 0 AND completion_tokens = 0
      AND EXISTS (SELECT 1 FROM token_usage WHERE token_usage.session_id = sessions.id);
  `)

  return db
}

/**
 * Validate a username: must be alphanumeric only (a-zA-Z0-9).
 * Returns true if valid, false otherwise.
 */
export function isValidUsername(username: string): boolean {
  return /^[a-zA-Z0-9]+$/.test(username)
}

/**
 * Validate a username and throw an error if invalid.
 */
export function validateUsername(username: string): void {
  if (!isValidUsername(username)) {
    throw new Error(`Invalid username "${username}": only alphanumeric characters (a-zA-Z0-9) are allowed, no spaces, umlauts, or special characters.`)
  }
}

export function getDatabase(): Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.')
  }
  return db
}
