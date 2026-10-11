import fs from 'node:fs'
import path from 'node:path'
import webpush from 'web-push'
import { getConfigDir } from '@axiom/core'

export interface VapidKeys {
  publicKey: string
  privateKey: string
  /** Contact (`mailto:` or `https:`) sent to push services; `null` derives it per device. */
  subject: string | null
}

interface StoredVapidFile {
  publicKey?: unknown
  privateKey?: unknown
  subject?: unknown
}

function getVapidFilePath(): string {
  return path.join(getConfigDir(), 'vapid.json')
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readStoredKeys(filePath: string): VapidKeys {
  let parsed: StoredVapidFile
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as StoredVapidFile
  } catch (err) {
    throw new Error(`Cannot read VAPID keys from ${filePath}: ${(err as Error).message}`)
  }
  const publicKey = optionalString(parsed.publicKey)
  const privateKey = optionalString(parsed.privateKey)
  if (!publicKey || !privateKey) {
    throw new Error(`${filePath} must contain "publicKey" and "privateKey"`)
  }
  return { publicKey, privateKey, subject: optionalString(parsed.subject) }
}

/**
 * Writing through a temp file keeps a crash mid-write from leaving a truncated
 * key file behind, which would invalidate every existing subscription.
 */
function writeNewKeys(filePath: string): VapidKeys {
  const generated = webpush.generateVAPIDKeys()
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(tmpPath, JSON.stringify({
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
    createdAt: new Date().toISOString(),
  }, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
  fs.renameSync(tmpPath, filePath)
  return { publicKey: generated.publicKey, privateKey: generated.privateKey, subject: null }
}

/**
 * `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` win over the generated key file;
 * `VAPID_SUBJECT` wins over the file's optional `subject`. Keys are never
 * regenerated once the file exists: a new key pair silently orphans every
 * subscription, so an unreadable file is an error instead.
 */
export function loadOrCreateVapidKeys(env: NodeJS.ProcessEnv = process.env, filePath = getVapidFilePath()): VapidKeys {
  const envPublic = optionalString(env.VAPID_PUBLIC_KEY)
  const envPrivate = optionalString(env.VAPID_PRIVATE_KEY)
  const envSubject = optionalString(env.VAPID_SUBJECT)

  if (envPublic || envPrivate) {
    if (!envPublic || !envPrivate) {
      throw new Error('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set together')
    }
    return { publicKey: envPublic, privateKey: envPrivate, subject: envSubject }
  }

  const keys = fs.existsSync(filePath) ? readStoredKeys(filePath) : writeNewKeys(filePath)
  return { ...keys, subject: envSubject ?? keys.subject }
}
