import { describe, it, expect } from 'vitest'
import { applyTurnContext, formatTurnContext, toTurnChannel } from './turn-context.js'
import type { TurnChannel } from './turn-context.js'

const now = new Date('2026-03-01T23:30:00Z')

function prefix(previousChannel: TurnChannel | null, currentChannel: TurnChannel, isFirstTurn: boolean): string | null {
  return formatTurnContext({ previousChannel, currentChannel, isFirstTurn, timezone: 'UTC', now }).prefix
}

describe('formatTurnContext', () => {
  it('announces Telegram on the first turn', () => {
    const result = prefix(null, 'telegram', true)
    expect(result).toContain('<channel_context>')
    expect(result).toContain('You ARE the Telegram bot')
  })

  it('stays silent on the first web turn', () => {
    expect(prefix(null, 'web', true)).toBeNull()
  })

  it('announces a switch from web to Telegram', () => {
    expect(prefix('web', 'telegram', false)).toContain('You ARE the Telegram bot')
  })

  it('announces a switch from Telegram back to web', () => {
    const result = prefix('telegram', 'web', false)
    expect(result).toContain('<channel_context>')
    expect(result).toContain('web interface')
  })

  it('adds no prefix while the channel is unchanged', () => {
    expect(prefix('telegram', 'telegram', false)).toBeNull()
    expect(prefix('web', 'web', false)).toBeNull()
  })

  it('suffixes the current date, time and timezone', () => {
    expect(formatTurnContext({ previousChannel: null, currentChannel: 'web', isFirstTurn: true, timezone: 'Europe/Berlin', now }).suffix)
      .toBe('<current_time>Current time: Monday, 2026-03-02 00:30 (Europe/Berlin)</current_time>')
    expect(formatTurnContext({ previousChannel: 'web', currentChannel: 'telegram', isFirstTurn: false, timezone: 'UTC', now }).suffix)
      .toBe('<current_time>Current time: Sunday, 2026-03-01 23:30 (UTC)</current_time>')
  })
})

describe('toTurnChannel', () => {
  it('maps Telegram sources to telegram and everything else to web', () => {
    expect(toTurnChannel('telegram')).toBe('telegram')
    expect(toTurnChannel('telegram-group')).toBe('telegram')
    expect(toTurnChannel('web')).toBe('web')
    expect(toTurnChannel(undefined)).toBe('web')
  })
})

describe('applyTurnContext', () => {
  it('puts the prefix before and the suffix after the message', () => {
    expect(applyTurnContext('hi', { prefix: 'P', suffix: 'S' })).toBe('P\n\nhi\n\nS')
    expect(applyTurnContext('hi', { prefix: null, suffix: 'S' })).toBe('hi\n\nS')
  })
})
