import type { Response } from 'express'
import type { AuthenticatedRequest } from '../../../auth.js'
import type { SettingsRouterOptions } from './types.js'
import { createSettingsService, SettingsValidationError } from './service.js'
import { createOwnSettingsService } from './own-settings.js'
import { buildWebManifest } from './web-manifest.js'

export interface SettingsController {
  getSettings: (req: AuthenticatedRequest, res: Response) => void
  getAppearance: (req: AuthenticatedRequest, res: Response) => void
  getWebManifest: (req: AuthenticatedRequest, res: Response) => void
  putSettings: (req: AuthenticatedRequest, res: Response) => void
  getOwnSettings: (req: AuthenticatedRequest, res: Response) => void
  putOwnSettings: (req: AuthenticatedRequest, res: Response) => void
  getChatModels: (req: AuthenticatedRequest, res: Response) => void
}

export function createSettingsController(options: SettingsRouterOptions = {}): SettingsController {
  const service = createSettingsService(options)
  const ownService = options.db
    ? createOwnSettingsService(options.db, service, options.onActiveProviderChanged, options.onTimezoneChanged)
    : null

  return {
    getSettings(_req, res) {
      try {
        const payload = service.readSettings()
        res.json(payload)
      } catch (err) {
        res.status(500).json({ error: `Failed to read settings: ${(err as Error).message}` })
      }
    },

    getAppearance(_req, res) {
      try {
        res.json(service.readAppearance())
      } catch (err) {
        res.status(500).json({ error: `Failed to read appearance settings: ${(err as Error).message}` })
      }
    },

    getWebManifest(_req, res) {
      try {
        const manifest = buildWebManifest(service.readAppearance().logo)
        // The icons change with the logo setting, so browsers must revalidate.
        res.set('Cache-Control', 'no-cache')
        res.type('application/manifest+json').send(JSON.stringify(manifest))
      } catch (err) {
        res.status(500).json({ error: `Failed to build the web app manifest: ${(err as Error).message}` })
      }
    },

    putSettings(req, res) {
      try {
        const payload = service.updateSettings((req.body ?? {}) as Record<string, unknown>)
        res.json(payload)
      } catch (err) {
        if (err instanceof SettingsValidationError) {
          res.status(400).json({ error: err.message })
          return
        }

        res.status(500).json({ error: `Failed to update settings: ${(err as Error).message}` })
      }
    },

    getOwnSettings(req, res) {
      if (!ownService || !req.user) {
        res.status(503).json({ error: 'Own settings are not available' })
        return
      }
      try {
        res.json(ownService.read(req.user.userId))
      } catch (err) {
        if (err instanceof SettingsValidationError) {
          res.status(404).json({ error: err.message })
          return
        }
        res.status(500).json({ error: `Failed to read settings: ${(err as Error).message}` })
      }
    },

    putOwnSettings(req, res) {
      if (!ownService || !req.user) {
        res.status(503).json({ error: 'Own settings are not available' })
        return
      }
      try {
        res.json(ownService.update(req.user.userId, (req.body ?? {}) as Record<string, unknown>))
      } catch (err) {
        if (err instanceof SettingsValidationError) {
          res.status(400).json({ error: err.message })
          return
        }
        res.status(500).json({ error: `Failed to update settings: ${(err as Error).message}` })
      }
    },

    getChatModels(_req, res) {
      if (!ownService) {
        res.status(503).json({ error: 'Chat models are not available' })
        return
      }
      try {
        res.json({ providers: ownService.listChatModels() })
      } catch (err) {
        res.status(500).json({ error: `Failed to list chat models: ${(err as Error).message}` })
      }
    },
  }
}
