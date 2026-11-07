import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildTaskSystemPrompt } from './task-system-prompt.js'
import type { UserScope } from './user-scope.js'

const settings = { chatModel: null, thinkingLevel: 'off' as const, language: 'en', timezone: 'UTC' }

function scopeFor(dataDir: string, overrides: Partial<UserScope>): UserScope {
  return {
    id: 2,
    username: 'ann',
    role: 'user',
    isBootstrapAdmin: false,
    paths: {
      userDir: path.join(dataDir, 'users', 'ann'),
      profile: path.join(dataDir, 'users', 'ann', 'PROFILE.md'),
      dailyDir: path.join(dataDir, 'users', 'ann', 'daily'),
      heartbeatFile: path.join(dataDir, 'users', 'ann', 'HEARTBEAT.md'),
      workspace: '/workspace/ann',
    },
    settings,
    ...overrides,
  }
}

describe('buildTaskSystemPrompt', () => {
  let dataDir: string
  let memoryDir: string
  let configDir: string

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-task-prompt-'))
    memoryDir = path.join(dataDir, 'memory')
    configDir = path.join(dataDir, 'config')
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(path.join(configDir, 'TASKS.md'), '- Custom task guideline.\n', 'utf-8')
  })

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  const build = (scope: UserScope | null, multiUser: boolean) => buildTaskSystemPrompt({
    taskPrompt: 'Summarize the news',
    scope,
    multiUser,
    memoryDir,
    configDir,
    now: new Date('2026-03-04T12:00:00Z'),
  })

  it('orders intro, task guidelines, task owner, system rules, paths and output format', () => {
    const prompt = build(scopeFor(dataDir, {}), true)
    const markers = ['background task agent', 'Your task: Summarize the news', '<task_guidelines>', '<task_owner>', '<system_rules>', '<paths>', 'STATUS: completed | failed | question | silent']
    const positions = markers.map(marker => prompt.indexOf(marker))
    for (const position of positions) expect(position).toBeGreaterThanOrEqual(0)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    expect(prompt).toContain('- Custom task guideline.')
  })

  it('has no workspace, memory reference or codemode blocks', () => {
    const prompt = build(scopeFor(dataDir, {}), true)
    expect(prompt).not.toContain('<workspace>')
    expect(prompt).not.toContain('<memory_reference>')
    expect(prompt).not.toContain('<codemode>')
  })

  it('uses the task variant of the system rules', () => {
    const prompt = build(null, false)
    expect(prompt).toContain('/tmp')
    expect(prompt).toContain('OS-level schedulers')
    expect(prompt).not.toContain('<task_injection>')
  })

  it('shows the owner\'s personal paths for a personal-scope task', () => {
    const scope = scopeFor(dataDir, {})
    const prompt = build(scope, true)
    expect(prompt).toContain('Your personal files:')
    expect(prompt).toContain('/workspace/ann')
    expect(prompt).toContain(scope.paths.profile)
    expect(prompt).toContain(path.join(scope.paths.dailyDir, '2026-03-04.md'))
    expect(prompt).not.toContain('Config files:')
    expect(prompt).toContain('This task belongs to the user "ann" (role: user)')
  })

  it('gives multi-user tasks the shared-data rules via system rules only', () => {
    const prompt = build(scopeFor(dataDir, {}), true)
    const rules = prompt.slice(prompt.indexOf('<system_rules>'), prompt.indexOf('</system_rules>'))
    expect(rules).toContain('Never write personal information')
    expect(rules).toContain('managed by the admin. Refuse')
    const owner = prompt.slice(prompt.indexOf('<task_owner>'), prompt.indexOf('</task_owner>'))
    expect(owner).not.toContain('shared by all users')
  })

  it('keeps the legacy layout and config paths for the bootstrap admin of a single-user instance', () => {
    const scope = scopeFor(dataDir, {
      username: 'admin',
      role: 'admin',
      isBootstrapAdmin: true,
      paths: {
        userDir: null,
        profile: path.join(memoryDir, 'users', 'admin.md'),
        dailyDir: path.join(memoryDir, 'daily'),
        heartbeatFile: path.join(configDir, 'HEARTBEAT.md'),
        workspace: '/workspace',
      },
    })
    const prompt = build(scope, false)
    expect(prompt).not.toContain('Your personal files:')
    expect(prompt).toContain(path.join(memoryDir, 'users', 'admin.md'))
    expect(prompt).toContain(path.join(configDir, 'TASKS.md'))
    expect(prompt).not.toContain('several users')
  })

  it('omits the task owner block without a scope', () => {
    const prompt = build(null, false)
    expect(prompt).not.toContain('<task_owner>')
    expect(prompt).toContain('<paths>')
  })
})
