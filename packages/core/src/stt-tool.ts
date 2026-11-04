import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import nodePath from 'node:path'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'
import type { TSchema } from 'typebox'
import { getWorkspaceDir } from './workspace.js'
import { loadProviders, parseProviderModelId } from './provider-config.js'
import { getVoiceProviderCapabilities } from './voice-capabilities.js'
import { loadSttSettings, transcribeAudio } from './stt.js'
import type { SttSettings } from './stt.js'
import type { Database } from './database.js'
import type { VoiceUsageContext } from './voice-usage.js'

export const TRANSCRIBE_AUDIO_TOOL_NAME = 'audio_transcribe'

const AUDIO_EXTENSIONS: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.webm': 'audio/webm',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
}

const VIDEO_EXTENSIONS: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.m4v': 'video/x-m4v',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
}

const SUPPORTED_EXTENSIONS = [...Object.keys(AUDIO_EXTENSIONS), ...Object.keys(VIDEO_EXTENSIONS)]

/** OpenAI-compatible STT endpoints reject uploads above 25 MB; larger audio is re-encoded first. */
const MAX_DIRECT_UPLOAD_BYTES = 24 * 1024 * 1024
/** Longer transcripts go to a workspace file so they do not flood the context. */
const INLINE_TRANSCRIPT_MAX_CHARS = 20_000
const TRANSCRIPT_PREVIEW_CHARS = 2_000
const FFMPEG_TIMEOUT_MS = 10 * 60_000
const REENCODE_BITRATE_KBPS = 32
const REENCODE_BYTES_PER_SECOND = (REENCODE_BITRATE_KBPS * 1000) / 8
/** Fits the re-encoded upload limit with headroom; used in the split instructions. */
const SPLIT_SEGMENT_SECONDS = 90 * 60

/**
 * Re-encode the audio track of `inputPath` to a compact mono MP3 and return
 * it. Rejects with an actionable message when ffmpeg is not installed.
 */
export type ExtractAudio = (inputPath: string) => Promise<Buffer>

const extractAudioWithFfmpeg: ExtractAudio = async (inputPath) => {
  const tempDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'axiom-stt-'))
  const outputPath = nodePath.join(tempDir, 'audio.mp3')
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        'ffmpeg',
        ['-nostdin', '-y', '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', `${REENCODE_BITRATE_KBPS}k`, outputPath],
        { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
        (err, _stdout, stderr) => {
          if (!err) return resolve()
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return reject(new Error('ffmpeg is not installed. Install it via shell (e.g. `sudo apt-get install -y ffmpeg`) and retry.'))
          }
          const detail = String(stderr).trim().split('\n').slice(-3).join(' ')
          reject(new Error(`ffmpeg could not extract the audio track: ${detail || err.message}`))
        },
      )
    })
    return fs.readFileSync(outputPath)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

export interface TranscribeAudioToolOptions {
  /** Directory relative paths resolve against; defaults to the global workspace. */
  getWorkspaceDir?: () => string
  /** Settings the declaration is built from; defaults to the saved settings. */
  settings?: SttSettings
  extractAudio?: ExtractAudio
  /** Books transcriptions in the token usage; omitted in tests. */
  usage?: ToolUsageOptions
}

/** Where a tool books its speech usage; the getters are read per call. */
export interface ToolUsageOptions {
  db: Database
  getSessionId?: () => string | null | undefined
  getUserId?: () => number | undefined
}

function resolveToolUsage(options: ToolUsageOptions | undefined): VoiceUsageContext | undefined {
  if (!options) return undefined
  return { db: options.db, sessionId: options.getSessionId?.() ?? null, userId: options.getUserId?.() ?? null }
}

export function isTranscribeAudioToolEnabled(settings: SttSettings): boolean {
  return settings.enabled && settings.agentTool && settings.model !== ''
}

function isRewriteOffered(settings: SttSettings): boolean {
  return settings.rewrite.enabled && settings.rewrite.providerId !== ''
}

/** `audio_transcribe` when STT is enabled and offered to the agent in the settings, otherwise nothing. */
export function createTranscribeAudioTools(options: Omit<TranscribeAudioToolOptions, 'settings'> = {}): AgentTool[] {
  let settings: SttSettings
  try {
    settings = loadSttSettings()
  } catch {
    return []
  }
  return isTranscribeAudioToolEnabled(settings) ? [createTranscribeAudioTool({ ...options, settings })] : []
}

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], details: { error: true } }
}

