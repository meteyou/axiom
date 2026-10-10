import {
  countEmailSendLog,
  createEmailAccount,
  createEmailApprovalService,
  createEmailClient,
  deleteEmailAccount,
  getEmailAccount,
  getEmailAccountDecrypted,
  getEmailSendLogEntry,
  listEmailAccounts,
  listEmailSendLog,
  updateEmailAccount,
} from '@axiom/core'
import type {
  CreateEmailAccountInput,
  Database,
  EmailApprovalDecider,
  EmailApprovalErrorCode,
  EmailApprovalResult,
  EmailClientAccount,
  EmailConnectionTestResult,
  EmailFolder,
  EmailProtocol,
  EmailSendLogEntry,
  ListEmailSendLogOptions,
  SafeEmailAccount,
  UpdateEmailAccountInput,
} from '@axiom/core'

/**
 * Connection settings for an account that may not be persisted yet — the form
 * dialog tests and lists folders before the account is saved.
 */
export interface EmailConnectionInput extends Partial<EmailClientAccount> {
  accountId?: string
  protocol?: EmailProtocol
}

export class EmailAccountNotFoundError extends Error {
  constructor(id: string) {
    super(`Email account not found: ${id}`)
  }
}

export class EmailAccountConflictError extends Error {}

export class EmailForbiddenError extends Error {}

export interface EmailActor {
  userId: number
  role: string
}

export type EmailAccountView = SafeEmailAccount & { ownerUsername: string | null }

export class EmailConnectionInputError extends Error {}

export class EmailSendLogNotFoundError extends Error {
  constructor(id: string) {
    super(`Send log entry not found: ${id}`)
  }
}

/** Carries the log entry so the UI can show the state that actually won. */
export class EmailApprovalError extends Error {
  constructor(
    readonly code: Exclude<EmailApprovalErrorCode, 'not_found' | 'forbidden'>,
    message: string,
    readonly entry: EmailSendLogEntry | null,
  ) {
    super(message)
  }
}

export interface EmailSendLogPage {
  entries: EmailSendLogEntry[]
  total: number
  limit: number
  offset: number
}

export interface EmailServiceOptions {
  db: Database
}

export interface EmailService {
  listAccounts: (actor: EmailActor) => EmailAccountView[]
  getAccount: (actor: EmailActor, id: string) => EmailAccountView
  createAccount: (actor: EmailActor, input: CreateEmailAccountInput) => EmailAccountView
  updateAccount: (actor: EmailActor, id: string, input: UpdateEmailAccountInput) => EmailAccountView
  deleteAccount: (actor: EmailActor, id: string) => void
  testConnection: (actor: EmailActor, input: EmailConnectionInput) => Promise<EmailConnectionTestResult>
  listFolders: (actor: EmailActor, input: EmailConnectionInput) => Promise<EmailFolder[]>
  listSendLog: (actor: EmailActor, options: ListEmailSendLogOptions) => EmailSendLogPage
  getSendLogEntry: (actor: EmailActor, id: string) => EmailSendLogEntry
  approveSendLogEntry: (id: string, decider: EmailApprovalDecider) => Promise<EmailSendLogEntry>
  rejectSendLogEntry: (id: string, decider: EmailApprovalDecider) => Promise<EmailSendLogEntry>
  retrySendLogEntry: (id: string, decider: EmailApprovalDecider) => Promise<EmailSendLogEntry>
}

const isAdmin = (actor: EmailActor) => actor.role === 'admin'

/**
 * Merges submitted form values over the stored account so an unchanged password
 * field does not have to be re-entered just to test the connection.
 */
function resolveConnection(actor: EmailActor, input: EmailConnectionInput): EmailClientAccount {
  const stored = input.accountId ? getEmailAccountDecrypted(input.accountId) : null
  if (input.accountId && (!stored || (stored.ownerUserId !== actor.userId && !isAdmin(actor)))) {
    throw new EmailAccountNotFoundError(input.accountId)
  }
  // The stored passwords are merged in server-side, so even the admin may not
  // probe another user's mailbox with them.
  if (stored && stored.ownerUserId !== actor.userId) {
    throw new EmailForbiddenError('Only the owner can use the stored credentials of this account')
  }

  const account: EmailClientAccount = {
    imapHost: input.imapHost ?? stored?.imapHost ?? '',
    imapPort: input.imapPort ?? stored?.imapPort ?? 993,
    imapUser: input.imapUser ?? stored?.imapUser ?? '',
    imapPassword: input.imapPassword || stored?.imapPassword || '',
    imapSecurity: input.imapSecurity ?? stored?.imapSecurity ?? 'ssl',
    smtpHost: input.smtpHost ?? stored?.smtpHost ?? '',
    smtpPort: input.smtpPort ?? stored?.smtpPort ?? 465,
    smtpUser: input.smtpUser ?? stored?.smtpUser ?? '',
    smtpPassword: input.smtpPassword || stored?.smtpPassword || '',
    smtpSecurity: input.smtpSecurity ?? stored?.smtpSecurity ?? 'ssl',
    allowSelfSignedCert: input.allowSelfSignedCert ?? stored?.allowSelfSignedCert ?? false,
  }

  if (input.protocol === 'smtp') {
    if (!account.smtpHost) throw new EmailConnectionInputError('SMTP host is required')
  } else if (!account.imapHost || !account.imapUser) {
    throw new EmailConnectionInputError('IMAP host and user are required')
  }

  return account
}

