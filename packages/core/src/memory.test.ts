import { describe, it, expect, afterEach } from 'vitest'
import {
  ensureMemoryStructure,
  ensureConfigStructure,
  readSoulFile,
  readMemoryFile,
  writeMemoryFile,
  readAgentsRulesFile,
  readHeartbeatFile,
  readTasksGuidelinesFile,
  writeTasksGuidelinesFile,
  getDefaultTasksGuidelinesContent,
  getDefaultAgentsRulesContent,
  ensureDailyFile,
  readDailyFile,
  appendToDailyFile,
  readRecentDailyFiles,
  assembleSystemPrompt,
  assembleSystemPromptWithSections,
  getUserProfileDir,
  ensureUserProfile,
  readUserProfile,
  ensureWikiDir,
  ensureSourcesDir,
  ensureProjectsDir,
  parseProjectAliases,
  listWikiPages,
  listProjectNotes,
  formatCurrentTimeContext,
} from './memory.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('formatCurrentTimeContext', () => {
  it('carries date, time and timezone of the configured zone', () => {
    const now = new Date('2026-03-01T23:30:00Z')
    expect(formatCurrentTimeContext('Europe/Berlin', now))
      .toBe('<current_time>Current time: Monday, 2026-03-02 00:30 (Europe/Berlin)</current_time>')
    expect(formatCurrentTimeContext('UTC', now))
      .toBe('<current_time>Current time: Sunday, 2026-03-01 23:30 (UTC)</current_time>')
  })
})

