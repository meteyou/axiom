import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadOrCreateVapidKeys } from './vapid-keys.js'

describe('loadOrCreateVapidKeys', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-vapid-'))
    file = path.join(dir, 'config', 'vapid.json')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('generates a key pair on first use and reuses it afterwards', () => {
    const first = loadOrCreateVapidKeys({}, file)
    const second = loadOrCreateVapidKeys({}, file)

    expect(first.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/)
    expect(first.privateKey).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(second).toEqual(first)
    expect(first.subject).toBeNull()
    const stored = JSON.parse(fs.readFileSync(file, 'utf-8')) as { publicKey: string; privateKey: string }
    expect(stored.publicKey).toBe(first.publicKey)
    expect(stored.privateKey).toBe(first.privateKey)
  })

  it('writes the key file readable by the owner only', () => {
    loadOrCreateVapidKeys({}, file)

    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  it('prefers keys and subject from the environment', () => {
    loadOrCreateVapidKeys({}, file)

    const keys = loadOrCreateVapidKeys({
      VAPID_PUBLIC_KEY: 'env-public',
      VAPID_PRIVATE_KEY: 'env-private',
      VAPID_SUBJECT: 'mailto:ops@example.org',
    }, file)

    expect(keys).toEqual({ publicKey: 'env-public', privateKey: 'env-private', subject: 'mailto:ops@example.org' })
  })

  it('applies VAPID_SUBJECT on top of the stored keys and reads a subject from the file', () => {
    const generated = loadOrCreateVapidKeys({}, file)
    expect(loadOrCreateVapidKeys({ VAPID_SUBJECT: 'https://axiom.example.org' }, file).subject).toBe('https://axiom.example.org')

    fs.writeFileSync(file, JSON.stringify({ ...generated, subject: 'mailto:me@example.org' }))
    expect(loadOrCreateVapidKeys({}, file).subject).toBe('mailto:me@example.org')
  })

  it('rejects a half-configured environment', () => {
    expect(() => loadOrCreateVapidKeys({ VAPID_PUBLIC_KEY: 'only-public' }, file)).toThrow(/must be set together/)
  })

  it('refuses to replace an unreadable key file', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{ not json')

    expect(() => loadOrCreateVapidKeys({}, file)).toThrow(/Cannot read VAPID keys/)
    expect(fs.readFileSync(file, 'utf-8')).toBe('{ not json')
  })
})
