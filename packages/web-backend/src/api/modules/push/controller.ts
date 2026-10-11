import type { Response } from 'express'
import type { AuthenticatedRequest } from '../../../auth.js'
import { mapPushDeliveryResult, mapPushDevice } from './mapper.js'
import { parsePreferencesBody, parseSubscribeBody, parseSubscriptionIdParam } from './schema.js'
import { PushSubscriptionNotFoundError, PushUnavailableError } from './service.js'
import type { PushService } from './service.js'

export interface PushController {
  getPublicKey: (req: AuthenticatedRequest, res: Response) => void
  listDevices: (req: AuthenticatedRequest, res: Response) => void
  subscribe: (req: AuthenticatedRequest, res: Response) => void
  removeDevice: (req: AuthenticatedRequest, res: Response) => void
  sendTest: (req: AuthenticatedRequest, res: Response) => Promise<void>
  updatePreferences: (req: AuthenticatedRequest, res: Response) => void
}

function handleError(res: Response, err: unknown, fallback: string): void {
  if (err instanceof PushUnavailableError) {
    res.status(503).json({ error: `Push notifications are unavailable: ${err.message}` })
    return
  }
  if (err instanceof PushSubscriptionNotFoundError) {
    res.status(404).json({ error: err.message })
    return
  }
  res.status(500).json({ error: `${fallback}: ${(err as Error).message}` })
}

/** Browsers send `Origin` on every POST; the Host fallback covers non-browser clients. */
function requestOrigin(req: AuthenticatedRequest): string | null {
  const origin = req.get('origin')
  if (origin) return origin
  const host = req.get('host')
  return host ? `${req.protocol}://${host}` : null
}

export function createPushController(service: PushService): PushController {
  return {
    getPublicKey(_req, res) {
      try {
        res.json({ publicKey: service.getPublicKey() })
      } catch (err) {
        handleError(res, err, 'Failed to load the VAPID key')
      }
    },

    listDevices(req, res) {
      try {
        const { devices, showPreview } = service.listDevices(req.user!.userId)
        res.json({ devices: devices.map(mapPushDevice), showPreview })
      } catch (err) {
        handleError(res, err, 'Failed to list devices')
      }
    },

    subscribe(req, res) {
      const parsed = parseSubscribeBody(req.body)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error })
        return
      }
      try {
        const device = service.subscribe(req.user!.userId, parsed.value, {
          userAgent: req.get('user-agent')?.slice(0, 512) ?? null,
          origin: requestOrigin(req),
        })
        res.status(201).json({ device: mapPushDevice(device) })
      } catch (err) {
        handleError(res, err, 'Failed to save the subscription')
      }
    },

    removeDevice(req, res) {
      const parsed = parseSubscriptionIdParam(req.params.id)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error })
        return
      }
      try {
        service.removeDevice(req.user!.userId, parsed.value)
        res.json({ removed: true })
      } catch (err) {
        handleError(res, err, 'Failed to remove the device')
      }
    },

    async sendTest(req, res) {
      try {
        const results = await service.sendTest(req.user!.userId)
        res.json({ results: results.map(mapPushDeliveryResult) })
      } catch (err) {
        handleError(res, err, 'Failed to send the test notification')
      }
    },

    updatePreferences(req, res) {
      const parsed = parsePreferencesBody(req.body)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error })
        return
      }
      try {
        res.json({ showPreview: service.setShowPreview(req.user!.userId, parsed.value.showPreview) })
      } catch (err) {
        handleError(res, err, 'Failed to save the preferences')
      }
    },
  }
}
