import fs from 'node:fs'
import path from 'node:path'
import multer from 'multer'
import type { Request, Response, NextFunction } from 'express'
import {
  getUploadsDir,
  parseUploadsMetadata,
  type UploadDescriptor,
} from '@axiom/core'

const MAX_UPLOAD_SIZE = 50 * 1024 * 1024

export const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_SIZE,
    files: 5,
  },
})

export function extractUploadsFromMetadata(metadata?: string | null): UploadDescriptor[] {
  return parseUploadsMetadata(metadata)
}

export function sendUploadedFile(req: Request, res: Response, next: NextFunction): void {
  try {
    const rawPath = req.params.path ?? req.params[0]
    const relativePath = Array.isArray(rawPath) ? rawPath.join('/') : rawPath
    if (!relativePath) {
      res.status(404).json({ error: 'File not found' })
      return
    }

    const normalized = path.posix.normalize(relativePath).replace(/^\/+/, '')
    if (!normalized || normalized.includes('..')) {
      res.status(400).json({ error: 'Invalid file path' })
      return
    }

    const uploadsDir = path.resolve(getUploadsDir())
    const absolutePath = path.resolve(uploadsDir, normalized)
    if (!absolutePath.startsWith(uploadsDir) || !fs.existsSync(absolutePath)) {
      res.status(404).json({ error: 'File not found' })
      return
    }

    if (req.query.preview === '1') {
      const width = Number(req.query.w)
      const height = Number(req.query.h)
      const style: string[] = ['max-width:100%', 'height:auto', 'display:block']
      if (Number.isFinite(width) && width > 0) style.push(`width:${Math.round(width)}px`)
      if (Number.isFinite(height) && height > 0) style.push(`max-height:${Math.round(height)}px`)
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(`<!doctype html><html><body style="margin:0;background:#111;display:flex;align-items:center;justify-content:center;min-height:100vh;"><img src="/api/uploads/${encodeURIComponent(normalized).replace(/%2F/g, '/')}" alt="preview" style="${style.join(';')}" /></body></html>`)
      return
    }

    const download = typeof req.query.download === 'string'
    if (download) {
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(absolutePath).replace(/"/g, '')}"`)
    }
    res.sendFile(absolutePath, { dotfiles: 'allow' })
  } catch (err) {
    next(err)
  }
}
