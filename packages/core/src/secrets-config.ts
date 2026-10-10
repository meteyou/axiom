import fs from 'node:fs'
import path from 'node:path'
import { getConfigDir } from './config.js'
import { encrypt, decrypt, isEncrypted, maskApiKey } from './encryption.js'

/**
 * The secrets.json file structure
 */
export interface SecretsFile {
  env: Record<string, string> // Values are encrypted at rest
}

const SECRETS_FILENAME = 'secrets.json'

/** Global secrets live in the config dir; a user's personal secrets in their personal folder. */
function secretsFilePath(userDir?: string | null): string {
  return path.join(userDir ?? getConfigDir(), SECRETS_FILENAME)
}

/**
 * Load secrets.json from the config directory, or from a user's personal folder
 */
export function loadSecrets(userDir?: string | null): SecretsFile {
  const filePath = secretsFilePath(userDir)

  if (!fs.existsSync(filePath)) {
    return { env: {} }
  }

  const content = fs.readFileSync(filePath, 'utf-8')
  return JSON.parse(content) as SecretsFile
}

/**
 * Save secrets.json to config directory
 */
export function saveSecrets(data: SecretsFile, userDir?: string | null): void {
  const filePath = secretsFilePath(userDir)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
}

/**
 * Get all secrets with values decrypted (for runtime use)
 */
export function loadSecretsDecrypted(userDir?: string | null): Record<string, string> {
  const file = loadSecrets(userDir)
  const decrypted: Record<string, string> = {}
  for (const [key, value] of Object.entries(file.env)) {
    if (value && isEncrypted(value)) {
      try {
        decrypted[key] = decrypt(value)
      } catch {
        // Skip secrets that can't be decrypted (e.g. ENCRYPTION_KEY changed)
        console.warn(`[axiom] Failed to decrypt secret "${key}", skipping`)
      }
    } else {
      decrypted[key] = value
    }
  }
  return decrypted
}

/**
 * Get secrets in masked form for API responses (never return real values)
 */
export function loadSecretsMasked(userDir?: string | null): Array<{ key: string; configured: boolean; maskedValue: string }> {
  const file = loadSecrets(userDir)
  const result: Array<{ key: string; configured: boolean; maskedValue: string }> = []
  for (const [key, encryptedValue] of Object.entries(file.env)) {
    if (!encryptedValue) {
      result.push({ key, configured: false, maskedValue: '' })
      continue
    }
    try {
      const decrypted = isEncrypted(encryptedValue) ? decrypt(encryptedValue) : encryptedValue
      result.push({
        key,
        configured: true,
        maskedValue: maskApiKey(decrypted),
      })
    } catch {
      result.push({ key, configured: true, maskedValue: '••••••••' })
    }
  }
  return result
}

/**
 * Set a secret (encrypts and saves)
 */
export function setSecret(key: string, value: string, userDir?: string | null): void {
  const file = loadSecrets(userDir)
  file.env[key] = value ? encrypt(value) : ''
  saveSecrets(file, userDir)
}

/**
 * Set multiple secrets at once (encrypts and saves)
 */
export function setSecrets(secrets: Record<string, string>, userDir?: string | null): void {
  const file = loadSecrets(userDir)
  for (const [key, value] of Object.entries(secrets)) {
    file.env[key] = value ? encrypt(value) : ''
  }
  saveSecrets(file, userDir)
}

/**
 * Delete a secret
 */
export function deleteSecret(key: string, userDir?: string | null): void {
  const file = loadSecrets(userDir)
  delete file.env[key]
  saveSecrets(file, userDir)
}

/** Keys currently managed by injectSecretsIntoEnv — used to clean up removed secrets */
let _injectedKeys: Set<string> = new Set()

/**
 * Inject all decrypted secrets into process.env
 * Call this at startup and after secret changes.
 * Removes env vars for secrets that were previously injected but no longer exist.
 */
export function injectSecretsIntoEnv(): void {
  const decrypted = loadSecretsDecrypted()
  const currentKeys = new Set<string>()

  for (const [key, value] of Object.entries(decrypted)) {
    if (value) {
      process.env[key] = value
      currentKeys.add(key)
    }
  }

  // Clean up keys that were previously injected but are no longer in secrets
  for (const key of _injectedKeys) {
    if (!currentKeys.has(key)) {
      delete process.env[key]
    }
  }

  _injectedKeys = currentKeys

  if (currentKeys.size > 0) {
    console.log(`[axiom] Injected ${currentKeys.size} secret(s) into environment`)
  }
}
