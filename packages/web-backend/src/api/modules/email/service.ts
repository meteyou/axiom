import {
  createEmailAccount,
  createEmailClient,
  deleteEmailAccount,
  getEmailAccount,
  getEmailAccountDecrypted,
  listEmailAccounts,
  updateEmailAccount,
} from '@axiom/core'
import type {
  CreateEmailAccountInput,
  EmailClientAccount,
  EmailConnectionTestResult,
  EmailFolder,
  SafeEmailAccount,
  UpdateEmailAccountInput,
} from '@axiom/core'

/**
 * Connection settings for an account that may not be persisted yet — the form
 * dialog tests and lists folders before the account is saved.
 */
export interface EmailConnectionInput extends Partial<EmailClientAccount> {
  accountId?: string
}

export class EmailAccountNotFoundError extends Error {
  constructor(id: string) {
    super(`Email account not found: ${id}`)
  }
}

export class EmailAccountConflictError extends Error {}

export class EmailConnectionInputError extends Error {}

export interface EmailService {
  listAccounts: () => SafeEmailAccount[]
  getAccount: (id: string) => SafeEmailAccount
  createAccount: (input: CreateEmailAccountInput) => SafeEmailAccount
  updateAccount: (id: string, input: UpdateEmailAccountInput) => SafeEmailAccount
  deleteAccount: (id: string) => void
  testConnection: (input: EmailConnectionInput) => Promise<EmailConnectionTestResult>
  listFolders: (input: EmailConnectionInput) => Promise<EmailFolder[]>
}

/**
 * Merges submitted form values over the stored account so an unchanged password
 * field does not have to be re-entered just to test the connection.
 */
function resolveConnection(input: EmailConnectionInput): EmailClientAccount {
  const stored = input.accountId ? getEmailAccountDecrypted(input.accountId) : null
  if (input.accountId && !stored) throw new EmailAccountNotFoundError(input.accountId)

  const account: EmailClientAccount = {
    imapHost: input.imapHost ?? stored?.imapHost ?? '',
    imapPort: input.imapPort ?? stored?.imapPort ?? 993,
    imapUser: input.imapUser ?? stored?.imapUser ?? '',
    imapPassword: input.imapPassword || stored?.imapPassword || '',
    smtpHost: input.smtpHost ?? stored?.smtpHost ?? '',
    smtpPort: input.smtpPort ?? stored?.smtpPort ?? 465,
    smtpUser: input.smtpUser ?? stored?.smtpUser ?? '',
    smtpPassword: input.smtpPassword || stored?.smtpPassword || '',
    allowSelfSignedCert: input.allowSelfSignedCert ?? stored?.allowSelfSignedCert ?? false,
  }

  if (!account.imapHost || !account.imapUser) {
    throw new EmailConnectionInputError('IMAP host and user are required')
  }

  return account
}

export function createEmailService(): EmailService {
  const client = createEmailClient()

  return {
    listAccounts() {
      return listEmailAccounts()
    },

    getAccount(id) {
      const account = getEmailAccount(id)
      if (!account) throw new EmailAccountNotFoundError(id)
      return account
    },

    createAccount(input) {
      try {
        return createEmailAccount(input)
      } catch (err) {
        const message = (err as Error).message
        if (message.includes('already exists')) throw new EmailAccountConflictError(message)
        throw err
      }
    },

    updateAccount(id, input) {
      if (!getEmailAccount(id)) throw new EmailAccountNotFoundError(id)
      try {
        return updateEmailAccount(id, input)
      } catch (err) {
        const message = (err as Error).message
        if (message.includes('already exists')) throw new EmailAccountConflictError(message)
        throw err
      }
    },

    deleteAccount(id) {
      if (!deleteEmailAccount(id)) throw new EmailAccountNotFoundError(id)
    },

    testConnection(input) {
      return client.testConnection(resolveConnection(input))
    },

    listFolders(input) {
      return client.listFolders(resolveConnection(input))
    },
  }
}
