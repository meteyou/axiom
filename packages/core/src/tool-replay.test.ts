import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { createBaseAgentTools } from './agent-runtime.js'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { createEmailTools } from './email-tools.js'
import type { EmailAccount } from './email-account-store.js'
import type { EmailClient } from './email-client.js'
import { createTaskReadTool, createTaskWriteTool } from './task-tools.js'
import type { TaskToolsOptions } from './task-tools.js'
import { createScheduleReadTool, createScheduleWriteTool } from './schedule-tools.js'
import type { ScheduleToolsOptions } from './schedule-tools.js'
import type { ActionTool } from './action-tool.js'
import { createSendFileTool } from './send-file-tool.js'
import { createGenerateImageTool } from './image-tool.js'
import { createConsolidationTools } from './consolidation-tools.js'
import type { QuotaServiceLike } from './quota-tool.js'
import { getToolReplayPolicy, hasExplicitToolReplayPolicy } from './tool-replay.js'

function emailAccountWithAllPermissions(): EmailAccount {
  return {
    id: 'acc-1',
    name: 'Work',
    canSend: true,
    canManage: true,
    canDelete: true,
    canDownloadAttachments: true,
  } as EmailAccount
}

function buildEveryRegisteredTool(db: Database): AgentTool[] {
  const account = emailAccountWithAllPermissions()
  const taskToolsOptions = {} as TaskToolsOptions
  const scheduleToolsOptions = {} as ScheduleToolsOptions

  return [
    ...createBaseAgentTools({
      db,
      builtinToolsConfig: { webSearch: { enabled: true }, webFetch: { enabled: true } },
      sttEnabled: true,
      quotaService: {} as QuotaServiceLike,
    }),
    ...createEmailTools({
      client: {} as EmailClient,
      listAccounts: () => [{ id: account.id, name: account.name }],
      getAccount: () => account,
    }),
    createTaskReadTool(taskToolsOptions),
    createTaskWriteTool(taskToolsOptions),
    createScheduleReadTool(scheduleToolsOptions),
    createScheduleWriteTool(scheduleToolsOptions),
    createSendFileTool({ getCurrentToolUserId: () => undefined }),
    createGenerateImageTool(),
    ...createConsolidationTools({ db, scope: null }),
  ]
}

