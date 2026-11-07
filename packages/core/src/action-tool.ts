import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { StringEnum } from '@earendil-works/pi-ai'
import { Type } from 'typebox'
import type { TSchema } from 'typebox'
import { THINKING_LEVEL_PARAM_DESCRIPTION } from './thinking-level.js'
import type { ToolReplayPolicy } from './tool-replay.js'

type ActionParams = Record<string, unknown>

export interface ActionConfig<P extends ActionParams> {
  /** Short explanation shown next to the action in the `action` enum description. */
  description: string
  /** Parameters that must be present for this action; all other parameters stay optional. */
  required?: readonly (keyof P & string)[]
  replay: ToolReplayPolicy
  execute: (params: P, toolCallId: string, signal?: AbortSignal) => Promise<AgentToolResult<unknown>>
}

export interface ActionToolDefinition<P extends ActionParams, A extends string> {
  name: string
  label: string
  description: string
  /** Every parameter except `action`; each one is optional in the schema and enforced per action. */
  parameters: Record<keyof P & string, TSchema>
  actions: Record<A, ActionConfig<P>>
}

export interface ActionTool<A extends string = string> extends AgentTool {
  actions: readonly A[]
  /** Replay policy per action, consumed by the crash-replay classification. */
  actionReplayPolicies: Readonly<Record<A, ToolReplayPolicy>>
}

/** Parameters shared by every tool that spawns or schedules a background agent run. */
export const AGENT_RUN_PARAMETERS = {
  provider: Type.String({
    description: 'Provider name or id for the agent run (e.g. "Kimi.ai", "OpenAI"). Choose from `<available_providers>` and only pass it when you have a reason to deviate from the default task model. Can be combined with `model`.',
  }),
  model: Type.String({
    description: 'Model id for the agent run (e.g. "kimi-k2.6", "gpt-5"). Prefer cost-effective models for simple work and stronger ones for complex coding or research. Without `provider`, the provider is auto-detected (requires a unique match).',
  }),
  thinking_level: Type.String({
    description: `${THINKING_LEVEL_PARAM_DESCRIPTION} When editing, pass "default" to reset it and omit it to leave it unchanged.`,
  }),
  attached_skills: Type.Array(Type.String(), {
    description: 'Agent-skill names (directories under /data/skills_agent/<name>/) or installed skill ids ("owner/name") whose SKILL.md is injected into the task prompt, so the task agent does not have to discover them. Example: ["nitter", "reddit"]. Missing skills are skipped with a warning. When editing, the list replaces the stored one; [] clears it.',
  }),
} satisfies Record<string, TSchema>

function actionToolError(text: string): AgentToolResult<{ error: true }> {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], details: { error: true } }
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
}

function describeActions<P extends ActionParams>(actions: Record<string, ActionConfig<P>>): string {
  const lines = Object.entries(actions).map(([name, config]) => {
    const required = config.required?.length ? ` Requires: ${config.required.join(', ')}.` : ''
    return `"${name}": ${config.description}${required}`
  })
  return `The operation to perform. ${lines.join(' ')}`
}

/**
 * Builds one tool that groups several actions behind an `action` enum. The
 * schema stays flat (no oneOf/anyOf, which OpenAI strict mode and Gemini
 * reject), so required fields are checked per action at execution time.
 */
export function defineActionTool<P extends ActionParams, A extends string>(
  definition: ActionToolDefinition<P, A>,
): ActionTool<A> {
  const actionNames = Object.keys(definition.actions) as A[]
  const properties: Record<string, TSchema> = {
    action: StringEnum(actionNames, { description: describeActions(definition.actions) }) as unknown as TSchema,
  }
  for (const [key, schema] of Object.entries(definition.parameters) as [string, TSchema][]) {
    properties[key] = Type.Optional(schema)
  }

  const actionReplayPolicies = Object.fromEntries(
    actionNames.map(action => [action, definition.actions[action].replay]),
  ) as Record<A, ToolReplayPolicy>

  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: Type.Object(properties),
    actions: actionNames,
    actionReplayPolicies,
    execute: async (toolCallId, rawParams, signal) => {
      const params = (rawParams ?? {}) as P & { action?: unknown }
      const action = params.action
      if (typeof action !== 'string' || !Object.prototype.hasOwnProperty.call(definition.actions, action)) {
        const received = typeof action === 'string' ? `Unknown action "${action}"` : 'action is required'
        return actionToolError(`${received} for ${definition.name}. Valid actions: ${actionNames.join(', ')}.`)
      }

      const config = definition.actions[action as A]
      const missing = (config.required ?? []).filter(field => isMissing(params[field]))
      if (missing.length > 0) {
        return actionToolError(`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required for action=${action}.`)
      }

      return config.execute(params, toolCallId, signal)
    },
  }
}
