import { formatToolName, getToolCallSummary } from './toolNameFormat'

/**
 * One nested tool call inside a codemode script. Mirrors the `nestedCalls`
 * entries of the chat `tool_call_update` chunks and the task
 * `codemode_progress` events, and of the `details.calls` rows persisted on a
 * finished codemode tool result. `args` carries the nested call's arguments
 * (both the streamed snapshot and the persisted rows include it) so the row
 * mapper can render the summary line via the existing per-tool summaries.
 */
export interface CodemodeNestedCall {
  id: string
  name: string
  status: 'running' | 'ok' | 'error' | 'cancelled'
  durationMs?: number
  errorPreview?: string
  args?: unknown
}

export interface CodemodeCallRow {
  id: string
  name: string
  displayName: string
  summary: string | null
  status: CodemodeNestedCall['status']
  durationMs?: number
  errorPreview?: string
}

/** Map nested-call snapshots to the display rows of the codemode card. */
export function toCodemodeCallRows(calls: readonly CodemodeNestedCall[] | null | undefined): CodemodeCallRow[] {
  return (calls ?? []).map(call => ({
    id: call.id,
    name: call.name,
    displayName: formatToolName(call.name),
    summary: getToolCallSummary(call.name, call.args),
    status: call.status,
    durationMs: call.durationMs,
    errorPreview: call.errorPreview,
  }))
}

export interface CodemodeCollapsedSummary {
  count: number
  toolNames: string[]
}

/**
 * Summary shown on the collapsed card: how many nested calls ran and which
 * tools, deduplicated in first-seen order.
 */
export function codemodeCollapsedSummary(calls: readonly CodemodeNestedCall[] | null | undefined): CodemodeCollapsedSummary {
  const list = calls ?? []
  const seen = new Set<string>()
  const toolNames: string[] = []
  for (const call of list) {
    const name = formatToolName(call.name)
    if (!seen.has(name)) {
      seen.add(name)
      toolNames.push(name)
    }
  }
  return { count: list.length, toolNames }
}

/** The raw script source of a codemode tool call, from its arguments. */
export function codemodeScriptCode(toolArgs: unknown): string {
  if (toolArgs && typeof toolArgs === 'object') {
    const code = (toolArgs as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return ''
}

/** The nested calls persisted on the `details.calls` of a finished result. */
export function codemodeCallsFromResult(toolResult: unknown): CodemodeNestedCall[] | null {
  const calls = (toolResult as { details?: { calls?: unknown } } | null | undefined)?.details?.calls
  if (!Array.isArray(calls)) return null
  return calls
    .map(normalizeNestedCall)
    .filter((call): call is CodemodeNestedCall => call !== null)
}

/**
 * The nested calls a codemode card should show. Once the result is in, its
 * `details.calls` are the final list — calls still running when the script
 * ended are marked cancelled there, while the retained live snapshot (no
 * snapshot is sent after the script ends) still shows them as running. So the
 * result wins whenever it exists; the live snapshot is only used while the
 * result is missing.
 */
export function codemodeCallsToDisplay(
  liveCalls: CodemodeNestedCall[] | null | undefined,
  toolResult: unknown,
): CodemodeNestedCall[] {
  if (toolResult != null) return codemodeCallsFromResult(toolResult) ?? []
  return liveCalls ?? []
}

const NESTED_CALL_STATUSES = new Set(['running', 'ok', 'error', 'cancelled'])

function normalizeNestedCall(entry: unknown): CodemodeNestedCall | null {
  if (!entry || typeof entry !== 'object') return null
  const record = entry as Record<string, unknown>
  if (typeof record.name !== 'string') return null
  const status = record.status
  return {
    id: typeof record.id === 'string' ? record.id : '',
    name: record.name,
    status: NESTED_CALL_STATUSES.has(status as string) ? status as CodemodeNestedCall['status'] : 'running',
    args: record.args,
    durationMs: typeof record.durationMs === 'number' ? record.durationMs : undefined,
    errorPreview: typeof record.errorPreview === 'string' ? record.errorPreview : undefined,
  }
}

/**
 * The user-facing script output of a codemode result: the text blocks of the
 * tool result, joined. `null` while the result is not in yet.
 */
export function codemodeOutputText(toolResult: unknown): string | null {
  const content = (toolResult as { content?: unknown } | null | undefined)?.content
  if (!Array.isArray(content)) return null
  const blocks = content
    .filter((block): block is { type: string; text: string } =>
      !!block && typeof block === 'object'
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string')
    .map(block => block.text)
  return blocks.length > 0 ? blocks.join('\n') : null
}
