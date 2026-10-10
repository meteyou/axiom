import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { runToolCall } from '@earendil-works/pi-agent-core'
import type {
  AgentMessage,
  AgentOptions,
  AgentTool,
  AgentToolCallOutcome,
  AgentToolResult,
} from '@earendil-works/pi-agent-core'
import type { Api, AssistantMessage, JsonObject, Model, Usage } from '@earendil-works/pi-ai'
import { Type } from '@earendil-works/pi-ai'
import {
  CODEMODE_SOURCE_GRAMMAR,
  CodemodeSandbox,
  parseCodemodeSource,
  toCodemodeIdentifier,
} from '@earendil-works/pi-codemode'
import type {
  CodemodeError,
  CodemodeJsonSchema,
  CodemodeOutputItem,
  CodemodeResult,
  CodemodeTool as PiCodemodeTool,
} from '@earendil-works/pi-codemode'
import { isFailedToolResult } from './loop-detection.js'
import { extractUploadsFromToolResult } from './send-file-tool.js'
import { logToolCall } from './token-logger.js'
import type { UploadDescriptor } from './uploads.js'
import { omitToolResultStructuredContent, redactToolResultImages } from './llm-image.js'
import type { Database } from './database.js'
import { getWorkspaceDir } from './workspace.js'
import { loadConfig, warnConfigReadFailed } from './config.js'

export const CODEMODE_TOOL_NAME = 'codemode'

export const CODEMODE_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024
export const CODEMODE_DEFAULT_MAX_OUTPUT_TOKENS = 10_000
export const CODEMODE_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
export const CODEMODE_MAX_TIMEOUT_MS = 30 * 60 * 1000

/** Characters-per-token estimate used to turn the token budget into a character budget. */
const CHARS_PER_TOKEN = 4

/** Workspace-relative folder that holds the full text of truncated script output. */
export const CODEMODE_SPILL_DIR = 'codemode'
/** How long spill files are kept before the periodic prune removes them. */
const CODEMODE_SPILL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/**
 * One nested tool call, as tracked by the codemode tool for the observer and the
 * failure summary. `status` transitions running → ok | error | cancelled. `args`
 * is compacted for display (see `compactNestedCallArgs`); the full arguments
 * remain on the nested call's own tool-call log row and task journal.
 */
export interface CodemodeNestedCall {
  id: string
  name: string
  status: 'running' | 'ok' | 'error' | 'cancelled'
  args: unknown
  durationMs?: number
  errorPreview?: string
}

/** Snapshot entry streamed as progress after every nested call start/end. */
export interface CodemodeNestedCallSnapshot {
  id: string
  name: string
  status: 'running' | 'ok' | 'error' | 'cancelled'
  /** The nested call's arguments, compacted so clients can render the per-tool summary line. */
  args?: unknown
  durationMs?: number
  errorPreview?: string
}

export interface CodemodeNestedCallStart {
  parentToolCallId: string
  toolCallId: string
  toolName: string
  args: unknown
}

export interface CodemodeNestedCallEnd {
  parentToolCallId: string
  toolCallId: string
  toolName: string
  args: unknown
  result: unknown
  isError: boolean
  durationMs: number
}

/**
 * Consumed by the main runtime and the task runner for logging, journaling, loop
 * detection and live progress. The codemode tool emits one start and one end event
 * per nested call; `toolCallId` is unique within the parent codemode call.
 */
export interface CodemodeNestedCallObserver {
  onCallStart?(info: CodemodeNestedCallStart): void
  onCallEnd?(info: CodemodeNestedCallEnd): void
}

/**
 * The view of the owning agent the codemode tool needs to dispatch nested calls.
 * Tools and the transcript are read lazily so a tool that is added to (or removed
 * from) the agent after codemode is created is reflected in the next script.
 */
export interface CodemodeToolOwner {
  /** The agent's current tools, including `codemode` itself (filtered out internally). */
  getTools(): AgentTool[]
  /** The agent's current transcript, passed as the nested call's context. */
  getMessages(): AgentMessage[]
  /** The agent's current model, used to stamp the synthetic assistant message. */
  getModel(): Model<Api>
  /** The agent's after-tool hook (image normalization); applied to nested results. */
  afterToolCall?: NonNullable<AgentOptions['afterToolCall']>
}

