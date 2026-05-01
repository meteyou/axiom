import { Router } from 'express'
import {
  getApiKeyForProvider,
  loadProvidersDecrypted,
  loadTtsSettings,
  synthesizeTts,
} from '@axiom/core'
import type { TtsSettings } from '@axiom/core'
import { jwtMiddleware } from '../auth.js'
import type { AuthenticatedRequest } from '../auth.js'

interface TtsRequestBody {
  text: string
  voice?: string
}

/**
 * Strip markdown so the synthesized speech doesn't read out backticks,
 * asterisks, list markers, etc. Kept here (not in core) because it's purely
 * a UX concern for the web/Telegram callers — the core synthesizer takes
 * the text it's given.
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/^>\s+/gm, '')
    .replace(/^[-*_]{3,}\s*$/gm, '')
    .replace(/^[\s]*[-*+]\s+/gm, '')
    .replace(/^[\s]*\d+\.\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function createTtsRouter(): Router {
  const router = Router()
  router.use(jwtMiddleware)

  /**
   * POST /api/tts
   * Generate speech from text using the saved settings.
   * Body: { text: string, voice?: string }
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

    const cleanText = stripMarkdown(body.text)
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
      const result = await synthesizeTts(cleanText, { voice: body.voice })
      res.setHeader('Content-Type', result.contentType)
      res.setHeader('Content-Length', result.audio.length)
      res.send(result.audio)
    } catch (err) {
      res.status(500).json({ error: `TTS generation failed: ${(err as Error).message}` })
    }
  })

  /**
   * POST /api/tts/preview
   * Preview TTS so the user can test before saving. Works even when TTS is
   * globally disabled.
   *
   * Body: { text: string, voice?: string, settings?: Partial<TtsSettings> }
   *
   * NOTE: `settings` overrides are accepted for forward compatibility but
   * currently ignored — `synthesizeTts()` reads from disk. The frontend
   * sends the same provider that's saved (just with different model/voice
   * values), and those round-trip via the saved settings unchanged.
   */
  router.post('/preview', async (req: AuthenticatedRequest, res) => {
    const body = req.body as {
      text?: string
      voice?: string
      settings?: Partial<TtsSettings>
    }

    if (!body.text || typeof body.text !== 'string' || !body.text.trim()) {
      res.status(400).json({ error: 'text is required' })
      return
    }

    const cleanText = stripMarkdown(body.text).slice(0, 1000) // 1K-char preview cap
    if (!cleanText) {
      res.status(400).json({ error: 'text is empty' })
      return
    }

    try {
      const result = await synthesizeTts(cleanText, { voice: body.voice })
      res.setHeader('Content-Type', result.contentType)
      res.setHeader('Content-Length', result.audio.length)
      res.send(result.audio)
    } catch (err) {
      res.status(500).json({ error: `TTS preview failed: ${(err as Error).message}` })
    }
  })

  /**
   * GET /api/tts/settings
   * Returns current TTS settings so the frontend can check if TTS is enabled.
   */
  router.get('/settings', (_req: AuthenticatedRequest, res) => {
    const ttsSettings = loadTtsSettings()
    res.json(ttsSettings)
  })

  /**
   * GET /api/tts/voices
   * Fetch available Mistral voices via Mistral's /v1/audio/voices endpoint.
   * Returns an empty list for any other provider (OpenAI/Deepgram have static
   * voice catalogs; the UI lists them inline / fetches them via the Deepgram
   * models endpoint).
   */
  router.get('/voices', async (_req: AuthenticatedRequest, res) => {
    const ttsSettings = loadTtsSettings()
    if (ttsSettings.provider !== 'mistral') {
      res.json({ voices: [] })
      return
    }

    try {
      const file = loadProvidersDecrypted()
      const provider
        = (ttsSettings.providerId && file.providers.find(p => p.id === ttsSettings.providerId))
        || file.providers.find(p => p.providerType === 'mistral' || p.provider === 'mistral')
        || file.providers.find(p => p.baseUrl?.includes('api.mistral.ai'))
      if (!provider) {
        res.json({ voices: [] })
        return
      }

      const apiKey = await getApiKeyForProvider(provider)
      const baseUrl = (provider.baseUrl || 'https://api.mistral.ai')
        .replace(/\/+$/, '')
        .replace(/\/v1$/, '')
      const url = `${baseUrl}/v1/audio/voices?limit=100`

      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      if (!response.ok) {
        res.json({ voices: [] })
        return
      }

      const data = await response.json() as {
        items?: Array<{ id: string; name: string; languages?: string[]; user_id?: string | null }>
      }
      const voices = (data.items ?? []).map(v => ({
        id: v.id,
        name: v.name,
        languages: v.languages ?? [],
        isPreset: !v.user_id || v.user_id === 'preset',
      }))
      res.json({ voices })
    } catch {
      res.json({ voices: [] })
    }
  })

  return router
}
