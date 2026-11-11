import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { createConsolidationTools } from './consolidation-tools.js'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { resolveUserScope } from './user-scope.js'
import type { UserScope } from './user-scope.js'

let dataDir: string
let previousDataDir: string | undefined
let db: Database
let admin: UserScope
let bob: UserScope

function dataPath(relative: string): string {
  return path.join(dataDir, relative)
}

function writeData(relative: string, content: string): void {
  fs.mkdirSync(path.dirname(dataPath(relative)), { recursive: true })
  fs.writeFileSync(dataPath(relative), content, 'utf-8')
}

function addUser(username: string, role: string): UserScope {
  const id = Number(db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(username, 'h', role).lastInsertRowid)
  return resolveUserScope(db, id)!
}

function tool(tools: AgentTool[], name: string): AgentTool {
  const found = tools.find(t => t.name === name)
  if (!found) throw new Error(`missing tool ${name}`)
  return found
}

async function call(tools: AgentTool[], name: string, params: Record<string, unknown>): Promise<AgentToolResult<unknown>> {
  return tool(tools, name).execute('call-1', params)
}

function text(result: AgentToolResult<unknown>): string {
  return result.content.map(part => (part.type === 'text' ? part.text : '')).join('')
}

async function write(tools: AgentTool[], relative: string): Promise<AgentToolResult<unknown>> {
  return call(tools, 'file_write', { path: dataPath(relative), content: 'injected' })
}

beforeEach(() => {
  dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-consolidation-tools-')))
  previousDataDir = process.env.DATA_DIR
  process.env.DATA_DIR = dataDir
  db = initDatabase(':memory:')
  admin = addUser('admin', 'admin')
  bob = addUser('bob', 'user')

  writeData('memory/MEMORY.md', '# Memory\n')
  writeData('memory/SOUL.md', 'soul')
  writeData('memory/AGENTS.md', 'legacy agents')
  writeData('memory/users/admin.md', 'admin profile')
  writeData('memory/daily/2026-11-07.md', 'admin daily')
  writeData('memory/sources/notes/2026-11-07-a.md', 'source')
  writeData('memory/wiki/index.md', 'line one\nlinks to [[topic]]\n')
  writeData('memory/wiki/topic/index.md', 'topic hub\n')
  writeData('config/AGENTS.md', 'agents')
  writeData('config/settings.json', '{}')
  writeData('users/bob/PROFILE.md', 'bob profile')
  writeData('users/bob/daily/2026-11-07.md', 'bob daily')
  writeData('users/bob/secrets.json', '{}')
  writeData('memory-snapshots/2026-11-06T03-00-00-000Z/memory/MEMORY.md', 'old')
})