describe('memory', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  function makeTmpDir(): string {
    tmpDir = path.join(os.tmpdir(), `axiom-memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
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
      expect(content).toContain('Communication Rules')
    })

    it('creates AGENTS.md if missing', () => {
      const dir = makeTmpDir()
      const content = readAgentsRulesFile(dir)
      expect(content).toContain('# Agent Contract')
    })

    it('ships the wiki and docs policies but no multi-user rules in the template', () => {
      const template = getDefaultAgentsRulesContent()
      expect(template).toContain('## Wiki Rules')
      expect(template).toContain('Maintain and organize the wiki autonomously')
      expect(template).toContain('genuinely contradicts')
      expect(template).toContain('load the wiki skill')
      expect(template).toContain('## Docs Rules')
      expect(template).toContain('instead of guessing')
      expect(template).toContain('Never write to the docs')
      expect(template).toContain('## Red Lines')
      expect(template).not.toContain('shared by all users')
      expect(template).not.toContain('managed by the admin')
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

  describe('TASKS.md (background task guidelines)', () => {
    it('ensureConfigStructure creates TASKS.md from the default template', () => {
      const dir = makeTmpDir()
      ensureConfigStructure(dir)

      const tasksPath = path.join(dir, 'TASKS.md')
      expect(fs.existsSync(tasksPath)).toBe(true)
      const content = fs.readFileSync(tasksPath, 'utf-8')
      expect(content).toBe(getDefaultTasksGuidelinesContent())
      expect(content).toContain('# Background Task Guidelines')
      expect(content).toContain('Work independently for as long as possible')
      expect(content).toContain('Do NOT just describe what you did')
    })

    it('readTasksGuidelinesFile creates TASKS.md if missing and returns content', () => {
      const dir = makeTmpDir()
      const content = readTasksGuidelinesFile(dir)
      expect(content).toContain('# Background Task Guidelines')
      expect(fs.existsSync(path.join(dir, 'TASKS.md'))).toBe(true)
    })

    it('readTasksGuidelinesFile reads existing custom content unchanged', () => {
      const dir = makeTmpDir()
      ensureConfigStructure(dir)
      const custom = '# Background Task Guidelines\n\n- Be brief.\n'
      fs.writeFileSync(path.join(dir, 'TASKS.md'), custom, 'utf-8')

      const content = readTasksGuidelinesFile(dir)
      expect(content).toBe(custom)
    })

    it('writeTasksGuidelinesFile persists user edits', () => {
      const dir = makeTmpDir()
      writeTasksGuidelinesFile('# Custom\n- one rule\n', dir)

      const onDisk = fs.readFileSync(path.join(dir, 'TASKS.md'), 'utf-8')
      expect(onDisk).toBe('# Custom\n- one rule\n')
      expect(readTasksGuidelinesFile(dir)).toBe('# Custom\n- one rule\n')
    })

    it('ensureConfigStructure does not overwrite existing TASKS.md', () => {
      const dir = makeTmpDir()
      ensureConfigStructure(dir)
      fs.writeFileSync(path.join(dir, 'TASKS.md'), '# Mine\n', 'utf-8')

      ensureConfigStructure(dir)
      expect(fs.readFileSync(path.join(dir, 'TASKS.md'), 'utf-8')).toBe('# Mine\n')
    })
  })

  describe('assembleSystemPrompt', () => {
    it('is built from labeled blocks that join to exactly the prompt', () => {
      const dir = makeTmpDir()
      const configDir = path.join(dir, 'config')
      ensureMemoryStructure(dir)
      ensureConfigStructure(configDir)
      appendToDailyFile('Discussed the context meter.', undefined, dir)
      fs.writeFileSync(path.join(dir, 'wiki', 'axiom.md'), '# Axiom\n')
      const options = {
        memoryDir: dir,
        configDir,
        baseInstructions: 'base rules',
        language: 'German',
        currentUser: { username: 'alice', role: 'admin' },
        agentSkillsDir: '/skills-agent',
        skills: [{ name: 'wiki', description: 'Wiki upkeep', location: '/skills-agent/wiki' }],
        availableProviders: [{ name: 'Local', models: [{ id: 'model-a', isDefaultAgentModel: true }] }],
      }

      const { prompt, sections } = assembleSystemPromptWithSections(options)

      expect(prompt).toBe(assembleSystemPrompt(options))
      expect(sections.map(section => section.text).join('\n\n')).toBe(prompt)
      for (const section of sections) expect(section.text.startsWith(`<${section.key}>`)).toBe(true)
      expect(sections.map(section => section.key)).toEqual([
        'personality', 'instructions', 'agent_rules', 'system_rules', 'core_memory', 'recent_memory', 'current_user',
        'user_profile', 'available_providers',
        'available_skills', 'paths', 'language',
      ])
    })

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

    it('has no tool overview, task system, skill creation or codemode blocks', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({
        memoryDir: dir,
        agentSkillsDir: '/skills-agent',
        availableImageModels: [{ provider: 'OpenRouter', id: 'img' }],
      })

      for (const tag of ['available_tools', 'task_system', 'agent_skills', 'codemode']) {
        expect(prompt).not.toContain(`<${tag}>`)
      }
    })

    it('keeps skill-creator and tasks-and-cronjobs discoverable via available_skills', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({
        memoryDir: dir,
        skills: [
          { name: 'tasks-and-cronjobs', description: 'Tasks', location: '/skills-agent/tasks-and-cronjobs' },
          { name: 'skill-creator', description: 'Skill creation', location: '/skills-agent/skill-creator' },
        ],
      })

      const block = prompt.slice(prompt.indexOf('<available_skills>'), prompt.indexOf('</available_skills>'))
      expect(block).toContain('<name>tasks-and-cronjobs</name>')
      expect(block).toContain('<name>skill-creator</name>')
      expect(prompt.slice(prompt.indexOf('<system_rules>'), prompt.indexOf('</system_rules>'))).toContain('tasks-and-cronjobs')
    })

    it('includes a paths block with memory, wiki, sources, skills, config and docs paths', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({ memoryDir: dir, configDir: path.join(dir, 'cfg'), agentSkillsDir: '/skills-agent' })

      expect(prompt).toContain('<paths>')
      expect(prompt).toContain(path.join(dir, 'SOUL.md'))
      expect(prompt).toContain(path.join(dir, 'MEMORY.md'))
      expect(prompt).toContain(path.join(dir, 'daily/'))
      expect(prompt).toContain(path.join(dir, 'wiki/'))
      expect(prompt).toContain(path.join(dir, 'sources/'))
      expect(prompt).toContain(path.join(dir, 'users/'))
      expect(prompt).toContain('/skills-agent/')
      expect(prompt).toContain(path.join(dir, 'cfg', 'AGENTS.md'))
      expect(prompt).toContain(path.join(dir, 'cfg', 'HEARTBEAT.md'))
      expect(prompt).toContain('README.md')
      expect(prompt).toContain('docs/concepts/')
      expect(prompt).toContain('docs/guide/')
      expect(prompt).toContain('docs/reference/')
      expect(prompt).toContain('</paths>')
    })

    it('no longer emits the removed path and docs sections', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const { sections } = assembleSystemPromptWithSections({ memoryDir: dir })
      const keys = sections.map(section => section.key as string)

      for (const removed of ['memory_paths', 'workspace', 'user_profiles_path', 'shared_data_rules', 'axiom_docs']) {
        expect(keys).not.toContain(removed)
      }
    })

    it('puts the hard-coded system rules right after the agent rules', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const { sections } = assembleSystemPromptWithSections({ memoryDir: dir })
      const keys = sections.map(section => section.key)
      const rules = sections.find(section => section.key === 'system_rules')!.text

      expect(keys.indexOf('system_rules')).toBe(keys.indexOf('agent_rules') + 1)
      expect(rules).toContain('OS-level schedulers')
      expect(rules).toContain('<task_injection>')
      expect(rules).not.toContain('several users')
    })

    it('does not list wiki pages in the prompt', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)
      fs.writeFileSync(path.join(dir, 'wiki', 'axiom.md'), '---\naliases: [Axiom, the-axiom]\n---\n# Project: Axiom\n', 'utf-8')

      const prompt = assembleSystemPrompt({ memoryDir: dir })

      expect(prompt).not.toContain('<wiki_pages>')
      expect(prompt).not.toContain('the-axiom')
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

    it('lists the profiles directory in paths when no currentUser', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({ memoryDir: dir })

      expect(prompt).toContain(`User profiles directory: ${path.join(dir, 'users/')}`)
      expect(prompt).not.toContain('<user_profile>')
    })

    it('lists the current user profile file in paths', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({ memoryDir: dir, currentUser: { username: 'stefan' } })

      expect(prompt).toContain(`User profile: ${path.join(dir, 'users', 'stefan.md')}`)
    })

    it('renders only annotated + default models in available_providers', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({
        memoryDir: dir,
        availableProviders: [
          {
            name: 'Anthropic OAuth',
            models: [
              { id: 'opus-4.8', isDefaultAgentModel: true, description: 'Starkes Modell für komplexe Analyse und Coding.' },
              { id: 'claude-haiku' },
            ],
          },
          {
            name: 'OpenAI',
            models: [
              { id: 'gpt-5.5', isDefaultTaskModel: true },
              { id: 'gpt-4o-mini' },
            ],
          },
          {
            name: 'OpenCode',
            models: [
              { id: 'glm-5.2', description: 'Schnelles aber leistungsfähiges Model für Textverarbeitung wie Twitter/Reddit Digest.' },
            ],
          },
          {
            name: 'Empty Provider',
            models: [
              { id: 'no-description-model' },
            ],
          },
        ],
      })

      expect(prompt).toContain('<available_providers>')
      // Annotated/default models are listed with the label/description suffix
      expect(prompt).toContain('- Anthropic OAuth — opus-4.8: default agent model. Starkes Modell für komplexe Analyse und Coding.')
      expect(prompt).toContain('- OpenAI — gpt-5.5: default task model')
      expect(prompt).toContain('- OpenCode — glm-5.2: Schnelles aber leistungsfähiges Model für Textverarbeitung wie Twitter/Reddit Digest.')
      // Models without a description and not a default are hidden
      expect(prompt).not.toContain('claude-haiku')
      expect(prompt).not.toContain('gpt-4o-mini')
      expect(prompt).not.toContain('no-description-model')
      // A provider with no routable models is omitted entirely
      expect(prompt).not.toContain('Empty Provider')
      // Routing guidance for the agent
      expect(prompt).toContain('Prefer cost-effective models for simple work')
      expect(prompt).toContain('auto-detect the provider from this list')
    })

    it('omits available_providers block when no model qualifies', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({
        memoryDir: dir,
        availableProviders: [
          { name: 'Only Hidden', models: [{ id: 'mystery-model' }] },
        ],
      })

      expect(prompt).not.toContain('<available_providers>')
    })

    it('lists every image generation model in its own block and marks the default', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({
        memoryDir: dir,
        availableProviders: [
          { name: 'Anthropic', models: [{ id: 'opus', isDefaultAgentModel: true }] },
        ],
        availableImageModels: [
          { provider: 'OpenRouter', id: 'recraft/recraft-v4.1-vector', description: 'Logos and icons as SVG.', isDefault: true },
          { provider: 'OpenRouter', id: 'google/gemini-3.1-flash-image' },
        ],
      })

      const block = prompt.slice(prompt.indexOf('<available_providers>'), prompt.indexOf('</available_providers>'))
      expect(block).toContain('- Anthropic — opus: default agent model')
      expect(block).toContain('Image generation models (usable only with `image_generate`')
      expect(block).toContain('- OpenRouter — recraft/recraft-v4.1-vector: default image model. Logos and icons as SVG.')
      expect(block).toContain('- OpenRouter — google/gemini-3.1-flash-image')
      expect(block.indexOf('- Anthropic — opus')).toBeLessThan(block.indexOf('Image generation models'))
    })

    it('renders the image block even when no text model qualifies', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({
        memoryDir: dir,
        availableProviders: [{ name: 'Only Hidden', models: [{ id: 'mystery-model' }] }],
        availableImageModels: [{ provider: 'OpenRouter', id: 'recraft/recraft-v4.1' }],
      })

      expect(prompt).toContain('<available_providers>\nImage generation models')
      expect(prompt).not.toContain('mystery-model')
      expect(prompt).not.toContain('Configured LLM providers')
    })

    it('omits the image block and the image_generate tool line without image models', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({
        memoryDir: dir,
        availableProviders: [{ name: 'Anthropic', models: [{ id: 'opus', isDefaultAgentModel: true }] }],
        availableImageModels: [],
      })

      expect(prompt).toContain('<available_providers>')
      expect(prompt).not.toContain('Image generation models')
      expect(prompt).not.toContain('image_generate')
    })
  })

  describe('parseProjectAliases', () => {
    it('extracts aliases from valid YAML frontmatter', () => {
      const content = '---\naliases: [Axiom, the-axiom, axiom]\n---\n# Project\n'
      expect(parseProjectAliases(content)).toEqual(['Axiom', 'the-axiom', 'axiom'])
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
