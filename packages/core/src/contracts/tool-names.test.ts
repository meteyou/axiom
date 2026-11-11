import { describe, expect, it } from 'vitest'
import {
  LEGACY_TOOL_NAMES,
  TOOL_NAMES_FORMAT_VERSION,
  currentToolName,
  currentToolNames,
  legacyToolNamesIn,
  migrateDisabledToolNames,
  resolveToolName,
  toolNameWithLegacyAliases,
} from './tool-names.js'

describe('legacy tool names', () => {
  it('maps every renamed simple tool to its area_verb name', () => {
    expect(Object.fromEntries(Object.entries(LEGACY_TOOL_NAMES).map(([legacy, target]) => [legacy, target.name]))).toEqual({
      read_file: 'file_read',
      write_file: 'file_write',
      edit_file: 'file_edit',
      list_files: 'file_list',
      send_file_to_user: 'file_send',
      read_chat_history: 'chat_history_read',
      search_memories: 'memory_search',
      list_agent_skills: 'skill_list',
      generate_image: 'image_generate',
      transcribe_audio: 'audio_transcribe',
      list_tasks: 'task_read',
      create_task: 'task_write',
      resume_task: 'task_write',
      stop_task: 'task_write',
      list_cronjobs: 'schedule_read',
      get_cronjob: 'schedule_read',
      create_cronjob: 'schedule_write',
      edit_cronjob: 'schedule_write',
      remove_cronjob: 'schedule_write',
      create_reminder: 'schedule_write',
      email_list: 'email_read',
      email_folders: 'email_read',
      email_read: 'email_read',
      email_mark_read: 'email_read',
      email_mark_unread: 'email_read',
    })
  })

  it('maps the email read and flag tools to the email_read actions', () => {
    expect(resolveToolName('email_list')).toEqual({ name: 'email_read', action: 'list', legacyName: 'email_list' })
    expect(resolveToolName('email_folders')).toEqual({ name: 'email_read', action: 'folders', legacyName: 'email_folders' })
    expect(resolveToolName('email_mark_read')).toEqual({ name: 'email_read', action: 'mark_read', legacyName: 'email_mark_read' })
    expect(resolveToolName('email_mark_unread')).toEqual({ name: 'email_read', action: 'mark_unread', legacyName: 'email_mark_unread' })
    expect(resolveToolName('email_read', { action: 'list' })).toEqual({ name: 'email_read', action: 'list' })
    expect(resolveToolName('email_read', { uid: 42 })).toEqual({ name: 'email_read', action: 'read' })
    expect(currentToolName('email_read')).toBe('email_read')
    expect(currentToolName('email_list')).toBe('email_read')
    expect(toolNameWithLegacyAliases('email_read'))
      .toEqual(['email_read', 'email_list', 'email_folders', 'email_mark_read', 'email_mark_unread'])
  })

  it('disables email_read only when every folded email tool was disabled', () => {
    const all = ['email_list', 'email_folders', 'email_read', 'email_mark_read', 'email_mark_unread']
    expect(migrateDisabledToolNames([...all, 'email_send'])).toEqual({ names: ['email_read', 'email_send'], keptEnabled: [], changed: true })
    expect(migrateDisabledToolNames(['email_list', 'email_folders', 'email_mark_read', 'email_mark_unread'])).toEqual({
      names: [],
      keptEnabled: [{ name: 'email_read', disabledLegacyNames: ['email_list', 'email_folders', 'email_mark_read', 'email_mark_unread'] }],
      changed: true,
    })
    expect(migrateDisabledToolNames(['email_read', 'email_list']).keptEnabled)
      .toEqual([{ name: 'email_read', disabledLegacyNames: ['email_list', 'email_read'] }])
  })

  it('reads email_read in a version 1 list as the old single read tool, whatever else is listed', () => {
    const onlyRead = { name: 'email_read', disabledLegacyNames: ['email_read'] }
    expect(migrateDisabledToolNames(['email_read'])).toEqual({ names: [], keptEnabled: [onlyRead], changed: true })
    expect(migrateDisabledToolNames(['email_read', 'shell'])).toEqual({ names: ['shell'], keptEnabled: [onlyRead], changed: true })
    expect(migrateDisabledToolNames(['email_read', 'create_task'])).toEqual({
      names: [],
      keptEnabled: [onlyRead, { name: 'task_write', disabledLegacyNames: ['create_task'] }],
      changed: true,
    })
    expect(migrateDisabledToolNames(['email_read', 'read_file']))
      .toEqual({ names: ['file_read'], keptEnabled: [onlyRead], changed: true })
    expect(migrateDisabledToolNames(['email_read', 'file_read']))
      .toEqual({ names: ['file_read'], keptEnabled: [onlyRead], changed: true })
  })

  it('keeps a version 1 list without mapped names as it is', () => {
    expect(migrateDisabledToolNames([])).toEqual({ names: [], keptEnabled: [], changed: false })
    expect(migrateDisabledToolNames(['file_read', 'task_write', 'shell']))
      .toEqual({ names: ['file_read', 'task_write', 'shell'], keptEnabled: [], changed: false })
  })

  it('maps the task tools to task_read and the task_write actions', () => {
    expect(resolveToolName('list_tasks')).toEqual({ name: 'task_read', legacyName: 'list_tasks' })
    expect(resolveToolName('create_task')).toEqual({ name: 'task_write', action: 'create', legacyName: 'create_task' })
    expect(resolveToolName('resume_task')).toEqual({ name: 'task_write', action: 'resume', legacyName: 'resume_task' })
    expect(resolveToolName('stop_task')).toEqual({ name: 'task_write', action: 'stop', legacyName: 'stop_task' })
    expect(resolveToolName('task_write', { action: 'stop', task_id: 't1' })).toEqual({ name: 'task_write', action: 'stop' })
  })

  it('disables task_write only when create, resume and stop were all disabled', () => {
    expect(migrateDisabledToolNames(['list_tasks', 'create_task']))
      .toEqual({ names: ['task_read'], keptEnabled: [{ name: 'task_write', disabledLegacyNames: ['create_task'] }], changed: true })
    expect(migrateDisabledToolNames(['create_task', 'resume_task', 'stop_task']).names).toEqual(['task_write'])
  })

  it('maps the cronjob and reminder tools to their schedule action and type', () => {
    expect(resolveToolName('list_cronjobs')).toEqual({ name: 'schedule_read', action: 'list', legacyName: 'list_cronjobs' })
    expect(resolveToolName('get_cronjob')).toEqual({ name: 'schedule_read', action: 'get', legacyName: 'get_cronjob' })
    expect(resolveToolName('create_cronjob', { action_type: 'injection' }))
      .toEqual({ name: 'schedule_write', action: 'create', scheduleType: 'task', legacyName: 'create_cronjob' })
    expect(resolveToolName('create_reminder'))
      .toEqual({ name: 'schedule_write', action: 'create', scheduleType: 'reminder', legacyName: 'create_reminder' })
    expect(resolveToolName('edit_cronjob')).toEqual({ name: 'schedule_write', action: 'edit', legacyName: 'edit_cronjob' })
    expect(resolveToolName('remove_cronjob')).toEqual({ name: 'schedule_write', action: 'remove', legacyName: 'remove_cronjob' })
  })

  it('disables the grouped schedule tools only when all legacy members were disabled', () => {
    expect(migrateDisabledToolNames(['list_cronjobs', 'get_cronjob', 'create_cronjob']).names).toEqual(['schedule_read'])
    expect(migrateDisabledToolNames(['create_cronjob']).keptEnabled)
      .toEqual([{ name: 'schedule_write', disabledLegacyNames: ['create_cronjob'] }])
    const all = ['create_cronjob', 'edit_cronjob', 'remove_cronjob', 'create_reminder']
    expect(migrateDisabledToolNames(all)).toEqual({ names: ['schedule_write'], keptEnabled: [], changed: true })
  })

  it('passes current and unknown names through unchanged', () => {
    expect(currentToolName('file_read')).toBe('file_read')
    expect(currentToolName('shell')).toBe('shell')
    expect(currentToolName('mcp_custom_tool')).toBe('mcp_custom_tool')
    expect(currentToolName('constructor')).toBe('constructor')
    expect(currentToolName('toString')).toBe('toString')
  })

  it('maps name lists to current names without duplicates', () => {
    expect(currentToolNames(['read_file', 'file_read', 'shell', 'generate_image'])).toEqual(['file_read', 'shell', 'image_generate'])
  })

  it('finds the names a current (version 2) list must not contain', () => {
    expect(TOOL_NAMES_FORMAT_VERSION).toBe(2)
    expect(legacyToolNamesIn(['email_read', 'create_task', 'shell', 'read_file', 'file_read'])).toEqual(['create_task', 'read_file'])
    expect(legacyToolNamesIn(['email_read', 'email_send', 'task_write'])).toEqual([])
  })

  it('lists the legacy aliases of a current name', () => {
    expect(toolNameWithLegacyAliases('file_read')).toEqual(['file_read', 'read_file'])
    expect(toolNameWithLegacyAliases('shell')).toEqual(['shell'])
  })
})

