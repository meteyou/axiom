import { Router } from 'express'
import { sendUploadedFile } from '../uploads.js'

export function createUploadsRouter(): Router {
  const router = Router()
  router.get('/*path', sendUploadedFile)
  return router
}
