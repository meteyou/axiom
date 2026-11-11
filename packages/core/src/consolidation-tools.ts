import fs from 'node:fs'
import path from 'node:path'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'
import { createYoloTools } from './agent-runtime.js'
import { getAgentSkillsDir } from './agent-skills.js'
import { createReadChatHistoryTool } from './chat-history-tools.js'
import { getConfigDir } from './config.js'
import type { Database } from './database.js'
import { createSearchMemoriesTool } from './memories-tool.js'
import { getMemoryDir } from './memory.js'
import { checkPathAccess } from './memory-path-guard.js'
import type { PathAccess, PathPolicy } from './memory-path-guard.js'
import { resolveUserScope } from './user-scope.js'
import type { UserScope } from './user-scope.js'

const MAX_STATS_ENTRIES = 2000
const MAX_SEARCH_MATCHES = 200
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024

export interface ConsolidationToolsOptions {
  db: Database
  /** Owner of the consolidation run; null on instances without user rows. */
  scope: UserScope | null
}

function dataDir(): string {
  return process.env.DATA_DIR ?? '/data'
}

function otherUserProfiles(db: Database): string[] {
  const rows = db.prepare('SELECT id FROM users WHERE deleted_at IS NULL ORDER BY id').all() as Array<{ id: number }>
  return rows
    .map(row => resolveUserScope(db, row.id))
    .filter((scope): scope is UserScope => scope != null && !scope.isBootstrapAdmin)
    .map(scope => scope.paths.profile)
}

/**
 * The admin (or ownerless) run curates shared memory and may move personal
 * content into any user's profile. A regular user's run only sees shared
 * memory plus its own folder, and writes its own profile.
 */
function buildConsolidationPathPolicy(db: Database, scope: UserScope | null): PathPolicy {
  const memoryDir = getMemoryDir()
  const memoryFile = path.join(memoryDir, 'MEMORY.md')
  const wikiDir = path.join(memoryDir, 'wiki')
  const wikiSkillDir = path.join(getAgentSkillsDir(), 'wiki')
  const deny = [getConfigDir(), path.join(dataDir(), 'memory-snapshots')]
  const denyWrite = [
    path.join(memoryDir, 'SOUL.md'),
    path.join(memoryDir, 'AGENTS.md'),
    path.join(memoryDir, 'sources'),
    path.join(memoryDir, 'daily'),
    getAgentSkillsDir(),
    ...(scope ? [scope.paths.dailyDir] : []),
  ]

  if (scope && !scope.isBootstrapAdmin) {
    return {
      read: [memoryFile, wikiDir, path.join(memoryDir, 'sources'), wikiSkillDir, ...(scope.paths.userDir ? [scope.paths.userDir] : [])],
      write: [memoryFile, wikiDir, scope.paths.profile],
      deny,
      denyWrite,
    }
  }

  const profiles = otherUserProfiles(db)
  return {
    read: [memoryDir, wikiSkillDir, ...profiles],
    write: [memoryFile, path.join(memoryDir, 'users'), wikiDir, ...profiles],
    deny,
    denyWrite,
  }
}

function errorResult(text: string): AgentToolResult<{ error: true }> {
  return { content: [{ type: 'text', text }], details: { error: true }, isError: true }
}

function textResult(text: string, details: Record<string, unknown>): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: 'text', text }], details }
}

function guardPathTool(tool: AgentTool, policy: PathPolicy, access: PathAccess): AgentTool {
  return {
    ...tool,
    description: `${tool.description} Only absolute paths inside the memory locations of this consolidation run are accepted.`,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const toolParams = params as { path: string }
      const check = checkPathAccess(policy, toolParams.path, access)
      if (!check.allowed) return errorResult(check.reason)
      return tool.execute(toolCallId, { ...toolParams, path: check.path }, signal, onUpdate)
    },
  }
}

function countLines(content: string): number {
  if (content.length === 0) return 0
  const newlines = content.split('\n').length - 1
  return content.endsWith('\n') ? newlines : newlines + 1
}

/** Walks without following symlinks, so a link can never lead the walk outside an allowed root. */
function walkFiles(root: string, recursive: boolean, visit: (file: string, entry: fs.Dirent) => boolean): void {
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const entryPath = path.join(root, entry.name)
    if (!visit(entryPath, entry)) return
    if (recursive && entry.isDirectory()) walkFiles(entryPath, recursive, visit)
  }
}

function describeFile(file: string): string {
  const content = fs.readFileSync(file, 'utf-8')
  const lines = countLines(content)
  return `${lines} ${lines === 1 ? 'line' : 'lines'}, ${Buffer.byteLength(content)} bytes`
}