export interface CodemodeToolOptions {
  owner: CodemodeToolOwner
  observer?: CodemodeNestedCallObserver
  /**
   * Tools advertised in the tool description (the agent's tools minus `codemode`).
   * Defaults to `owner.getTools()` at creation time.
   */
  advertisedTools?: AgentTool[]
}

/**
 * Create the `codemode` AgentTool for a specific agent. The script can call exactly
 * the tools the agent has (minus `codemode`) as `await tools.<name>(args)`; nested
 * calls run through pi-agent-core's `runToolCall` so argument validation and the
 * after-tool hook apply exactly as for direct calls.
 */
export function createCodemodeTool(options: CodemodeToolOptions): AgentTool {
  const advertisedTools = (options.advertisedTools ?? options.owner.getTools())
    .filter(tool => tool.name !== CODEMODE_TOOL_NAME)

  return {
    name: CODEMODE_TOOL_NAME,
    label: 'Codemode',
    description: buildCodemodeDescription(advertisedTools),
    parameters: Type.Object({
      code: Type.String({
        description:
          'Raw JavaScript source (not JSON, no code fence), run as an async function body. '
          + 'Optionally preceded by a `// @options: {"max_output_tokens": 10000, "timeout_ms": 300000}` line.',
      }),
    }),
    // Capable models emit the raw script as unescaped text instead of a JSON string.
    constrainedSampling: { type: 'grammar', variants: { openai_lark: CODEMODE_SOURCE_GRAMMAR } },
    async execute(toolCallId, params, signal, onUpdate) {
      const rawCode = (params as { code?: string }).code ?? ''
      const startedAt = performance.now()

      let parsed: { code: string; options: { maxOutputTokens?: number; timeoutMs?: number } }
      try {
        parsed = parseCodemodeSource(rawCode)
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Script error:\nInvalid source: ${errorMessage(err)}` }],
          details: { calls: [] },
          isError: true,
        }
      }

      const maxOutputTokens = parsed.options.maxOutputTokens ?? CODEMODE_DEFAULT_MAX_OUTPUT_TOKENS
      const timeoutMs = resolveTimeoutMs(parsed.options.timeoutMs)

      const calls: CodemodeNestedCall[] = []
      // Uploads reported by nested calls (e.g. send_file_to_user) are lifted into
      // this result's details so the channel layers deliver them like direct calls.
      const uploads: UploadDescriptor[] = []
      const collectUploads = (toolResult: unknown): void => {
        for (const upload of extractUploadsFromToolResult(toolResult)) {
          if (!uploads.some(u => u.relativePath === upload.relativePath)) uploads.push(upload)
        }
      }
      // After every nested call start/end the tool streams a snapshot of all
      // nested calls as a partial update, so consumers (chat, task viewer,
      // watchdog) see live progress while the script runs.
      const emitProgress = (): void => {
        onUpdate?.({
          content: [],
          details: { calls: calls.map(toNestedCallSnapshot) },
        })
      }
      const consumerObserver = options.observer
      const observer: CodemodeNestedCallObserver = {
        onCallStart: info => {
          consumerObserver?.onCallStart?.(info)
          emitProgress()
        },
        onCallEnd: info => {
          consumerObserver?.onCallEnd?.(info)
          emitProgress()
        },
      }

      const sandbox = new CodemodeSandbox({
        tools: options.owner.getTools()
          .filter(tool => tool.name !== CODEMODE_TOOL_NAME)
          .map(tool => buildSandboxTool(tool, toolCallId, calls, options, observer, collectUploads)),
        timeoutMs,
        memoryLimitBytes: CODEMODE_MEMORY_LIMIT_BYTES,
      })

      let result: CodemodeResult
      try {
        result = await sandbox.execute(parsed.code, { signal })
      } finally {
        await sandbox.close()
      }

      for (const call of calls) {
        if (call.status === 'running') call.status = 'cancelled'
      }

      return buildCodemodeResult(result, startedAt, maxOutputTokens, calls, uploads)
    },
  }
}

/** Cap in characters for a string value in the compacted nested-call args. */
const NESTED_CALL_ARG_STRING_MAX = 200

/**
 * Compact a nested call's arguments for the progress snapshot and the persisted
 * result details: string values keep only their first line, capped, because the
 * client-side per-tool summary line renders nothing else. Without this, a script
 * that writes large files re-sends and re-persists every file body in each
 * snapshot and in the result details.
 */
function compactNestedCallArgs(args: unknown): unknown {
  if (typeof args === 'string') {
    const line = args.trim().split('\n', 1)[0] ?? ''
    return line.length > NESTED_CALL_ARG_STRING_MAX
      ? `${line.slice(0, NESTED_CALL_ARG_STRING_MAX - 1)}…`
      : line
  }
  if (Array.isArray(args)) return args.map(compactNestedCallArgs)
  if (args !== null && typeof args === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(args)) out[key] = compactNestedCallArgs(value)
    return out
  }
  return args
}

function toNestedCallSnapshot(call: CodemodeNestedCall): CodemodeNestedCallSnapshot {
  return {
    id: call.id,
    name: call.name,
    status: call.status,
    args: call.args,
    durationMs: call.durationMs,
    errorPreview: call.errorPreview,
  }
}

/**
 * Observer that writes finished nested calls to the `tool_calls` log with a
 * link to their parent codemode call, the same way direct calls are logged.
 * Consumed by the main runtime and the task runner so nested calls stay as
 * visible in the activity logs as direct calls.
 */
export function createNestedCallLogObserver(
  db: Database,
  getSessionId: () => string | null | undefined,
): CodemodeNestedCallObserver {
  return {
    onCallEnd: info => {
      try {
        const toolResult = omitToolResultStructuredContent(redactToolResultImages(info.result))
        logToolCall(db, {
          sessionId: getSessionId() ?? '',
          toolName: info.toolName,
          input: JSON.stringify(info.args ?? {}),
          output: JSON.stringify(toolResult ?? {}),
          durationMs: info.durationMs,
          status: info.isError ? 'error' : 'success',
          toolCallId: info.toolCallId,
          parentToolCallId: info.parentToolCallId,
        })
      } catch (err) {
        console.warn('[codemode] nested call log write failed:', err)
      }
    },
  }
}

/** Build one sandbox tool that dispatches a nested call through `runToolCall`. */
function buildSandboxTool(
  tool: AgentTool,
  toolCallId: string,
  calls: CodemodeNestedCall[],
  options: CodemodeToolOptions,
  observer: CodemodeNestedCallObserver,
  collectUploads: (toolResult: unknown) => void,
): PiCodemodeTool {
  let counter = 0
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters as unknown as CodemodeJsonSchema,
    outputSchema: (tool.outputSchema ?? undefined) as unknown as CodemodeJsonSchema | undefined,
    async execute(args, context) {
      const owner = options.owner
      const id = `${toolCallId}/${tool.name}/${++counter}`
      const record: CodemodeNestedCall = { id, name: tool.name, status: 'running', args: compactNestedCallArgs(args) }
      calls.push(record)
      observer.onCallStart?.({ parentToolCallId: toolCallId, toolCallId: id, toolName: tool.name, args })

      const startedAt = performance.now()
      let outcome: AgentToolCallOutcome
      try {
        const tools = owner.getTools().filter(t => t.name !== CODEMODE_TOOL_NAME)
        outcome = await runToolCall(
          { type: 'toolCall', id, name: tool.name, arguments: (args ?? {}) as JsonObject },
          {
            tools,
            assistantMessage: buildNestedAssistantMessage(toolCallId, owner.getModel()),
            context: { messages: owner.getMessages(), tools },
            signal: context.signal,
            afterToolCall: owner.afterToolCall,
          },
        )
      } catch (err) {
        // runToolCall normally reports tool failures as `isError`; a throw here means the
        // dispatch itself broke (missing hook, schema problem) and is reported the same way.
        outcome = {
          toolCall: { type: 'toolCall', id, name: tool.name, arguments: (args ?? {}) as JsonObject },
          result: { content: [{ type: 'text', text: errorMessage(err) }], details: {} },
          isError: true,
        }
      }

      const durationMs = Math.round(performance.now() - startedAt)
      const failed = isFailedToolResult(outcome.isError, outcome.result)
      collectUploads(outcome.result)
      record.status = context.signal.aborted ? 'cancelled' : failed ? 'error' : 'ok'
      record.durationMs = durationMs
      if (failed) {
        const text = resultText(outcome.result)
        if (text) record.errorPreview = text.slice(0, 200)
      }
      observer.onCallEnd?.({
        parentToolCallId: toolCallId,
        toolCallId: id,
        toolName: tool.name,
        args,
        result: outcome.result,
        isError: failed,
        durationMs,
      })

      return toScriptValue(tool, outcome)
    },
  }
}

/**
 * The value a script receives for a nested call. A failed, blocked or invalid call
 * rejects with an Error carrying the tool's error text; a tool with an output schema
 * resolves to its `structuredContent`; any other tool resolves to its text output.
 */
function toScriptValue(tool: AgentTool, outcome: AgentToolCallOutcome): unknown {
  if (isFailedToolResult(outcome.isError, outcome.result)) {
    throw new Error(resultText(outcome.result) || `Tool "${tool.name}" failed`)
  }
  if (tool.outputSchema && outcome.result.structuredContent !== undefined) {
    return outcome.result.structuredContent
  }
  return resultText(outcome.result)
}

function resultText(result: AgentToolResult<unknown>): string {
  return (result.content ?? [])
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/** Minimal assistant message the nested call is attributed to; hooks only read the result. */
function buildNestedAssistantMessage(toolCallId: string, model: Model<Api>): AssistantMessage {
  const usage: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id: toolCallId, name: CODEMODE_TOOL_NAME, arguments: {} }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: 'toolUse',
    timestamp: Date.now(),
  }
}

function resolveTimeoutMs(specified?: number): number {
  const value = specified ?? CODEMODE_DEFAULT_TIMEOUT_MS
  return Math.min(value, CODEMODE_MAX_TIMEOUT_MS)
}

/**
 * Assemble the model-facing result. Text items are numbered when there is more than
 * one, console lines are collected in one block, and a returned value is appended.
 * Output beyond the budget keeps its head and tail and the full text is spilled to a
 * workspace file. A failed script keeps its partial output plus the error and the
 * tool calls that already ran.
 */
function buildCodemodeResult(
  result: CodemodeResult,
  startedAt: number,
  maxOutputTokens: number,
  calls: CodemodeNestedCall[],
  uploads: UploadDescriptor[],
): AgentToolResult<Record<string, unknown>> {
  const wallTime = ((performance.now() - startedAt) / 1000).toFixed(1)
  const details: Record<string, unknown> = {
    calls: calls.map(call => ({ id: call.id, name: call.name, status: call.status, args: call.args, durationMs: call.durationMs, errorPreview: call.errorPreview })),
  }
  if (uploads.length > 0) details.uploadedFiles = uploads

  const scriptOutput: CodemodeOutputItem[] = [...result.output]
  if (result.ok && result.value !== undefined) {
    scriptOutput.push({ type: 'text', text: valueText(result.value) })
  }
  const items = formatOutput(scriptOutput)

  const header = `${result.ok ? 'Script completed' : 'Script failed'}\nWall time ${wallTime} seconds\nOutput:\n`
  const content: { type: 'text'; text: string }[] = [{ type: 'text', text: header }]

  const textItems = items.filter((item): item is { type: 'text'; text: string } => item.type === 'text')
  const combinedText = textItems.map(item => item.text).join('\n')
  const budget = maxOutputTokens * CHARS_PER_TOKEN

  if (combinedText.length > budget) {
    const headChars = Math.floor(budget / 2)
    const tailChars = budget - headChars
    const head = combinedText.slice(0, headChars)
    const tail = combinedText.slice(-tailChars)
    const spillPath = writeSpillFile(combinedText)
    if (spillPath) {
      details.fullOutputPath = spillPath
      details.outputTruncated = true
    }
    const note = spillPath
      ? `\n\n[Full output: ${spillPath} — read it with read_file to continue]`
      : '\n\n[Could not save the full output]'
    content.push({
      type: 'text',
      text: `Warning: output exceeded ${maxOutputTokens} tokens and was truncated to its start and end.`
        + `\n\n${head}\n…truncated…\n${tail}${note}`,
    })
  } else {
    for (const item of textItems) content.push({ type: 'text', text: item.text })
  }

  if (!result.ok) {
    content.push({ type: 'text', text: `Script error:\n${formatScriptError(result.error, calls)}` })
  }

  return { content, details, ...(result.ok ? {} : { isError: true }) }
}

/**
 * Lay out the script's output so the model can tell items apart. With more than one
 * text item (`text()` or the returned value) each starts with a `==> text N/M <==`
 * line; `console.*` lines follow all other output in one `<console_output>` block.
 * Image items are not delivered in v1 and become a text note.
 */
function formatOutput(output: CodemodeOutputItem[]): CodemodeOutputItem[] {
  const total = output.filter(item => item.type === 'text' && !item.console).length
  const items: CodemodeOutputItem[] = []
  const consoleLines: string[] = []
  let index = 0
  for (const item of output) {
    if (item.type === 'image') {
      items.push({ type: 'text', text: `[image ${item.mimeType}, ${item.data.length} base64 chars — not shown]` })
    } else if (item.console) {
      consoleLines.push(item.text)
    } else {
      index++
      items.push({ type: 'text', text: total > 1 ? `==> text ${index}/${total} <==\n${item.text}` : item.text })
    }
  }
  if (consoleLines.length > 0) {
    items.push({ type: 'text', text: `<console_output>\n${consoleLines.join('\n')}\n</console_output>` })
  }
  return items
}

function formatScriptError(error: CodemodeError, calls: CodemodeNestedCall[]): string {
  const head =
    error.kind === 'script'
      ? (error.stack ?? `${error.name ?? 'Error'}: ${error.message}`)
      : error.kind === 'timeout'
        ? `Script timed out: ${error.message}`
        : error.kind === 'aborted'
          ? `Script aborted: ${error.message}`
          : `Script sandbox failed: ${error.message}`
  const executed = calls.length > 0
    ? `Tool calls made before the failure (they are not undone): ${calls.map(call => `${call.name} (${call.status})`).join(', ')}`
    : 'No tool calls were made.'
  return `${head}\n\n${executed}`
}

function valueText(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value) ?? String(value)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Read the `codemode.mainAgent` switch from settings.json. Re-read on every
 * turn so the toggle applies from the next turn without a restart.
 */
export function readCodemodeMainAgentEnabled(): boolean {
  try {
    const settings = loadConfig<{ codemode?: { mainAgent?: unknown } }>('settings.json')
    return settings.codemode?.mainAgent === true
  } catch (err) {
    warnConfigReadFailed('settings.json', err, 'codemode disabled')
    return false
  }
}

/* ── Spill folder ─────────────────────────────────────────────────────────── */

function getSpillDir(): string {
  const dir = path.join(getWorkspaceDir(), CODEMODE_SPILL_DIR)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

// The spill folder lives in the shared workspace, so pruning must only ever
// delete files that writeSpillFile created — never user or agent files.
const SPILL_FILE_PATTERN = /^spill-\d+-[0-9a-f]{8}\.txt$/

function spillFileName(): string {
  return `spill-${Date.now()}-${randomUUID().slice(0, 8)}.txt`
}

/** Write the full (untruncated) text of an oversized script output; returns the file path. */
function writeSpillFile(text: string): string | null {
  try {
    const file = path.join(getSpillDir(), spillFileName())
    fs.writeFileSync(file, text, 'utf-8')
    return file
  } catch {
    return null
  }
}

/**
 * Remove spill files older than the retention window. Called periodically by the
 * task runner's cleanup timer; safe to call at any time and returns the count of
 * removed files.
 */
export function pruneCodemodeSpillFolder(nowMs = Date.now()): number {
  try {
    const dir = path.join(getWorkspaceDir(), CODEMODE_SPILL_DIR)
    if (!fs.existsSync(dir)) return 0
    let removed = 0
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !SPILL_FILE_PATTERN.test(entry.name)) continue
      const file = path.join(dir, entry.name)
      const stat = fs.statSync(file)
      if (nowMs - stat.mtimeMs > CODEMODE_SPILL_RETENTION_MS) {
        fs.rmSync(file, { force: true })
        removed++
      }
    }
    return removed
  } catch {
    return 0
  }
}

/* ── Prompt guideline ─────────────────────────────────────────────── */

/**
 * Short system-prompt guideline appended to an agent's prompt while codemode is
 * active, so the model reaches for it when it saves work and leaves single calls
 * direct.
 */
export function buildCodemodePromptGuideline(): string {
  return `<codemode>
The \`codemode\` tool runs a JavaScript script that calls your other tools; only the script's output reaches you. Use it when it saves round trips or context:
- Batch independent calls (e.g. \`Promise.allSettled\`) instead of many separate tool calls.
- Chain calls so one result feeds the next.
- Filter or aggregate large tool output before it reaches you.
Do NOT wrap a single tool call in a script — call that tool directly instead.
</codemode>`
}

/* ── Description ──────────────────────────────────────────────────────────── */

/** What a script sees a nested call resolve to, in a few words. */
function describeResolveHint(tool: AgentTool): string {
  if (!tool.outputSchema) return 'a string (the tool\'s text output)'
  const props = objectPropertyNames(tool.outputSchema)
  const shape = props.length > 0 ? `an object { ${props.join(', ')} }` : 'an object (the tool\'s structured output)'
  if (tool.name === 'shell') {
    return `${shape}; a non-zero exit code does NOT reject — branch on \`exit_code\``
  }
  return shape
}

function objectPropertyNames(schema: unknown): string[] {
  const props = (schema as { properties?: unknown } | undefined)?.properties
  return props && typeof props === 'object' ? Object.keys(props) : []
}

function firstSentence(text: string | undefined): string {
  const trimmed = (text ?? '').trim()
  if (trimmed === '') return ''
  const match = trimmed.match(/^[^.!?]+[.!?]?\s*/)
  return (match ? match[0].trim() : trimmed).replace(/\s+/g, ' ')
}

/**
 * Model-facing description: intro, the globals a script may use, and one line per
 * callable tool with how to call it and what it resolves to. `store()`/`load()` and
 * the `models.*` API are not advertised in v1.
 */
export function buildCodemodeDescription(tools: AgentTool[]): string {
  const intro = [
    'Run JavaScript that calls your other tools; only the script\'s output reaches you, so use it to batch, chain and filter.',
    'The input is raw JavaScript (not JSON, no code fence), run as an async function body in a sandboxed VM: top-level `await` and `return` work. There is no Node, file system, network or timers.',
    '- `await tools.<name>({ ...args })` calls a tool, resolves to ' + 'a string or an object, and rejects with an Error on failure. Calls still running when the script ends are cancelled; use `try/catch` or `Promise.allSettled` to handle failures.',
    '- Optional first line: `// @options: {"max_output_tokens": 10000, "timeout_ms": 300000}` (default budget 10000 tokens, default deadline 5 minutes, capped at 30).',
  ].join('\n')

  const globals = [
    'Globals:',
    '- `text(value)` adds a text item to the output; a top-level `return value` does the same.',
    '- `console.log(...)` adds lines to a `<console_output>` block after the other output.',
    '- `exit()` ends the script successfully.',
    '- With several text items, each starts with a `==> text N/M <==` line.',
  ].join('\n')

  const toolLines = tools.map(tool => {
    const id = toCodemodeIdentifier(tool.name)
    const label = id === tool.name ? id : `${id} (tool \`${tool.name}\`)`
    return `- \`await tools.${label}({ ...args })\` — ${firstSentence(tool.description)} Resolves to ${describeResolveHint(tool)}.`
  })

  return [intro, globals, ...(toolLines.length > 0 ? [`Callable tools:`, ...toolLines] : [])].join('\n\n')
}
