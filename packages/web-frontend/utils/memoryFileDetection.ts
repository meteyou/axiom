/**
 * Utility to detect memory-related file operations and provide
 * descriptive labels and icon hints for the chat view.
 */

export interface MemoryFileInfo {
  isMemoryFile: boolean
  label: string
  icon: 'brain' | 'settings'
}

const MEMORY_PATH_PATTERNS: Array<{ pattern: RegExp; readLabel: string; writeLabel: string; editLabel: string }> = [
  { pattern: /SOUL\.md$/i, readLabel: 'Reading Personality', writeLabel: 'Writing Personality', editLabel: 'Editing Personality' },
  { pattern: /MEMORY\.md$/i, readLabel: 'Reading Memory', writeLabel: 'Writing Memory', editLabel: 'Editing Memory' },
  { pattern: /AGENTS\.md$/i, readLabel: 'Reading Agent Rules', writeLabel: 'Writing Agent Rules', editLabel: 'Editing Agent Rules' },
  { pattern: /HEARTBEAT\.md$/i, readLabel: 'Reading Heartbeat Tasks', writeLabel: 'Writing Heartbeat Tasks', editLabel: 'Editing Heartbeat Tasks' },
  { pattern: /\/daily\/[^/]+\.md$/i, readLabel: 'Reading Daily Notes', writeLabel: 'Writing Daily Notes', editLabel: 'Editing Daily Notes' },
  { pattern: /\/users\/[^/]+\.md$/i, readLabel: 'Reading User Profile', writeLabel: 'Writing User Profile', editLabel: 'Editing User Profile' },
]

/**
 * Check if a tool call path is a memory file and return display info.
 */
export function detectMemoryFile(
  toolName: string,
  toolArgs: unknown,
): MemoryFileInfo {
  const defaultResult: MemoryFileInfo = { isMemoryFile: false, label: '', icon: 'settings' }

  // Only match file read/write/edit tools
  const isRead = toolName === 'read_file' || toolName === 'Read'
  const isWrite = toolName === 'write_file' || toolName === 'Write'
  const isEdit = toolName === 'edit_file' || toolName === 'Edit'
  if (!isRead && !isWrite && !isEdit) return defaultResult

  // Extract path from tool args
  const filePath = extractPath(toolArgs)
  if (!filePath) return defaultResult

  // Check if path is in memory directory
  if (!isMemoryPath(filePath)) return defaultResult

  // Match against known patterns
  for (const { pattern, readLabel, writeLabel, editLabel } of MEMORY_PATH_PATTERNS) {
    if (pattern.test(filePath)) {
      return {
        isMemoryFile: true,
        label: isEdit ? editLabel : isWrite ? writeLabel : readLabel,
        icon: 'brain',
      }
    }
  }

  // Generic memory file
  return {
    isMemoryFile: true,
    label: isEdit ? 'Editing Memory File' : isWrite ? 'Writing Memory File' : 'Reading Memory File',
    icon: 'brain',
  }
}

function extractPath(toolArgs: unknown): string | null {
  if (!toolArgs || typeof toolArgs !== 'object') return null
  const args = toolArgs as Record<string, unknown>
  if (typeof args.path === 'string') return args.path
  if (typeof args.file_path === 'string') return args.file_path
  if (typeof args.filePath === 'string') return args.filePath
  return null
}

function isMemoryPath(filePath: string): boolean {
  // Match common memory directory patterns
  return (
    filePath.includes('/data/memory/') ||
    filePath.includes('/memory/SOUL.md') ||
    filePath.includes('/memory/MEMORY.md') ||
    filePath.includes('/memory/AGENTS.md') ||
    filePath.includes('/memory/HEARTBEAT.md') ||
    filePath.includes('/memory/daily/') ||
    filePath.includes('/memory/users/')
  )
}

/**
 * Extract a canonical memory file path for display purposes.
 * Always returns `/data/memory/...` regardless of the actual host path.
 */
export function extractMemoryFileName(toolArgs: unknown): string | null {
  const filePath = extractPath(toolArgs)
  if (!filePath || !isMemoryPath(filePath)) return null

  // Normalize to canonical /data/memory/... path
  const memoryIndex = filePath.indexOf('/memory/')
  if (memoryIndex !== -1) {
    return `/data${filePath.substring(memoryIndex)}`
  }

  return filePath.split('/').pop() ?? null
}

/**
 * Extract memoryDiff from a write_file tool result.
 * Returns { before, after } if present, null otherwise.
 */
export function extractMemoryDiff(toolResult: unknown): { before: string; after: string } | null {
  if (!toolResult || typeof toolResult !== 'object') return null

  // Direct shape: { details: { memoryDiff: { before, after } } }
  const result = toolResult as Record<string, unknown>
  const details = result.details as Record<string, unknown> | undefined
  const diff = details?.memoryDiff as Record<string, unknown> | undefined

  if (diff && typeof diff.before === 'string' && typeof diff.after === 'string') {
    return { before: diff.before, after: diff.after }
  }

  // Stringified JSON shape (from activity log output)
  if (typeof result.memoryDiff === 'object' && result.memoryDiff) {
    const md = result.memoryDiff as Record<string, unknown>
    if (typeof md.before === 'string' && typeof md.after === 'string') {
      return { before: md.before, after: md.after }
    }
  }

  return null
}

/**
 * Extract the written content from a write_file tool call on a memory file.
 * Used as fallback when no memoryDiff is available in the result.
 */
export function extractMemoryWriteContent(toolName: string, toolArgs: unknown): string | null {
  if (toolName !== 'write_file' && toolName !== 'Write') return null
  if (!toolArgs || typeof toolArgs !== 'object') return null

  const args = toolArgs as Record<string, unknown>
  const filePath = extractPath(args)
  if (!filePath || !isMemoryPath(filePath)) return null

  const content = args.content
  if (typeof content !== 'string') return null

  return content
}

/**
 * Extract edits from an edit_file tool call's args.
 * Returns array of { oldText, newText } if present, null otherwise.
 */
export function extractEditsFromArgs(toolArgs: unknown): Array<{ oldText: string; newText: string }> | null {
  if (!toolArgs || typeof toolArgs !== 'object') return null
  const args = toolArgs as Record<string, unknown>
  const edits = args.edits
  if (!Array.isArray(edits) || edits.length === 0) return null

  const valid = edits.every(
    (e: unknown) => e && typeof e === 'object' && typeof (e as Record<string, unknown>).oldText === 'string' && typeof (e as Record<string, unknown>).newText === 'string',
  )
  if (!valid) return null

  return edits as Array<{ oldText: string; newText: string }>
}
