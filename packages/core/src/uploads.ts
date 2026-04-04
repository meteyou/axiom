import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Database } from './database.js'
import { loadConfig } from './config.js'

export interface UploadSettings {
  uploadRetentionDays?: number
}

export interface UploadDescriptor {
  kind: 'image' | 'file'
  originalName: string
  storedName: string
  relativePath: string
  urlPath: string
  mimeType: string
  size: number
  previewUrl?: string
  width?: number
  height?: number
}

export interface SaveUploadInput {
  buffer: Buffer
  originalName?: string | null
  mimeType?: string | null
  source: 'web' | 'telegram'
  userId?: number | null
  sessionId?: string | null
}

const IMAGE_MIME_PREFIX = 'image/'
const PREVIEW_WIDTH = 640
const PREVIEW_HEIGHT = 640

export function getDataDir(): string {
  return process.env.DATA_DIR ?? '/data'
}

export function getUploadsDir(): string {
  return path.join(getDataDir(), 'uploads')
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function sanitizeBaseName(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/[\\/]+/g, '-')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120) || 'upload'
}

function sanitizeExtension(ext: string): string {
  const cleaned = ext.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16).toLowerCase()
  return cleaned ? `.${cleaned}` : ''
}

function splitName(name?: string | null): { base: string; ext: string } {
  const fallback = 'upload'
  const input = (name ?? '').trim()
  const parsed = path.parse(input || fallback)
  return {
    base: sanitizeBaseName(parsed.name || fallback),
    ext: sanitizeExtension(parsed.ext || ''),
  }
}

function buildStorageKey(): string {
  return crypto.randomBytes(12).toString('hex')
}

function buildDatePath(date = new Date()): string {
  const y = String(date.getUTCFullYear())
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  return path.join(y, m, d)
}

function detectKind(mimeType: string): 'image' | 'file' {
  return mimeType.startsWith(IMAGE_MIME_PREFIX) ? 'image' : 'file'
}

function parsePngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) return null
  if (buffer.toString('ascii', 1, 4) !== 'PNG') return null
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  }
}

function parseJpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  let offset = 2
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xFF) {
      offset += 1
      continue
    }

    const marker = buffer[offset + 1]
    const length = buffer.readUInt16BE(offset + 2)
    if (length < 2) return null

    const isSof = marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)
    if (isSof && offset + 8 < buffer.length) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      }
    }

    offset += 2 + length
  }

  return null
}

export function getImageDimensions(buffer: Buffer, mimeType: string): { width: number; height: number } | null {
  if (mimeType === 'image/png') return parsePngDimensions(buffer)
  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') return parseJpegDimensions(buffer)
  return null
}

function computePreviewSize(width: number, height: number): { width: number; height: number } {
  const ratio = Math.min(PREVIEW_WIDTH / width, PREVIEW_HEIGHT / height, 1)
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  }
}

export function saveUpload(input: SaveUploadInput): UploadDescriptor {
  const mimeType = input.mimeType?.trim() || 'application/octet-stream'
  const kind = detectKind(mimeType)
  const { base, ext } = splitName(input.originalName)
  const datePath = buildDatePath()
  const uploadRoot = getUploadsDir()
  const storageDir = path.join(uploadRoot, datePath)
  ensureDir(storageDir)

  const storageKey = buildStorageKey()
  const storedName = `${storageKey}-${base}${ext}`
  const absolutePath = path.join(storageDir, storedName)
  fs.writeFileSync(absolutePath, input.buffer)

  const relativePath = path.posix.join(...datePath.split(path.sep), storedName)
  const urlPath = `/api/uploads/${relativePath}`

  const result: UploadDescriptor = {
    kind,
    originalName: `${base}${ext}`,
    storedName,
    relativePath,
    urlPath,
    mimeType,
    size: input.buffer.length,
  }

  if (kind === 'image') {
    const dimensions = getImageDimensions(input.buffer, mimeType)
    if (dimensions) {
      const preview = computePreviewSize(dimensions.width, dimensions.height)
      result.width = dimensions.width
      result.height = dimensions.height
      result.previewUrl = `${urlPath}?preview=1&w=${preview.width}&h=${preview.height}`
    }
  }

  return result
}

export function serializeUploadsMetadata(files: UploadDescriptor[]): string {
  return JSON.stringify({ files })
}

export function parseUploadsMetadata(metadata?: string | null): UploadDescriptor[] {
  if (!metadata) return []
  try {
    const parsed = JSON.parse(metadata) as { files?: UploadDescriptor[] }
    return Array.isArray(parsed.files) ? parsed.files : []
  } catch {
    return []
  }
}

export function getUploadRetentionDays(): number {
  try {
    const settings = loadConfig<UploadSettings>('settings.json')
    const days = settings.uploadRetentionDays
    if (typeof days === 'number' && Number.isFinite(days) && days >= 0) return days
  } catch {
    // ignore
  }
  return 30
}

export function cleanupExpiredUploads(db: Database, now = new Date()): { deletedFiles: number; deletedMessages: number } {
  const retentionDays = getUploadRetentionDays()
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString()
  const rows = db.prepare(
    `SELECT id, metadata FROM chat_messages WHERE metadata IS NOT NULL AND timestamp < ? AND (
      metadata LIKE '%"relativePath"%' OR metadata LIKE '%"files"%'
    )`
  ).all(cutoff) as Array<{ id: number; metadata: string | null }>

  let deletedFiles = 0
  let deletedMessages = 0

  for (const row of rows) {
    const files = parseUploadsMetadata(row.metadata)
    if (files.length === 0) continue

    for (const file of files) {
      const absolutePath = path.join(getUploadsDir(), file.relativePath)
      if (absolutePath.startsWith(getUploadsDir()) && fs.existsSync(absolutePath)) {
        fs.rmSync(absolutePath, { force: true })
        deletedFiles += 1
      }
    }

    db.prepare('UPDATE chat_messages SET metadata = NULL WHERE id = ?').run(row.id)
    deletedMessages += 1
  }

  return { deletedFiles, deletedMessages }
}
