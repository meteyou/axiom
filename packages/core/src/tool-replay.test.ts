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
import { createTaskTool, createResumeTaskTool, listTasksTool } from './task-tools.js'
import type { TaskToolsOptions } from './task-tools.js'
import {
  createCronjobTool,
  editCronjobTool,
  removeCronjobTool,
  listCronjobsTool,
  getCronjobTool,
  createReminderTool,
} from './cronjob-tools.js'
import type { CronjobToolsOptions } from './cronjob-tools.js'
import { createSendFileTool } from './send-file-tool.js'
import { createGenerateImageTool } from './image-tool.js'
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
  const cronjobToolsOptions = {} as CronjobToolsOptions

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
    createTaskTool(taskToolsOptions),
    createResumeTaskTool(taskToolsOptions),
    listTasksTool(taskToolsOptions),
    createCronjobTool(cronjobToolsOptions),
    editCronjobTool(cronjobToolsOptions),
    removeCronjobTool(cronjobToolsOptions),
    listCronjobsTool(cronjobToolsOptions),
    getCronjobTool(cronjobToolsOptions),
    createReminderTool(cronjobToolsOptions),
    createSendFileTool({ getCurrentToolUserId: () => undefined }),
    createGenerateImageTool(),
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
    // createBaseAgentTools reads providers.json (to decide on generate_image); never let it touch a real /data.
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
    expect(toolNames).toContain('transcribe_audio')
    expect(toolNames).toContain('provider_quota')
    expect(toolNames.filter(name => !hasExplicitToolReplayPolicy(name))).toEqual([])
  })

  it('treats file, shell and outbound tools as unsafe', () => {
    for (const name of ['shell', 'write_file', 'edit_file', 'email_send', 'create_task', 'send_file_to_user', 'generate_image']) {
      expect(getToolReplayPolicy(name)).toBe('unsafe')
    }
  })

  it('treats read-only tools as safe', () => {
    for (const name of ['read_file', 'list_files', 'web_fetch', 'email_read', 'list_tasks']) {
      expect(getToolReplayPolicy(name)).toBe('safe')
    }
  })

  it('defaults unknown tools to unsafe', () => {
    expect(hasExplicitToolReplayPolicy('mcp_custom_tool')).toBe(false)
    expect(getToolReplayPolicy('mcp_custom_tool')).toBe('unsafe')
    expect(getToolReplayPolicy('constructor')).toBe('unsafe')
  })
})
