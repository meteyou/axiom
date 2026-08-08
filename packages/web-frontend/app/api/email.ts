export interface EmailAllowlist {
  addresses: string[]
  domains: string[]
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

  return { listAccounts, createAccount, updateAccount, deleteAccount }
}
