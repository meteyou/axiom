/**
 * Turns a raw tool identifier such as `read_file` or `email_send` into a
 * human-readable label (`Read file`, `Email send`).
 */
export function formatToolName(name: string): string {
  const words = name.split(/[_\s]+/).filter(Boolean)
  if (words.length === 0) return name

  const [first, ...rest] = words
  return [first!.charAt(0).toUpperCase() + first!.slice(1).toLowerCase(), ...rest.map(w => w.toLowerCase())].join(' ')
}

const TOOL_SUMMARY_ARG: Record<string, string> = {
  read_file: 'path',
  write_file: 'path',
  edit_file: 'path',
  list_files: 'path',
  shell: 'command',
}

/**
 * Picks the single most descriptive argument of a tool call (file path,
 * shell command) for display next to the tool name.
 */
export function getToolCallSummary(toolName: string, args: unknown): string | null {
  const key = TOOL_SUMMARY_ARG[toolName]
  if (!key || typeof args !== 'object' || args === null) return null

  const value = (args as Record<string, unknown>)[key]
  if (typeof value !== 'string' || value.trim() === '') return null

  const summary = toolName === 'shell' ? stripLeadingCd(value) : value
  return summary.trim().split('\n')[0] || null
}

// Agents almost always prefix shell commands with `cd <workspace> &&`, which
// adds no information in a one-line summary. The full command is still
// visible in the expanded arguments.
const LEADING_CD = /^\s*cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/

function stripLeadingCd(command: string): string {
  let result = command
  while (LEADING_CD.test(result)) {
    result = result.replace(LEADING_CD, '')
  }
  return result
}
