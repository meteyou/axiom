import { describe, expect, it } from 'vitest'
import {
  LEGACY_TOOL_NAMES,
  currentToolName,
  currentToolNames,
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
    })
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
