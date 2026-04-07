import { Router } from 'express'
import { loadProvidersDecrypted, getApiKeyForProvider } from '@openagent/core'
import type { ProviderConfig } from '@openagent/core'
import { loadConfig, ensureConfigTemplates } from '@openagent/core'
import { jwtMiddleware } from '../auth.js'
import type { AuthenticatedRequest } from '../auth.js'

interface TtsSettings {
  enabled: boolean
  provider: 'openai' | 'mistral'
  providerId: string
  openaiModel: string
  openaiVoice: string
  openaiInstructions: string
  mistralVoice: string
  responseFormat: string
}

interface TtsRequestBody {
  text: string
  voice?: string
}

function loadTtsSettings(): TtsSettings {
  ensureConfigTemplates()
  const settings = loadConfig<Record<string, unknown>>('settings.json')
  const tts = (settings.tts ?? {}) as Partial<TtsSettings>
  return {
    enabled: tts.enabled ?? false,
    provider: tts.provider ?? 'openai',
    providerId: tts.providerId ?? '',
    openaiModel: tts.openaiModel ?? 'gpt-4o-mini-tts',
    openaiVoice: tts.openaiVoice ?? 'nova',
    openaiInstructions: tts.openaiInstructions ?? '',
    mistralVoice: tts.mistralVoice ?? '',
    responseFormat: tts.responseFormat ?? 'mp3',
  }
}

/**
 * Find the provider to use for TTS.
 * If a specific providerId is configured, use that.
 * Otherwise, fall back to finding the first provider matching the TTS provider type.
 */
function findTtsProvider(settings: TtsSettings): ProviderConfig | null {
  const file = loadProvidersDecrypted()

  // If a specific provider is selected, use exactly that one
  if (settings.providerId) {
    return file.providers.find(p => p.id === settings.providerId) ?? null
  }

  // Fallback: find first provider matching the TTS type
  const providerType = settings.provider
  const byType = file.providers.find(p => p.providerType === providerType || p.provider === providerType)
  if (byType) return byType

  if (providerType === 'openai') {
    return file.providers.find(p => p.baseUrl?.includes('api.openai.com')) ?? null
  }
  if (providerType === 'mistral') {
    return file.providers.find(p => p.baseUrl?.includes('api.mistral.ai')) ?? null
  }
  return null
}

/**
 * Strip markdown from text for cleaner TTS output
 */
