import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { buildPathsBlock, buildSystemRules } from './system-prompt-blocks.js'
import type { PathsBlockOptions } from './system-prompt-blocks.js'

describe('buildSystemRules', () => {
  it('only contains the scheduler ban and the task injection trigger for single-user instances', () => {
    const rules = buildSystemRules({ multiUser: false, isAdmin: true })
    expect(rules.startsWith('<system_rules>')).toBe(true)
    expect(rules).toContain('OS-level schedulers')
    expect(rules).toContain('<task_injection>')
    expect(rules).toContain('tasks-and-cronjobs')
    expect(rules).not.toContain('several users')
    expect(rules).not.toContain('Refuse')
  })

  it('adds the shared-data rules in multi-user mode', () => {
    const rules = buildSystemRules({ multiUser: true, isAdmin: true })
    expect(rules).toContain('several users')
    expect(rules).toContain('Never write personal information')
    expect(rules).not.toContain('Refuse')
  })

  it('adds the admin-managed config refusal for non-admins', () => {
    const rules = buildSystemRules({ multiUser: true, isAdmin: false })
    expect(rules).toContain('several users')
    expect(rules).toContain('managed by the admin. Refuse')
  })

  it('replaces the task injection trigger with the working-directory rule in the task variant', () => {
    const rules = buildSystemRules({ multiUser: true, isAdmin: false, variant: 'task' })
    expect(rules).toContain('OS-level schedulers')
    expect(rules).toContain('/tmp')
    expect(rules).not.toContain('<task_injection>')
    expect(rules).toContain('Never write personal information')
    expect(rules).toContain('managed by the admin. Refuse')
  })
})

describe('buildPathsBlock', () => {
  const base: PathsBlockOptions = {
    memoryDir: '/data/memory',
    configDir: '/data/config',
    workspaceDir: '/workspace',
    agentSkillsDir: '/data/skills_agent',
    readmePath: '/app/README.md',
    docsDir: '/app/docs',
    today: '2026-01-02',
    isAdmin: true,
    personalPaths: null,
  }
  const personalPaths = {
    userDir: '/data/users/ann',
    profile: '/data/users/ann/PROFILE.md',
    dailyDir: '/data/users/ann/daily',
    heartbeatFile: '/data/users/ann/HEARTBEAT.md',
    workspace: '/workspace/ann',
  }

  it('lists the legacy layout with config and docs', () => {
    const block = buildPathsBlock(base)
    for (const expected of [
      '/workspace\n', '/data/memory/users/', '/data/memory/daily/', path.join('/data/memory/daily', '2026-01-02.md'),
      '/data/memory/MEMORY.md', '/data/memory/SOUL.md', '/data/memory/wiki/', '/data/memory/sources/',
      '/data/skills_agent/', '/data/config/AGENTS.md', '/data/config/TASKS.md', '/app/README.md',
      '/app/docs/concepts/', '/app/docs/guide/', '/app/docs/reference/',
    ]) expect(block).toContain(expected)
  })

  it('lists personal and shared paths without config files for regular users', () => {
    const block = buildPathsBlock({ ...base, isAdmin: false, personalPaths })
    expect(block).toContain('/workspace/ann')
    expect(block).toContain('/data/users/ann/PROFILE.md')
    expect(block).toContain('/data/users/ann/daily/')
    expect(block).toContain('/data/memory/wiki/')
    expect(block).toContain('SOUL.md (admin-managed)')
    expect(block).not.toContain('/data/memory/users/')
    expect(block).not.toContain('/data/config/')
    expect(block).toContain('/app/docs/reference/')
  })

  it('adds config files for personal admins', () => {
    const block = buildPathsBlock({ ...base, personalPaths })
    expect(block).toContain('/data/config/AGENTS.md')
    expect(block).not.toContain('admin-managed')
  })
})
