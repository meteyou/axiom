import fs from 'node:fs'
import path from 'node:path'
import {
  NotFoundError,
  InvalidInputError,
  getMemoryDir,
  ensureMemoryStructure,
  readSoulFile,
  readMemoryFile,
  writeMemoryFile,
  readAgentsRulesFile,
  writeAgentsRulesFile,
  getDefaultAgentsRulesContent,
  readUserHeartbeat,
  writeUserHeartbeat,
  isUserHeartbeatEnabled,
  setUserHeartbeatEnabled,
  loadAgentHeartbeatSettings,
  getDefaultHeartbeatContent,
  readConsolidationFile,
  writeConsolidationFile,
  getDefaultConsolidationContent,
  readTasksGuidelinesFile,
  writeTasksGuidelinesFile,
  getDefaultTasksGuidelinesContent,
  getUserProfileTemplate,
  getMemoryById,
  listMemories,
  updateMemory,
  deleteMemory,
  getMemoryUsageStats,
} from '@axiom/core'
import type { ConsolidationResult, UserScope } from '@axiom/core'
import type {
  DailyFileSummary,
  FactsQuery,
  LegacyProjectFileSummary,
  MemoryModuleOptions,
  MemoryTreeNode,
  WikiFileSummary,
} from './types.js'

const DEFAULT_CONSOLIDATION_STATUS = {
  enabled: false,
  runAtHour: 3,
  lookbackDays: 3,
  providerId: '',
  lastRun: null,
  lastResult: null,
  nextRunEstimate: null,
}

export class MemoryFileNotFoundError extends Error {}

export class MemorySchedulerUnavailableError extends Error {}

class MemoryService {
  constructor(private readonly options: MemoryModuleOptions) {}

  readSoul(): string {
    return readSoulFile()
  }

  writeSoul(content: string): void {
    const memoryDir = getMemoryDir()
    ensureMemoryStructure(memoryDir)

    const soulPath = path.join(memoryDir, 'SOUL.md')
    fs.writeFileSync(soulPath, content, 'utf-8')
    this.refreshAgentPrompt()
  }

  readCoreMemory(): string {
    return readMemoryFile()
  }

  writeCoreMemory(content: string): void {
    writeMemoryFile(content)
    this.refreshAgentPrompt()
  }

  readAgentRules(): string {
    return readAgentsRulesFile()
  }

  writeAgentRules(content: string): void {
    writeAgentsRulesFile(content)
    this.refreshAgentPrompt()
  }

  readDefaultAgentRules(): string {
    return getDefaultAgentsRulesContent()
  }

  // Path safety invariant: relPath must come from parseMemoryPathParam (no absolute paths, no '..').
  listFileTree(): MemoryTreeNode[] {
    const memoryDir = getMemoryDir()
    ensureMemoryStructure(memoryDir)
    return readTree(memoryDir, '')
  }

  readFileByPath(relPath: string): string {
    const filePath = path.join(getMemoryDir(), relPath)

    if (!fs.existsSync(filePath)) {
      throw new MemoryFileNotFoundError(`Memory file "${relPath}" not found`)
    }

    return fs.readFileSync(filePath, 'utf-8')
  }

