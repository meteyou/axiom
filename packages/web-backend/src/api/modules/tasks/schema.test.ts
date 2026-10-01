import { describe, expect, it } from 'vitest'
import { parseRestartTaskBody } from './schema.js'

describe('parseRestartTaskBody thinkingLevel', () => {
  it('distinguishes inherit, default and an explicit level', () => {
    expect(parseRestartTaskBody({})).toEqual({ ok: true, value: {} })
    expect(parseRestartTaskBody({ thinkingLevel: null })).toEqual({ ok: true, value: { thinkingLevel: null } })
    expect(parseRestartTaskBody({ thinkingLevel: '' })).toEqual({ ok: true, value: { thinkingLevel: null } })
    expect(parseRestartTaskBody({ thinkingLevel: 'max' })).toEqual({ ok: true, value: { thinkingLevel: 'max' } })
  })

  it('rejects unknown levels', () => {
    const parsed = parseRestartTaskBody({ thinkingLevel: 'turbo' })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('thinkingLevel must be one of')
  })
})
