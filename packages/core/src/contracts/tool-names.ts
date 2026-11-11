export type ScheduleToolType = 'task' | 'reminder'

/**
 * Format of stored tool-name lists (cronjob `tools_override`). 1 or missing =
 * names from before the `area_verb` rename, 2 = current names. `email_read`
 * exists in both with different meanings, so a list can only be interpreted
 * through its version, never through its content.
 */
export const TOOL_NAMES_FORMAT_VERSION = 2

export interface LegacyToolTarget {
  name: string
  action?: string
  scheduleType?: ScheduleToolType
}

export interface ResolvedToolName extends LegacyToolTarget {
  /** The name the call was recorded under, when it differs from `name`. */
  legacyName?: string
}

/**
 * Tool names that were renamed or folded into grouped tools. Stored history,
 * cronjob overrides and user skills may still carry the old names; the model
 * only ever sees the targets.
 */
export const LEGACY_TOOL_NAMES: Readonly<Record<string, LegacyToolTarget>> = Object.freeze({
  read_file: { name: 'file_read' },
  write_file: { name: 'file_write' },
  edit_file: { name: 'file_edit' },
  list_files: { name: 'file_list' },
  send_file_to_user: { name: 'file_send' },
  read_chat_history: { name: 'chat_history_read' },
  search_memories: { name: 'memory_search' },
  list_agent_skills: { name: 'skill_list' },
  generate_image: { name: 'image_generate' },
  transcribe_audio: { name: 'audio_transcribe' },
  list_tasks: { name: 'task_read' },
  create_task: { name: 'task_write', action: 'create' },
  resume_task: { name: 'task_write', action: 'resume' },
  stop_task: { name: 'task_write', action: 'stop' },
  list_cronjobs: { name: 'schedule_read', action: 'list' },
  get_cronjob: { name: 'schedule_read', action: 'get' },
  create_cronjob: { name: 'schedule_write', action: 'create', scheduleType: 'task' },
  edit_cronjob: { name: 'schedule_write', action: 'edit' },
  remove_cronjob: { name: 'schedule_write', action: 'remove' },
  create_reminder: { name: 'schedule_write', action: 'create', scheduleType: 'reminder' },
  email_list: { name: 'email_read', action: 'list' },
  email_folders: { name: 'email_read', action: 'folders' },
  // Kept its name as the grouped tool; old calls carry no action and were reads.
  email_read: { name: 'email_read', action: 'read' },
  email_mark_read: { name: 'email_read', action: 'mark_read' },
  email_mark_unread: { name: 'email_read', action: 'mark_unread' },
})

type LegacyToolNameMap = Readonly<Record<string, LegacyToolTarget>>

// A legacy key equal to its target (e.g. a grouped tool that kept an old name) is a current name.
function legacyTarget(name: string, mapping: LegacyToolNameMap = LEGACY_TOOL_NAMES): LegacyToolTarget | undefined {
  if (!Object.prototype.hasOwnProperty.call(mapping, name)) return undefined
  const target = mapping[name]!
  return target.name === name ? undefined : target
}

function legacyMembers(name: string, mapping: LegacyToolNameMap): string[] {
  return Object.keys(mapping).filter(legacy => legacyTarget(legacy, mapping)?.name === name)
}

/** Names that are no longer valid in a current (format version 2) tool-name list. */
export function legacyToolNamesIn(names: readonly string[]): string[] {
  return names.filter(name => legacyTarget(name) !== undefined)
}

/** Every old tool folded into `name`, including an old tool that kept the name. */
function foldedTools(name: string, mapping: LegacyToolNameMap): string[] {
  return Object.keys(mapping).filter(legacy => mapping[legacy]!.name === name)
}

/** Current tool name for a possibly legacy one; current and unknown names pass through. */
export function currentToolName(name: string): string {
  return legacyTarget(name)?.name ?? name
}

/** Maps a tool name list (skill frontmatter, overrides) to current names, deduplicated in order. */
export function currentToolNames(names: readonly string[]): string[] {
  return [...new Set(names.map(currentToolName))]
}

/** The current name followed by every legacy name that maps onto it. */
export function toolNameWithLegacyAliases(name: string): string[] {
  return [name, ...legacyMembers(name, LEGACY_TOOL_NAMES)]
}

/**
 * Normalizes a recorded tool call to its current name and, for grouped tools,
 * its action and schedule type. Legacy names carry them in the mapping; current
 * names carry them in the call arguments.
 */
export function resolveToolName(name: string, args?: unknown): ResolvedToolName {
  const target = legacyTarget(name)
  if (target) return { ...target, legacyName: name }

  const resolved: ResolvedToolName = { name }
  const record = args && typeof args === 'object' ? args as Record<string, unknown> : undefined
  if (typeof record?.action === 'string' && record.action !== '') resolved.action = record.action
  else if (Object.prototype.hasOwnProperty.call(LEGACY_TOOL_NAMES, name)) {
    const action = LEGACY_TOOL_NAMES[name]!.action
    if (action !== undefined) resolved.action = action
  }
  if (name.startsWith('schedule_') && (record?.type === 'task' || record?.type === 'reminder')) {
    resolved.scheduleType = record.type
  }
  return resolved
}

export interface MigratedToolOverride {
  names: string[]
  /** Grouped tools that stay enabled because only some of their legacy members were disabled. */
  keptEnabled: { name: string; disabledLegacyNames: string[] }[]
  changed: boolean
}

/**
 * Rewrites a format version 1 list of disabled tool names to current names.
 * Every mapped name is read with its old meaning, so `email_read` is the old
 * single read tool. A grouped tool is only disabled when every legacy member
 * that maps onto it was disabled; otherwise disabling it would remove actions
 * the user wanted to keep.
 */
export function migrateDisabledToolNames(
  names: readonly string[],
  mapping: LegacyToolNameMap = LEGACY_TOOL_NAMES,
): MigratedToolOverride {
  const disabled = new Set(names)
  const result = new Set<string>()
  const keptEnabled: MigratedToolOverride['keptEnabled'] = []

  for (const name of names) {
    const target = Object.prototype.hasOwnProperty.call(mapping, name) ? mapping[name]!.name : undefined
    if (target === undefined) {
      result.add(name)
      continue
    }
    if (result.has(target) || keptEnabled.some(kept => kept.name === target)) continue

    const members = foldedTools(target, mapping)
    const disabledMembers = members.filter(member => disabled.has(member))
    const targetAlreadyDisabled = !members.includes(target) && disabled.has(target)
    if (targetAlreadyDisabled || disabledMembers.length === members.length) result.add(target)
    else keptEnabled.push({ name: target, disabledLegacyNames: disabledMembers })
  }

  const migrated = [...result]
  const changed = migrated.length !== names.length || migrated.some((name, index) => name !== names[index])
  return { names: migrated, keptEnabled, changed }
}