export function createEmailService(options: EmailServiceOptions): EmailService {
  const client = createEmailClient()
  const db = options.db
  const approval = createEmailApprovalService({ db })

  function unwrap(id: string, result: EmailApprovalResult): EmailSendLogEntry {
    if (result.ok) return result.entry
    if (result.code === 'not_found') throw new EmailSendLogNotFoundError(id)
    if (result.code === 'forbidden') throw new EmailForbiddenError(result.message)
    throw new EmailApprovalError(result.code, result.message, result.entry)
  }

  function withOwner(account: SafeEmailAccount): EmailAccountView {
    const row = db.prepare('SELECT username FROM users WHERE id = ?').get(account.ownerUserId) as
      | { username: string }
      | undefined
    return { ...account, ownerUsername: row?.username ?? null }
  }

  /** Foreign accounts do not exist for regular users; the admin sees them but must not edit. */
  function visibleAccount(actor: EmailActor, id: string): SafeEmailAccount {
    const account = getEmailAccount(id)
    if (!account || (account.ownerUserId !== actor.userId && !isAdmin(actor))) {
      throw new EmailAccountNotFoundError(id)
    }
    return account
  }

  function visibleEntry(actor: EmailActor, id: string): EmailSendLogEntry {
    const entry = getEmailSendLogEntry(db, id)
    if (!entry || (entry.ownerUserId !== actor.userId && !isAdmin(actor))) {
      throw new EmailSendLogNotFoundError(id)
    }
    return entry
  }

  return {
    listAccounts(actor) {
      return listEmailAccounts(isAdmin(actor) ? {} : { ownerUserId: actor.userId }).map(withOwner)
    },

    getAccount(actor, id) {
      return withOwner(visibleAccount(actor, id))
    },

    createAccount(actor, input) {
      try {
        return withOwner(createEmailAccount(input, actor.userId))
      } catch (err) {
        const message = (err as Error).message
        if (message.includes('already exists')) throw new EmailAccountConflictError(message)
        throw err
      }
    },

    updateAccount(actor, id, input) {
      const account = visibleAccount(actor, id)
      if (account.ownerUserId !== actor.userId) {
        throw new EmailForbiddenError('Only the owner can edit this email account')
      }
      try {
        return withOwner(updateEmailAccount(id, input))
      } catch (err) {
        const message = (err as Error).message
        if (message.includes('already exists')) throw new EmailAccountConflictError(message)
        throw err
      }
    },

    deleteAccount(actor, id) {
      visibleAccount(actor, id)
      if (!deleteEmailAccount(id)) throw new EmailAccountNotFoundError(id)
    },

    testConnection(actor, input) {
      return client.testConnection(resolveConnection(actor, input), input.protocol)
    },

    listFolders(actor, input) {
      return client.listFolders(resolveConnection(actor, input))
    },

    listSendLog(actor, query) {
      const limit = Math.max(1, Math.min(query.limit ?? 50, 500))
      const offset = Math.max(0, query.offset ?? 0)
      const scoped = isAdmin(actor) ? query : { ...query, ownerUserId: actor.userId }
      return {
        entries: listEmailSendLog(db, { ...scoped, limit, offset }),
        total: countEmailSendLog(db, scoped),
        limit,
        offset,
      }
    },

    getSendLogEntry(actor, id) {
      return visibleEntry(actor, id)
    },

    async approveSendLogEntry(id, decider) {
      return unwrap(id, await approval.approve(id, decider))
    },

    async rejectSendLogEntry(id, decider) {
      return unwrap(id, await approval.reject(id, decider))
    },

    async retrySendLogEntry(id, decider) {
      return unwrap(id, await approval.retry(id, decider))
    },
  }
}
