import fs from 'node:fs'
import path from 'node:path'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { Type } from '@mariozechner/pi-ai'
import { saveUpload, type UploadDescriptor } from './uploads.js'
import { getWorkspaceDir } from './workspace.js'

/**
 * Options for the `send_file_to_user` tool.
 *
 * The tool needs to know which user and session the file belongs to so that
 * downstream channels (ws-chat, telegram-bot) can correlate the generated
 * {@link UploadDescriptor} with the active conversation. Both getters are
 * expected to return `undefined`/`null` when invoked from a background
 * context (tasks, heartbeats, etc.) — in that case the tool refuses to run
 * because there is no user to deliver the file to.
 */
export interface SendFileToolOptions {
  /** Resolve the current user id (numeric, matches `users.id`). */
  getCurrentToolUserId: () => number | undefined
  /** Resolve the currently active interactive session id, if any. */
  getCurrentInteractiveSessionId?: () => string | null
}

/**
 * Payload attached to a `send_file_to_user` tool result so channels can
 * generically pick up the uploaded file without sniffing for specific tool
 * names.
 *
 * Channel layers should check `toolResult.details.uploadedFile` (single) or
 * `toolResult.details.uploadedFiles` (array) on every `tool_call_end` chunk.
 * Other tools may populate this field in the future to deliver files too.
 */
export interface SendFileToolDetails {
  uploadedFile?: UploadDescriptor
  uploadedFiles?: UploadDescriptor[]
  caption?: string
  error?: boolean
}

/**
 * Very small extension → MIME map. Kept local (not pulled from a dependency)
 * because the set of file types agents realistically produce is tiny and we
 * want zero dependency creep. Falls through to `application/octet-stream`
 * for unknown extensions, which is fine for downloads.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.xml': 'application/xml',
  '.log': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

function guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream'
}

/** Maximum size (bytes) a single agent-produced file may have. Matches the
 *  user upload limit (see `web-backend/src/uploads.ts`). */
const MAX_FILE_SIZE = 50 * 1024 * 1024

/**
 * Resolve `inputPath` against the workspace dir (same semantics as the
 * `read_file`/`write_file` YOLO tools). Returns an absolute path.
 */
