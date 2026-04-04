/**
 * Utility to detect memory-related file operations and provide
 * descriptive labels and icon hints for the chat view.
 */

export interface MemoryFileInfo {
  isMemoryFile: boolean
  label: string
  icon: 'brain' | 'settings'
}

const MEMORY_PATH_PATTERNS: Array<{ pattern: RegExp; readLabel: string; writeLabel: string }> = [
  { pattern: /SOUL\.md$/i, readLabel: 'Reading Personality', writeLabel: 'Writing Personality' },
  { pattern: /MEMORY\.md$/i, readLabel: 'Reading Memory', writeLabel: 'Writing Memory' },
  { pattern: /AGENTS\.md$/i, readLabel: 'Reading Agent Rules', writeLabel: 'Writing Agent Rules' },
  { pattern: /HEARTBEAT\.md$/i, readLabel: 'Reading Heartbeat Tasks', writeLabel: 'Writing Heartbeat Tasks' },
  { pattern: /\/daily\/[^/]+\.md$/i, readLabel: 'Reading Daily Notes', writeLabel: 'Writing Daily Notes' },
  { pattern: /\/users\/[^/]+\.md$/i, readLabel: 'Reading User Profile', writeLabel: 'Writing User Profile' },
]

/**
 * Check if a tool call path is a memory file and return display info.
 */
export function detectMemoryFile(
  toolName: string,
  toolArgs: unknown,
): MemoryFileInfo {
  const defaultResult: MemoryFileInfo = { isMemoryFile: false, label: '', icon: 'settings' }

  // Only match file read/write tools
  const isRead = toolName === 'read_file' || toolName === 'Read'
  const isWrite = toolName === 'write_file' || toolName === 'Write' || toolName === 'edit_file' || toolName === 'Edit'
  if (!isRead && !isWrite) return defaultResult

  // Extract path from tool args
  const filePath = extractPath(toolArgs)
  if (!filePath) return defaultResult

  // Check if path is in memory directory
  if (!isMemoryPath(filePath)) return defaultResult

  // Match against known patterns
  for (const { pattern, readLabel, writeLabel } of MEMORY_PATH_PATTERNS) {
    if (pattern.test(filePath)) {
      return {
        isMemoryFile: true,
        label: isWrite ? writeLabel : readLabel,
        icon: 'brain',
      }
    }
  }

  // Generic memory file
  return {
    isMemoryFile: true,
    label: isWrite ? 'Writing Memory File' : 'Reading Memory File',
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
