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
  ensureWikiDir,
  ensureSourcesDir,
  ensureProjectsDir,
  parseProjectAliases,
  listWikiPages,
  listProjectNotes,
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
    it('creates memory directory structure including users/ and wiki/', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      expect(fs.existsSync(dir)).toBe(true)
      expect(fs.existsSync(path.join(dir, 'daily'))).toBe(true)
      expect(fs.existsSync(path.join(dir, 'users'))).toBe(true)
      expect(fs.existsSync(path.join(dir, 'wiki'))).toBe(true)
      expect(fs.existsSync(path.join(dir, 'SOUL.md'))).toBe(true)
      expect(fs.existsSync(path.join(dir, 'MEMORY.md'))).toBe(true)
      // AGENTS.md and HEARTBEAT.md are now in config dir, not memory dir
      expect(fs.existsSync(path.join(dir, 'AGENTS.md'))).toBe(false)
      expect(fs.existsSync(path.join(dir, 'HEARTBEAT.md'))).toBe(false)
    })

    it('creates sources/ directory with README on first run', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const sourcesDir = path.join(dir, 'sources')
      expect(fs.existsSync(sourcesDir)).toBe(true)

      const readmePath = path.join(sourcesDir, 'README.md')
      expect(fs.existsSync(readmePath)).toBe(true)
      const readme = fs.readFileSync(readmePath, 'utf-8')
      expect(readme).toContain('# Sources')
      expect(readme).toContain('Immutable')

      // Subfolders (articles/, youtube/, ...) should NOT be auto-created
      expect(fs.existsSync(path.join(sourcesDir, 'articles'))).toBe(false)
      expect(fs.existsSync(path.join(sourcesDir, 'youtube'))).toBe(false)
    })

    it('migrates projects/ to wiki/ on first run', () => {
      const dir = makeTmpDir()
      fs.mkdirSync(dir, { recursive: true })
      // Create a legacy projects/ directory with a file
      const projectsDir = path.join(dir, 'projects')
      fs.mkdirSync(projectsDir, { recursive: true })
      fs.writeFileSync(path.join(projectsDir, 'myproject.md'), '# My Project\n', 'utf-8')

      ensureMemoryStructure(dir)

      // projects/ should be gone, wiki/ should exist with the migrated file
      expect(fs.existsSync(path.join(dir, 'projects'))).toBe(false)
      expect(fs.existsSync(path.join(dir, 'wiki'))).toBe(true)
      expect(fs.existsSync(path.join(dir, 'wiki', 'myproject.md'))).toBe(true)
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

  describe('ensureSourcesDir', () => {
    it('is idempotent and does not overwrite an existing README', () => {
      const dir = makeTmpDir()
      fs.mkdirSync(dir, { recursive: true })

      const sourcesDir = ensureSourcesDir(dir)
      expect(sourcesDir).toBe(path.join(dir, 'sources'))

      // User edits the README
      const readmePath = path.join(sourcesDir, 'README.md')
      fs.writeFileSync(readmePath, '# My Custom Sources Index\n', 'utf-8')

      // Second call must not overwrite user edits
      ensureSourcesDir(dir)
      const content = fs.readFileSync(readmePath, 'utf-8')
      expect(content).toBe('# My Custom Sources Index\n')
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
      // After migration, AGENTS.md was renamed to MEMORY.md and no longer exists in memory dir
      expect(fs.existsSync(path.join(dir, 'AGENTS.md'))).toBe(false)
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
      expect(content).not.toContain('Daily Memory Update')
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

    it('includes search_memories in the available tools section', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({ memoryDir: dir })

      expect(prompt).toContain('<available_tools>')
      expect(prompt).toContain('search_memories')
      expect(prompt).toContain('fact memory')
    })

    it('includes memory_paths section with all file paths including wiki/', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({ memoryDir: dir })

      expect(prompt).toContain('<memory_paths>')
      expect(prompt).toContain('SOUL.md')
      expect(prompt).toContain('MEMORY.md')
      expect(prompt).toContain('AGENTS.md')
      expect(prompt).toContain('HEARTBEAT.md')
      expect(prompt).toContain('daily/')
      expect(prompt).toContain('wiki/')
      expect(prompt).toContain('read_file, write_file, and edit_file')
      expect(prompt).toContain('</memory_paths>')
    })

    it('includes Sources directory reference in memory_paths', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({ memoryDir: dir })

      expect(prompt).toContain('<memory_paths>')
      expect(prompt).toContain('Sources directory')
      expect(prompt).toContain(path.join(dir, 'sources'))
    })

    it('includes wiki_pages section when wiki pages exist', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      // Create a wiki page
      const wikiDir = path.join(dir, 'wiki')
      fs.writeFileSync(path.join(wikiDir, 'openagent.md'), '---\naliases: [OpenAgent, open-agent]\n---\n# Project: OpenAgent\n', 'utf-8')

      const prompt = assembleSystemPrompt({ memoryDir: dir })

      expect(prompt).toContain('<wiki_pages>')
      expect(prompt).toContain('openagent.md')
      expect(prompt).toContain('OpenAgent')
      expect(prompt).toContain('open-agent')
      expect(prompt).toContain('load it with read_file')
      expect(prompt).toContain('</wiki_pages>')
    })

    it('excludes wiki_pages section when no wiki pages exist', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({ memoryDir: dir })

      expect(prompt).not.toContain('<wiki_pages>')
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

  describe('parseProjectAliases', () => {
    it('extracts aliases from valid YAML frontmatter', () => {
      const content = '---\naliases: [OpenAgent, open-agent, openagent]\n---\n# Project\n'
      expect(parseProjectAliases(content)).toEqual(['OpenAgent', 'open-agent', 'openagent'])
    })

    it('returns empty array when no frontmatter', () => {
      const content = '# Project\n\nSome content'
      expect(parseProjectAliases(content)).toEqual([])
    })

    it('returns empty array for empty content', () => {
      expect(parseProjectAliases('')).toEqual([])
    })

    it('returns empty array for frontmatter without aliases', () => {
      const content = '---\ntitle: My Project\n---\n# Project\n'
      expect(parseProjectAliases(content)).toEqual([])
    })

    it('handles empty aliases array', () => {
      const content = '---\naliases: []\n---\n# Project\n'
      expect(parseProjectAliases(content)).toEqual([])
    })

    it('handles single alias value', () => {
      const content = '---\naliases: MyProject\n---\n# Project\n'
      expect(parseProjectAliases(content)).toEqual(['MyProject'])
    })

    it('handles malformed frontmatter (no closing ---)', () => {
      const content = '---\naliases: [Foo]\n# No closing delimiter\n'
      expect(parseProjectAliases(content)).toEqual([])
    })

    it('handles aliases with extra spaces', () => {
      const content = '---\naliases: [  Foo ,  Bar  , Baz ]\n---\n# Project\n'
      expect(parseProjectAliases(content)).toEqual(['Foo', 'Bar', 'Baz'])
    })
  })

  describe('listWikiPages', () => {
    it('returns empty array for empty wiki directory', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const pages = listWikiPages(dir)
      expect(pages).toEqual([])
    })

    it('lists multiple wiki page files with aliases', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const wikiDir = path.join(dir, 'wiki')
      fs.writeFileSync(path.join(wikiDir, 'alpha.md'), '---\naliases: [Alpha, alpha-project]\n---\n# Alpha\n', 'utf-8')
      fs.writeFileSync(path.join(wikiDir, 'beta.md'), '---\naliases: [Beta]\n---\n# Beta\n', 'utf-8')

      const pages = listWikiPages(dir)
      expect(pages).toHaveLength(2)
      expect(pages[0]).toEqual({ filename: 'alpha.md', aliases: ['Alpha', 'alpha-project'] })
      expect(pages[1]).toEqual({ filename: 'beta.md', aliases: ['Beta'] })
    })

    it('handles files without frontmatter', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const wikiDir = path.join(dir, 'wiki')
      fs.writeFileSync(path.join(wikiDir, 'noaliases.md'), '# No Aliases Page\n', 'utf-8')

      const pages = listWikiPages(dir)
      expect(pages).toHaveLength(1)
      expect(pages[0]).toEqual({ filename: 'noaliases.md', aliases: [] })
    })

    it('ignores non-md files', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const wikiDir = path.join(dir, 'wiki')
      fs.writeFileSync(path.join(wikiDir, 'page.md'), '---\naliases: [P]\n---\n', 'utf-8')
      fs.writeFileSync(path.join(wikiDir, 'readme.txt'), 'not a page', 'utf-8')

      const pages = listWikiPages(dir)
      expect(pages).toHaveLength(1)
      expect(pages[0].filename).toBe('page.md')
    })

    it('creates wiki directory if it does not exist', () => {
      const dir = makeTmpDir()
      fs.mkdirSync(dir, { recursive: true })

      const pages = listWikiPages(dir)
      expect(pages).toEqual([])
      expect(fs.existsSync(path.join(dir, 'wiki'))).toBe(true)
    })
  })

  describe('listProjectNotes (backward compat alias)', () => {
    it('returns same result as listWikiPages', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const wikiDir = path.join(dir, 'wiki')
      fs.writeFileSync(path.join(wikiDir, 'mypage.md'), '---\naliases: [MyPage]\n---\n# My Page\n', 'utf-8')

      const pages = listProjectNotes(dir)
      expect(pages).toHaveLength(1)
      expect(pages[0]).toEqual({ filename: 'mypage.md', aliases: ['MyPage'] })
    })
  })

  describe('ensureWikiDir', () => {
    it('creates wiki directory and returns path', () => {
      const dir = makeTmpDir()
      fs.mkdirSync(dir, { recursive: true })

      const wikiDir = ensureWikiDir(dir)
      expect(wikiDir).toBe(path.join(dir, 'wiki'))
      expect(fs.existsSync(wikiDir)).toBe(true)
    })

    it('is idempotent', () => {
      const dir = makeTmpDir()
      fs.mkdirSync(dir, { recursive: true })

      ensureWikiDir(dir)
      ensureWikiDir(dir)
      expect(fs.existsSync(path.join(dir, 'wiki'))).toBe(true)
    })

    it('migrates projects/ to wiki/', () => {
      const dir = makeTmpDir()
      fs.mkdirSync(dir, { recursive: true })
      const projectsDir = path.join(dir, 'projects')
      fs.mkdirSync(projectsDir, { recursive: true })
      fs.writeFileSync(path.join(projectsDir, 'old.md'), '# Old\n', 'utf-8')

      const wikiDir = ensureWikiDir(dir)
      expect(wikiDir).toBe(path.join(dir, 'wiki'))
      expect(fs.existsSync(path.join(dir, 'projects'))).toBe(false)
      expect(fs.existsSync(path.join(dir, 'wiki', 'old.md'))).toBe(true)
    })
  })

  describe('ensureProjectsDir (backward compat alias)', () => {
    it('creates wiki directory and returns wiki path', () => {
      const dir = makeTmpDir()
      fs.mkdirSync(dir, { recursive: true })

      const result = ensureProjectsDir(dir)
      expect(result).toBe(path.join(dir, 'wiki'))
      expect(fs.existsSync(result)).toBe(true)
    })

    it('is idempotent', () => {
      const dir = makeTmpDir()
      fs.mkdirSync(dir, { recursive: true })

      ensureProjectsDir(dir)
      ensureProjectsDir(dir)
      expect(fs.existsSync(path.join(dir, 'wiki'))).toBe(true)
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