interface MediaFile {
  path: string
  filename: string
  ext: string
  mimeType: string
}

/** Resolve and validate the requested file; returns an error message when it cannot be transcribed. */
function resolveMediaFile(filePath: string, workspaceDir: string): MediaFile | string {
  const resolved = nodePath.isAbsolute(filePath) ? filePath : nodePath.resolve(workspaceDir, filePath)
  if (!fs.existsSync(resolved)) return `Error: File not found: ${resolved}`
  try {
    fs.accessSync(resolved, fs.constants.R_OK)
  } catch {
    return `Error: File is not readable: ${resolved}`
  }
  const ext = nodePath.extname(resolved).toLowerCase()
  const mimeType = AUDIO_EXTENSIONS[ext] ?? VIDEO_EXTENSIONS[ext]
  if (!mimeType) return `Error: Unsupported file format "${ext}". Supported formats: ${SUPPORTED_EXTENSIONS.join(', ')}`
  return { path: resolved, filename: nodePath.basename(resolved), ext, mimeType }
}

/** Deepgram accepts files far beyond any practical length; the other STT backends stop at about 25 MB. */
function uploadLimitBytes(modelRef: string): number | null {
  try {
    const { providerId } = parseProviderModelId(modelRef || undefined)
    const providerType = loadProviders().providers.find(p => p.id === providerId)?.providerType
    return providerType && getVoiceProviderCapabilities(providerType)?.backend === 'deepgram' ? null : MAX_DIRECT_UPLOAD_BYTES
  } catch {
    return MAX_DIRECT_UPLOAD_BYTES
  }
}

function oversizedAudioError(sizeBytes: number, limitBytes: number): string {
  const minutes = Math.round(sizeBytes / REENCODE_BYTES_PER_SECOND / 60)
  const maxMinutes = Math.floor(limitBytes / REENCODE_BYTES_PER_SECOND / 60)
  return `Error: The audio track is about ${minutes} minutes long, too long for the STT provider (about ${maxMinutes} minutes per file at most). `
    + 'Split it into parts with ffmpeg via shell, e.g. '
    + `\`ffmpeg -i <file> -vn -ac 1 -ar 16000 -c:a libmp3lame -b:a ${REENCODE_BITRATE_KBPS}k -f segment -segment_time ${SPLIT_SEGMENT_SECONDS} <name>_part%03d.mp3\`, `
    + 'then transcribe each part.'
}

interface UploadAudio {
  buffer: Buffer
  uploadName: string
  reencoded: boolean
}

/**
 * Audio to upload: the file itself, or a compact MP3 of its audio track for
 * videos and oversized audio. Returns an error message when even the MP3 is
 * too large for the provider of `modelRef`.
 */
async function loadUploadAudio(file: MediaFile, extractAudio: ExtractAudio, modelRef: string): Promise<UploadAudio | string> {
  if (!(file.ext in VIDEO_EXTENSIONS) && fs.statSync(file.path).size <= MAX_DIRECT_UPLOAD_BYTES) {
    return { buffer: fs.readFileSync(file.path), uploadName: file.filename, reencoded: false }
  }
  const buffer = await extractAudio(file.path)
  const limit = uploadLimitBytes(modelRef)
  if (limit !== null && buffer.length > limit) return oversizedAudioError(buffer.length, limit)
  return { buffer, uploadName: `${nodePath.basename(file.path, file.ext)}.mp3`, reencoded: true }
}

function writeTranscriptFile(workspaceDir: string, sourcePath: string, transcript: string): string {
  const base = nodePath.basename(sourcePath, nodePath.extname(sourcePath))
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = nodePath.join(workspaceDir, 'transcripts', `${base}-${stamp}.txt`)
  fs.mkdirSync(nodePath.dirname(target), { recursive: true })
  fs.writeFileSync(target, transcript, 'utf-8')
  return target
}

