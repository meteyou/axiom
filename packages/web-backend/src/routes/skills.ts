import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import multer from 'multer'
import {
  loadSkills,
  addSkill,
  updateSkill,
  deleteSkill as deleteSkillConfig,
  getSkill,
  installSkill,
  installSkillFromZip,
  loadConfig,
  ensureConfigTemplates,
  getConfigDir,
  encrypt,
  maskApiKey,
  listAgentSkills,
} from '@openagent/core'
import type { AgentCore, SkillConfig, BuiltinToolsConfig } from '@openagent/core'
import { jwtMiddleware } from '../auth.js'
import type { AuthenticatedRequest } from '../auth.js'

// Multer configured for in-memory storage, max 50 MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    if (ext === '.zip' || ext === '.skill') {
      cb(null, true)
    } else {
      cb(new Error('Only .zip and .skill files are allowed'))
    }
  },
})

export interface SkillsRouterOptions {
  getAgentCore?: () => AgentCore | null
}

/**
 * Settings file shape (only the parts we care about)
 */
interface SettingsWithBuiltinTools {
  builtinTools?: BuiltinToolsConfig
  braveSearchApiKey?: string
  searxngUrl?: string
  [key: string]: unknown
}

/**
 * Strip envValues from a skill config for safe API response
 */
function sanitizeSkill(skill: SkillConfig): Omit<SkillConfig, 'envValues'> {
  const { envValues: _envValues, ...rest } = skill
  return rest
}

