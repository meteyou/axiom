import { Router } from 'express'
import {
  loadTtsSettings,
  SETTINGS_TTS_RESPONSE_FORMATS,
  stripMarkdownForSpeech,
  synthesizeTts,
} from '@axiom/core'
import type { Database, SynthesizeOptions, TtsResponseFormat } from '@axiom/core'
import { jwtMiddleware } from '../auth.js'
import type { AuthenticatedRequest } from '../auth.js'

interface TtsRequestBody {
  text: string
}

function parsePreviewSettings(value: unknown): NonNullable<SynthesizeOptions['settings']> {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const settings: NonNullable<SynthesizeOptions['settings']> = {}
  for (const key of ['model', 'voice', 'instructions'] as const) {
    if (typeof source[key] === 'string') settings[key] = source[key] as string
  }
  if ((SETTINGS_TTS_RESPONSE_FORMATS as readonly unknown[]).includes(source.responseFormat)) {
    settings.responseFormat = source.responseFormat as TtsResponseFormat
  }
  return settings
}

export function createTtsRouter(db?: Database): Router {
  const router = Router()
  router.use(jwtMiddleware)

  /**
   * POST /api/tts
   * Generate speech from text using the saved settings.
   * Body: { text: string }
   */
  router.post('/', async (req: AuthenticatedRequest, res) => {
    const ttsSettings = loadTtsSettings()
    if (!ttsSettings.enabled) {
      res.status(403).json({ error: 'TTS is not enabled. Enable it in Settings → Text-to-Speech.' })
      return
    }

    const body = req.body as TtsRequestBody
    if (!body.text || typeof body.text !== 'string') {
      res.status(400).json({ error: 'text is required' })
      return
    }

    const cleanText = stripMarkdownForSpeech(body.text)
    if (!cleanText) {
      res.status(400).json({ error: 'text is empty after stripping markdown' })
      return
    }

    // Character limit to prevent abuse (100K chars ≈ $1.50)
    if (cleanText.length > 100_000) {
      res.status(400).json({ error: 'text exceeds maximum length of 100,000 characters' })
      return
    }

    try {
      const result = await synthesizeTts(cleanText, db ? { usage: { db, userId: req.user?.userId ?? null } } : {})
      res.setHeader('Content-Type', result.contentType)
      res.setHeader('Content-Length', result.audio.length)
      res.send(result.audio)
    } catch (err) {
      res.status(500).json({ error: `TTS generation failed: ${(err as Error).message}` })
    }
  })

  /**
   * POST /api/tts/preview
   * Admin-only preview of unsaved TTS settings; works while TTS is disabled.
   * Body: { text: string, settings?: { model?, voice?, instructions?, responseFormat? } }
   */
  router.post('/preview', async (req: AuthenticatedRequest, res) => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' })
      return
    }
    const body = req.body as { text?: unknown; settings?: unknown }

    if (typeof body.text !== 'string' || !body.text.trim()) {
      res.status(400).json({ error: 'text is required' })
      return
    }

    const cleanText = stripMarkdownForSpeech(body.text).slice(0, 1000)
    if (!cleanText) {
      res.status(400).json({ error: 'text is empty' })
      return
    }

    try {
      const result = await synthesizeTts(cleanText, {
        settings: parsePreviewSettings(body.settings),
        ignoreEnabled: true,
        ...(db && { usage: { db, userId: req.user?.userId ?? null } }),
      })
      res.setHeader('Content-Type', result.contentType)
      res.setHeader('Content-Length', result.audio.length)
      res.send(result.audio)
    } catch (err) {
      res.status(500).json({ error: `TTS preview failed: ${(err as Error).message}` })
    }
  })

  /**
   * GET /api/tts/settings
   * Lets the chat UI check whether the "Read aloud" action is available.
   */
  router.get('/settings', (_req: AuthenticatedRequest, res) => {
    try {
      res.json({ enabled: loadTtsSettings().enabled })
    } catch {
      res.json({ enabled: false })
    }
  })

  return router
}