  writeFileByPath(relPath: string, content: string): void {
    const memoryDir = getMemoryDir()
    ensureMemoryStructure(memoryDir)

    const filePath = path.join(memoryDir, relPath)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, content, 'utf-8')
    this.refreshAgentPrompt()
  }

  deleteFileByPath(relPath: string): void {
    const filePath = path.join(getMemoryDir(), relPath)

    if (!fs.existsSync(filePath)) {
      throw new MemoryFileNotFoundError(`Memory file "${relPath}" not found`)
    }

    fs.unlinkSync(filePath)
    this.refreshAgentPrompt()
  }

  listDailyFiles(dailyDir: string): DailyFileSummary[] {
    ensureMemoryStructure(getMemoryDir())

    if (!fs.existsSync(dailyDir)) {
      return []
    }

    const entries = fs.readdirSync(dailyDir)
      .filter((filename) => filename.endsWith('.md'))
      .sort()
      .reverse()

    return entries.map((filename) => {
      const filePath = path.join(dailyDir, filename)
      const stats = fs.statSync(filePath)
      const date = filename.replace('.md', '')

      return {
        filename,
        date,
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
      }
    })
  }

  readDailyFile(dailyDir: string, date: string): string {
    const filePath = path.join(dailyDir, `${date}.md`)

    if (!fs.existsSync(filePath)) {
      throw new MemoryFileNotFoundError(`Daily file for ${date} not found`)
    }

    return fs.readFileSync(filePath, 'utf-8')
  }

  writeDailyFile(dailyDir: string, date: string, content: string): void {
    ensureMemoryStructure(getMemoryDir())

    if (!fs.existsSync(dailyDir)) {
      fs.mkdirSync(dailyDir, { recursive: true })
    }

    const filePath = path.join(dailyDir, `${date}.md`)
    fs.writeFileSync(filePath, content, 'utf-8')
    this.refreshAgentPrompt()
  }

  listWikiPages(): WikiFileSummary[] {
    const memoryDir = getMemoryDir()
    const wikiDir = path.join(memoryDir, 'wiki')

    ensureMemoryStructure(memoryDir)

    if (!fs.existsSync(wikiDir)) {
      return []
    }

    const entries = fs.readdirSync(wikiDir)
      .filter((filename) => filename.endsWith('.md'))
      .sort()

    return entries.map((filename) => {
      const filePath = path.join(wikiDir, filename)
      const stats = fs.statSync(filePath)
      const name = filename.replace('.md', '')
      const content = fs.readFileSync(filePath, 'utf-8')

      return {
        filename,
        name,
        title: extractWikiTitle(content, name),
        aliases: extractWikiAliases(content),
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
      }
    })
  }

  readWikiPage(safeFilename: string): string {
    const memoryDir = getMemoryDir()
    const filePath = path.join(memoryDir, 'wiki', safeFilename)

    if (!fs.existsSync(filePath)) {
      throw new MemoryFileNotFoundError(`Wiki page "${safeFilename.slice(0, -3)}" not found`)
    }

    return fs.readFileSync(filePath, 'utf-8')
  }

  writeWikiPage(safeFilename: string, content: string): void {
    const memoryDir = getMemoryDir()
    const wikiDir = path.join(memoryDir, 'wiki')

    ensureMemoryStructure(memoryDir)

    if (!fs.existsSync(wikiDir)) {
      fs.mkdirSync(wikiDir, { recursive: true })
    }

    const filePath = path.join(wikiDir, safeFilename)
    fs.writeFileSync(filePath, content, 'utf-8')
    this.refreshAgentPrompt()
  }

  deleteWikiPage(safeFilename: string): void {
    const memoryDir = getMemoryDir()
    const filePath = path.join(memoryDir, 'wiki', safeFilename)

    if (!fs.existsSync(filePath)) {
      throw new MemoryFileNotFoundError(`Wiki page "${safeFilename.slice(0, -3)}" not found`)
    }

    fs.unlinkSync(filePath)
    this.refreshAgentPrompt()
  }

  listLegacyProjectFiles(): LegacyProjectFileSummary[] {
    const memoryDir = getMemoryDir()
    const wikiDir = path.join(memoryDir, 'wiki')

    ensureMemoryStructure(memoryDir)

    if (!fs.existsSync(wikiDir)) {
      return []
    }

    const entries = fs.readdirSync(wikiDir)
      .filter((filename) => filename.endsWith('.md'))
      .sort()

    return entries.map((filename) => {
      const filePath = path.join(wikiDir, filename)
      const stats = fs.statSync(filePath)
      const name = filename.replace('.md', '')

      return {
        filename,
        name,
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
      }
    })
  }

  readLegacyProjectFile(name: string): string {
    const memoryDir = getMemoryDir()
    const filePath = path.join(memoryDir, 'wiki', `${name}.md`)

    if (!fs.existsSync(filePath)) {
      throw new MemoryFileNotFoundError(`Project file "${name}" not found`)
    }

    return fs.readFileSync(filePath, 'utf-8')
  }

  writeLegacyProjectFile(name: string, content: string): void {
    const memoryDir = getMemoryDir()
    const wikiDir = path.join(memoryDir, 'wiki')

    ensureMemoryStructure(memoryDir)

    if (!fs.existsSync(wikiDir)) {
      fs.mkdirSync(wikiDir, { recursive: true })
    }

    const filePath = path.join(wikiDir, `${name}.md`)
    fs.writeFileSync(filePath, content, 'utf-8')
    this.refreshAgentPrompt()
  }

  readHeartbeat(scope: UserScope): string {
    return readUserHeartbeat(scope, getDefaultHeartbeatContent())
  }

  writeHeartbeat(scope: UserScope, content: string): void {
    writeUserHeartbeat(scope, content)
    this.refreshAgentPrompt()
  }

  readHeartbeatSettings(scope: UserScope) {
    const global = loadAgentHeartbeatSettings()
    return {
      enabled: isUserHeartbeatEnabled(this.options.db, scope.id, global.enabled),
      masterEnabled: global.enabled,
      intervalMinutes: global.intervalMinutes,
      nightMode: global.nightMode,
      timezone: scope.settings.timezone,
    }
  }

  setHeartbeatEnabled(scope: UserScope, enabled: boolean) {
    setUserHeartbeatEnabled(this.options.db, scope.id, enabled)
    return this.readHeartbeatSettings(scope)
  }

  readDefaultHeartbeat(): string {
    return getDefaultHeartbeatContent()
  }

  readProfile(scope: UserScope): string {
    return readProfileFile(scope)
  }

  writeProfile(scope: UserScope, content: string): void {
    readProfileFile(scope)
    fs.writeFileSync(scope.paths.profile, content, 'utf-8')
    this.refreshAgentPrompt()
  }

  listFacts(query: FactsQuery) {
    return listMemories(this.options.db, {
      query: query.query,
      userId: query.userId,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      limit: query.limit,
      offset: query.offset,
    })
  }

  getUsageStats(days: number) {
    return getMemoryUsageStats(this.options.db, { memoryDir: getMemoryDir(), days })
  }

  assertFactOwner(id: number, ownerId: number): void {
    const fact = getMemoryById(this.options.db, id)
    if (!fact || fact.userId !== ownerId) {
      throw new NotFoundError(`Memory not found: ${id}`)
    }
  }

  updateFact(id: number, content: string): void {
    updateMemory(this.options.db, id, content)
  }

  deleteFact(id: number): void {
    deleteMemory(this.options.db, id)
  }

  readConsolidationRules(): string {
    return readConsolidationFile()
  }

  writeConsolidationRules(content: string): void {
    writeConsolidationFile(content)
  }

  readDefaultConsolidationRules(): string {
    return getDefaultConsolidationContent()
  }

  readTasksGuidelines(): string {
    return readTasksGuidelinesFile()
  }

  writeTasksGuidelines(content: string): void {
    writeTasksGuidelinesFile(content)
    this.refreshAgentPrompt()
  }

  readDefaultTasksGuidelines(): string {
    return getDefaultTasksGuidelinesContent()
  }

  getConsolidationStatus() {
    const scheduler = this.options.consolidationScheduler
    if (!scheduler) {
      return DEFAULT_CONSOLIDATION_STATUS
    }

    return scheduler.getSnapshot()
  }

  async runConsolidation(): Promise<ConsolidationResult> {
    const scheduler = this.options.consolidationScheduler
    if (!scheduler) {
      throw new MemorySchedulerUnavailableError('Consolidation scheduler not available')
    }

    const result = await scheduler.runNow()
    this.refreshAgentPrompt()
    return result
  }

  private refreshAgentPrompt(): void {
    const agentCore = this.options.getAgentCore?.() ?? null
    if (!agentCore) {
      return
    }

    try {
      agentCore.refreshSystemPrompt()
    } catch (err) {
      console.error('[axiom] Failed to refresh system prompt after memory update:', err)
    }
  }
}

