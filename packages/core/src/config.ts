import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TEMPLATES: Record<string, object> = {
  'providers.json': {
    providers: [],
    _comment: 'Add LLM provider configurations here. Each provider needs: name, type, baseUrl, apiKey, defaultModel',
  },
  'settings.json': {
    sessionTimeoutMinutes: 30,
    sessionSummaryProviderId: '',
    language: 'en',
    timezone: 'UTC',
    thinkingLevel: 'off',
    heartbeat: {
      intervalMinutes: 5,
      fallbackTrigger: 'down',
      failuresBeforeFallback: 1,
      recoveryCheckIntervalMinutes: 1,
      successesBeforeRecovery: 3,
      notifications: {
        healthyToDegraded: false,
        degradedToHealthy: false,
        degradedToDown: true,
        healthyToDown: true,
        downToFallback: true,
        fallbackToHealthy: true,
      },
    },
    batchingDelayMs: 2500,
    uploads: {
      retentionDays: 30,
    },
    tokenPriceTable: {
      'gpt-4o': { input: 2.5, output: 10 },
      'gpt-4o-mini': { input: 0.15, output: 0.6 },
      'claude-3-5-sonnet-20241022': { input: 3, output: 15 },
      'claude-sonnet-4-20250514': { input: 3, output: 15 }
    },
    memoryConsolidation: {
      enabled: true,
      runAtHour: 3,
      lookbackDays: 3,
      providerId: '',
    },
    factExtraction: {
      enabled: true,
      providerId: '',
      minSessionMessages: 3,
    },
    agentHeartbeat: {
      enabled: false,
      intervalMinutes: 60,
      nightMode: {
        enabled: true,
        startHour: 23,
        endHour: 8,
      },
    },
    builtinTools: {
      webSearch: { enabled: true, provider: 'duckduckgo' },
      webFetch: { enabled: true },
    },
    braveSearchApiKey: '',
    searxngUrl: '',
    tasks: {
      defaultProvider: '',
      maxDurationMinutes: 60,
      telegramDelivery: 'auto',
      loopDetection: {
        enabled: true,
        method: 'systematic',
        maxConsecutiveFailures: 3,
        smartProvider: '',
        smartCheckInterval: 5,
      },
      statusUpdates: {
        enabled: false,
        intervalMinutes: 10,
      },
      backgroundThinkingLevel: 'off',
    },
  },
  'skills.json': {
    skills: [],
  },
  'telegram.json': {
    enabled: false,
    botToken: '',
    adminUserIds: [],
    pollingMode: true,
    webhookUrl: '',
    batchingDelayMs: 2500,
  },
}

export function getConfigDir(): string {
  return path.join(process.env.DATA_DIR ?? '/data', 'config')
}

// =============================================================================
// Project asset paths (shipped with the source tree / Docker image)
//
// In Docker: WORKDIR /app + `COPY . .` → README.md / docs/ / agent_docs/ live
//   under /app/.
// In dev (tsx, tests): we walk up from this file's directory until we find a
//   package.json that declares `workspaces` — that's the monorepo root.
// Override via env var OPENAGENT_PROJECT_DIR for unusual deployments.
// =============================================================================

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let _cachedProjectRoot: string | undefined

/**
 * Resolve the Axiom monorepo root directory.
 *
 * Resolution order:
 *   1. `process.env.AXIOM_PROJECT_DIR` (with `~` / `~/` expansion)
 *   2. Walk up from this module's directory looking for a `package.json`
 *      that has a `workspaces` field (the monorepo root)
 *   3. Fall back to `process.cwd()` (last resort, dev shells)
 *
 * Result is cached for the process lifetime.
 */
export function getProjectRootDir(): string {
  if (_cachedProjectRoot) return _cachedProjectRoot

  const envDir = process.env.AXIOM_PROJECT_DIR
  if (envDir) {
    let resolved = envDir
    if (envDir === '~') resolved = process.env.HOME ?? envDir
    else if (envDir.startsWith('~/')) resolved = path.join(process.env.HOME ?? '', envDir.slice(2))
    _cachedProjectRoot = resolved
    return resolved
  }

  let dir = __dirname
  while (dir !== path.dirname(dir)) {
    const pkgPath = path.join(dir, 'package.json')
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { workspaces?: unknown }
        if (pkg.workspaces) {
          _cachedProjectRoot = dir
          return dir
        }
      } catch {
        // ignore unreadable / invalid package.json and keep walking up
      }
    }
    dir = path.dirname(dir)
  }

  _cachedProjectRoot = process.cwd()
  return _cachedProjectRoot
}

/** Absolute path to the repo's main README.md. */
export function getReadmePath(): string {
  return path.join(getProjectRootDir(), 'README.md')
}

/** Absolute path to the user-facing `docs/` directory (VitePress source). */
export function getDocsPath(): string {
  return path.join(getProjectRootDir(), 'docs')
}

/** Absolute path to the contributor-facing `agent_docs/` directory. */
export function getAgentDocsPath(): string {
  return path.join(getProjectRootDir(), 'agent_docs')
}

export function loadConfig<T = unknown>(filename: string): T {
  const configDir = getConfigDir()
  const filePath = path.join(configDir, filename)

  if (!fs.existsSync(filePath)) {
    ensureConfigTemplates(configDir)
  }

  const content = fs.readFileSync(filePath, 'utf-8')
  return JSON.parse(content) as T
}

export function ensureConfigTemplates(configDir?: string): void {
  const dir = configDir ?? getConfigDir()

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  for (const [filename, template] of Object.entries(TEMPLATES)) {
    const filePath = path.join(dir, filename)
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(template, null, 2) + '\n', 'utf-8')
    }
  }
}
