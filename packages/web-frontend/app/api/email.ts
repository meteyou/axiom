export interface EmailAllowlist {
  addresses: string[]
  domains: string[]
}

export type EmailFolderMode = 'all' | 'selected'

export interface EmailFolder {
  path: string
  name: string
  delimiter: string
  specialUse?: string
  subscribed: boolean
}

export interface EmailConnectionPayload {
  accountId?: string
  imapHost?: string
  imapPort?: number
  imapUser?: string
  imapPassword?: string
  smtpHost?: string
  smtpPort?: number
  smtpUser?: string
  smtpPassword?: string
  allowSelfSignedCert?: boolean
}

export interface EmailConnectionTestResult {
  ok: boolean
  imap: { ok: boolean; error?: string }
  smtp: { ok: boolean; error?: string }
}

export interface EmailAccount {
  id: string
  name: string
  imapHost: string
  imapPort: number
  imapUser: string
  smtpHost: string
  smtpPort: number
  smtpUser: string
  imapPasswordSet: boolean
  smtpPasswordSet: boolean
  allowSelfSignedCert: boolean
  canSend: boolean
  canManage: boolean
  canDelete: boolean
  canDownloadAttachments: boolean
  requireApproval: boolean
  allowlist: EmailAllowlist
  folderMode: EmailFolderMode
  allowedFolders: string[]
  displayName: string
  signature: string
  appendToSentFolder: boolean
  allowHtml: boolean
  attachmentDownloadPath: string
  createdAt: string
  updatedAt: string
}

export interface EmailAccountPayload {
  name: string
  imapHost: string
  imapPort: number
  imapUser: string
  imapPassword?: string
  smtpHost: string
  smtpPort: number
  smtpUser: string
  smtpPassword?: string
  allowSelfSignedCert: boolean
  canSend: boolean
  canManage: boolean
  canDelete: boolean
  canDownloadAttachments: boolean
  requireApproval: boolean
  allowlist: EmailAllowlist
  folderMode: EmailFolderMode
  allowedFolders: string[]
  displayName: string
  signature: string
  appendToSentFolder: boolean
  allowHtml: boolean
  attachmentDownloadPath: string
}

export function useEmailApi() {
  const { apiFetch } = useApi()

  const listAccounts = () =>
    apiFetch<{ accounts: EmailAccount[] }>('/api/email/accounts')

  const createAccount = (payload: EmailAccountPayload) =>
    apiFetch<{ account: EmailAccount }>('/api/email/accounts', {
      method: 'POST',
      body: JSON.stringify(payload),
    })

  const updateAccount = (id: string, payload: Partial<EmailAccountPayload>) =>
    apiFetch<{ account: EmailAccount }>(`/api/email/accounts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    })

  const deleteAccount = (id: string) =>
    apiFetch<{ success: boolean }>(`/api/email/accounts/${id}`, { method: 'DELETE' })

  const testConnection = (payload: EmailConnectionPayload) =>
    apiFetch<EmailConnectionTestResult>('/api/email/accounts/test-connection', {
      method: 'POST',
      body: JSON.stringify(payload),
    })

  const listFolders = (payload: EmailConnectionPayload) =>
    apiFetch<{ folders: EmailFolder[] }>('/api/email/accounts/folders', {
      method: 'POST',
      body: JSON.stringify(payload),
    })

  return { listAccounts, createAccount, updateAccount, deleteAccount, testConnection, listFolders }
}
