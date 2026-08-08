import {
  createEmailAccount,
  deleteEmailAccount,
  getEmailAccount,
  listEmailAccounts,
  updateEmailAccount,
} from '@axiom/core'
import type { CreateEmailAccountInput, SafeEmailAccount, UpdateEmailAccountInput } from '@axiom/core'

export class EmailAccountNotFoundError extends Error {
  constructor(id: string) {
    super(`Email account not found: ${id}`)
  }
}

export class EmailAccountConflictError extends Error {}

export interface EmailService {
  listAccounts: () => SafeEmailAccount[]
  getAccount: (id: string) => SafeEmailAccount
  createAccount: (input: CreateEmailAccountInput) => SafeEmailAccount
  updateAccount: (id: string, input: UpdateEmailAccountInput) => SafeEmailAccount
  deleteAccount: (id: string) => void
}

export function createEmailService(): EmailService {
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
  }
}
