import { describe, expect, it, vi } from 'vitest'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { EmailAccount } from './email-account-store.js'
import type { EmailClient, EmailMessage, EmailMessageSummary } from './email-client.js'
import {
  createEmailFoldersTool,
  createEmailListTool,
  createEmailReadTool,
  createEmailTools,
  isFolderAllowed,
} from './email-tools.js'

function makeAccount(overrides: Partial<EmailAccount> = {}): EmailAccount {
  return {
    id: 'acc-1',
    name: 'Work',
    imapHost: 'imap.example.com',
    imapPort: 993,
    imapUser: 'agent@example.com',
    imapPassword: 'secret',
    smtpHost: 'smtp.example.com',
    smtpPort: 465,
    smtpUser: 'agent@example.com',
    smtpPassword: 'secret',
    allowSelfSignedCert: false,
    canSend: false,
    canManage: false,
    canDelete: false,
    canDownloadAttachments: false,
    requireApproval: false,
    allowlist: { addresses: [], domains: [] },
    folderMode: 'all',
    allowedFolders: [],
    displayName: 'Agent',
    signature: '',
    appendToSentFolder: false,
    allowHtml: false,
    attachmentDownloadPath: 'email-attachments',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeSummary(overrides: Partial<EmailMessageSummary> = {}): EmailMessageSummary {
  return {
    uid: 42,
    folder: 'INBOX',
    subject: 'Invoice March',
    from: [{ name: 'Alice', address: 'alice@example.com' }],
    to: [{ address: 'agent@example.com' }],
    date: '2026-03-01T10:00:00.000Z',
    seen: false,
    flagged: false,
    size: 1234,
    ...overrides,
  }
}

function makeMessage(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    ...makeSummary(),
    cc: [],
    references: [],
    text: 'Hello from the invoice',
    attachments: [],
    ...overrides,
  }
}

function mockClient(overrides: Partial<EmailClient> = {}): EmailClient {
  return {
    testConnection: vi.fn(),
    listFolders: vi.fn().mockResolvedValue([]),
    listMessages: vi.fn().mockResolvedValue([]),
    readMessage: vi.fn().mockResolvedValue(makeMessage()),
    setSeen: vi.fn(),
    moveMessages: vi.fn(),
    deleteMessages: vi.fn(),
    downloadAttachment: vi.fn(),
    sendMessage: vi.fn(),
    ...overrides,
  } as unknown as EmailClient
}

function makeDeps(accounts: EmailAccount[], client: EmailClient) {
  return {
    client,
    listAccounts: () => accounts.map(a => ({ id: a.id, name: a.name })),
    getAccount: (id: string) => accounts.find(a => a.id === id) ?? null,
  }
}

function text(result: Awaited<ReturnType<AgentTool['execute']>>): string {
  if (!result || !('content' in result)) return ''
  const content = (result as { content: { type: string; text?: string }[] }).content
  return content.filter(item => item.type === 'text').map(item => item.text ?? '').join('')
}

function details(result: Awaited<ReturnType<AgentTool['execute']>>): Record<string, unknown> {
  if (!result || !('details' in result)) return {}
  return (result as { details: Record<string, unknown> }).details
}

describe('isFolderAllowed', () => {
  it('allows everything in "all" mode', () => {
    expect(isFolderAllowed(makeAccount(), 'Whatever')).toBe(true)
  })

  it('restricts to the selected folders, case-insensitively', () => {
    const account = makeAccount({ folderMode: 'selected', allowedFolders: ['INBOX', 'Archive/2026'] })
    expect(isFolderAllowed(account, 'inbox')).toBe(true)
    expect(isFolderAllowed(account, 'Archive/2026')).toBe(true)
    expect(isFolderAllowed(account, 'Archive')).toBe(false)
  })
})

describe('createEmailTools', () => {
  it('registers no tools when no account exists', () => {
    expect(createEmailTools(makeDeps([], mockClient()))).toEqual([])
  })

  it('registers the read tools when an account exists', () => {
    const tools = createEmailTools(makeDeps([makeAccount()], mockClient()))
    expect(tools.map(tool => tool.name)).toEqual(['email_list', 'email_folders', 'email_read'])
  })
})

describe('email_list tool', () => {
  it('defaults to unread messages in INBOX with a limit of 50', async () => {
    const client = mockClient({ listMessages: vi.fn().mockResolvedValue([makeSummary()]) })
    const tool = createEmailListTool(makeDeps([makeAccount()], client))

    const result = await tool.execute('call-1', {})

    expect(client.listMessages).toHaveBeenCalledWith(
      expect.objectContaining({ imapHost: 'imap.example.com' }),
      { folder: 'INBOX', unseenOnly: true, limit: 50 },
    )
    expect(text(result)).toContain('UID 42')
    expect(text(result)).toContain('Invoice March')
    expect(text(result)).toContain('Alice <alice@example.com>')
    expect(details(result).count).toBe(1)
  })

  it('returns metadata only, never the message body', async () => {
    const client = mockClient({ listMessages: vi.fn().mockResolvedValue([makeSummary()]) })
    const tool = createEmailListTool(makeDeps([makeAccount()], client))

    const result = await tool.execute('call-1', {})

    expect(text(result)).not.toContain('Hello from the invoice')
  })

  it('caps the limit and honours explicit folder / unread_only', async () => {
    const client = mockClient({ listMessages: vi.fn().mockResolvedValue([]) })
    const tool = createEmailListTool(makeDeps([makeAccount()], client))

    await tool.execute('call-1', { folder: 'Archive', unread_only: false, limit: 5000 })

    expect(client.listMessages).toHaveBeenCalledWith(
      expect.anything(),
      { folder: 'Archive', unseenOnly: false, limit: 100 },
    )
  })

  it('blocks folders outside the account restriction', async () => {
    const client = mockClient()
    const account = makeAccount({ folderMode: 'selected', allowedFolders: ['INBOX'] })
    const tool = createEmailListTool(makeDeps([account], client))

    const result = await tool.execute('call-1', { folder: 'Secret' })

    expect(text(result)).toContain('not accessible')
    expect(details(result).error).toBe(true)
    expect(client.listMessages).not.toHaveBeenCalled()
  })

  it('requires an account parameter when several accounts exist', async () => {
    const accounts = [makeAccount(), makeAccount({ id: 'acc-2', name: 'Private' })]
    const tool = createEmailListTool(makeDeps(accounts, mockClient()))

    const result = await tool.execute('call-1', {})

    expect(text(result)).toContain('Multiple email accounts')
    expect(text(result)).toContain('"Private" (acc-2)')
    expect(details(result).error).toBe(true)
  })

  it('selects the account by name', async () => {
    const accounts = [makeAccount(), makeAccount({ id: 'acc-2', name: 'Private', imapHost: 'imap.private.test' })]
    const client = mockClient({ listMessages: vi.fn().mockResolvedValue([]) })
    const tool = createEmailListTool(makeDeps(accounts, client))

    await tool.execute('call-1', { account: 'private' })

    expect(client.listMessages).toHaveBeenCalledWith(
      expect.objectContaining({ imapHost: 'imap.private.test' }),
      expect.anything(),
    )
  })

  it('reports unknown accounts with the available ones', async () => {
    const tool = createEmailListTool(makeDeps([makeAccount()], mockClient()))

    const result = await tool.execute('call-1', { account: 'nope' })

    expect(text(result)).toContain('Unknown email account "nope"')
    expect(text(result)).toContain('"Work" (acc-1)')
  })

  it('surfaces client errors as tool errors', async () => {
    const client = mockClient({ listMessages: vi.fn().mockRejectedValue(new Error('IMAP: authentication failed')) })
    const tool = createEmailListTool(makeDeps([makeAccount()], client))

    const result = await tool.execute('call-1', {})

    expect(text(result)).toContain('IMAP: authentication failed')
    expect(details(result).error).toBe(true)
  })
})

describe('email_folders tool', () => {
  const folders = [
    { path: 'INBOX', name: 'INBOX', delimiter: '/', subscribed: true },
    { path: 'Archive', name: 'Archive', delimiter: '/', subscribed: true },
  ]

  it('lists all folders when the account is unrestricted', async () => {
    const client = mockClient({ listFolders: vi.fn().mockResolvedValue(folders) })
    const tool = createEmailFoldersTool(makeDeps([makeAccount()], client))

    const result = await tool.execute('call-1', {})

    expect(details(result).folders).toEqual(['INBOX', 'Archive'])
  })

  it('hides folders outside the account restriction', async () => {
    const client = mockClient({ listFolders: vi.fn().mockResolvedValue(folders) })
    const account = makeAccount({ folderMode: 'selected', allowedFolders: ['INBOX'] })
    const tool = createEmailFoldersTool(makeDeps([account], client))

    const result = await tool.execute('call-1', {})

    expect(details(result).folders).toEqual(['INBOX'])
    expect(text(result)).not.toContain('Archive')
  })
})

describe('email_read tool', () => {
  it('reads the message body and marks it as read', async () => {
    const message = makeMessage({ text: 'Converted body text', attachments: [] })
    const client = mockClient({ readMessage: vi.fn().mockResolvedValue(message) })
    const tool = createEmailReadTool(makeDeps([makeAccount()], client))

    const result = await tool.execute('call-1', { uid: 42 })

    expect(client.readMessage).toHaveBeenCalledWith(
      expect.objectContaining({ imapUser: 'agent@example.com' }),
      'INBOX',
      42,
      { markSeen: true },
    )
    expect(text(result)).toContain('Subject: Invoice March')
    expect(text(result)).toContain('Converted body text')
    expect(details(result).markedRead).toBe(true)
  })

  it('marks as read even for readonly accounts', async () => {
    const client = mockClient({ readMessage: vi.fn().mockResolvedValue(makeMessage()) })
    const readonly = makeAccount({ canSend: false, canManage: false, canDelete: false })
    const tool = createEmailReadTool(makeDeps([readonly], client))

    const result = await tool.execute('call-1', { uid: 42 })

    expect(details(result).markedRead).toBe(true)
    expect(details(result).error).toBeUndefined()
  })

  it('blocks folders outside the account restriction', async () => {
    const client = mockClient()
    const account = makeAccount({ folderMode: 'selected', allowedFolders: ['INBOX'] })
    const tool = createEmailReadTool(makeDeps([account], client))

    const result = await tool.execute('call-1', { uid: 1, folder: 'Secret' })

    expect(text(result)).toContain('not accessible')
    expect(client.readMessage).not.toHaveBeenCalled()
  })

  it('rejects a missing uid', async () => {
    const tool = createEmailReadTool(makeDeps([makeAccount()], mockClient()))

    const result = await tool.execute('call-1', {})

    expect(text(result)).toContain('"uid" must be a number')
  })

  it('lists attachment metadata', async () => {
    const message = makeMessage({
      attachments: [{ partId: '2', filename: 'invoice.pdf', contentType: 'application/pdf', size: 2048 }],
    })
    const client = mockClient({ readMessage: vi.fn().mockResolvedValue(message) })
    const tool = createEmailReadTool(makeDeps([makeAccount()], client))

    const result = await tool.execute('call-1', { uid: 42 })

    expect(text(result)).toContain('invoice.pdf (application/pdf, 2048 bytes)')
  })
})
