import { Router } from 'express'
import { jwtMiddleware } from '../../auth.js'
import type { AuthenticatedRequest } from '../../auth.js'
import { uploadMiddleware } from '../../uploads.js'

// ── Config (can be overridden via environment variables) ───────────────────────
const WHISPER_URL = process.env.WHISPER_URL ?? 'https://whisper.jansohn.xyz/inference'
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://192.168.10.222:11434/api/generate'
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'qwen3:32b'
const VOICE_REWRITE_ENABLED = process.env.VOICE_REWRITE_ENABLED === 'true'

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

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Forwards an audio buffer to the Whisper inference endpoint and returns the
 * raw transcript string.
 */
async function transcribeAudio(
  audioBuffer: Buffer,
  originalName: string,
  mimeType: string,
): Promise<string> {
  const formData = new FormData()
  const blob = new Blob([audioBuffer], { type: mimeType })
  formData.append('file', blob, originalName)
  formData.append('response_format', 'text')

  const response = await fetch(WHISPER_URL, {
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
async function rewriteTranscript(transcript: string): Promise<RewriteVariants> {
  const prompt = `Du bearbeitest diktierten Text in mehrere Varianten. Antworte NUR mit validem JSON, keine Erklärung, kein Markdown.

Regeln pro Variante:
- corrected: Nur Rechtschreibung, Grammatik, Satzzeichen korrigieren. Füllwörter entfernen. Stil EXAKT beibehalten.
- rewritten: Natürlich und flüssig umformulieren. Gleiche Bedeutung, gleiche Tonalität.
- formal: Professioneller Ton. Siezen statt Duzen. Geschäftstauglich.
- short: Auf das Wesentliche kürzen. So knapp wie möglich.

Input: ${transcript}

Antwort als JSON:
{"corrected": "...", "rewritten": "...", "formal": "...", "short": "..."}`

  const response = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
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
   * Accepts a single audio file via multipart/form-data (field name: "audio")
   * and forwards it to the Whisper inference endpoint.
   *
   * Response: { transcript: string }
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

      try {
        const transcript = await transcribeAudio(file.buffer, file.originalname, file.mimetype)
        res.json({ transcript, rewriteEnabled: VOICE_REWRITE_ENABLED })
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
   * Accepts { transcript: string } and returns four rewritten variants via Ollama.
   *
   * Response: { corrected: string, rewritten: string, formal: string, short: string }
   */
  router.post('/rewrite', async (req: AuthenticatedRequest, res) => {
    const { transcript } = req.body as { transcript?: unknown }
    if (typeof transcript !== 'string' || !transcript.trim()) {
      res.status(400).json({ error: 'transcript must be a non-empty string' })
      return
    }

    try {
      const variants = await rewriteTranscript(transcript.trim())
      res.json(variants)
    } catch (err) {
      const message = (err as Error).message
      console.error('[voice/rewrite] Error:', message)
      res.status(502).json({ error: `Rewrite failed: ${message}` })
    }
  })

  return router
}