afterEach(() => {
  db.close()
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('createConsolidationTools', () => {
  it('provides memory tools only: no shell, task, cronjob, email or web tools', () => {
    const names = createConsolidationTools({ db, scope: admin }).map(t => t.name).sort()

    expect(names).toEqual(['chat_history_read', 'file_edit', 'file_list', 'file_read', 'file_search', 'file_stats', 'file_write', 'memory_search'])
  })

  describe('admin run', () => {
    it.each([
      'memory/MEMORY.md',
      'memory/users/admin.md',
      'memory/wiki/index.md',
      'memory/wiki/new-topic/page.md',
      'users/bob/PROFILE.md',
    ])('may write %s', async (relative) => {
      const tools = createConsolidationTools({ db, scope: admin })

      const result = await write(tools, relative)

      expect(result.isError).toBeUndefined()
      expect(fs.readFileSync(dataPath(relative), 'utf-8')).toBe('injected')
    })

    it.each([
      'config/AGENTS.md',
      'config/settings.json',
      'memory/SOUL.md',
      'memory/AGENTS.md',
      'memory/daily/2026-11-07.md',
      'memory/sources/notes/2026-11-07-a.md',
      'memory/sources/notes/new.md',
      'memory-snapshots/2026-11-06T03-00-00-000Z/memory/MEMORY.md',
      'users/bob/daily/2026-11-07.md',
      'users/bob/secrets.json',
      'workspace/notes.md',
    ])('may not write %s', async (relative) => {
      const tools = createConsolidationTools({ db, scope: admin })
      const before = fs.existsSync(dataPath(relative)) ? fs.readFileSync(dataPath(relative), 'utf-8') : null

      const result = await write(tools, relative)

      expect(result.isError).toBe(true)
      expect(text(result)).toContain('Access denied')
      const after = fs.existsSync(dataPath(relative)) ? fs.readFileSync(dataPath(relative), 'utf-8') : null
      expect(after).toBe(before)
    })

    it('rejects file_edit outside the allowed paths', async () => {
      const tools = createConsolidationTools({ db, scope: admin })

      const result = await call(tools, 'file_edit', { path: dataPath('config/AGENTS.md'), edits: [{ oldText: 'agents', newText: 'pwned' }] })

      expect(result.isError).toBe(true)
      expect(fs.readFileSync(dataPath('config/AGENTS.md'), 'utf-8')).toBe('agents')
    })

    it('rejects .. traversal and symlinks that leave the memory paths', async () => {
      fs.symlinkSync(dataPath('config'), dataPath('memory/wiki/config-link'))
      const tools = createConsolidationTools({ db, scope: admin })

      const traversal = await call(tools, 'file_write', { path: `${dataPath('memory/wiki')}/../../config/AGENTS.md`, content: 'x' })
      const viaLink = await call(tools, 'file_edit', { path: dataPath('memory/wiki/config-link/AGENTS.md'), edits: [{ oldText: 'agents', newText: 'x' }] })
      const readViaLink = await call(tools, 'file_read', { path: dataPath('memory/wiki/config-link/settings.json') })

      expect([traversal.isError, viaLink.isError, readViaLink.isError]).toEqual([true, true, true])
      expect(fs.readFileSync(dataPath('config/AGENTS.md'), 'utf-8')).toBe('agents')
    })

    it('reads memory, sources and dailies but not config, snapshots or files outside the data dir', async () => {
      const tools = createConsolidationTools({ db, scope: admin })

      expect(text(await call(tools, 'file_read', { path: dataPath('memory/daily/2026-11-07.md') }))).toContain('admin daily')
      expect(text(await call(tools, 'file_read', { path: dataPath('memory/sources/notes/2026-11-07-a.md') }))).toContain('source')
      expect((await call(tools, 'file_read', { path: dataPath('config/settings.json') })).isError).toBe(true)
      expect((await call(tools, 'file_list', { path: dataPath('memory-snapshots') })).isError).toBe(true)
      expect((await call(tools, 'file_read', { path: '/etc/hostname' })).isError).toBe(true)
      expect((await call(tools, 'file_list', { path: dataPath('users/bob/daily') })).isError).toBe(true)
    })

    it('rejects relative paths', async () => {
      const tools = createConsolidationTools({ db, scope: admin })

      const result = await call(tools, 'file_write', { path: 'MEMORY.md', content: 'x' })

      expect(result.isError).toBe(true)
      expect(text(result)).toContain('Path must be absolute')
    })
  })

  describe('user run', () => {
    it.each([
      'memory/MEMORY.md',
      'memory/wiki/bob-topic.md',
      'users/bob/PROFILE.md',
    ])('may write %s', async (relative) => {
      const tools = createConsolidationTools({ db, scope: bob })

      expect((await write(tools, relative)).isError).toBeUndefined()
    })

    it.each([
      'memory/users/admin.md',
      'memory/users/bob.md',
      'users/bob/daily/2026-11-07.md',
      'users/bob/HEARTBEAT.md',
      'config/AGENTS.md',
    ])('may not write %s', async (relative) => {
      const tools = createConsolidationTools({ db, scope: bob })

      expect((await write(tools, relative)).isError).toBe(true)
    })

    it('reads its own daily notes but not the admin\'s dailies or profiles', async () => {
      const tools = createConsolidationTools({ db, scope: bob })

      expect(text(await call(tools, 'file_read', { path: dataPath('users/bob/daily/2026-11-07.md') }))).toContain('bob daily')
      expect((await call(tools, 'file_read', { path: dataPath('memory/daily/2026-11-07.md') })).isError).toBe(true)
      expect((await call(tools, 'file_read', { path: dataPath('memory/users/admin.md') })).isError).toBe(true)
    })
  })

  describe('file_stats', () => {
    it('reports line count and size of a file', async () => {
      const tools = createConsolidationTools({ db, scope: admin })

      const result = await call(tools, 'file_stats', { path: dataPath('memory/wiki/index.md') })

      expect(text(result)).toBe(`${dataPath('memory/wiki/index.md')}: 2 lines, 28 bytes`)
    })

    it('lists a directory recursively', async () => {
      const tools = createConsolidationTools({ db, scope: admin })

      const result = await call(tools, 'file_stats', { path: dataPath('memory/wiki'), recursive: true })

      expect(text(result).split('\n')).toEqual([
        '[file] index.md: 2 lines, 28 bytes',
        '[dir] topic',
        '[file] topic/index.md: 1 line, 10 bytes',
      ])
    })

    it('is limited to readable paths', async () => {
      const tools = createConsolidationTools({ db, scope: admin })

      expect((await call(tools, 'file_stats', { path: dataPath('config') })).isError).toBe(true)
    })
  })

  describe('file_search', () => {
    it('finds literal matches with file and line number', async () => {
      const tools = createConsolidationTools({ db, scope: admin })

      const result = await call(tools, 'file_search', { path: dataPath('memory/wiki'), query: '[[TOPIC]]', ignore_case: true })

      expect(text(result)).toBe(`${dataPath('memory/wiki/index.md')}:2: links to [[topic]]`)
    })

    it('does not follow symlinks out of the searched directory', async () => {
      fs.symlinkSync(dataPath('config'), dataPath('memory/wiki/config-link'))
      const tools = createConsolidationTools({ db, scope: admin })

      const result = await call(tools, 'file_search', { path: dataPath('memory/wiki'), query: 'agents' })

      expect(text(result)).toBe('No matches.')
    })

    it('is limited to readable paths', async () => {
      const tools = createConsolidationTools({ db, scope: bob })

      expect((await call(tools, 'file_search', { path: dataPath('memory/daily'), query: 'daily' })).isError).toBe(true)
    })
  })
})
