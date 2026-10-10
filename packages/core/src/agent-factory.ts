import { Agent as PiAgent } from '@earendil-works/pi-agent-core'
import type { AgentInitialState, AgentOptions, StreamFn } from '@earendil-works/pi-agent-core'
import { buildStreamFn } from './provider-config.js'
import type { ProviderConfig } from './provider-config.js'
import type { ContextCompactor } from './context-compactor.js'
import { createToolResultImageHook, createTranscriptImageBudget } from './llm-image.js'

export interface AxiomAgentOptions {
  initialState: AgentInitialState
  provider?: Pick<ProviderConfig, 'textVerbosity' | 'transport'>
  getApiKey: NonNullable<AgentOptions['getApiKey']>
  sessionId?: string
  compactor?: ContextCompactor
  /**
   * Overrides the default image-normalization hook; pass the same hook the
   * codemode tool gets so nested calls normalize images like direct calls.
   */
  afterToolCall?: NonNullable<AgentOptions['afterToolCall']>
  /** Replaces the provider-derived stream function (tests). */
  streamFn?: StreamFn
}

/**
 * The one place the main chat runtime and background tasks build their pi
 * agent, so loop hooks such as compaction and image limits are wired
 * identically for both.
 */
export function createAxiomAgent(options: AxiomAgentOptions): PiAgent {
  const transport = options.provider?.transport
  const agent: PiAgent = new PiAgent({
    initialState: options.initialState,
    streamFn: options.streamFn ?? buildStreamFn({
      textVerbosity: options.provider?.textVerbosity,
      transport,
    }),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(transport && transport !== 'sse' && { transport }),
    afterToolCall: options.afterToolCall ?? createToolResultImageHook(() => agent.state.model),
    transformContext: createTranscriptImageBudget(() => agent.state.model),
    getApiKey: options.getApiKey,
  })
  options.compactor?.attach(agent)
  return agent
}
