import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import {
  getEmailAccountDecrypted,
  listEmailAccounts,
} from './email-account-store.js'
import type { EmailAccount } from './email-account-store.js'
import { createEmailClient, formatAddress } from './email-client.js'
import type { EmailClient, EmailClientAccount } from './email-client.js'

export const DEFAULT_EMAIL_FOLDER = 'INBOX'
export const DEFAULT_EMAIL_LIST_LIMIT = 50
export const MAX_EMAIL_LIST_LIMIT = 100

/**
 * Boundary the email tools depend on. Injectable so tests can drive the tools
 * without an IMAP server and without touching the accounts file.
 */
export interface EmailToolsDeps {
  client?: EmailClient
  listAccounts?: () => { id: string; name: string }[]
  getAccount?: (id: string) => EmailAccount | null
}

interface ResolvedDeps {
  client: EmailClient
  listAccounts: () => { id: string; name: string }[]
  getAccount: (id: string) => EmailAccount | null
}

function resolveDeps(deps: EmailToolsDeps = {}): ResolvedDeps {
  return {
    client: deps.client ?? createEmailClient(),
    listAccounts: deps.listAccounts ?? (() => listEmailAccounts().map(a => ({ id: a.id, name: a.name }))),
    getAccount: deps.getAccount ?? getEmailAccountDecrypted,
  }
}

type ToolResult = {
  content: { type: 'text'; text: string }[]
  details: Record<string, unknown>
}

function ok(text: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: 'text', text }], details }
}

