import { randomUUID } from 'node:crypto'
import type { Database } from './database.js'
import type { SettingsThinkingLevel } from './contracts/settings.js'
import { normalizeThinkingLevel } from './thinking-level.js'

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
  skillsOverride: string | null
  systemPromptOverride: string | null
  /**
   * Optional list of agent-skill names (matching directories under
   * `/data/skills_agent/<name>/`) whose `SKILL.md` content should be
   * injected verbatim into the task prompt under an `<attached_skills>`
   * block. Lets cronjobs bake skill rules into the prompt deterministically
   * instead of requiring the task agent to `read_file` them on every run.
   */
  attachedSkills: string[] | null
  /** Thinking level for the spawned task; `null` = the background default at run time. */
  thinkingLevel: SettingsThinkingLevel | null
  codemode: ScheduledTaskCodemode | null
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
  attachedSkills?: string[] | null
  thinkingLevel?: SettingsThinkingLevel | null
  codemode?: ScheduledTaskCodemode | null
}

export interface UpdateScheduledTaskInput {
  name?: string
  prompt?: string
  schedule?: string
  actionType?: ScheduledTaskActionType
  provider?: string
  enabled?: boolean
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
  skills_override: string | null
  system_prompt_override: string | null
  attached_skills: string | null
  thinking_level: string | null
  codemode: string | null
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
    skillsOverride: row.skills_override,
    systemPromptOverride: row.system_prompt_override,
    attachedSkills: parseAttachedSkills(row.attached_skills),
    thinkingLevel: normalizeThinkingLevel(row.thinking_level) ?? null,
    codemode: row.codemode === 'on' || row.codemode === 'off' ? row.codemode : null,
    lastRunAt: row.last_run_at,
    lastRunTaskId: row.last_run_task_id,
    lastRunStatus: row.last_run_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
      skills_override TEXT,
      system_prompt_override TEXT,
      attached_skills TEXT,
      thinking_level TEXT,
      codemode TEXT,
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
      INSERT INTO scheduled_tasks (id, name, prompt, schedule, action_type, provider, enabled, attached_skills, thinking_level, codemode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.name,
      input.prompt,
      input.schedule,
      input.actionType ?? 'task',
      input.provider ?? null,
      input.enabled !== undefined ? (input.enabled ? 1 : 0) : 1,
      serializeAttachedSkills(input.attachedSkills ?? null),
      input.thinkingLevel ?? null,
      input.codemode ?? null,
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
  list(): ScheduledTask[] {
    const rows = this.db.prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC').all() as ScheduledTaskRow[]
    return rows.map(rowToScheduledTask)
  }

  /**
   * List only enabled scheduled tasks
   */
  listEnabled(): ScheduledTask[] {
    const rows = this.db.prepare('SELECT * FROM scheduled_tasks WHERE enabled = 1 ORDER BY created_at DESC').all() as ScheduledTaskRow[]
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
      setClauses.push('tools_override = ?')
      params.push(input.toolsOverride)
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
