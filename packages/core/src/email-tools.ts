import fs from 'node:fs'
import path from 'node:path'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import {
  DEFAULT_ATTACHMENT_DOWNLOAD_PATH,
  getEmailAccountDecrypted,
  listEmailAccounts,
} from './email-account-store.js'
import type { EmailAccount } from './email-account-store.js'
import { createEmailClient, formatAddress } from './email-client.js'
import type { EmailClient, EmailClientAccount } from './email-client.js'
import { getWorkspaceDir } from './workspace.js'

export const DEFAULT_EMAIL_FOLDER = 'INBOX'
export const DEFAULT_EMAIL_LIST_LIMIT = 50
export const MAX_EMAIL_LIST_LIMIT = 100
export const MAX_EMAIL_BULK_UIDS = 200

/**
 * Boundary the email tools depend on. Injectable so tests can drive the tools
 * without an IMAP server and without touching the accounts file.
 */
export interface EmailToolsDeps {
  client?: EmailClient
  listAccounts?: () => { id: string; name: string }[]
  getAccount?: (id: string) => EmailAccount | null
  workspaceDir?: () => string
}

interface ResolvedDeps {
  client: EmailClient
  listAccounts: () => { id: string; name: string }[]
  getAccount: (id: string) => EmailAccount | null
  workspaceDir: () => string
}

