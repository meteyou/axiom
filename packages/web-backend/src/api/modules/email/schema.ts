import type { CreateEmailAccountInput, UpdateEmailAccountInput } from '@axiom/core'

interface ParseSuccess<T> {
  ok: true
  value: T
}

interface ParseFailure {
  ok: false
  error: string
}

export type ParseResult<T> = ParseSuccess<T> | ParseFailure

const BOOLEAN_FIELDS = [
  'allowSelfSignedCert',
  'canSend',
  'canManage',
  'canDelete',
  'canDownloadAttachments',
  'requireApproval',
  'appendToSentFolder',
  'allowHtml',
] as const

const OPTIONAL_STRING_FIELDS = ['displayName', 'signature', 'attachmentDownloadPath'] as const

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function parsePort(value: unknown, field: string): ParseResult<number> {
  const port = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: `${field} must be an integer between 1 and 65535` }
  }
  return { ok: true, value: port }
}

function parseStringList(value: unknown, field: string): ParseResult<string[]> {
  if (!Array.isArray(value)) return { ok: false, error: `${field} must be an array of strings` }
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') return { ok: false, error: `${field} must be an array of strings` }
    const trimmed = entry.trim()
    if (trimmed) out.push(trimmed)
  }
  return { ok: true, value: out }
}

function parseAllowlist(value: unknown): ParseResult<{ addresses: string[]; domains: string[] }> {
  const record = toRecord(value)
  const addresses = parseStringList(record.addresses ?? [], 'allowlist.addresses')
  if (!addresses.ok) return addresses
  const domains = parseStringList(record.domains ?? [], 'allowlist.domains')
  if (!domains.ok) return domains
  return { ok: true, value: { addresses: addresses.value, domains: domains.value } }
}

function applyOptionalFields(
  body: Record<string, unknown>,
  out: UpdateEmailAccountInput,
): ParseFailure | null {
  for (const field of BOOLEAN_FIELDS) {
    const raw = body[field]
    if (raw === undefined) continue
    if (typeof raw !== 'boolean') return { ok: false, error: `${field} must be a boolean` }
    out[field] = raw
  }

  for (const field of OPTIONAL_STRING_FIELDS) {
    const raw = body[field]
    if (raw === undefined) continue
    if (typeof raw !== 'string') return { ok: false, error: `${field} must be a string` }
    out[field] = raw
  }

  if (body.allowlist !== undefined) {
    const allowlist = parseAllowlist(body.allowlist)
    if (!allowlist.ok) return allowlist
    out.allowlist = allowlist.value
  }

  return null
}

export function parseCreateEmailAccountBody(body: unknown): ParseResult<CreateEmailAccountInput> {
  const b = toRecord(body)

  const requiredStrings = ['name', 'imapHost', 'imapUser', 'smtpHost', 'smtpUser'] as const
  const values: Record<string, string> = {}
  for (const field of requiredStrings) {
    const raw = b[field]
    if (typeof raw !== 'string' || !raw.trim()) {
      return { ok: false, error: `${field} is required` }
    }
    values[field] = raw.trim()
  }

  const imapPort = parsePort(b.imapPort, 'imapPort')
  if (!imapPort.ok) return imapPort
  const smtpPort = parsePort(b.smtpPort, 'smtpPort')
  if (!smtpPort.ok) return smtpPort

  if (b.imapPassword !== undefined && typeof b.imapPassword !== 'string') {
    return { ok: false, error: 'imapPassword must be a string' }
  }
  if (b.smtpPassword !== undefined && typeof b.smtpPassword !== 'string') {
    return { ok: false, error: 'smtpPassword must be a string' }
  }

  const out: CreateEmailAccountInput = {
    name: values.name!,
    imapHost: values.imapHost!,
    imapPort: imapPort.value,
    imapUser: values.imapUser!,
    smtpHost: values.smtpHost!,
    smtpPort: smtpPort.value,
    smtpUser: values.smtpUser!,
  }

  if (typeof b.imapPassword === 'string') out.imapPassword = b.imapPassword
  if (typeof b.smtpPassword === 'string') out.smtpPassword = b.smtpPassword

  const failure = applyOptionalFields(b, out)
  if (failure) return failure

  return { ok: true, value: out }
}

export function parseUpdateEmailAccountBody(body: unknown): ParseResult<UpdateEmailAccountInput> {
  const b = toRecord(body)
  const out: UpdateEmailAccountInput = {}

  for (const field of ['name', 'imapHost', 'imapUser', 'smtpHost', 'smtpUser'] as const) {
    const raw = b[field]
    if (raw === undefined) continue
    if (typeof raw !== 'string' || !raw.trim()) {
      return { ok: false, error: `${field} must be a non-empty string` }
    }
    out[field] = raw.trim()
  }

  for (const field of ['imapPort', 'smtpPort'] as const) {
    if (b[field] === undefined) continue
    const port = parsePort(b[field], field)
    if (!port.ok) return port
    out[field] = port.value
  }

  for (const field of ['imapPassword', 'smtpPassword'] as const) {
    const raw = b[field]
    if (raw === undefined) continue
    if (typeof raw !== 'string') return { ok: false, error: `${field} must be a string` }
    if (raw) out[field] = raw
  }

  const failure = applyOptionalFields(b, out)
  if (failure) return failure

  return { ok: true, value: out }
}
