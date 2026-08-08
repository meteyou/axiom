import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Database, SafeEmailAccount } from '@axiom/core'
import { initDatabase, isEncrypted } from '@axiom/core'
import { createApp } from '../../../app.js'
import { generateAccessToken } from '../../../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let adminToken: string
let userToken: string
let tempDataDir: string
let previousDataDir: string | undefined

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-email-route-'))
  process.env.DATA_DIR = tempDataDir

  db = initDatabase(':memory:')

  server = http.createServer(createApp({ db }))
  await new Promise<void>((resolve) => server.listen(0, resolve))

  const port = (server.address() as { port: number }).port
  baseUrl = `http://127.0.0.1:${port}`
  adminToken = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
  userToken = generateAccessToken({ userId: 2, username: 'user', role: 'user' })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))

  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir

  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

function accountsFile(): string {
  return path.join(tempDataDir, 'config', 'email-accounts.json')
}

beforeEach(() => {
  fs.rmSync(accountsFile(), { force: true })
})

function authHeaders(token = adminToken) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

function accountPayload(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Work',
    imapHost: '127.0.0.1',
    imapPort: 1143,
    imapUser: 'agent@example.com',
    imapPassword: 'imap-secret',
    smtpHost: '127.0.0.1',
    smtpPort: 1025,
    smtpUser: 'agent@example.com',
    smtpPassword: 'smtp-secret',
    ...overrides,
  }
}

async function createAccount(overrides: Record<string, unknown> = {}): Promise<SafeEmailAccount> {
  const res = await fetch(`${baseUrl}/api/email/accounts`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(accountPayload(overrides)),
  })
  expect(res.status).toBe(201)
  const body = await res.json() as { account: SafeEmailAccount }
  return body.account
}

describe('email route module', () => {
  it('creates an account with correct defaults and without leaking passwords', async () => {
    const account = await createAccount()

    expect(account.id).toBeTruthy()
    expect(account.canDelete).toBe(false)
    expect(account.allowSelfSignedCert).toBe(false)
    expect(account.appendToSentFolder).toBe(false)
    expect(account.allowHtml).toBe(false)
    expect(account.requireApproval).toBe(false)
    expect(account.attachmentDownloadPath).toBe('email-attachments')
    expect(account).not.toHaveProperty('imapPassword')
    expect(account).not.toHaveProperty('smtpPassword')
    expect(account.imapPasswordSet).toBe(true)
    expect(account.smtpPasswordSet).toBe(true)
  })

  it('stores passwords encrypted at rest', async () => {
    await createAccount()

    const raw = fs.readFileSync(accountsFile(), 'utf-8')
    expect(raw).not.toContain('imap-secret')
    expect(raw).not.toContain('smtp-secret')

    const stored = JSON.parse(raw) as { accounts: { imapPassword: string; smtpPassword: string }[] }
    expect(isEncrypted(stored.accounts[0]!.imapPassword)).toBe(true)
    expect(isEncrypted(stored.accounts[0]!.smtpPassword)).toBe(true)
  })

  it('lists accounts without passwords', async () => {
    await createAccount()

    const res = await fetch(`${baseUrl}/api/email/accounts`, { headers: authHeaders() })
    const body = await res.json() as { accounts: SafeEmailAccount[] }

    expect(res.status).toBe(200)
    expect(body.accounts).toHaveLength(1)
    expect(JSON.stringify(body)).not.toContain('imap-secret')
  })

  it('gets a single account and returns 404 for unknown ids', async () => {
    const created = await createAccount()

    const found = await fetch(`${baseUrl}/api/email/accounts/${created.id}`, { headers: authHeaders() })
    expect(found.status).toBe(200)

    const missing = await fetch(`${baseUrl}/api/email/accounts/does-not-exist`, { headers: authHeaders() })
    expect(missing.status).toBe(404)
  })

  it('updates account fields, flags and allowlist', async () => {
    const created = await createAccount()

    const res = await fetch(`${baseUrl}/api/email/accounts/${created.id}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({
        name: 'Private',
        canSend: true,
        requireApproval: true,
        allowHtml: true,
        allowlist: { addresses: ['Boss@Example.com'], domains: ['@example.org'] },
        signature: 'Sent by an AI agent',
      }),
    })

    const body = await res.json() as { account: SafeEmailAccount }
    expect(res.status).toBe(200)
    expect(body.account.name).toBe('Private')
    expect(body.account.canSend).toBe(true)
    expect(body.account.requireApproval).toBe(true)
    expect(body.account.allowHtml).toBe(true)
    expect(body.account.allowlist).toEqual({ addresses: ['boss@example.com'], domains: ['example.org'] })
    expect(body.account.signature).toBe('Sent by an AI agent')
  })

  it('deletes an account', async () => {
    const created = await createAccount()

    const res = await fetch(`${baseUrl}/api/email/accounts/${created.id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    })
    expect(res.status).toBe(200)

    const list = await fetch(`${baseUrl}/api/email/accounts`, { headers: authHeaders() })
    expect((await list.json() as { accounts: unknown[] }).accounts).toHaveLength(0)
  })

  it('rejects invalid payloads', async () => {
    const missingName = await fetch(`${baseUrl}/api/email/accounts`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(accountPayload({ name: '  ' })),
    })
    expect(missingName.status).toBe(400)

    const badPort = await fetch(`${baseUrl}/api/email/accounts`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(accountPayload({ imapPort: 0 })),
    })
    expect(badPort.status).toBe(400)

    const badFlag = await fetch(`${baseUrl}/api/email/accounts`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(accountPayload({ canDelete: 'yes' })),
    })
    expect(badFlag.status).toBe(400)
  })

  it('rejects duplicate account names with 409', async () => {
    await createAccount()

    const res = await fetch(`${baseUrl}/api/email/accounts`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(accountPayload()),
    })
    expect(res.status).toBe(409)
  })

  it('denies non-admin users on every account endpoint', async () => {
    const created = await createAccount()

    const requests = [
      fetch(`${baseUrl}/api/email/accounts`, { headers: authHeaders(userToken) }),
      fetch(`${baseUrl}/api/email/accounts/${created.id}`, { headers: authHeaders(userToken) }),
      fetch(`${baseUrl}/api/email/accounts`, {
        method: 'POST',
        headers: authHeaders(userToken),
        body: JSON.stringify(accountPayload({ name: 'Other' })),
      }),
      fetch(`${baseUrl}/api/email/accounts/${created.id}`, {
        method: 'PUT',
        headers: authHeaders(userToken),
        body: JSON.stringify({ canSend: true }),
      }),
      fetch(`${baseUrl}/api/email/accounts/${created.id}`, {
        method: 'DELETE',
        headers: authHeaders(userToken),
      }),
    ]

    for (const res of await Promise.all(requests)) {
      expect(res.status).toBe(403)
    }
  })

  it('requires authentication', async () => {
    const res = await fetch(`${baseUrl}/api/email/accounts`)
    expect(res.status).toBe(401)
  })
})
