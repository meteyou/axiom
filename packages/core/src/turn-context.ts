import { formatCurrentTimeContext } from './memory.js'

export type TurnChannel = 'web' | 'telegram'

export interface TurnContextInput {
  /** Channel of the session's previous turn; null when there was none. */
  previousChannel: TurnChannel | null
  currentChannel: TurnChannel
  isFirstTurn: boolean
  timezone?: string
  now?: Date
}

export interface TurnContext {
  prefix: string | null
  suffix: string
}

const TELEGRAM_CHANNEL_CONTEXT = `<channel_context>
You are communicating with the user through Telegram. You ARE the Telegram bot — messages the user sends arrive directly to you, and your responses are sent back to the user automatically. Do not tell the user to use the Telegram Bot API, curl commands, or any external tools to communicate. Just respond naturally to their messages.
Keep responses concise and well-formatted for Telegram (use Markdown sparingly, avoid very long messages).
</channel_context>`

const WEB_CHANNEL_CONTEXT = `<channel_context>
The user switched from Telegram to the web interface. The Telegram constraints no longer apply; full Markdown and longer responses are fine again.
</channel_context>`

export function toTurnChannel(source?: string): TurnChannel {
  return source?.startsWith('telegram') ? 'telegram' : 'web'
}

function channelPrefix({ previousChannel, currentChannel, isFirstTurn }: TurnContextInput): string | null {
  if (currentChannel === 'telegram') {
    return isFirstTurn || previousChannel !== 'telegram' ? TELEGRAM_CHANNEL_CONTEXT : null
  }
  return !isFirstTurn && previousChannel === 'telegram' ? WEB_CHANNEL_CONTEXT : null
}

/**
 * Channel guidance travels with the user message instead of the system
 * prompt, which is frozen per session while the channel may change mid-session.
 */
export function formatTurnContext(input: TurnContextInput): TurnContext {
  return {
    prefix: channelPrefix(input),
    suffix: formatCurrentTimeContext(input.timezone, input.now),
  }
}

export function applyTurnContext(text: string, context: TurnContext): string {
  const body = `${text}\n\n${context.suffix}`
  return context.prefix ? `${context.prefix}\n\n${body}` : body
}
