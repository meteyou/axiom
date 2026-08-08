import type { Response } from 'express'
import type { AuthenticatedRequest } from '../../../auth.js'
import { parseCreateEmailAccountBody, parseUpdateEmailAccountBody } from './schema.js'
import {
  createEmailService,
  EmailAccountConflictError,
  EmailAccountNotFoundError,
} from './service.js'

export interface EmailController {
  listAccounts: (req: AuthenticatedRequest, res: Response) => void
  getAccount: (req: AuthenticatedRequest, res: Response) => void
  createAccount: (req: AuthenticatedRequest, res: Response) => void
  updateAccount: (req: AuthenticatedRequest, res: Response) => void
  deleteAccount: (req: AuthenticatedRequest, res: Response) => void
}

function handleError(res: Response, err: unknown, fallback: string): void {
  if (err instanceof EmailAccountNotFoundError) {
    res.status(404).json({ error: err.message })
    return
  }
  if (err instanceof EmailAccountConflictError) {
    res.status(409).json({ error: err.message })
    return
  }
  res.status(500).json({ error: `${fallback}: ${(err as Error).message}` })
}

export function createEmailController(): EmailController {
  const service = createEmailService()

  return {
    listAccounts(_req, res) {
      try {
        res.json({ accounts: service.listAccounts() })
      } catch (err) {
        handleError(res, err, 'Failed to list email accounts')
      }
    },

    getAccount(req, res) {
      try {
        res.json({ account: service.getAccount(String(req.params.id)) })
      } catch (err) {
        handleError(res, err, 'Failed to get email account')
      }
    },

    createAccount(req, res) {
      const parsed = parseCreateEmailAccountBody(req.body)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error })
        return
      }

      try {
        res.status(201).json({ account: service.createAccount(parsed.value) })
      } catch (err) {
        handleError(res, err, 'Failed to create email account')
      }
    },

    updateAccount(req, res) {
      const parsed = parseUpdateEmailAccountBody(req.body)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error })
        return
      }

      try {
        res.json({ account: service.updateAccount(String(req.params.id), parsed.value) })
      } catch (err) {
        handleError(res, err, 'Failed to update email account')
      }
    },

    deleteAccount(req, res) {
      try {
        service.deleteAccount(String(req.params.id))
        res.json({ success: true })
      } catch (err) {
        handleError(res, err, 'Failed to delete email account')
      }
    },
  }
}
