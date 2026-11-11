import { randomUUID } from 'node:crypto'
import type { Database } from './database.js'
import type { SettingsThinkingLevel } from './contracts/settings.js'
import { normalizeThinkingLevel } from './thinking-level.js'
import { getBootstrapAdminId } from './user-scope.js'
import { TOOL_NAMES_FORMAT_VERSION, migrateDisabledToolNames } from './contracts/tool-names.js'

export type ScheduledTaskActionType = 'task' | 'injection'

/** Per-cronjob codemode override. `null` = inherit the global `codemode.tasks` setting. */
export type ScheduledTaskCodemode = 'on' | 'off'

export interface ScheduledTask {
  id: string
  name: string
  prompt: string
  schedule: string
  actionType: ScheduledTaskActionType
  provider: string | null
  enabled: boolean
  toolsOverride: string | null
  /** Tool-name format of `toolsOverride`; see `TOOL_NAMES_FORMAT_VERSION`. `null` = legacy, not yet migrated. */
  toolsOverrideVersion: number | null
  skillsOverride: string | null
  systemPromptOverride: string | null
  /**
   * Optional list of agent-skill names (matching directories under
   * `/data/skills_agent/<name>/`) whose `SKILL.md` content should be
   * injected verbatim into the task prompt under an `<attached_skills>`
   * block. Lets cronjobs bake skill rules into the prompt deterministically
   * instead of requiring the task agent to `file_read` them on every run.
   */
  attachedSkills: string[] | null
  /** Thinking level for the spawned task; `null` = the background default at run time. */
  thinkingLevel: SettingsThinkingLevel | null
  codemode: ScheduledTaskCodemode | null
  ownerUserId: number | null
  lastRunAt: string | null
  lastRunTaskId: string | null
  lastRunStatus: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateScheduledTaskInput {
  name: string
  prompt: string
  schedule: string
  actionType?: ScheduledTaskActionType
  provider?: string
  enabled?: boolean
  /** JSON array of current tool names; callers validate the names. */
  toolsOverride?: string | null
  attachedSkills?: string[] | null
  thinkingLevel?: SettingsThinkingLevel | null
  codemode?: ScheduledTaskCodemode | null
  /** Defaults to the bootstrap admin. */
  ownerUserId?: number
}

export interface ScheduledTaskListFilters {
  ownerUserId?: number
}

export interface UpdateScheduledTaskInput {
  name?: string
  prompt?: string
  schedule?: string
  actionType?: ScheduledTaskActionType
  provider?: string
  enabled?: boolean
  /** JSON array of current tool names; callers validate the names. */
  toolsOverride?: string | null
  skillsOverride?: string | null
  systemPromptOverride?: string | null
  attachedSkills?: string[] | null
  /** `null` resets to the background default. */
  thinkingLevel?: SettingsThinkingLevel | null
  /** `null` resets to inherit (global task setting). */
  codemode?: ScheduledTaskCodemode | null
  lastRunAt?: string
  lastRunTaskId?: string
  lastRunStatus?: string
}

interface ScheduledTaskRow {
  id: string
  name: string
  prompt: string
  schedule: string
  action_type: string
  provider: string | null
  enabled: number
  tools_override: string | null
  tools_override_version: number | null
  skills_override: string | null
  system_prompt_override: string | null
  attached_skills: string | null
  thinking_level: string | null
  codemode: string | null
  owner_user_id: number | null
  last_run_at: string | null
  last_run_task_id: string | null
  last_run_status: string | null
  created_at: string
  updated_at: string
}

function parseAttachedSkills(raw: string | null): string[] | null {
  if (raw === null || raw === undefined) return null
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.every(v => typeof v === 'string')) {
      return parsed as string[]
    }
  } catch {
    // Fall through — treat as null on malformed data
  }
  return null
}

function serializeAttachedSkills(value: string[] | null | undefined): string | null {
  if (value === null || value === undefined) return null
  if (!Array.isArray(value)) return null
  return JSON.stringify(value.filter(v => typeof v === 'string'))
}

