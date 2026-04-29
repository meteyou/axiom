import { Router } from 'express'
import { loadConfig, ensureConfigTemplates, transcribeAudio, loadSttSettings } from '@axiom/core'
import { jwtMiddleware } from '../auth.js'
import type { AuthenticatedRequest } from '../auth.js'
import { uploadMiddleware } from '../uploads.js'

export function createSttRouter(): Router {
  const router = Router()
  router.use(jwtMiddleware)

  /**
   * POST /api/stt/transcribe
   * Accepts a multipart audio file upload and returns a transcript.
   * Uses the configured STT provider (whisper-url, openai, ollama).
   */
  router.post(
    '/transcribe',
    uploadMiddleware.single('file'),
    async (req: AuthenticatedRequest, res) => {
      try {
        const file = (req as AuthenticatedRequest & { file?: Express.Multer.File }).file
        if (!file || !file.buffer) {
          res.status(400).json({ error: 'No audio file provided. Send a "file" field with multipart/form-data.' })
          return
        }

        // Auto-resolve language from settings (unless "match" or "auto")
        ensureConfigTemplates()
        const settings = loadConfig<Record<string, unknown>>('settings.json')
        const settingsLanguage = (settings.language as string) ?? ''
        const autoLanguages = ['match', 'auto', '']
        const language = autoLanguages.includes(settingsLanguage.toLowerCase())
          ? undefined
          : settingsLanguage

        const result = await transcribeAudio(file.buffer, { language, filename: file.originalname })
        const body: { transcript: string; rewritten?: string } = { transcript: result.transcript }
        if (result.rewritten !== undefined) {
          body.rewritten = result.rewritten
        }
        res.json(body)
      } catch (err) {
        const message = (err as Error).message
        const status = message.includes('not enabled') ? 403 : 500
        res.status(status).json({ error: message })
      }
    },
  )

  /**
   * GET /api/stt/settings
   * Returns minimal STT settings so the frontend can check if STT is enabled.
   */
  router.get('/settings', (_req: AuthenticatedRequest, res) => {
    try {
      const settings = loadSttSettings()
      res.json({ enabled: settings.enabled })
    } catch {
      res.json({ enabled: false })
    }
  })

  return router
}
