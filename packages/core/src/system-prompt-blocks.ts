import path from 'node:path'
import type { UserPaths } from './user-scope.js'

export interface SystemRulesOptions {
  multiUser: boolean
  isAdmin: boolean
  /** `task` renders the rules for background task agents instead of the main chat agent. */
  variant?: 'chat' | 'task'
}

export function buildSystemRules(options: SystemRulesOptions): string {
  const rules = [
    '- Never use OS-level schedulers (system crontab, launchd, at, or shell-spawned long-running processes via nohup / & / background loops). Always use the built-in task and cronjob tools instead.',
  ]
  if (options.variant === 'task') {
    rules.push('- Do not create working directories elsewhere (e.g. /tmp). Use your workspace (see <paths>) for cloning repos, creating files and all other file operations.')
  } else {
    rules.push('- When you receive a <task_injection> block (a background-task result with status="completed|failed|question"), load the tasks-and-cronjobs skill before responding to it.')
  }
  if (options.multiUser) {
    rules.push(
      '- This instance has several users. Your profile, daily notes, workspace and chat history are private to you; the wiki, MEMORY.md and skills are shared with everyone.',
      '- Never write personal information about a user (health, finances, relationships, private routines, contact details) into the wiki, MEMORY.md, sources or skills. Keep it in the user\'s profile.',
      '- Wiki pages, MEMORY.md entries and skills must contain general knowledge that is safe for every user to read.',
    )
    if (!options.isAdmin) {
      rules.push('- Global configuration (SOUL.md, AGENTS.md, TASKS.md, CONSOLIDATION.md, providers and global settings) is managed by the admin. Refuse requests to change it and tell the user to ask the admin.')
    }
  }
  return `<system_rules>\n${rules.join('\n')}\n</system_rules>`
}

export interface PathsBlockOptions {
  memoryDir: string
  configDir: string
  workspaceDir: string
  agentSkillsDir: string
  readmePath: string
  docsDir: string
  /**
   * Date key (YYYY-MM-DD) that adds today's daily file. Only for prompts built
   * per run: a session prompt is frozen and would point at yesterday's file
   * after midnight.
   */
  today?: string
  isAdmin: boolean
  /** Personal paths of a non-bootstrap user; null keeps the legacy single-user layout. */
  personalPaths: UserPaths | null
  /** Profile owner in the legacy layout; without it only the profiles directory is listed. */
  legacyUsername?: string
}

export function buildPathsBlock(options: PathsBlockOptions): string {
  const { memoryDir, configDir, today, personalPaths } = options
  const groups: string[] = []
  const todayLine = (label: string, dailyDir: string) =>
    today ? `\n- ${label}: ${path.join(dailyDir, `${today}.md`)}` : ''

  if (personalPaths) {
    groups.push(`Your personal files:
- Workspace (default directory for shell and relative file paths): ${personalPaths.workspace}
- Your profile: ${personalPaths.profile}
- Your daily notes directory (one file per day, YYYY-MM-DD.md): ${personalPaths.dailyDir}/${todayLine('Your daily file for today', personalPaths.dailyDir)}`)
    groups.push(`Shared files:
- MEMORY.md (general lessons only): ${path.join(memoryDir, 'MEMORY.md')}
- SOUL.md${options.isAdmin ? '' : ' (admin-managed)'}: ${path.join(memoryDir, 'SOUL.md')}
- Wiki pages directory: ${path.join(memoryDir, 'wiki/')}
- Sources directory (immutable raw material): ${path.join(memoryDir, 'sources/')}
- Agent skills directory: ${options.agentSkillsDir}/`)
  } else {
    const profileLine = options.legacyUsername
      ? `- User profile: ${path.join(memoryDir, 'users', `${options.legacyUsername}.md`)}`
      : `- User profiles directory: ${path.join(memoryDir, 'users/')}`
    groups.push(`Files:
- Workspace (default directory for shell and relative file paths): ${options.workspaceDir}
${profileLine}
- Daily notes directory (one file per day, YYYY-MM-DD.md): ${path.join(memoryDir, 'daily/')}${todayLine("Today's daily file", path.join(memoryDir, 'daily'))}
- MEMORY.md: ${path.join(memoryDir, 'MEMORY.md')}
- SOUL.md: ${path.join(memoryDir, 'SOUL.md')}
- Wiki pages directory: ${path.join(memoryDir, 'wiki/')}
- Sources directory (immutable raw material): ${path.join(memoryDir, 'sources/')}
- Agent skills directory: ${options.agentSkillsDir}/`)
  }

  if (options.isAdmin) {
    groups.push(`Config files:
- AGENTS.md (agent rules): ${path.join(configDir, 'AGENTS.md')}
- HEARTBEAT.md (heartbeat tasks): ${path.join(configDir, 'HEARTBEAT.md')}
- CONSOLIDATION.md (consolidation rules): ${path.join(configDir, 'CONSOLIDATION.md')}
- TASKS.md (background task guidelines): ${path.join(configDir, 'TASKS.md')}`)
  }

  groups.push(`Axiom docs (read-only):
- README: ${options.readmePath}
- Concepts: ${path.join(options.docsDir, 'concepts/')}
- Guide: ${path.join(options.docsDir, 'guide/')}
- Reference: ${path.join(options.docsDir, 'reference/')}`)

  return `<paths>\n${groups.join('\n\n')}\n</paths>`
}