function fail(text: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${text}` }], details: { ...details, error: true } }
}

export function toClientAccount(account: EmailAccount): EmailClientAccount {
  return {
    imapHost: account.imapHost,
    imapPort: account.imapPort,
    imapUser: account.imapUser,
    imapPassword: account.imapPassword,
    smtpHost: account.smtpHost,
    smtpPort: account.smtpPort,
    smtpUser: account.smtpUser,
    smtpPassword: account.smtpPassword,
    allowSelfSignedCert: account.allowSelfSignedCert,
    displayName: account.displayName,
    appendToSentFolder: account.appendToSentFolder,
  }
}

/** Server-side folder restriction — the agent can never reach a folder outside it. */
export function isFolderAllowed(account: EmailAccount, folder: string): boolean {
  if (account.folderMode !== 'selected') return true
  const target = folder.trim().toLowerCase()
  return account.allowedFolders.some(entry => entry.trim().toLowerCase() === target)
}

type Resolution<T> = { ok: true; value: T } | { ok: false; error: ToolResult }

function resolveAccount(deps: ResolvedDeps, requested?: string): Resolution<EmailAccount> {
  const available = deps.listAccounts()
  if (available.length === 0) {
    return { ok: false, error: fail('No email accounts are configured.') }
  }

  const known = () => available.map(entry => `"${entry.name}" (${entry.id})`).join(', ')

  let selected: { id: string; name: string } | undefined
  const wanted = requested?.trim()
  if (!wanted) {
    if (available.length > 1) {
      return {
        ok: false,
        error: fail(`Multiple email accounts are configured — pass the "account" parameter. Available: ${known()}`),
      }
    }
    selected = available[0]
  } else {
    selected =
      available.find(entry => entry.id === wanted) ??
      available.find(entry => entry.name.toLowerCase() === wanted.toLowerCase())
    if (!selected) {
      return { ok: false, error: fail(`Unknown email account "${wanted}". Available: ${known()}`) }
    }
  }

  const account = deps.getAccount(selected.id)
  if (!account) {
    return { ok: false, error: fail(`Email account "${selected.name}" could not be loaded.`) }
  }
  return { ok: true, value: account }
}

function resolveFolder(account: EmailAccount, folder?: string): Resolution<string> {
  const target = folder?.trim() || DEFAULT_EMAIL_FOLDER
  if (!isFolderAllowed(account, target)) {
    return {
      ok: false,
      error: fail(
        `Folder "${target}" is not accessible for account "${account.name}". Allowed folders: ${account.allowedFolders.join(', ') || 'none'}`,
      ),
    }
  }
  return { ok: true, value: target }
}

function accountParam() {
  return Type.Optional(
    Type.String({
      description: 'Email account name or id. Optional when only one account is configured. Use email_folders output or the error message to discover account names.',
    }),
  )
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function formatSender(from: { name?: string; address: string }[]): string {
  return from.length > 0 ? from.map(formatAddress).join(', ') : '(unknown sender)'
}

export function createEmailListTool(deps: EmailToolsDeps = {}): AgentTool {
  const resolved = resolveDeps(deps)

  return {
    name: 'email_list',
    label: 'List Emails',
    description:
      'List emails of a mailbox folder as metadata only (sender, subject, date, UID) — never full bodies. ' +
      `Defaults to unread messages in ${DEFAULT_EMAIL_FOLDER} with a limit of ${DEFAULT_EMAIL_LIST_LIMIT}. ` +
      'Use email_read with the UID to read a single message.',
    parameters: Type.Object({
      account: accountParam(),
      folder: Type.Optional(
        Type.String({ description: `IMAP folder path (default: ${DEFAULT_EMAIL_FOLDER}). Use email_folders to discover available folders.` }),
      ),
      unread_only: Type.Optional(
        Type.Boolean({ description: 'Only list unread messages. Default: true.' }),
      ),
      limit: Type.Optional(
        Type.Number({ description: `Maximum number of messages to return (default: ${DEFAULT_EMAIL_LIST_LIMIT}, max: ${MAX_EMAIL_LIST_LIMIT}).` }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { account: accountParamValue, folder, unread_only, limit } = params as {
        account?: string
        folder?: string
        unread_only?: boolean
        limit?: number
      }

      const account = resolveAccount(resolved, accountParamValue)
      if (!account.ok) return account.error

      const targetFolder = resolveFolder(account.value, folder)
      if (!targetFolder.ok) return targetFolder.error

      const unseenOnly = unread_only !== false
      const effectiveLimit = Math.min(
        Math.max(1, Math.floor(limit ?? DEFAULT_EMAIL_LIST_LIMIT)),
        MAX_EMAIL_LIST_LIMIT,
      )

      try {
        const messages = await resolved.client.listMessages(toClientAccount(account.value), {
          folder: targetFolder.value,
          unseenOnly,
          limit: effectiveLimit,
        })

        if (messages.length === 0) {
          return ok(
            `No ${unseenOnly ? 'unread ' : ''}messages in "${targetFolder.value}" (account "${account.value.name}").`,
            { accountId: account.value.id, folder: targetFolder.value, count: 0 },
          )
        }

        const lines = messages.map(message => {
          const date = message.date ?? 'unknown date'
          const flags = message.seen ? '' : ' [unread]'
          return `• UID ${message.uid} | ${date} | ${formatSender(message.from)} | ${message.subject}${flags}`
        })

        return ok(
          `${messages.length} message(s) in "${targetFolder.value}" (account "${account.value.name}"):\n\n${lines.join('\n')}`,
          {
            accountId: account.value.id,
            folder: targetFolder.value,
            count: messages.length,
            unreadOnly: unseenOnly,
            limit: effectiveLimit,
          },
        )
      } catch (err) {
        return fail(`Failed to list emails: ${errorText(err)}`)
      }
    },
  }
}

export function createEmailFoldersTool(deps: EmailToolsDeps = {}): AgentTool {
  const resolved = resolveDeps(deps)

  return {
    name: 'email_folders',
    label: 'List Email Folders',
    description:
      'List the folders of an email account. Only folders the account is allowed to access are returned. ' +
      'Use the returned paths as the "folder" parameter of email_list / email_read.',
    parameters: Type.Object({
      account: accountParam(),
    }),
    execute: async (_toolCallId, params) => {
      const { account: accountParamValue } = params as { account?: string }

      const account = resolveAccount(resolved, accountParamValue)
      if (!account.ok) return account.error

      try {
        const folders = await resolved.client.listFolders(toClientAccount(account.value))
        const allowed = folders.filter(entry => isFolderAllowed(account.value, entry.path))

        if (allowed.length === 0) {
          return ok(`No accessible folders for account "${account.value.name}".`, {
            accountId: account.value.id,
            count: 0,
          })
        }

        const lines = allowed.map(entry => {
          const special = entry.specialUse ? ` (${entry.specialUse})` : ''
          return `• ${entry.path}${special}`
        })

        return ok(
          `${allowed.length} folder(s) for account "${account.value.name}":\n\n${lines.join('\n')}`,
          { accountId: account.value.id, count: allowed.length, folders: allowed.map(entry => entry.path) },
        )
      } catch (err) {
        return fail(`Failed to list folders: ${errorText(err)}`)
      }
    },
  }
}

export function createEmailReadTool(deps: EmailToolsDeps = {}): AgentTool {
  const resolved = resolveDeps(deps)

  return {
    name: 'email_read',
    label: 'Read Email',
    description:
      'Read a single email by UID including its full body (HTML is converted to plain text). ' +
      'The message is automatically marked as read. Use email_list first to get UIDs.',
    parameters: Type.Object({
      account: accountParam(),
      folder: Type.Optional(
        Type.String({ description: `IMAP folder path the message lives in (default: ${DEFAULT_EMAIL_FOLDER}).` }),
      ),
      uid: Type.Number({ description: 'UID of the message, as returned by email_list.' }),
    }),
    execute: async (_toolCallId, params) => {
      const { account: accountParamValue, folder, uid } = params as {
        account?: string
        folder?: string
        uid: number
      }

      if (typeof uid !== 'number' || !Number.isFinite(uid)) {
        return fail('Parameter "uid" must be a number (see email_list output).')
      }

      const account = resolveAccount(resolved, accountParamValue)
      if (!account.ok) return account.error

      const targetFolder = resolveFolder(account.value, folder)
      if (!targetFolder.ok) return targetFolder.error

      try {
        const message = await resolved.client.readMessage(
          toClientAccount(account.value),
          targetFolder.value,
          uid,
          { markSeen: true },
        )

        const attachments = message.attachments.length > 0
          ? message.attachments.map(a => `${a.filename} (${a.contentType}, ${a.size} bytes)`).join(', ')
          : 'none'

        const header = [
          `From: ${formatSender(message.from)}`,
          `To: ${message.to.map(formatAddress).join(', ') || '(none)'}`,
          message.cc.length > 0 ? `Cc: ${message.cc.map(formatAddress).join(', ')}` : null,
          `Date: ${message.date ?? 'unknown'}`,
          `Subject: ${message.subject}`,
          `Folder: ${targetFolder.value} | UID: ${message.uid} | Account: ${account.value.name}`,
          `Attachments: ${attachments}`,
        ].filter(Boolean).join('\n')

        return ok(`${header}\n\n${message.text || '(empty body)'}`, {
          accountId: account.value.id,
          folder: targetFolder.value,
          uid: message.uid,
          markedRead: true,
          attachments: message.attachments,
        })
      } catch (err) {
        return fail(`Failed to read email: ${errorText(err)}`)
      }
    },
  }
}

/**
 * Read-only email tools. Returns an empty array when no account is configured
 * so the agent never sees tools it cannot use.
 */
export function createEmailTools(deps: EmailToolsDeps = {}): AgentTool[] {
  const resolved = resolveDeps(deps)
  if (resolved.listAccounts().length === 0) return []

  return [
    createEmailListTool(resolved),
    createEmailFoldersTool(resolved),
    createEmailReadTool(resolved),
  ]
}
