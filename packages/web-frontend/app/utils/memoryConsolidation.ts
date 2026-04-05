/**
 * Detection helpers for memory_consolidation log entries.
 *
 * Co-owned with MemoryConsolidationDiff.vue — these functions decide
 * whether the diff component should be rendered.
 */

export type MemoryConsolidationLogData = Record<string, unknown> & {
  memoryDiff?: {
    before?: string
    after?: string
  }
}

export function isMemoryConsolidationEntry(toolName: string): boolean {
  return toolName.toLowerCase() === 'memory_consolidation'
}

export function hasMemoryConsolidationDiff(toolName: string, output: string | null | undefined): boolean {
  if (!isMemoryConsolidationEntry(toolName)) return false
  const parsed = parseMemoryConsolidationOutput(output)
  const diff = parsed?.memoryDiff
  return !!diff && typeof diff.before === 'string' && typeof diff.after === 'string'
}

function parseMemoryConsolidationOutput(output: string | null | undefined): MemoryConsolidationLogData | null {
  if (!output) return null
  try {
    const parsed = JSON.parse(output)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as MemoryConsolidationLogData
  } catch {
    return null
  }
}