/** Inline transcript, or a preview plus the path of the file it was saved to when it is too long for the context. */
function formatTranscript(text: string, rewriteError: string | undefined, saveTranscript: () => string): { text: string; transcriptPath?: string } {
  const note = rewriteError ? `Note: the rewrite failed (${rewriteError}); this is the raw transcript.` : null
  if (text.length <= INLINE_TRANSCRIPT_MAX_CHARS) {
    return { text: note ? `${text}\n\n${note}` : text }
  }
  const transcriptPath = saveTranscript()
  const summary = `Transcript (${text.length} characters) saved to ${transcriptPath}. Read it with read_file. Preview:\n\n`
    + `${text.slice(0, TRANSCRIPT_PREVIEW_CHARS)}…`
  return { text: note ? `${summary}\n\n${note}` : summary, transcriptPath }
}

/**
 * Create the `audio_transcribe` agent tool: transcribes audio or video files
 * from the workspace with the configured STT model. The `rewrite` parameter
 * is only declared when a rewrite model is configured.
 */
export function createTranscribeAudioTool(options: TranscribeAudioToolOptions = {}): AgentTool {
  const getWorkspace = options.getWorkspaceDir ?? getWorkspaceDir
  const extractAudio = options.extractAudio ?? extractAudioWithFfmpeg
  const declaredSettings = options.settings ?? loadSttSettings()
  const rewriteDeclared = isRewriteOffered(declaredSettings)

  const properties: Record<string, TSchema> = {
    path: Type.String({
      description: 'Path to the audio or video file, relative to workspace root.',
    }),
    language: Type.Optional(
      Type.String({
        description: 'Language code (e.g., "en", "de") for improved accuracy. Default: auto-detect.',
      }),
    ),
  }
  if (rewriteDeclared) {
    properties.rewrite = Type.Optional(
      Type.Boolean({
        description: 'Clean up the transcript (filler words, false starts, grammar) with the configured rewrite model. '
          + 'Default: false — the raw transcript is usually what you need.',
      }),
    )
  }

  return {
    name: TRANSCRIBE_AUDIO_TOOL_NAME,
    label: 'Transcribe Audio',
    description:
      'Transcribe an audio or video file to text using the configured speech-to-text provider. ' +
      'Supports audio (mp3, wav, ogg, webm, m4a, flac) and video (mp4, mov, mkv, avi, m4v, mpeg); ' +
      'the audio track of videos is extracted with ffmpeg. The file must exist in the workspace. ' +
      `Transcripts longer than ${INLINE_TRANSCRIPT_MAX_CHARS} characters are saved to a file in the workspace and only a preview is returned.`,
    parameters: Type.Object(properties),
    execute: async (_toolCallId, params) => {
      const { path: filePath, language, rewrite } = params as {
        path: string
        language?: string
        rewrite?: boolean
      }

      try {
        const settings = loadSttSettings()
        if (!settings.enabled) {
          return errorResult('Error: Speech-to-text is not enabled. Enable it in Settings → Speech-to-Text.')
        }

        const workspaceDir = getWorkspace()
        const file = resolveMediaFile(filePath, workspaceDir)
        if (typeof file === 'string') return errorResult(file)

        const upload = await loadUploadAudio(file, extractAudio, settings.model)
        if (typeof upload === 'string') return errorResult(upload)
        const { buffer, uploadName, reencoded } = upload
        const result = await transcribeAudio(buffer, {
          language,
          filename: uploadName,
          rewrite: rewrite === true && isRewriteOffered(settings),
          usage: resolveToolUsage(options.usage),
        })
        const output = formatTranscript(
          result.rewritten ?? result.transcript,
          result.rewriteError,
          () => writeTranscriptFile(workspaceDir, file.path, result.rewritten ?? result.transcript),
        )

        return {
          content: [{ type: 'text' as const, text: output.text }],
          details: {
            path: file.path,
            filename: file.filename,
            mimeType: file.mimeType,
            language: language ?? 'auto',
            rewrite: result.rewritten !== undefined,
            ...(reencoded && { audioExtracted: true }),
            ...(result.rewriteError && { rewriteError: result.rewriteError }),
            ...(output.transcriptPath && { transcriptPath: output.transcriptPath }),
          },
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        return errorResult(`Error transcribing audio: ${errorMsg}`)
      }
    },
  }
}
