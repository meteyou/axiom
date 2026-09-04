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