export function createMemoryService(options: MemoryModuleOptions): MemoryService {
  return new MemoryService(options)
}

function readProfileFile(scope: UserScope): string {
  const profilePath = scope.paths.profile
  if (!fs.existsSync(profilePath)) {
    fs.mkdirSync(path.dirname(profilePath), { recursive: true })
    fs.writeFileSync(profilePath, getUserProfileTemplate(scope.username), 'utf-8')
  }
  return fs.readFileSync(profilePath, 'utf-8')
}

function readTree(dir: string, relPath: string): MemoryTreeNode[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name))

  const nodes: MemoryTreeNode[] = []

  for (const entry of entries.filter((e) => e.isDirectory())) {
    const childPath = relPath ? `${relPath}/${entry.name}` : entry.name
    nodes.push({
      name: entry.name,
      path: childPath,
      type: 'dir',
      children: readTree(path.join(dir, entry.name), childPath),
    })
  }

  for (const entry of entries.filter((e) => e.isFile() && e.name.endsWith('.md'))) {
    const stats = fs.statSync(path.join(dir, entry.name))
    nodes.push({
      name: entry.name,
      path: relPath ? `${relPath}/${entry.name}` : entry.name,
      type: 'file',
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    })
  }

  return nodes
}

function extractWikiTitle(content: string, fallbackName: string): string {
  const titleMatch = content.match(/^#\s+(.+)$/m)
  return titleMatch ? titleMatch[1].trim() : fallbackName
}

function extractWikiAliases(content: string): string[] {
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!frontmatterMatch) {
    return []
  }

  const aliases: string[] = []
  const inlineAliasesMatch = frontmatterMatch[1].match(/^aliases:\s*\[([^\]]*)\]/m)
  if (inlineAliasesMatch) {
    aliases.push(
      ...inlineAliasesMatch[1]
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    )

    return aliases
  }

  const singleAliasMatch = frontmatterMatch[1].match(/^aliases:\s*(.+)$/m)
  if (singleAliasMatch && singleAliasMatch[1].trim()) {
    aliases.push(singleAliasMatch[1].trim())
  }

  return aliases
}

export {
  InvalidInputError,
  NotFoundError,
}
