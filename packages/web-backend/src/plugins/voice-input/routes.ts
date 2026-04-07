import { Router } from 'express'
import { jwtMiddleware } from '../../auth.js'
import type { AuthenticatedRequest } from '../../auth.js'
import { uploadMiddleware } from '../../uploads.js'

// ── Config defaults (can be overridden via environment variables or per-request settings) ──
const DEFAULT_WHISPER_URL = process.env.WHISPER_URL ?? 'https://whisper.jansohn.xyz/inference'
const DEFAULT_OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://192.168.10.222:11434/api/generate'
const DEFAULT_OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'qwen3:32b'
const DEFAULT_VOICE_REWRITE_ENABLED = process.env.VOICE_REWRITE_ENABLED === 'true'
const DEFAULT_REWRITE_PROMPT = `You are a prompt architect. The user has dictated a voice message that should become a prompt for an AI assistant.

Your task:
- Convert the transcribed speech into a single, clean, optimized prompt
- Remove filler words, repetitions, and spoken artifacts
- Preserve the full intent and all relevant details
- Output ONLY the optimized prompt — no explanations, no alternatives, no labels

Transcript: {{transcript}}`

// ── Types ─────────────────────────────────────────────────────────────────────

interface RewriteVariants {
  corrected: string
  rewritten: string
  formal: string
  short: string
}

interface OllamaGenerateResponse {
  response: string
  done: boolean
}

/**
 * Per-request settings that the frontend can pass to override env defaults.
 * All fields are optional — missing fields fall back to the env/default values.
 */
interface RequestSettings {
  whisperUrl?: string
  rewriteEnabled?: boolean
  ollamaUrl?: string
  ollamaModel?: string
  rewritePrompt?: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Normalises the Ollama base URL so it always ends with /api/generate.
 * Accepts either a bare host ("http://host:11434") or the full path.
 */
function resolveOllamaUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (trimmed.endsWith('/api/generate')) return trimmed
  return `${trimmed}/api/generate`
}

/**
 * Forwards an audio buffer to the Whisper inference endpoint and returns the
 * raw transcript string.
 */