function stripMarkdown(text: string): string {
  return text
    // Remove code blocks
    .replace(/```[\s\S]*?```/g, '')
    // Remove inline code
    .replace(/`([^`]+)`/g, '$1')
    // Remove bold/italic markers
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    // Remove headers
    .replace(/^#{1,6}\s+/gm, '')
    // Remove link syntax, keep text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove images
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    // Remove blockquotes
    .replace(/^>\s+/gm, '')
    // Remove horizontal rules
    .replace(/^[-*_]{3,}\s*$/gm, '')
    // Remove list markers
    .replace(/^[\s]*[-*+]\s+/gm, '')
    .replace(/^[\s]*\d+\.\s+/gm, '')
    // Collapse multiple newlines
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function generateOpenAiTts(
  apiKey: string,
  baseUrl: string,
  text: string,
  settings: TtsSettings,
  voice?: string,
): Promise<Response> {
  const url = `${normalizeBaseUrl(baseUrl)}/v1/audio/speech`
  const body: Record<string, unknown> = {
    model: settings.openaiModel,
    voice: voice ?? settings.openaiVoice,
    input: text,
    response_format: settings.responseFormat,
  }
  if (settings.openaiInstructions && settings.openaiModel === 'gpt-4o-mini-tts') {
    body.instructions = settings.openaiInstructions
  }

  return fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

async function generateMistralTts(
  apiKey: string,
  baseUrl: string,
  text: string,
  settings: TtsSettings,
  voice?: string,
): Promise<Response> {
  const url = `${normalizeBaseUrl(baseUrl)}/v1/audio/speech`
  const voiceId = voice ?? settings.mistralVoice
  const body: Record<string, unknown> = {
    model: 'voxtral-mini-tts-2603',
    input: text,
    response_format: settings.responseFormat,
    stream: false,
  }
  if (voiceId) {
    body.voice_id = voiceId
  }

  return fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

/**
 * Normalize base URL: strip trailing slash and /v1 suffix
 * so we can always append /v1/audio/speech.
 */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
}

const CONTENT_TYPE_MAP: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  opus: 'audio/opus',
  flac: 'audio/flac',
  pcm: 'audio/pcm',
}

export function createTtsRouter(): Router {
  const router = Router()
  router.use(jwtMiddleware)

  /**
   * POST /api/tts
   * Generate speech from text.
   * Body: { text: string, voice?: string, provider?: 'openai' | 'mistral' }
   * Returns: streamed audio (audio/mpeg, audio/wav, etc.)
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
      const providerConfig = findTtsProvider(ttsSettings)
      if (!providerConfig) {
        const hint = ttsSettings.providerId
          ? `Selected provider (${ttsSettings.providerId}) not found.`
          : `No ${ttsSettings.provider} provider configured.`
        res.status(400).json({ error: `${hint} Add or select a provider in Settings → Text-to-Speech.` })
        return
      }

      const apiKey = await getApiKeyForProvider(providerConfig)
      const defaultBaseUrl = ttsSettings.provider === 'mistral' ? 'https://api.mistral.ai' : 'https://api.openai.com'
      const baseUrl = providerConfig.baseUrl || defaultBaseUrl

      let response: Response

      if (ttsSettings.provider === 'mistral') {
        response = await generateMistralTts(apiKey, baseUrl, cleanText, ttsSettings, body.voice)
      } else {
        response = await generateOpenAiTts(apiKey, baseUrl, cleanText, ttsSettings, body.voice)
      }

      if (!response.ok) {
        const errorText = await response.text()
        let errorMessage: string
        try {
          const errorJson = JSON.parse(errorText) as { error?: { message?: string } }
          errorMessage = errorJson.error?.message ?? errorText
        } catch {
          errorMessage = errorText
        }
        res.status(response.status).json({ error: `TTS API error: ${errorMessage}` })
        return
      }

      // For Mistral non-streaming, the response is JSON with base64 audio
      if (ttsSettings.provider === 'mistral') {
        const contentType = response.headers.get('content-type') ?? ''
        if (contentType.includes('application/json')) {
          const data = await response.json() as { audio_data?: string }
          if (!data.audio_data) {
            res.status(500).json({ error: 'Mistral TTS returned no audio data' })
            return
          }
          const audioBuffer = Buffer.from(data.audio_data, 'base64')
          res.setHeader('Content-Type', CONTENT_TYPE_MAP[ttsSettings.responseFormat] ?? 'audio/mpeg')
          res.setHeader('Content-Length', audioBuffer.length)
          res.send(audioBuffer)
          return
        }
      }

      // For OpenAI (and Mistral streaming), pipe the binary audio stream
      const audioContentType = CONTENT_TYPE_MAP[ttsSettings.responseFormat] ?? 'audio/mpeg'
      res.setHeader('Content-Type', audioContentType)
      res.setHeader('Transfer-Encoding', 'chunked')

      if (!response.body) {
        res.status(500).json({ error: 'No audio stream received from TTS provider' })
        return
      }

      // Pipe the ReadableStream to Express response
      const reader = response.body.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(value)
        }
        res.end()
      } catch (streamErr) {
        if (!res.headersSent) {
          res.status(500).json({ error: `Stream error: ${(streamErr as Error).message}` })
        } else {
          res.end()
        }
      }
    } catch (err) {
      res.status(500).json({ error: `TTS generation failed: ${(err as Error).message}` })
    }
  })

  /**
   * POST /api/tts/preview
   * Preview TTS with the settings from the request body (for testing unsaved changes).
   * Body: { text: string, voice?: string, settings: TtsSettings }
   * Unlike the main endpoint, this works even when TTS is disabled.
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

    const cleanText = stripMarkdown(body.text).slice(0, 1000) // Limit preview to 1000 chars
    if (!cleanText) {
      res.status(400).json({ error: 'text is empty' })
      return
    }

    // Merge saved settings with overrides from the request
    const savedSettings = loadTtsSettings()
    const ttsSettings: TtsSettings = {
      ...savedSettings,
      ...body.settings,
    }

    const providerConfig = findTtsProvider(ttsSettings)
    if (!providerConfig) {
      res.status(400).json({ error: `No provider configured for TTS. Add a provider in the Providers page.` })
      return
    }

    try {
      const apiKey = await getApiKeyForProvider(providerConfig)
      const defaultBaseUrl = ttsSettings.provider === 'mistral' ? 'https://api.mistral.ai' : 'https://api.openai.com'
      const baseUrl = providerConfig.baseUrl || defaultBaseUrl

      let response: Response
      if (ttsSettings.provider === 'mistral') {
        response = await generateMistralTts(apiKey, baseUrl, cleanText, ttsSettings, body.voice)
      } else {
        response = await generateOpenAiTts(apiKey, baseUrl, cleanText, ttsSettings, body.voice)
      }

      if (!response.ok) {
        const errorText = await response.text()
        let errorMessage: string
        try {
          const errorJson = JSON.parse(errorText) as { error?: { message?: string } }
          errorMessage = errorJson.error?.message ?? errorText
        } catch {
          errorMessage = errorText
        }
        res.status(response.status).json({ error: `TTS API error: ${errorMessage}` })
        return
      }

      // Handle Mistral JSON response (base64)
      if (ttsSettings.provider === 'mistral') {
        const contentType = response.headers.get('content-type') ?? ''
        if (contentType.includes('application/json')) {
          const data = await response.json() as { audio_data?: string }
          if (!data.audio_data) {
            res.status(500).json({ error: 'No audio data returned' })
            return
          }
          const audioBuffer = Buffer.from(data.audio_data, 'base64')
          res.setHeader('Content-Type', CONTENT_TYPE_MAP[ttsSettings.responseFormat] ?? 'audio/mpeg')
          res.setHeader('Content-Length', audioBuffer.length)
          res.send(audioBuffer)
          return
        }
      }

      // Stream binary audio
      res.setHeader('Content-Type', CONTENT_TYPE_MAP[ttsSettings.responseFormat] ?? 'audio/mpeg')
      res.setHeader('Transfer-Encoding', 'chunked')

      if (!response.body) {
        res.status(500).json({ error: 'No audio stream received' })
        return
      }

      const reader = response.body.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(value)
        }
        res.end()
      } catch {
        res.end()
      }
    } catch (err) {
      res.status(500).json({ error: `TTS preview failed: ${(err as Error).message}` })
    }
  })

  /**
   * GET /api/tts/settings
   * Get current TTS settings (for the frontend to check if TTS is enabled)
   */
  router.get('/settings', (_req: AuthenticatedRequest, res) => {
    const ttsSettings = loadTtsSettings()
    res.json(ttsSettings)
  })

  /**
   * GET /api/tts/voices
   * Fetch available Mistral voices from the API.
   * Returns the preset voices with their IDs, names, and languages.
   */
  router.get('/voices', async (_req: AuthenticatedRequest, res) => {
    const ttsSettings = loadTtsSettings()
    const providerConfig = findTtsProvider(ttsSettings)

    if (!providerConfig) {
      res.json({ voices: [] })
      return
    }

    // Only Mistral has a voices API
    if (ttsSettings.provider !== 'mistral') {
      res.json({ voices: [] })
      return
    }

    try {
      const apiKey = await getApiKeyForProvider(providerConfig)
      const baseUrl = providerConfig.baseUrl || 'https://api.mistral.ai'
      const url = `${normalizeBaseUrl(baseUrl)}/v1/audio/voices?limit=100`

      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
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
