import type { TurnChannel } from './turn-context.js'

export type TelegramDeliveryMode = 'auto' | 'always'

export interface DeliveryChannelInput {
  userId: number
  telegramDeliveryMode: TelegramDeliveryMode
  hasActiveWebSocket: (userId: number) => boolean
  isTelegramLinked: (userId: number) => boolean
}

/**
 * Decides where background output (task results, status updates, injection
 * responses) reaches the user. Injections must be formatted for the channel
 * returned here, so "always" resolves to Telegram even if a web socket is
 * open — the response is sent to Telegram either way.
 */
export function resolveDeliveryChannel(input: DeliveryChannelInput): TurnChannel {
  if (!input.isTelegramLinked(input.userId)) return 'web'
  if (input.telegramDeliveryMode === 'always') return 'telegram'
  return input.hasActiveWebSocket(input.userId) ? 'web' : 'telegram'
}