function rowToScheduledTask(row: ScheduledTaskRow): ScheduledTask {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    schedule: row.schedule,
    actionType: (row.action_type === 'injection' ? 'injection' : 'task') as ScheduledTaskActionType,
    provider: row.provider,
    enabled: row.enabled === 1,
    toolsOverride: row.tools_override,
    toolsOverrideVersion: row.tools_override_version ?? null,
    skillsOverride: row.skills_override,
    systemPromptOverride: row.system_prompt_override,
    attachedSkills: parseAttachedSkills(row.attached_skills),
    thinkingLevel: normalizeThinkingLevel(row.thinking_level) ?? null,
    codemode: row.codemode === 'on' || row.codemode === 'off' ? row.codemode : null,
    ownerUserId: row.owner_user_id ?? null,
    lastRunAt: row.last_run_at,
    lastRunTaskId: row.last_run_task_id,
    lastRunStatus: row.last_run_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Adds `scheduled_tasks.owner_user_id` and attributes cronjobs and reminders
 * without an owner to the bootstrap admin. Idempotent.
 */
export function migrateScheduledTaskOwners(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(scheduled_tasks)').all() as { name: string }[]
  if (!columns.some(column => column.name === 'owner_user_id')) {
    db.exec('ALTER TABLE scheduled_tasks ADD COLUMN owner_user_id INTEGER')
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_owner ON scheduled_tasks(owner_user_id)')

  const bootstrapAdminId = getBootstrapAdminId(db)
  if (bootstrapAdminId === null) return
  db.prepare('UPDATE scheduled_tasks SET owner_user_id = ? WHERE owner_user_id IS NULL').run(bootstrapAdminId)
}

/**
 * Moves every `tools_override` without a format version (or with version 1) to
 * the current tool names and stamps it with `TOOL_NAMES_FORMAT_VERSION`, in one
 * transaction. Rows already on the current version are never read again.
 * Unparseable lists keep no version, so the task runner refuses to run them.
 */
export function migrateScheduledTaskToolOverrides(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(scheduled_tasks)').all() as { name: string }[]
  if (!columns.some(column => column.name === 'tools_override_version')) {
    db.exec('ALTER TABLE scheduled_tasks ADD COLUMN tools_override_version INTEGER')
  }

  const rows = db.prepare(
    'SELECT id, tools_override FROM scheduled_tasks WHERE tools_override_version IS NULL OR tools_override_version = 1',
  ).all() as { id: string; tools_override: string | null }[]
  if (rows.length === 0) return
  const stampVersion = db.prepare('UPDATE scheduled_tasks SET tools_override_version = ? WHERE id = ?')
  const rewrite = db.prepare('UPDATE scheduled_tasks SET tools_override = ?, tools_override_version = ? WHERE id = ?')

  let migratedRows = 0
  let rewrittenLists = 0
  db.transaction(() => {
    for (const row of rows) {
      if (row.tools_override === null || row.tools_override === '') {
        stampVersion.run(TOOL_NAMES_FORMAT_VERSION, row.id)
        migratedRows++
        continue
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(row.tools_override)
      } catch {
        parsed = undefined
      }
      if (!Array.isArray(parsed) || !parsed.every((name): name is string => typeof name === 'string')) {
        console.warn(`[db] Cronjob ${row.id}: tools_override is not a list of tool names; left unmigrated, its runs will fail until the override is fixed`)
        continue
      }

      const migrated = migrateDisabledToolNames(parsed)
      for (const kept of migrated.keptEnabled) {
        console.log(`[db] Cronjob ${row.id}: ${kept.name} stays enabled — only ${kept.disabledLegacyNames.join(', ')} of its legacy tools were disabled`)
      }
      if (migrated.changed) {
        rewrite.run(JSON.stringify(migrated.names), TOOL_NAMES_FORMAT_VERSION, row.id)
        rewrittenLists++
      } else {
        stampVersion.run(TOOL_NAMES_FORMAT_VERSION, row.id)
      }
      migratedRows++
    }
  })()

  if (migratedRows > 0) {
    console.log(`[db] Migrated ${migratedRows} cronjob tool override(s) to tool-name format v${TOOL_NAMES_FORMAT_VERSION} (${rewrittenLists} list(s) rewritten)`)
  }
}

/**
 * Initialize the scheduled_tasks table in the database
 */
export function initScheduledTasksTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule TEXT NOT NULL,
      provider TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      tools_override TEXT,
      tools_override_version INTEGER,
      skills_override TEXT,
      system_prompt_override TEXT,
      attached_skills TEXT,
      thinking_level TEXT,
      codemode TEXT,
      owner_user_id INTEGER,
      last_run_at TEXT,
      last_run_task_id TEXT,
      last_run_status TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
}

/**
 * Scheduled Task Store — CRUD operations for the scheduled_tasks table
 */
export class ScheduledTaskStore {
  constructor(private db: Database) {}

  /**
   * Create a new scheduled task
   */
  create(input: CreateScheduledTaskInput): ScheduledTask {
    const id = randomUUID()
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19)

    this.db.prepare(`
      INSERT INTO scheduled_tasks (id, name, prompt, schedule, action_type, provider, enabled, tools_override, tools_override_version, attached_skills, thinking_level, codemode, owner_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.name,
      input.prompt,
      input.schedule,
      input.actionType ?? 'task',
      input.provider ?? null,
      input.enabled !== undefined ? (input.enabled ? 1 : 0) : 1,
      input.toolsOverride ?? null,
      TOOL_NAMES_FORMAT_VERSION,
      serializeAttachedSkills(input.attachedSkills ?? null),
      input.thinkingLevel ?? null,
      input.codemode ?? null,
      input.ownerUserId ?? getBootstrapAdminId(this.db),
      now,
      now,
    )

    return this.getById(id)!
  }

  /**
   * Get a scheduled task by ID
   */
  getById(id: string): ScheduledTask | null {
    const row = this.db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as ScheduledTaskRow | undefined
    return row ? rowToScheduledTask(row) : null
  }

  /**
   * List all scheduled tasks
   */
  list(filters: ScheduledTaskListFilters = {}): ScheduledTask[] {
    const rows = (filters.ownerUserId !== undefined
      ? this.db.prepare('SELECT * FROM scheduled_tasks WHERE owner_user_id = ? ORDER BY created_at DESC').all(filters.ownerUserId)
      : this.db.prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC').all()) as ScheduledTaskRow[]
    return rows.map(rowToScheduledTask)
  }

  /**
   * List only enabled scheduled tasks
   */
  listEnabled(filters: ScheduledTaskListFilters = {}): ScheduledTask[] {
    const rows = (filters.ownerUserId !== undefined
      ? this.db.prepare('SELECT * FROM scheduled_tasks WHERE enabled = 1 AND owner_user_id = ? ORDER BY created_at DESC').all(filters.ownerUserId)
      : this.db.prepare('SELECT * FROM scheduled_tasks WHERE enabled = 1 ORDER BY created_at DESC').all()) as ScheduledTaskRow[]
    return rows.map(rowToScheduledTask)
  }

  /**
   * Update a scheduled task
   */
  update(id: string, input: UpdateScheduledTaskInput): ScheduledTask | null {
    const setClauses: string[] = []
    const params: unknown[] = []

    if (input.name !== undefined) {
      setClauses.push('name = ?')
      params.push(input.name)
    }
    if (input.prompt !== undefined) {
      setClauses.push('prompt = ?')
      params.push(input.prompt)
    }
    if (input.schedule !== undefined) {
      setClauses.push('schedule = ?')
      params.push(input.schedule)
    }
    if (input.actionType !== undefined) {
      setClauses.push('action_type = ?')
      params.push(input.actionType)
    }
    if (input.provider !== undefined) {
      setClauses.push('provider = ?')
      params.push(input.provider)
    }
    if (input.enabled !== undefined) {
      setClauses.push('enabled = ?')
      params.push(input.enabled ? 1 : 0)
    }
    if (input.toolsOverride !== undefined) {
      setClauses.push('tools_override = ?', 'tools_override_version = ?')
      params.push(input.toolsOverride, TOOL_NAMES_FORMAT_VERSION)
    }
    if (input.skillsOverride !== undefined) {
      setClauses.push('skills_override = ?')
      params.push(input.skillsOverride)
    }
    if (input.systemPromptOverride !== undefined) {
      setClauses.push('system_prompt_override = ?')
      params.push(input.systemPromptOverride)
    }
    if (input.attachedSkills !== undefined) {
      setClauses.push('attached_skills = ?')
      params.push(serializeAttachedSkills(input.attachedSkills))
    }
    if (input.thinkingLevel !== undefined) {
      setClauses.push('thinking_level = ?')
      params.push(input.thinkingLevel)
    }
    if (input.codemode !== undefined) {
      setClauses.push('codemode = ?')
      params.push(input.codemode)
    }
    if (input.lastRunAt !== undefined) {
      setClauses.push('last_run_at = ?')
      params.push(input.lastRunAt)
    }
    if (input.lastRunTaskId !== undefined) {
      setClauses.push('last_run_task_id = ?')
      params.push(input.lastRunTaskId)
    }
    if (input.lastRunStatus !== undefined) {
      setClauses.push('last_run_status = ?')
      params.push(input.lastRunStatus)
    }

    if (setClauses.length === 0) return this.getById(id)

    // Always update updated_at
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
    setClauses.push('updated_at = ?')
    params.push(now)

    params.push(id)
    const result = this.db.prepare(`UPDATE scheduled_tasks SET ${setClauses.join(', ')} WHERE id = ?`).run(...params)

    if (result.changes === 0) return null
    return this.getById(id)
  }

  /**
   * Delete a scheduled task
   */
  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id)
    return result.changes > 0
  }
}
