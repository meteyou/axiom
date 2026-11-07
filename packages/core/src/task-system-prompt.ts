import { getAgentSkillsDir } from './agent-skills.js'
import { getConfigDir, getDefaultTimezone, getDocsPath, getReadmePath } from './config.js'
import { formatDateKey, getMemoryDir, readTasksGuidelinesFile } from './memory.js'
import { buildPathsBlock, buildSystemRules } from './system-prompt-blocks.js'
import type { UserScope } from './user-scope.js'
import { getWorkspaceDir } from './workspace.js'

export interface TaskSystemPromptOptions {
  taskPrompt: string
  /** Owner of the task; null on an instance without users (legacy single-user layout). */
  scope: UserScope | null
  multiUser: boolean
  memoryDir?: string
  configDir?: string
  agentSkillsDir?: string
  now?: Date
}

const TASK_OUTPUT_FORMAT = `Your final message MUST follow this exact format:

STATUS: completed | failed | question | silent
SUMMARY:
<your complete, detailed results here — this is the ONLY thing the user will see, so include ALL data, analysis, findings, content, etc. Do NOT write a meta-description of what you did. Instead, write the actual output the user asked for.>

Use STATUS: question only when you are blocked and need the user to answer something specific before you can continue. In that case, the SUMMARY must contain exactly one concrete question plus the minimal context needed to answer it.
Do not ask multi-part questions. Ask only for the smallest missing piece required to continue.

Use STATUS: silent when there is genuinely nothing to report to the user (e.g. a periodic check found no changes). The task will be recorded as completed but NO message will be delivered to the user. Only use this when the prompt explicitly allows silent completion.

If you encounter an unrecoverable error, use STATUS: failed and explain what went wrong.`

/** Base system prompt of a background task agent; attached skills are prepended by the caller. */
export function buildTaskSystemPrompt(options: TaskSystemPromptOptions): string {
  const { scope } = options
  const personalPaths = scope && !scope.isBootstrapAdmin ? scope.paths : null
  const multiUser = Boolean(personalPaths) || options.multiUser
  const isAdmin = scope ? scope.role === 'admin' : !multiUser
  const sections: string[] = []

  sections.push(`You are a background task agent. You are NOT a chatbot — you are an autonomous worker.

Your task: ${options.taskPrompt}`)

  const taskGuidelines = readTasksGuidelinesFile(options.configDir).trim()
  if (taskGuidelines.length > 0) {
    sections.push(`<task_guidelines>\n${taskGuidelines}\n</task_guidelines>`)
  }

  if (scope) {
    sections.push(`<task_owner>
This task belongs to the user "${scope.username}" (role: ${scope.role}). Results are delivered only to this user.
Memory tools and chat history only return this user's data. Never include or act on other users' personal data.
</task_owner>`)
  }

  sections.push(buildSystemRules({ multiUser, isAdmin, variant: 'task' }))

  const timezone = scope?.settings.timezone || getDefaultTimezone()
  sections.push(buildPathsBlock({
    memoryDir: options.memoryDir ?? getMemoryDir(),
    configDir: options.configDir ?? getConfigDir(),
    workspaceDir: scope?.paths.workspace ?? getWorkspaceDir(),
    agentSkillsDir: options.agentSkillsDir ?? getAgentSkillsDir(),
    readmePath: getReadmePath(),
    docsDir: getDocsPath(),
    today: formatDateKey(options.now ?? new Date(), timezone),
    isAdmin,
    personalPaths,
    legacyUsername: scope?.username,
  }))

  sections.push(TASK_OUTPUT_FORMAT)

  return sections.join('\n\n')
}
