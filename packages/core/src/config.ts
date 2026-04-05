import fs from 'node:fs'
import path from 'node:path'

const TEMPLATES: Record<string, object> = {
  'providers.json': {
    providers: [],
    _comment: 'Add LLM provider configurations here. Each provider needs: name, type, baseUrl, apiKey, defaultModel',
  },
  'settings.json': {
    sessionTimeoutMinutes: 15,
    language: 'en',
    timezone: 'UTC',
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
    uploadRetentionDays: 30,
    tokenPriceTable: {
      'gpt-4o': { input: 2.5, output: 10 },
      'gpt-4o-mini': { input: 0.15, output: 0.6 },
      'claude-3-5-sonnet-20241022': { input: 3, output: 15 },
      'claude-sonnet-4-20250514': { input: 3, output: 15 }
    },
    memoryConsolidation: {
      enabled: false,
      runAtHour: 3,
      lookbackDays: 3,
      providerId: '',
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
      statusUpdateIntervalMinutes: 10,
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
