import { describe, it, expect, afterEach } from 'vitest'
import {
  ensureMemoryStructure,
  readSoulFile,
  readMemoryFile,
  writeMemoryFile,
  readAgentsRulesFile,
  readHeartbeatFile,
  ensureDailyFile,
  readDailyFile,
  appendToDailyFile,
  readRecentDailyFiles,
  assembleSystemPrompt,
  getUserProfileDir,
  ensureUserProfile,
  readUserProfile,
} from './memory.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('memory', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  function makeTmpDir(): string {
    tmpDir = path.join(os.tmpdir(), `openagent-memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    return tmpDir
  }

  describe('ensureMemoryStructure', () => {
    it('creates memory directory structure including users/', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      expect(fs.existsSync(dir)).toBe(true)
      expect(fs.existsSync(path.join(dir, 'daily'))).toBe(true)
      expect(fs.existsSync(path.join(dir, 'users'))).toBe(true)
      expect(fs.existsSync(path.join(dir, 'SOUL.md'))).toBe(true)
      expect(fs.existsSync(path.join(dir, 'MEMORY.md'))).toBe(true)
      expect(fs.existsSync(path.join(dir, 'AGENTS.md'))).toBe(true)
      expect(fs.existsSync(path.join(dir, 'HEARTBEAT.md'))).toBe(true)
    })

    it('creates AGENTS.md with default template', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const content = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf-8')
      expect(content).toContain('# Agent Contract')
      expect(content).toContain('## Communication Style')
      expect(content).toContain('## Execution Rules')
      expect(content).toContain('## Red Lines')
    })

    it('creates HEARTBEAT.md with default template', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const content = fs.readFileSync(path.join(dir, 'HEARTBEAT.md'), 'utf-8')
      expect(content).toContain('# Heartbeat Tasks')
      expect(content).toContain('## Daily Memory Update')
      expect(content).toContain('## Memory Hygiene')
    })

    it('does not overwrite existing AGENTS.md', () => {
      const dir = makeTmpDir()
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# Memory', 'utf-8')
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Custom Rules', 'utf-8')

      ensureMemoryStructure(dir)

      const content = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf-8')
      expect(content).toBe('# Custom Rules')
    })

    it('does not overwrite existing HEARTBEAT.md', () => {
      const dir = makeTmpDir()
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'HEARTBEAT.md'), '# Custom Heartbeat', 'utf-8')

      ensureMemoryStructure(dir)

      const content = fs.readFileSync(path.join(dir, 'HEARTBEAT.md'), 'utf-8')
      expect(content).toBe('# Custom Heartbeat')
    })

    it('does not overwrite existing files', () => {
      const dir = makeTmpDir()
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'SOUL.md'), '# Custom Soul', 'utf-8')

      ensureMemoryStructure(dir)

      const content = fs.readFileSync(path.join(dir, 'SOUL.md'), 'utf-8')
      expect(content).toBe('# Custom Soul')
    })
  })

  describe('readSoulFile', () => {
    it('reads SOUL.md content', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const content = readSoulFile(dir)
      expect(content).toContain('# Soul')
      expect(content).toContain('Personality')
    })

    it('creates SOUL.md if missing', () => {
      const dir = makeTmpDir()
      // Don't call ensureMemoryStructure first
      const content = readSoulFile(dir)
      expect(content).toContain('# Soul')
    })
  })

  describe('readMemoryFile / writeMemoryFile', () => {
    it('reads MEMORY.md content', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const content = readMemoryFile(dir)
      expect(content).toContain('# Agent Memory')
      expect(content).toContain('Learned Lessons')
    })

    it('writes and reads back MEMORY.md', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const newContent = '# Agent Memory\n\n## Learned: Testing works!\n'
      writeMemoryFile(newContent, dir)

      const content = readMemoryFile(dir)
      expect(content).toBe(newContent)
    })

    it('migrates legacy AGENTS.md to MEMORY.md when no MEMORY.md exists', () => {
      const dir = makeTmpDir()
      fs.mkdirSync(dir, { recursive: true })
      fs.mkdirSync(path.join(dir, 'daily'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'SOUL.md'), '# Soul', 'utf-8')
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Legacy Content\n', 'utf-8')

      ensureMemoryStructure(dir)

      expect(fs.existsSync(path.join(dir, 'MEMORY.md'))).toBe(true)
      const content = readMemoryFile(dir)
      expect(content).toBe('# Legacy Content\n')
      // After migration, AGENTS.md should be recreated with new template
      expect(fs.existsSync(path.join(dir, 'AGENTS.md'))).toBe(true)
      const agentsContent = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf-8')
      expect(agentsContent).toContain('# Agent Contract')
    })
  })

  describe('daily memory files', () => {
    it('auto-creates daily file with header', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const filePath = ensureDailyFile(undefined, dir)

      expect(fs.existsSync(filePath)).toBe(true)
      const content = fs.readFileSync(filePath, 'utf-8')
      expect(content).toContain('# Daily Memory')

      const today = new Date().toISOString().split('T')[0]
      expect(filePath).toContain(`${today}.md`)
    })

    it('creates daily file at correct path', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const date = new Date('2025-06-15T12:00:00Z')
      const filePath = ensureDailyFile(date, dir)

      expect(filePath).toContain(path.join('daily', '2025-06-15.md'))
      const content = fs.readFileSync(filePath, 'utf-8')
      expect(content).toContain('2025-06-15')
    })

    it('reads daily file', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const content = readDailyFile(undefined, dir)
      expect(content).toContain('# Daily Memory')
    })

    it('appends to daily file', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      appendToDailyFile('\n## Test Entry\n\nSome content\n', undefined, dir)

      const content = readDailyFile(undefined, dir)
      expect(content).toContain('## Test Entry')
      expect(content).toContain('Some content')
    })

    it('appends multiple entries to daily file', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      appendToDailyFile('\n## Entry 1\n\nFirst\n', undefined, dir)
      appendToDailyFile('\n## Entry 2\n\nSecond\n', undefined, dir)

      const content = readDailyFile(undefined, dir)
      expect(content).toContain('## Entry 1')
      expect(content).toContain('## Entry 2')
      expect(content).toContain('First')
      expect(content).toContain('Second')
    })
  })

  describe('readRecentDailyFiles', () => {
    it('returns empty string when no daily files exist', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const content = readRecentDailyFiles(3, dir)
      expect(content).toBe('')
    })

    it('reads recent daily files with content', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      // Write to today's daily file with some content beyond the header
      appendToDailyFile('\n## Session\n\nDid something today\n', undefined, dir)

      const content = readRecentDailyFiles(3, dir)
      expect(content).toContain('Did something today')
    })
  })

  describe('readAgentsRulesFile', () => {
    it('reads AGENTS.md content', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const content = readAgentsRulesFile(dir)
      expect(content).toContain('# Agent Contract')
      expect(content).toContain('Communication Style')
    })

    it('creates AGENTS.md if missing', () => {
      const dir = makeTmpDir()
      const content = readAgentsRulesFile(dir)
      expect(content).toContain('# Agent Contract')
    })
  })

  describe('readHeartbeatFile', () => {
    it('reads HEARTBEAT.md content', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const content = readHeartbeatFile(dir)
      expect(content).toContain('# Heartbeat Tasks')
      expect(content).toContain('Daily Memory Update')
    })

    it('creates HEARTBEAT.md if missing', () => {
      const dir = makeTmpDir()
      const content = readHeartbeatFile(dir)
      expect(content).toContain('# Heartbeat Tasks')
    })
  })

  describe('assembleSystemPrompt', () => {
    it('combines all memory tiers into a coherent prompt', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({ memoryDir: dir })

      // Should contain personality block
      expect(prompt).toContain('<personality>')
      expect(prompt).toContain('# Soul')
      expect(prompt).toContain('</personality>')

      // Should contain core memory block
      expect(prompt).toContain('<core_memory>')
      expect(prompt).toContain('# Agent Memory')
      expect(prompt).toContain('</core_memory>')
    })

    it('includes base instructions when provided', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({
        memoryDir: dir,
        baseInstructions: 'Always respond in German.',
      })

      expect(prompt).toContain('<instructions>')
      expect(prompt).toContain('Always respond in German.')
      expect(prompt).toContain('</instructions>')
    })

    it('includes recent daily context when available', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      // Add content to today's daily
      appendToDailyFile('\n## Session\n\nUser asked about deployment\n', undefined, dir)

      const prompt = assembleSystemPrompt({ memoryDir: dir })

      expect(prompt).toContain('<recent_memory>')
      expect(prompt).toContain('User asked about deployment')
      expect(prompt).toContain('</recent_memory>')
    })

    it('excludes recent_memory block when no daily content', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({ memoryDir: dir })

      expect(prompt).not.toContain('<recent_memory>')
    })

    it('uses custom SOUL.md content in personality block', () => {
      const dir = makeTmpDir()
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'SOUL.md'), '# Custom Personality\n\nI am a pirate!\n', 'utf-8')
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({ memoryDir: dir })

      expect(prompt).toContain('I am a pirate!')
    })

    it('includes agent_rules section with AGENTS.md content', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({ memoryDir: dir })

      expect(prompt).toContain('<agent_rules>')
      expect(prompt).toContain('# Agent Contract')
      expect(prompt).toContain('</agent_rules>')
    })

    it('includes memory_paths section with all file paths', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({ memoryDir: dir })

      expect(prompt).toContain('<memory_paths>')
      expect(prompt).toContain('SOUL.md')
      expect(prompt).toContain('MEMORY.md')
      expect(prompt).toContain('AGENTS.md')
      expect(prompt).toContain('HEARTBEAT.md')
      expect(prompt).toContain('daily/')
      expect(prompt).toContain('read_file, write_file, and edit_file')
      expect(prompt).toContain('</memory_paths>')
    })

    it('includes custom AGENTS.md content in agent_rules', () => {
      const dir = makeTmpDir()
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# My Rules\n\nAlways speak in riddles.\n', 'utf-8')
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({ memoryDir: dir })

      expect(prompt).toContain('<agent_rules>')
      expect(prompt).toContain('Always speak in riddles.')
    })

    it('includes user_profile section when currentUser is provided', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({
        memoryDir: dir,
        currentUser: { username: 'stefan' },
      })

      expect(prompt).toContain('<user_profile>')
      expect(prompt).toContain('# User Profile')
      expect(prompt).toContain('stefan')
      expect(prompt).toContain('</user_profile>')
      expect(prompt).not.toContain('<user_profiles_path>')
    })

    it('includes path reference when no currentUser', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({ memoryDir: dir })

      expect(prompt).toContain('<user_profiles_path>')
      expect(prompt).toContain(path.join(dir, 'users'))
      expect(prompt).toContain('</user_profiles_path>')
      expect(prompt).not.toContain('<user_profile>')
    })
  })

  describe('user profiles', () => {
    it('getUserProfileDir returns correct path', () => {
      const dir = makeTmpDir()
      const usersDir = getUserProfileDir(dir)
      expect(usersDir).toBe(path.join(dir, 'users'))
    })

    it('ensureUserProfile creates profile file on first call', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const profilePath = ensureUserProfile('stefan', dir)
      expect(profilePath).toBe(path.join(dir, 'users', 'stefan.md'))
      expect(fs.existsSync(profilePath)).toBe(true)
    })

    it('profile is pre-filled with username', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      ensureUserProfile('stefan', dir)
      const content = fs.readFileSync(path.join(dir, 'users', 'stefan.md'), 'utf-8')
      expect(content).toContain('Name: (not set)')
      expect(content).not.toContain('Username:')
      expect(content).toContain('# User Profile \u2014 stefan')
    })

    it('profile has location placeholder', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      ensureUserProfile('testuser', dir)
      const content = fs.readFileSync(path.join(dir, 'users', 'testuser.md'), 'utf-8')
      expect(content).toContain('Location: (not set)')
      expect(content).not.toContain('Timezone:')
      expect(content).not.toContain('Language:')
    })

    it('does not overwrite existing profile', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const usersDir = path.join(dir, 'users')
      fs.mkdirSync(usersDir, { recursive: true })
      fs.writeFileSync(path.join(usersDir, 'stefan.md'), '# Custom Profile', 'utf-8')

      ensureUserProfile('stefan', dir)
      const content = fs.readFileSync(path.join(usersDir, 'stefan.md'), 'utf-8')
      expect(content).toBe('# Custom Profile')
    })

    it('readUserProfile creates and reads profile', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const content = readUserProfile('alice', dir)
      expect(content).toContain('# User Profile')
      expect(content).toContain('alice')
      expect(content).toContain('Name: (not set)')
    })

    it('readUserProfile reads existing profile', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const usersDir = path.join(dir, 'users')
      fs.writeFileSync(path.join(usersDir, 'bob.md'), '# Bob\nCustom content', 'utf-8')

      const content = readUserProfile('bob', dir)
      expect(content).toBe('# Bob\nCustom content')
    })
  })
})