function resolveDeps(deps: EmailToolsDeps = {}): ResolvedDeps {
  return {
    client: deps.client ?? createEmailClient(),
    listAccounts: deps.listAccounts ?? (() => listEmailAccounts().map(a => ({ id: a.id, name: a.name }))),
    getAccount: deps.getAccount ?? getEmailAccountDecrypted,
    workspaceDir: deps.workspaceDir ?? getWorkspaceDir,
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

function uidsParam(description: string) {
  return Type.Array(Type.Number(), { description })
}

type EmailCapability = 'canManage' | 'canDelete' | 'canDownloadAttachments'

const CAPABILITY_LABEL: Record<EmailCapability, string> = {
  canManage: 'manage mailbox (move/archive)',
  canDelete: 'delete messages',
  canDownloadAttachments: 'download attachments',
}

function requireCapability(account: EmailAccount, capability: EmailCapability): ToolResult | null {
  if (account[capability]) return null
  return fail(
    `Account "${account.name}" is not allowed to ${CAPABILITY_LABEL[capability]} — the "${capability}" permission is disabled for this account. ` +
      'Ask the user to enable it in the email account settings.',
    { accountId: account.id, capability },
  )
}

function resolveUids(value: unknown): Resolution<number[]> {
  const raw = Array.isArray(value) ? value : [value]
  const uids: number[] = []
  for (const entry of raw) {
    const num = typeof entry === 'number' ? entry : Number(entry)
    if (!Number.isFinite(num) || num <= 0) {
      return { ok: false, error: fail('Parameter "uids" must be a non-empty array of positive UIDs (see email_list output).') }
    }
    uids.push(Math.floor(num))
  }

  const unique = [...new Set(uids)]
  if (unique.length === 0) {
    return { ok: false, error: fail('Parameter "uids" must be a non-empty array of positive UIDs (see email_list output).') }
  }
  if (unique.length > MAX_EMAIL_BULK_UIDS) {
    return { ok: false, error: fail(`Too many UIDs — at most ${MAX_EMAIL_BULK_UIDS} messages can be handled per call.`) }
  }
  return { ok: true, value: unique }
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

function createSetSeenTool(deps: EmailToolsDeps, seen: boolean): AgentTool {
  const resolved = resolveDeps(deps)
  const verb = seen ? 'read' : 'unread'

  return {
    name: seen ? 'email_mark_read' : 'email_mark_unread',
    label: seen ? 'Mark Emails Read' : 'Mark Emails Unread',
    description:
      `Mark one or more messages as ${verb} by UID without loading their bodies into the context. ` +
      'Pass several UIDs at once to handle a whole batch in a single call. Use email_list to get UIDs.',
    parameters: Type.Object({
      account: accountParam(),
      folder: Type.Optional(
        Type.String({ description: `IMAP folder the messages live in (default: ${DEFAULT_EMAIL_FOLDER}).` }),
      ),
      uids: uidsParam(`UIDs of the messages to mark as ${verb}, as returned by email_list.`),
    }),
    execute: async (_toolCallId, params) => {
      const { account: accountParamValue, folder, uids } = params as {
        account?: string
        folder?: string
        uids?: number[]
      }

      const account = resolveAccount(resolved, accountParamValue)
      if (!account.ok) return account.error

      const targetFolder = resolveFolder(account.value, folder)
      if (!targetFolder.ok) return targetFolder.error

      const targetUids = resolveUids(uids)
      if (!targetUids.ok) return targetUids.error

      try {
        const count = await resolved.client.setSeen(
          toClientAccount(account.value),
          targetFolder.value,
          targetUids.value,
          seen,
        )

        return ok(
          `Marked ${count} message(s) as ${verb} in "${targetFolder.value}" (account "${account.value.name}").`,
          {
            accountId: account.value.id,
            folder: targetFolder.value,
            uids: targetUids.value,
            seen,
            count,
          },
        )
      } catch (err) {
        return fail(`Failed to mark messages as ${verb}: ${errorText(err)}`)
      }
    },
  }
}

export function createEmailMarkReadTool(deps: EmailToolsDeps = {}): AgentTool {
  return createSetSeenTool(deps, true)
}

export function createEmailMarkUnreadTool(deps: EmailToolsDeps = {}): AgentTool {
  return createSetSeenTool(deps, false)
}

export function createEmailMoveTool(deps: EmailToolsDeps = {}): AgentTool {
  const resolved = resolveDeps(deps)

  return {
    name: 'email_move',
    label: 'Move Emails',
    description:
      'Move (archive) one or more messages to another folder. Source and target folder must both be accessible for the account. ' +
      'Requires the account permission to manage the mailbox.',
    parameters: Type.Object({
      account: accountParam(),
      folder: Type.Optional(
        Type.String({ description: `Source folder the messages live in (default: ${DEFAULT_EMAIL_FOLDER}).` }),
      ),
      target_folder: Type.String({ description: 'Destination folder path, e.g. "Archive". Use email_folders to discover it.' }),
      uids: uidsParam('UIDs of the messages to move, as returned by email_list.'),
    }),
    execute: async (_toolCallId, params) => {
      const { account: accountParamValue, folder, target_folder, uids } = params as {
        account?: string
        folder?: string
        target_folder?: string
        uids?: number[]
      }

      const account = resolveAccount(resolved, accountParamValue)
      if (!account.ok) return account.error

      const denied = requireCapability(account.value, 'canManage')
      if (denied) return denied

      const sourceFolder = resolveFolder(account.value, folder)
      if (!sourceFolder.ok) return sourceFolder.error

      if (!target_folder?.trim()) {
        return fail('Parameter "target_folder" is required (use email_folders to discover folders).')
      }
      const targetFolder = resolveFolder(account.value, target_folder)
      if (!targetFolder.ok) return targetFolder.error

      if (targetFolder.value.toLowerCase() === sourceFolder.value.toLowerCase()) {
        return fail('Source and target folder are identical — nothing to move.')
      }

      const targetUids = resolveUids(uids)
      if (!targetUids.ok) return targetUids.error

      try {
        const count = await resolved.client.moveMessages(
          toClientAccount(account.value),
          sourceFolder.value,
          targetUids.value,
          targetFolder.value,
        )

        return ok(
          `Moved ${count} message(s) from "${sourceFolder.value}" to "${targetFolder.value}" (account "${account.value.name}").`,
          {
            accountId: account.value.id,
            folder: sourceFolder.value,
            targetFolder: targetFolder.value,
            uids: targetUids.value,
            count,
          },
        )
      } catch (err) {
        return fail(`Failed to move messages: ${errorText(err)}`)
      }
    },
  }
}

export function createEmailDeleteTool(deps: EmailToolsDeps = {}): AgentTool {
  const resolved = resolveDeps(deps)

  return {
    name: 'email_delete',
    label: 'Delete Emails',
    description:
      'Delete one or more messages by UID. This is irreversible on most servers — prefer email_move to an archive or trash folder. ' +
      'Requires the account permission to delete messages.',
    parameters: Type.Object({
      account: accountParam(),
      folder: Type.Optional(
        Type.String({ description: `Folder the messages live in (default: ${DEFAULT_EMAIL_FOLDER}).` }),
      ),
      uids: uidsParam('UIDs of the messages to delete, as returned by email_list.'),
    }),
    execute: async (_toolCallId, params) => {
      const { account: accountParamValue, folder, uids } = params as {
        account?: string
        folder?: string
        uids?: number[]
      }

      const account = resolveAccount(resolved, accountParamValue)
      if (!account.ok) return account.error

      const denied = requireCapability(account.value, 'canDelete')
      if (denied) return denied

      const targetFolder = resolveFolder(account.value, folder)
      if (!targetFolder.ok) return targetFolder.error

      const targetUids = resolveUids(uids)
      if (!targetUids.ok) return targetUids.error

      try {
        const count = await resolved.client.deleteMessages(
          toClientAccount(account.value),
          targetFolder.value,
          targetUids.value,
        )

        return ok(
          `Deleted ${count} message(s) in "${targetFolder.value}" (account "${account.value.name}").`,
          {
            accountId: account.value.id,
            folder: targetFolder.value,
            uids: targetUids.value,
            count,
          },
        )
      } catch (err) {
        return fail(`Failed to delete messages: ${errorText(err)}`)
      }
    },
  }
}

/** Strips directory traversal so a hostile filename/config cannot escape the workspace. */
export function attachmentTargetDir(workspaceDir: string, account: EmailAccount): string {
  const configured = account.attachmentDownloadPath?.trim() || DEFAULT_ATTACHMENT_DOWNLOAD_PATH
  const candidate = path.resolve(workspaceDir, configured)
  const relative = path.relative(workspaceDir, candidate)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return path.join(workspaceDir, DEFAULT_ATTACHMENT_DOWNLOAD_PATH)
  }
  return candidate
}

export function safeAttachmentFilename(filename: string): string {
  // eslint-disable-next-line no-control-regex -- control chars in a filename would corrupt the path
  const base = path.basename(filename.replace(/\\/g, '/')).replace(/[\u0000-\u001f]/g, '').trim()
  const cleaned = base.replace(/^\.+/, '')
  return cleaned || 'attachment'
}

function uniquePath(dir: string, filename: string): string {
  const ext = path.extname(filename)
  const stem = filename.slice(0, filename.length - ext.length)
  let candidate = path.join(dir, filename)
  let counter = 1
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem}-${counter}${ext}`)
    counter += 1
  }
  return candidate
}

export function createEmailDownloadAttachmentTool(deps: EmailToolsDeps = {}): AgentTool {
  const resolved = resolveDeps(deps)

  return {
    name: 'email_download_attachment',
    label: 'Download Email Attachment',
    description:
      'Download a single attachment of a message into the workspace and return its file path. ' +
      'Use email_read first to get the attachment part ids. Requires the account permission to download attachments.',
    parameters: Type.Object({
      account: accountParam(),
      folder: Type.Optional(
        Type.String({ description: `Folder the message lives in (default: ${DEFAULT_EMAIL_FOLDER}).` }),
      ),
      uid: Type.Number({ description: 'UID of the message, as returned by email_list.' }),
      part_id: Type.String({ description: 'Attachment part id, as listed by email_read.' }),
      filename: Type.Optional(
        Type.String({ description: 'Override the file name used inside the workspace directory.' }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { account: accountParamValue, folder, uid, part_id, filename } = params as {
        account?: string
        folder?: string
        uid?: number
        part_id?: string
        filename?: string
      }

      if (typeof uid !== 'number' || !Number.isFinite(uid)) {
        return fail('Parameter "uid" must be a number (see email_list output).')
      }
      if (!part_id?.trim()) {
        return fail('Parameter "part_id" is required (see the attachment list of email_read).')
      }

      const account = resolveAccount(resolved, accountParamValue)
      if (!account.ok) return account.error

      const denied = requireCapability(account.value, 'canDownloadAttachments')
      if (denied) return denied

      const targetFolder = resolveFolder(account.value, folder)
      if (!targetFolder.ok) return targetFolder.error

      try {
        const download = await resolved.client.downloadAttachment(
          toClientAccount(account.value),
          targetFolder.value,
          uid,
          part_id.trim(),
        )

        const dir = attachmentTargetDir(resolved.workspaceDir(), account.value)
        fs.mkdirSync(dir, { recursive: true })
        const targetPath = uniquePath(dir, safeAttachmentFilename(filename?.trim() || download.filename))
        fs.writeFileSync(targetPath, download.content)

        return ok(
          `Saved attachment "${path.basename(targetPath)}" (${download.contentType}, ${download.content.length} bytes) to ${targetPath}`,
          {
            accountId: account.value.id,
            folder: targetFolder.value,
            uid,
            partId: part_id.trim(),
            path: targetPath,
            contentType: download.contentType,
            size: download.content.length,
          },
        )
      } catch (err) {
        return fail(`Failed to download attachment: ${errorText(err)}`)
      }
    },
  }
}

/**
 * Email tools available to the agent. Returns an empty array when no account is
 * configured, and only registers capability-gated tools when at least one
 * account grants them — the per-account check still runs on every call.
 */
export function createEmailTools(deps: EmailToolsDeps = {}): AgentTool[] {
  const resolved = resolveDeps(deps)
  const accounts = resolved.listAccounts()
    .map(entry => resolved.getAccount(entry.id))
    .filter((entry): entry is EmailAccount => entry !== null)
  if (accounts.length === 0) return []

  const tools = [
    createEmailListTool(resolved),
    createEmailFoldersTool(resolved),
    createEmailReadTool(resolved),
    createEmailMarkReadTool(resolved),
    createEmailMarkUnreadTool(resolved),
  ]

  if (accounts.some(account => account.canManage)) tools.push(createEmailMoveTool(resolved))
  if (accounts.some(account => account.canDelete)) tools.push(createEmailDeleteTool(resolved))
  if (accounts.some(account => account.canDownloadAttachments)) {
    tools.push(createEmailDownloadAttachmentTool(resolved))
  }

  return tools
}