describe('resolveToolName', () => {
  it('resolves legacy names and remembers the recorded name', () => {
    expect(resolveToolName('search_memories', { query: 'x' })).toEqual({ name: 'memory_search', legacyName: 'search_memories' })
  })

  it('reads action and schedule type of current grouped tools from the arguments', () => {
    expect(resolveToolName('schedule_write', { action: 'create', type: 'reminder' }))
      .toEqual({ name: 'schedule_write', action: 'create', scheduleType: 'reminder' })
    expect(resolveToolName('task_write', { action: 'stop', type: 'reminder' })).toEqual({ name: 'task_write', action: 'stop' })
    expect(resolveToolName('file_read', { path: 'a' })).toEqual({ name: 'file_read' })
    expect(resolveToolName('file_read')).toEqual({ name: 'file_read' })
  })
})

describe('migrateDisabledToolNames', () => {
  it('rewrites renamed tools and keeps other names', () => {
    expect(migrateDisabledToolNames(['shell', 'write_file', 'search_memories'])).toEqual({
      names: ['shell', 'file_write', 'memory_search'],
      keptEnabled: [],
      changed: true,
    })
  })

  it('is a no-op for already migrated lists', () => {
    const first = migrateDisabledToolNames(['read_file', 'file_read', 'web_fetch'])
    expect(first.names).toEqual(['file_read', 'web_fetch'])
    const second = migrateDisabledToolNames(first.names)
    expect(second).toEqual({ names: ['file_read', 'web_fetch'], keptEnabled: [], changed: false })
  })

  describe('grouped tools', () => {
    const mapping = {
      list_cronjobs: { name: 'schedule_read', action: 'list' },
      get_cronjob: { name: 'schedule_read', action: 'get' },
      read_file: { name: 'file_read' },
    }

    it('disables the grouped tool when every legacy member was disabled', () => {
      expect(migrateDisabledToolNames(['get_cronjob', 'shell', 'list_cronjobs'], mapping)).toEqual({
        names: ['schedule_read', 'shell'],
        keptEnabled: [],
        changed: true,
      })
    })

    it('keeps the grouped tool enabled when only some members were disabled', () => {
      expect(migrateDisabledToolNames(['get_cronjob', 'read_file'], mapping)).toEqual({
        names: ['file_read'],
        keptEnabled: [{ name: 'schedule_read', disabledLegacyNames: ['get_cronjob'] }],
        changed: true,
      })
    })

    it('keeps a grouped tool disabled that is already listed under its current name', () => {
      expect(migrateDisabledToolNames(['schedule_read', 'get_cronjob'], mapping).names).toEqual(['schedule_read'])
    })
  })
})