export function createSkillsRouter(options: SkillsRouterOptions = {}): Router {
  const router = Router()
  const getAgentCore = options.getAgentCore ?? (() => null)

  // All routes require auth
  router.use(jwtMiddleware)
  router.use((req: AuthenticatedRequest, res, next) => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' })
      return
    }
    next()
  })

  // ─── Installed Skills (static paths first) ──────────────────────────────────

  /**
   * GET /api/skills — List all installed skills (secrets masked)
   */
  router.get('/', (_req, res) => {
    try {
      const file = loadSkills()
      const skills = file.skills.map(sanitizeSkill)
      res.json({ skills })
    } catch (err) {
      res.status(500).json({ error: `Failed to load skills: ${(err as Error).message}` })
    }
  })

  /**
   * POST /api/skills/install — Install a skill from OpenClaw shorthand or GitHub URL
   * Body: { "source": "owner/name" } or { "source": "https://github.com/..." }
   */
  router.post('/install', async (req: AuthenticatedRequest, res) => {
    const { source } = req.body as { source?: string }

    if (!source || typeof source !== 'string' || !source.trim()) {
      res.status(400).json({ error: 'source is required (owner/name or GitHub URL)' })
      return
    }

    try {
      const result = await installSkill(source.trim())

      // Register in skills.json
      const skill = addSkill({
        id: `${result.source.owner}/${result.source.name}`,
        owner: result.source.owner,
        name: result.source.name,
        description: result.parsed.description,
        source: result.source.type,
        sourceUrl: result.source.sourceUrl,
        path: result.installPath,
        envKeys: result.parsed.envKeys,
        emoji: result.parsed.emoji,
      })

      // Refresh agent skills
      getAgentCore()?.refreshSkills()

      res.status(201).json({ skill: sanitizeSkill(skill) })
    } catch (err) {
      res.status(400).json({ error: `Failed to install skill: ${(err as Error).message}` })
    }
  })

  /**
   * POST /api/skills/upload — Install a skill from a .zip or .skill file upload
   * Multipart form-data with field "file"
   */
  router.post('/upload', upload.single('file'), (req: AuthenticatedRequest, res) => {
    const file = (req as AuthenticatedRequest & { file?: Express.Multer.File }).file
    if (!file) {
      res.status(400).json({ error: 'No file uploaded. Send a .zip or .skill file as "file" field.' })
      return
    }

    try {
      const result = installSkillFromZip(file.buffer, file.originalname)

      // Register in skills.json
      const skillId = `${result.owner}/${result.name}`
      const skill = addSkill({
        id: skillId,
        owner: result.owner,
        name: result.name,
        description: result.parsed.description,
        source: 'upload',
        sourceUrl: '',
        path: result.installPath,
        envKeys: result.parsed.envKeys,
        emoji: result.parsed.emoji,
      })

      // Refresh agent skills
      getAgentCore()?.refreshSkills()

      res.status(201).json({ skill: sanitizeSkill(skill) })
    } catch (err) {
      res.status(400).json({ error: `Failed to install skill from file: ${(err as Error).message}` })
    }
  })

  // ─── Agent Skills (self-created, read-only listing) ─────────────────────────

  /**
   * GET /api/skills/agent — List all agent-created skills.
   *
   * Annotates each entry with `missingEnvVars` (subset of `requiredEnvVars`
   * that is not currently set in the server's environment) so the frontend
   * can surface a warning badge without needing access to process.env.
   */
  router.get('/agent', (_req, res) => {
    try {
      const skills = listAgentSkills().map(s => {
        const missingEnvVars = (s.requiredEnvVars ?? []).filter(v => !process.env[v])
        return { ...s, missingEnvVars }
      })
      res.json({ skills })
    } catch (err) {
      res.status(500).json({ error: `Failed to list agent skills: ${(err as Error).message}` })
    }
  })

  // ─── Built-in Tools (must be before /:owner/:name to avoid conflicts) ──────

  /**
   * GET /api/skills/builtin — Get built-in tools config
   */
  router.get('/builtin', (_req, res) => {
    try {
      ensureConfigTemplates()
      const settings = loadConfig<SettingsWithBuiltinTools>('settings.json')

      const builtinTools = settings.builtinTools ?? {
        webSearch: { enabled: true, provider: 'duckduckgo' },
        webFetch: { enabled: true },
      }

      // Read braveSearchApiKey from builtinTools.webSearch (preferred) or top-level (legacy)
      const rawApiKey = builtinTools.webSearch?.braveSearchApiKey ?? settings.braveSearchApiKey ?? ''
      const maskedApiKey = rawApiKey ? maskApiKey(rawApiKey) : ''

      // Read searxngUrl from builtinTools.webSearch (preferred) or top-level (legacy)
      const resolvedSearxngUrl = builtinTools.webSearch?.searxngUrl ?? settings.searxngUrl ?? ''

      res.json({
        builtinTools,
        braveSearchApiKey: maskedApiKey,
        searxngUrl: resolvedSearxngUrl,
      })
    } catch (err) {
      res.status(500).json({ error: `Failed to load built-in tools config: ${(err as Error).message}` })
    }
  })

  /**
   * PATCH /api/skills/builtin — Update built-in tools config
   * Body: partial builtinTools object + optional braveSearchApiKey + searxngUrl
   */
  router.patch('/builtin', (req: AuthenticatedRequest, res) => {
    const body = req.body as {
      builtinTools?: Partial<BuiltinToolsConfig>
      braveSearchApiKey?: string
      searxngUrl?: string
    }

    try {
      ensureConfigTemplates()
      const configDir = getConfigDir()
      const settingsPath = path.join(configDir, 'settings.json')
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as SettingsWithBuiltinTools

      // Merge builtinTools
      if (body.builtinTools) {
        const existing = settings.builtinTools ?? {
          webSearch: { enabled: true, provider: 'duckduckgo' },
          webFetch: { enabled: true },
        }

        if (body.builtinTools.webSearch) {
          existing.webSearch = { ...existing.webSearch, ...body.builtinTools.webSearch }
        }
        if (body.builtinTools.webFetch) {
          existing.webFetch = { ...existing.webFetch, ...body.builtinTools.webFetch }
        }

        settings.builtinTools = existing
      }

      // Encrypt and store braveSearchApiKey — write into builtinTools.webSearch
      // so createBuiltinWebTools() picks it up, plus top-level for API response
      if (body.braveSearchApiKey !== undefined) {
        const encrypted = body.braveSearchApiKey ? encrypt(body.braveSearchApiKey) : ''
        settings.braveSearchApiKey = encrypted
        if (!settings.builtinTools) settings.builtinTools = {}
        if (!settings.builtinTools.webSearch) settings.builtinTools.webSearch = { enabled: true, provider: 'duckduckgo' }
        settings.builtinTools.webSearch.braveSearchApiKey = encrypted
      }

      // Store searxngUrl — write into builtinTools.webSearch + top-level
      if (body.searxngUrl !== undefined) {
        settings.searxngUrl = body.searxngUrl
        if (!settings.builtinTools) settings.builtinTools = {}
        if (!settings.builtinTools.webSearch) settings.builtinTools.webSearch = { enabled: true, provider: 'duckduckgo' }
        settings.builtinTools.webSearch.searxngUrl = body.searxngUrl
      }

      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8')

      // Refresh agent tools (skills + built-in tools)
      getAgentCore()?.refreshSkills()

      // Mask API key in response — read from builtinTools.webSearch (canonical location)
      const rawKey = settings.builtinTools?.webSearch?.braveSearchApiKey ?? settings.braveSearchApiKey ?? ''
      const maskedApiKey = rawKey ? maskApiKey(rawKey) : ''

      res.json({
        message: 'Built-in tools config updated',
        builtinTools: settings.builtinTools,
        braveSearchApiKey: maskedApiKey,
        searxngUrl: settings.builtinTools?.webSearch?.searxngUrl ?? settings.searxngUrl ?? '',
      })
    } catch (err) {
      res.status(500).json({ error: `Failed to update built-in tools config: ${(err as Error).message}` })
    }
  })

  // ─── Parameterized Skill Routes (after static paths) ────────────────────────

  /**
   * DELETE /api/skills/:owner/:name — Delete an installed skill
   */
  router.delete('/:owner/:name', (req: AuthenticatedRequest, res) => {
    const id = `${req.params.owner}/${req.params.name}`

    try {
      const skill = getSkill(id)
      if (!skill) {
        res.status(404).json({ error: `Skill not found: ${id}` })
        return
      }

      // Remove skill directory from disk
      if (skill.path && fs.existsSync(skill.path)) {
        fs.rmSync(skill.path, { recursive: true, force: true })
      }

      // Remove from skills.json
      deleteSkillConfig(id)

      // Refresh agent skills
      getAgentCore()?.refreshSkills()

      res.json({ message: 'Skill deleted', id })
    } catch (err) {
      res.status(500).json({ error: `Failed to delete skill: ${(err as Error).message}` })
    }
  })

  /**
   * PATCH /api/skills/:owner/:name — Update skill settings
   * Body: { "enabled": true/false } and/or { "envValues": { "KEY": "value" } } and/or { "envKeys": ["KEY"] }
   */
  router.patch('/:owner/:name', (req: AuthenticatedRequest, res) => {
    const id = `${req.params.owner}/${req.params.name}`
    const body = req.body as { enabled?: boolean; envValues?: Record<string, string>; envKeys?: string[] }

    try {
      const existing = getSkill(id)
      if (!existing) {
        res.status(404).json({ error: `Skill not found: ${id}` })
        return
      }

      const updated = updateSkill(id, {
        enabled: body.enabled,
        envValues: body.envValues,
        envKeys: body.envKeys,
      })

      // Refresh agent skills
      getAgentCore()?.refreshSkills()

      res.json({ skill: sanitizeSkill(updated) })
    } catch (err) {
      res.status(500).json({ error: `Failed to update skill: ${(err as Error).message}` })
    }
  })

  return router
}
