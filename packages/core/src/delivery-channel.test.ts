import { describe, expect, it } from 'vitest'
import { resolveDeliveryChannel } from './delivery-channel.js'
import type { DeliveryChannelInput } from './delivery-channel.js'

function resolve(overrides: Partial<DeliveryChannelInput> & { socket?: boolean, linked?: boolean } = {}) {
  const { socket = false, linked = true, ...rest } = overrides
  return resolveDeliveryChannel({
    userId: 1,
    telegramDeliveryMode: 'auto',
    hasActiveWebSocket: () => socket,
    isTelegramLinked: () => linked,
    ...rest,
  })
}

describe('resolveDeliveryChannel', () => {
  it('auto mode resolves to web while a web socket is active', () => {
    expect(resolve({ socket: true })).toBe('web')
  })

  it('auto mode resolves to telegram without an active web socket', () => {
    expect(resolve({ socket: false })).toBe('telegram')
  })

  it('always mode resolves to telegram even with an active web socket', () => {
    expect(resolve({ telegramDeliveryMode: 'always', socket: true })).toBe('telegram')
    expect(resolve({ telegramDeliveryMode: 'always', socket: false })).toBe('telegram')
  })

  it('resolves to web when the user has no linked Telegram account', () => {
    expect(resolve({ linked: false, socket: false })).toBe('web')
    expect(resolve({ linked: false, telegramDeliveryMode: 'always' })).toBe('web')
  })

  it('passes the user id to the presence and link checks', () => {
    const seen: number[] = []
    resolveDeliveryChannel({
      userId: 42,
      telegramDeliveryMode: 'auto',
      hasActiveWebSocket: uid => { seen.push(uid); return false },
      isTelegramLinked: uid => { seen.push(uid); return true },
    })
    expect(seen).toEqual([42, 42])
  })
})