function resolvePath(inputPath: string): string {
  if (path.isAbsolute(inputPath)) return inputPath
  return path.resolve(getWorkspaceDir(), inputPath)
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Create the `send_file_to_user` agent tool.
 *
 * The agent calls this tool with a path to an existing file (typically one
 * it just wrote via `shell`/`write_file` into the workspace). The tool:
 *   1. Reads the file from disk.
 *   2. Copies it into the uploads dir via {@link saveUpload}, producing a
 *      stable, sandboxed URL served by `/api/uploads/...`.
 *   3. Returns a tool result whose `details.uploadedFile` holds the
 *      {@link UploadDescriptor}. The channel layers (`ws-chat`, telegram
 *      bot) watch for this field and deliver the file through their
 *      transport.
 *
 * The tool itself does NOT talk to any channel. Delivery is a channel-layer
 * concern (same architectural split as user uploads).
 */
export function createSendFileTool(options: SendFileToolOptions): AgentTool {
  return {
    name: 'send_file_to_user',
    label: 'Send File to User',
    description:
      'Send a file to the current user via their active channel (web chat or Telegram). ' +
      'The file must already exist on disk — typically one you created with shell or write_file ' +
      'inside the workspace. The user will see a download button / attachment card for the file ' +
      'on your assistant message; on Telegram, the file is delivered as a document (or photo for images). ' +
      'Use this to deliver generated reports, exported data, rendered images, compiled archives, etc. ' +
      'Do NOT use this for large model outputs that fit in a normal chat reply — only for actual files.',
    parameters: Type.Object({
      path: Type.String({
        description:
          'Absolute path to the file to send, or a path relative to the workspace dir. ' +
          'The file must exist and be readable. Max size: 50 MB.',
      }),
      filename: Type.Optional(
        Type.String({
          description:
            'Optional display name shown to the user. Defaults to the basename of `path`. ' +
            'Use this to give a hashed/temporary file a human-friendly name (e.g. "report.pdf").',
        }),
      ),
      caption: Type.Optional(
        Type.String({
          description:
            'Optional short caption describing the file (1–2 sentences). Shown by some channels ' +
            '(e.g. Telegram) next to the file. If omitted, the file is delivered without a caption.',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { path: inputPath, filename, caption } = params as {
        path: string
        filename?: string
        caption?: string
      }

      const userId = options.getCurrentToolUserId()
      if (userId === undefined) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Error: send_file_to_user cannot be used in background contexts (no active user).',
          }],
          details: { error: true } satisfies SendFileToolDetails,
        }
      }

      const sessionId = options.getCurrentInteractiveSessionId?.() ?? null

      let absolutePath: string
      try {
        absolutePath = resolvePath(inputPath)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: `Error: failed to resolve path "${inputPath}": ${message}` }],
          details: { error: true } satisfies SendFileToolDetails,
        }
      }

      let stat: fs.Stats
      try {
        stat = fs.statSync(absolutePath)
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Error: file not found at "${absolutePath}".` }],
          details: { error: true } satisfies SendFileToolDetails,
        }
      }

      if (!stat.isFile()) {
        return {
          content: [{ type: 'text' as const, text: `Error: "${absolutePath}" is not a regular file.` }],
          details: { error: true } satisfies SendFileToolDetails,
        }
      }

      if (stat.size === 0) {
        return {
          content: [{ type: 'text' as const, text: `Error: file "${absolutePath}" is empty.` }],
          details: { error: true } satisfies SendFileToolDetails,
        }
      }

      if (stat.size > MAX_FILE_SIZE) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error: file too large (${formatBytes(stat.size)}). Max allowed: ${formatBytes(MAX_FILE_SIZE)}.`,
          }],
          details: { error: true } satisfies SendFileToolDetails,
        }
      }

      let buffer: Buffer
      try {
        buffer = fs.readFileSync(absolutePath)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: `Error reading "${absolutePath}": ${message}` }],
          details: { error: true } satisfies SendFileToolDetails,
        }
      }

      const displayName = filename?.trim() || path.basename(absolutePath)
      const mimeType = guessMimeType(displayName)

      let uploaded: UploadDescriptor
      try {
        uploaded = saveUpload({
          buffer,
          originalName: displayName,
          mimeType,
          // `source` is an advisory hint only (saveUpload doesn't persist it).
          // The delivery channel is determined dynamically at chunk time by
          // ws-chat / telegram-bot from the assistant's response context.
          source: 'web',
          userId,
          sessionId,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: `Error storing upload: ${message}` }],
          details: { error: true } satisfies SendFileToolDetails,
        }
      }

      const details: SendFileToolDetails = {
        uploadedFile: uploaded,
        caption: caption?.trim() || undefined,
      }

      const summary = `File prepared for delivery: ${uploaded.originalName} (${formatBytes(uploaded.size)}). ` +
        `The user sees a download card on this turn.`

      return {
        content: [{ type: 'text' as const, text: summary }],
        details,
      }
    },
  }
}

/**
 * Channel-layer helper: extract any uploads attached to a tool result.
 *
 * Looks at `toolResult.details.uploadedFile` (single) and
 * `toolResult.details.uploadedFiles` (array). Returns a de-duplicated list.
 * Unknown / malformed details are silently ignored so channels can call this
 * on every `tool_call_end` chunk without guarding themselves.
 */
export function extractUploadsFromToolResult(toolResult: unknown): UploadDescriptor[] {
  if (!toolResult || typeof toolResult !== 'object') return []
  const details = (toolResult as { details?: unknown }).details
  if (!details || typeof details !== 'object') return []
  const d = details as { uploadedFile?: unknown; uploadedFiles?: unknown }

  const out: UploadDescriptor[] = []
  if (isUploadDescriptor(d.uploadedFile)) out.push(d.uploadedFile)
  if (Array.isArray(d.uploadedFiles)) {
    for (const entry of d.uploadedFiles) {
      if (isUploadDescriptor(entry)) out.push(entry)
    }
  }

  // De-duplicate by relativePath
  const seen = new Set<string>()
  return out.filter(u => {
    if (seen.has(u.relativePath)) return false
    seen.add(u.relativePath)
    return true
  })
}

function isUploadDescriptor(value: unknown): value is UploadDescriptor {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<UploadDescriptor>
  return typeof v.relativePath === 'string'
    && typeof v.urlPath === 'string'
    && typeof v.originalName === 'string'
    && typeof v.mimeType === 'string'
    && typeof v.size === 'number'
    && (v.kind === 'image' || v.kind === 'file')
}