function createFileStatsTool(policy: PathPolicy): AgentTool {
  return {
    name: 'file_stats',
    label: 'File Stats',
    description: 'Line count and size of a file, or of every file in a directory (optionally recursive). Use it to check size budgets and find oversized wiki pages.',
    parameters: Type.Object({
      path: Type.String({ description: 'Absolute path of a file or directory' }),
      recursive: Type.Optional(Type.Boolean({ description: 'Include subdirectories (default: false)' })),
    }),
    execute: async (_toolCallId, params) => {
      const { path: requestedPath, recursive = false } = params as { path: string; recursive?: boolean }
      const check = checkPathAccess(policy, requestedPath, 'read')
      if (!check.allowed) return errorResult(check.reason)
      try {
        if (!fs.statSync(check.path).isDirectory()) {
          return textResult(`${check.path}: ${describeFile(check.path)}`, { path: check.path })
        }
        const lines: string[] = []
        walkFiles(check.path, recursive, (file, entry) => {
          const label = path.relative(check.path, file)
          if (entry.isDirectory()) lines.push(`[dir] ${label}`)
          else if (entry.isFile() && checkPathAccess(policy, file, 'read').allowed) lines.push(`[file] ${label}: ${describeFile(file)}`)
          return lines.length < MAX_STATS_ENTRIES
        })
        const truncated = lines.length >= MAX_STATS_ENTRIES ? `\n(truncated after ${MAX_STATS_ENTRIES} entries)` : ''
        return textResult((lines.join('\n') || '(empty directory)') + truncated, { path: check.path, count: lines.length })
      } catch (err) {
        return errorResult(`Error reading stats: ${(err as Error).message}`)
      }
    },
  }
}

function searchFile(file: string, needle: string, ignoreCase: boolean, matches: string[]): void {
  if (fs.statSync(file).size > MAX_SEARCH_FILE_BYTES) return
  const content = fs.readFileSync(file, 'utf-8')
  if (content.includes('\0')) return
  const lines = content.split('\n')
  for (let index = 0; index < lines.length && matches.length < MAX_SEARCH_MATCHES; index++) {
    const line = ignoreCase ? lines[index].toLowerCase() : lines[index]
    if (line.includes(needle)) matches.push(`${file}:${index + 1}: ${lines[index].trim()}`)
  }
}

function createSearchFilesTool(policy: PathPolicy): AgentTool {
  return {
    name: 'file_search',
    label: 'Search Files',
    description: 'Find lines containing a literal text in a file or, recursively, in all files of a directory. Use it to find links to a wiki page or duplicated facts.',
    parameters: Type.Object({
      path: Type.String({ description: 'Absolute path of a file or directory' }),
      query: Type.String({ description: 'Literal text to search for (no regex)' }),
      ignore_case: Type.Optional(Type.Boolean({ description: 'Case-insensitive match (default: false)' })),
    }),
    execute: async (_toolCallId, params) => {
      const { path: requestedPath, query, ignore_case: ignoreCase = false } = params as { path: string; query: string; ignore_case?: boolean }
      if (typeof query !== 'string' || query.length === 0) return errorResult('query must be a non-empty string.')
      const check = checkPathAccess(policy, requestedPath, 'read')
      if (!check.allowed) return errorResult(check.reason)
      const needle = ignoreCase ? query.toLowerCase() : query
      const matches: string[] = []
      try {
        if (!fs.statSync(check.path).isDirectory()) {
          searchFile(check.path, needle, ignoreCase, matches)
        } else {
          walkFiles(check.path, true, (file, entry) => {
            if (entry.isFile() && checkPathAccess(policy, file, 'read').allowed) searchFile(file, needle, ignoreCase, matches)
            return matches.length < MAX_SEARCH_MATCHES
          })
        }
      } catch (err) {
        return errorResult(`Error searching files: ${(err as Error).message}`)
      }
      const truncated = matches.length >= MAX_SEARCH_MATCHES ? `\n(truncated after ${MAX_SEARCH_MATCHES} matches)` : ''
      return textResult((matches.join('\n') || 'No matches.') + truncated, { path: check.path, count: matches.length })
    },
  }
}

const GUARDED_FILE_TOOLS: ReadonlyMap<string, PathAccess> = new Map([
  ['file_read', 'read'],
  ['file_list', 'read'],
  ['file_write', 'write'],
  ['file_edit', 'write'],
])

/**
 * Tool set of a memory consolidation task. Consolidation reads conversation
 * content that may contain injected instructions, so the boundary is enforced
 * here rather than in the prompt: no shell, no task, email, web or cronjob
 * tools, and file access limited to the memory locations of the run.
 */
export function createConsolidationTools(options: ConsolidationToolsOptions): AgentTool[] {
  const policy = buildConsolidationPathPolicy(options.db, options.scope)
  const fileTools = createYoloTools(getMemoryDir)
    .filter(tool => GUARDED_FILE_TOOLS.has(tool.name))
    .map(tool => guardPathTool(tool, policy, GUARDED_FILE_TOOLS.get(tool.name)!))

  return [
    ...fileTools,
    createFileStatsTool(policy),
    createSearchFilesTool(policy),
    createReadChatHistoryTool({
      db: options.db,
      getCurrentUserId: () => options.scope?.id,
      includeOwnerlessSessions: () => options.scope == null || options.scope.isBootstrapAdmin,
    }),
    createSearchMemoriesTool({
      db: options.db,
      getCurrentUserId: () => options.scope?.id,
    }),
  ]
}