describe('tool replay policy', () => {
  let db: Database
  let dbPath: string
  let dataDir: string
  const originalDataDir = process.env.DATA_DIR

  beforeAll(() => {
    dbPath = path.join(os.tmpdir(), `axiom-tool-replay-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    db = initDatabase(dbPath)
    // createBaseAgentTools reads providers.json (to decide on image_generate); never let it touch a real /data.
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-tool-replay-data-'))
    process.env.DATA_DIR = dataDir
  })

  afterAll(() => {
    db.close()
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(`${dbPath}${suffix}`) } catch { /* ignore */ }
    }
    fs.rmSync(dataDir, { recursive: true, force: true })
    if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir
    else delete process.env.DATA_DIR
  })

  it('has an explicit classification for every registered agent tool', () => {
    const toolNames = buildEveryRegisteredTool(db).map(tool => tool.name)

    expect(toolNames).toContain('email_send')
    expect(toolNames).toContain('audio_transcribe')
    expect(toolNames).toContain('provider_quota')
    expect(toolNames.filter(name => !hasExplicitToolReplayPolicy(name))).toEqual([])
  })

  it('treats file, shell and outbound tools as unsafe', () => {
    for (const name of ['shell', 'file_write', 'file_edit', 'email_send', 'file_send', 'image_generate', 'codemode']) {
      expect(getToolReplayPolicy(name)).toBe('unsafe')
    }
    expect(hasExplicitToolReplayPolicy('codemode')).toBe(true)
  })

  it('treats read-only tools as safe', () => {
    for (const name of ['file_read', 'file_list', 'file_stats', 'file_search', 'web_fetch', 'email_read', 'task_read']) {
      expect(getToolReplayPolicy(name)).toBe('safe')
    }
  })

  it('resolves legacy tool names to the policy of their current name', () => {
    for (const name of ['read_file', 'list_files', 'search_memories', 'read_chat_history', 'list_agent_skills', 'transcribe_audio']) {
      expect(hasExplicitToolReplayPolicy(name)).toBe(true)
      expect(getToolReplayPolicy(name)).toBe('safe')
    }
    for (const name of ['write_file', 'edit_file', 'send_file_to_user', 'generate_image']) {
      expect(hasExplicitToolReplayPolicy(name)).toBe(true)
      expect(getToolReplayPolicy(name)).toBe('unsafe')
    }
  })

  it('classifies grouped tools per action as declared by the tool', () => {
    const actionTools = buildEveryRegisteredTool(db).filter((tool): tool is ActionTool => 'actionReplayPolicies' in tool)
    expect(actionTools.map(tool => tool.name)).toEqual(expect.arrayContaining(['email_read', 'task_write', 'schedule_read', 'schedule_write']))
    for (const tool of actionTools) {
      for (const [action, policy] of Object.entries(tool.actionReplayPolicies)) {
        expect(getToolReplayPolicy(tool.name, { action }), `${tool.name}:${action}`).toBe(policy)
      }
    }
    expect(getToolReplayPolicy('schedule_read', { action: 'list' })).toBe('safe')
    expect(getToolReplayPolicy('schedule_write', { action: 'create', type: 'reminder' })).toBe('unsafe')
    expect(getToolReplayPolicy('schedule_read')).toBe('unsafe')
    expect(getToolReplayPolicy('schedule_read', { action: 'drop' })).toBe('unsafe')
  })

  it('treats task_read as safe and every task_write action as unsafe', () => {
    expect(getToolReplayPolicy('task_read')).toBe('safe')
    for (const action of ['create', 'resume', 'stop']) {
      expect(getToolReplayPolicy('task_write', { action })).toBe('unsafe')
    }
    expect(getToolReplayPolicy('list_tasks')).toBe('safe')
    for (const name of ['create_task', 'resume_task', 'stop_task']) {
      expect(hasExplicitToolReplayPolicy(name)).toBe(true)
      expect(getToolReplayPolicy(name)).toBe('unsafe')
    }
  })

  it('treats every email_read action as safe and the permission-gated email tools as unsafe', () => {
    for (const action of ['list', 'folders', 'read', 'mark_read', 'mark_unread']) {
      expect(getToolReplayPolicy('email_read', { action })).toBe('safe')
    }
    expect(getToolReplayPolicy('email_read', { uid: 42, folder: 'INBOX' })).toBe('safe')
    for (const name of ['email_list', 'email_folders', 'email_mark_read', 'email_mark_unread']) {
      expect(hasExplicitToolReplayPolicy(name)).toBe(true)
      expect(getToolReplayPolicy(name)).toBe('safe')
    }
    expect(getToolReplayPolicy('email_read', { action: 'delete' })).toBe('unsafe')
    for (const name of ['email_move', 'email_delete', 'email_send', 'email_download_attachment']) {
      expect(getToolReplayPolicy(name)).toBe('unsafe')
    }
  })

  it('classifies legacy schedule tools through their grouped action', () => {
    expect(getToolReplayPolicy('list_cronjobs')).toBe('safe')
    expect(getToolReplayPolicy('get_cronjob')).toBe('safe')
    for (const name of ['create_cronjob', 'edit_cronjob', 'remove_cronjob', 'create_reminder']) {
      expect(getToolReplayPolicy(name)).toBe('unsafe')
    }
  })

  it('ignores an action argument on tools without per-action policies', () => {
    expect(getToolReplayPolicy('file_read', { action: 'delete', path: 'a' })).toBe('safe')
    expect(getToolReplayPolicy('shell', { action: 'list' })).toBe('unsafe')
  })

  it('defaults unknown tools to unsafe', () => {
    expect(hasExplicitToolReplayPolicy('mcp_custom_tool')).toBe(false)
    expect(getToolReplayPolicy('mcp_custom_tool')).toBe('unsafe')
    expect(getToolReplayPolicy('constructor')).toBe('unsafe')
  })
})
