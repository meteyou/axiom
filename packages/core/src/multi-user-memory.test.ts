import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { SessionManager } from './session-manager.js'
import { assembleSystemPrompt } from './memory.js'
import { createBaseAgentTools } from './agent-runtime.js'
import { resolveUserScope } from './user-scope.js'
import { createMemory } from './memories-store.js'

function text(result: unknown): string {
  return (result as { content: Array<{ text?: string }> }).content.map(c => c.text ?? '').join('')
}

describe('multi-user memory and workspace', () => {
  let root: string
  let db: Database
  let admin: number
  let ann: number
  let bob: number
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mu-memory-'))
    for (const key of ['DATA_DIR', 'WORKSPACE_DIR']) saved[key] = process.env[key]
    process.env.DATA_DIR = path.join(root, 'data')
    process.env.WORKSPACE_DIR = path.join(root, 'workspace')
    db = initDatabase(':memory:')
    const add = (name: string, role: string) => Number(db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(name, 'h', role).lastInsertRowid)
    admin = add('admin', 'admin')
    ann = add('ann', 'user')
    bob = add('bob', 'user')
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  const promptFor = (userId: number): string => {
    const scope = resolveUserScope(db, userId)!
    return assembleSystemPrompt({
      memoryDir: path.join(root, 'data', 'memory'),
      configDir: path.join(root, 'data', 'config'),
      currentUser: { username: scope.username, role: scope.role },
      userScope: scope,
    })
  }

  it("writes B's session summary to B's daily folder and keeps it out of A's prompt", async () => {
    const manager = new SessionManager({
      db,
      memoryDir: path.join(root, 'data', 'memory'),
      onSummarize: async () => 'Bob discussed his surprise party.',
    })
    manager.getOrCreateSession(String(bob))
    manager.recordMessage(String(bob))
    manager.recordMessage(String(bob))
    manager.recordMessage(String(bob))
    await manager.handleNewCommand(String(bob))

    const today = new Date().toISOString().split('T')[0]
    const bobDaily = path.join(root, 'data/users/bob/daily', `${today}.md`)
    expect(fs.readFileSync(bobDaily, 'utf-8')).toContain('surprise party')
    expect(fs.existsSync(path.join(root, 'data/memory/daily', `${today}.md`))).toBe(false)

    expect(promptFor(bob)).toContain('surprise party')
    expect(promptFor(ann)).not.toContain('surprise party')
    expect(promptFor(admin)).not.toContain('surprise party')
    await manager.dispose()
  })

  it('gives a regular user their own profile, shared memory and no global config paths', () => {
    fs.mkdirSync(path.join(root, 'data/users/ann'), { recursive: true })
    fs.writeFileSync(path.join(root, 'data/users/ann/PROFILE.md'), '# Ann profile\nLikes tea', 'utf-8')
    const prompt = promptFor(ann)

    expect(prompt).toContain('Likes tea')
    expect(prompt).toContain('Shared memory (MEMORY.md)')
    expect(prompt).toContain(path.join(root, 'data/users/ann/daily'))
    expect(prompt).toContain(path.join(root, 'workspace/ann'))
    expect(prompt).not.toContain(path.join(root, 'data/config/AGENTS.md'))
    expect(prompt).not.toContain(path.join(root, 'data/memory/users/'))
    expect(prompt).not.toContain('HEARTBEAT.md')
    expect(prompt).toContain('managed by the admin')
    expect(prompt).toContain('shared with everyone')
  })

  it('keeps the bootstrap admin prompt on the legacy layout', () => {
    const prompt = promptFor(admin)
    expect(prompt).toContain(path.join(root, 'data/config/AGENTS.md'))
    expect(prompt).toContain(path.join(root, 'data/memory/users/'))
    expect(prompt).not.toContain('Shared memory (MEMORY.md)')
    expect(prompt).not.toContain('<shared_data_rules>')
  })

  it('keeps a regular user on their own layout in group chats without a profile', () => {
    const today = new Date().toISOString().split('T')[0]
    fs.mkdirSync(path.join(root, 'data/memory/daily'), { recursive: true })
    fs.writeFileSync(path.join(root, 'data/memory/daily', `${today}.md`), 'Admin private note', 'utf-8')
    fs.mkdirSync(path.join(root, 'data/users/bob'), { recursive: true })
    fs.writeFileSync(path.join(root, 'data/users/bob/PROFILE.md'), '# Bob profile\nLikes cake', 'utf-8')

    const prompt = assembleSystemPrompt({
      memoryDir: path.join(root, 'data', 'memory'),
      configDir: path.join(root, 'data', 'config'),
      userScope: resolveUserScope(db, bob)!,
    })

    expect(prompt).not.toContain('Admin private note')
    expect(prompt).not.toContain('Likes cake')
    expect(prompt).not.toContain(path.join(root, 'data/memory/users/'))
    expect(prompt).not.toContain(path.join(root, 'data/config/AGENTS.md'))
    expect(prompt).toContain(`Your working directory is ${path.join(root, 'workspace/bob')}.`)
  })

  it('lists global config files for non-bootstrap admins', () => {
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(ann)
    const prompt = promptFor(ann)
    expect(prompt).toContain(path.join(root, 'data/config/AGENTS.md'))
    expect(prompt).toContain(path.join(root, 'data/config/HEARTBEAT.md'))
    expect(prompt).not.toContain(path.join(root, 'data/users/ann/HEARTBEAT.md'))
    expect(prompt).not.toContain('managed by the admin. Refuse')
  })

  describe('tools', () => {
    const toolsFor = (userId: number): AgentTool[] => createBaseAgentTools({ db, user: resolveUserScope(db, userId) })
    const tool = (tools: AgentTool[], name: string) => tools.find(t => t.name === name)!

    it('runs the shell and resolves relative file paths in the user workspace', async () => {
      const tools = toolsFor(bob)
      const workspace = path.join(root, 'workspace/bob')
      const pwd = await tool(tools, 'shell').execute('c', { command: 'pwd' })
      expect(fs.realpathSync(text(pwd).trim())).toBe(fs.realpathSync(workspace))

      await tool(tools, 'write_file').execute('c', { path: 'note.txt', content: 'hi' })
      expect(fs.readFileSync(path.join(workspace, 'note.txt'), 'utf-8')).toBe('hi')
      expect(text(await tool(tools, 'read_file').execute('c', { path: 'note.txt' }))).toContain('hi')
      expect(text(await tool(tools, 'list_files').execute('c', { path: '.' }))).toContain('note.txt')
    })

    it('keeps the legacy workspace for the bootstrap admin', async () => {
      const pwd = await tool(toolsFor(admin), 'shell').execute('c', { command: 'pwd' })
      expect(fs.realpathSync(text(pwd).trim())).toBe(fs.realpathSync(path.join(root, 'workspace')))
    })

    it('returns only the callers chat history', async () => {
      const addSession = (id: string, userId: number, content: string) => {
        db.prepare("INSERT INTO sessions (id, user_id, source, type, session_user) VALUES (?, ?, 'web', 'interactive', ?)").run(id, userId, String(userId))
        db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content) VALUES (?, ?, 'user', ?)").run(id, userId, content)
      }
      addSession('s-ann', ann, 'ann private message')
      addSession('s-bob', bob, 'bob private message')

      const annResult = text(await tool(toolsFor(ann), 'read_chat_history').execute('c', {}))
      expect(annResult).toContain('ann private message')
      expect(annResult).not.toContain('bob private message')

      const bySession = text(await tool(toolsFor(ann), 'read_chat_history').execute('c', { session_id: 's-bob' }))
      expect(bySession).not.toContain('bob private message')
    })

    it('limits callers without a user row to their own sessions', async () => {
      db.prepare("INSERT INTO sessions (id, user_id, source, type, session_user) VALUES ('s-ann', ?, 'web', 'interactive', ?)").run(ann, String(ann))
      db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content) VALUES ('s-ann', ?, 'user', 'ann private message')").run(ann)
      db.prepare("INSERT INTO sessions (id, user_id, source, type, session_user) VALUES ('s-tg', NULL, 'telegram', 'interactive', 'telegram-42')").run()
      db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content) VALUES ('s-tg', NULL, 'user', 'telegram message')").run()

      const tools = createBaseAgentTools({ db, user: null, sessionUser: 'telegram-42' })
      const result = text(await tool(tools, 'read_chat_history').execute('c', {}))
      expect(result).toContain('telegram message')
      expect(result).not.toContain('ann private message')
    })

    it('limits facts of callers without a user row to their own sessions', async () => {
      db.prepare("INSERT INTO sessions (id, user_id, source, type, session_user) VALUES ('s-ann', ?, 'web', 'interactive', ?)").run(ann, String(ann))
      db.prepare("INSERT INTO sessions (id, user_id, source, type, session_user) VALUES ('s-tg', NULL, 'telegram', 'interactive', 'telegram-42')").run()
      createMemory(db, ann, 's-ann', 'ann likes zebrafish', 'web')
      createMemory(db, null, 's-tg', 'telegram likes zebrafish', 'telegram')
      createMemory(db, null, null, 'ownerless zebrafish fact', 'task')

      const tools = createBaseAgentTools({ db, user: null, sessionUser: 'telegram-42' })
      const result = text(await tool(tools, 'search_memories').execute('c', { query: 'zebrafish' }))
      expect(result).toContain('telegram likes')
      expect(result).not.toContain('ann likes')
      expect(result).not.toContain('ownerless')
    })

    it('keeps ownerless background transcripts readable for the bootstrap admin only', async () => {
      db.prepare("INSERT INTO sessions (id, user_id, source, type, session_user) VALUES ('s-task', NULL, 'task', 'task', NULL)").run()
      db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content) VALUES ('s-task', NULL, 'assistant', 'task transcript')").run()

      const adminResult = text(await tool(toolsFor(admin), 'read_chat_history').execute('c', { source: 'task' }))
      expect(adminResult).toContain('task transcript')

      const annResult = text(await tool(toolsFor(ann), 'read_chat_history').execute('c', { source: 'task' }))
      expect(annResult).not.toContain('task transcript')
    })

    it('searches only the callers facts', async () => {
      createMemory(db, ann, 'sess-a', 'ann likes zebrafish', 'web')
      createMemory(db, bob, 'sess-b', 'bob likes zebrafish too', 'web')

      const result = text(await tool(toolsFor(ann), 'search_memories').execute('c', { query: 'zebrafish' }))
      expect(result).toContain('ann likes')
      expect(result).not.toContain('bob likes')
    })
  })
})