async function transcribeAudio(
  audioBuffer: Buffer,
  originalName: string,
  mimeType: string,
  whisperUrl: string,
): Promise<string> {
  const formData = new FormData()
  const blob = new Blob([audioBuffer], { type: mimeType })
  formData.append('file', blob, originalName)
  formData.append('response_format', 'text')

  const response = await fetch(whisperUrl, {
    method: 'POST',
    body: formData,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Whisper returned ${response.status}: ${text}`)
  }

  // Whisper returns plain text when response_format=text
  const transcript = await response.text()
  return transcript.trim()
}

/**
 * Sends a transcript to Ollama for rewriting and returns the four variants.
 * Throws when Ollama is unreachable or returns invalid JSON.
 */
async function rewriteTranscript(
  transcript: string,
  ollamaUrl: string,
  ollamaModel: string,
  promptTemplate: string,
): Promise<RewriteVariants> {
  // Replace the {{transcript}} placeholder in the prompt template
  const prompt = promptTemplate.includes('{{transcript}}')
    ? promptTemplate.replace('{{transcript}}', transcript)
    : `${promptTemplate}\n\nInput: ${transcript}`

  const response = await fetch(ollamaUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ollamaModel,
      prompt,
      stream: false,
      options: {
        temperature: 0.3,
        num_predict: 2048,
      },
    }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Ollama returned ${response.status}: ${text}`)
  }

  const data = (await response.json()) as OllamaGenerateResponse

  // Extract the JSON block from the model response.
  // qwen3 with "think" mode may wrap its answer in <think>…</think> tags.
  let rawText = data.response?.trim() ?? ''

  // Strip <think>…</think> blocks (qwen3 extended thinking output)
  rawText = rawText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()

  // Find the first '{' and last '}' to extract the JSON object
  const jsonStart = rawText.indexOf('{')
  const jsonEnd = rawText.lastIndexOf('}')
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
    throw new Error(`Ollama response did not contain a valid JSON object: ${rawText.slice(0, 200)}`)
  }

  const jsonStr = rawText.slice(jsonStart, jsonEnd + 1)
  const parsed = JSON.parse(jsonStr) as Partial<RewriteVariants>

  return {
    corrected: String(parsed.corrected ?? transcript),
    rewritten: String(parsed.rewritten ?? transcript),
    formal: String(parsed.formal ?? transcript),
    short: String(parsed.short ?? transcript),
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

export function createVoiceRouter(): Router {
  const router = Router()

  router.use(jwtMiddleware)

  /**
   * POST /api/voice/transcribe
   *
   * Accepts a single audio file via multipart/form-data (field name: "audio").
   * Optional form fields can override backend defaults:
   *   - whisperUrl      (string)  — Whisper inference endpoint
   *   - rewriteEnabled  (string "true"/"false") — whether to run Ollama rewrite
   *   - ollamaUrl       (string)  — Ollama base URL
   *   - ollamaModel     (string)  — Ollama model name
   *   - rewritePrompt   (string)  — Prompt template (use {{transcript}} as placeholder)
   *
   * Response: { transcript: string, rewriteEnabled: boolean }
   */
  router.post(
    '/transcribe',
    uploadMiddleware.single('audio'),
    async (req: AuthenticatedRequest, res) => {
      const file = req.file as Express.Multer.File | undefined
      if (!file) {
        res.status(400).json({ error: 'No audio file provided. Use multipart/form-data with field "audio".' })
        return
      }

      // Read per-request overrides from form fields (sent alongside the audio file)
      const body = req.body as Record<string, string>
      const settings: RequestSettings = {
        whisperUrl: body.whisperUrl?.trim() || undefined,
        rewriteEnabled: body.rewriteEnabled !== undefined
          ? body.rewriteEnabled === 'true'
          : undefined,
      }

      const whisperUrl = settings.whisperUrl ?? DEFAULT_WHISPER_URL
      const rewriteEnabled = settings.rewriteEnabled ?? DEFAULT_VOICE_REWRITE_ENABLED

      try {
        const transcript = await transcribeAudio(file.buffer, file.originalname, file.mimetype, whisperUrl)
        res.json({ transcript, rewriteEnabled })
      } catch (err) {
        const message = (err as Error).message
        console.error('[voice/transcribe] Error:', message)
        res.status(502).json({ error: `Transcription failed: ${message}` })
      }
    },
  )

  /**
   * POST /api/voice/rewrite
   *
   * Accepts JSON body:
   *   {
   *     transcript:    string  (required)
   *     ollamaUrl?:    string  — override Ollama base URL
   *     ollamaModel?:  string  — override Ollama model
   *     rewritePrompt?: string — override prompt template (use {{transcript}} placeholder)
   *   }
   *
   * Response: { corrected: string, rewritten: string, formal: string, short: string }
   */
  router.post('/rewrite', async (req: AuthenticatedRequest, res) => {
    const body = req.body as {
      transcript?: unknown
      ollamaUrl?: unknown
      ollamaModel?: unknown
      rewritePrompt?: unknown
    }

    const { transcript } = body
    if (typeof transcript !== 'string' || !transcript.trim()) {
      res.status(400).json({ error: 'transcript must be a non-empty string' })
      return
    }

    // Per-request overrides (fall back to env defaults if not provided)
    const ollamaUrl = resolveOllamaUrl(
      typeof body.ollamaUrl === 'string' && body.ollamaUrl.trim()
        ? body.ollamaUrl.trim()
        : DEFAULT_OLLAMA_URL,
    )
    const ollamaModel =
      typeof body.ollamaModel === 'string' && body.ollamaModel.trim()
        ? body.ollamaModel.trim()
        : DEFAULT_OLLAMA_MODEL
    const rewritePrompt =
      typeof body.rewritePrompt === 'string' && body.rewritePrompt.trim()
        ? body.rewritePrompt.trim()
        : DEFAULT_REWRITE_PROMPT

    try {
      const variants = await rewriteTranscript(transcript.trim(), ollamaUrl, ollamaModel, rewritePrompt)
      res.json(variants)
    } catch (err) {
      const message = (err as Error).message
      console.error('[voice/rewrite] Error:', message)
      res.status(502).json({ error: `Rewrite failed: ${message}` })
    }
  })

  return router
}
