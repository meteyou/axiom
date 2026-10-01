import { describe, expect, it } from 'vitest'
import { parsePiModelSpec, rowsToThinkingMap, thinkingMapsEqual, thinkingMapToRows } from './modelSpecForm'

describe('thinking level rows', () => {
  it('follows pi-ai semantics: low levels default on, xhigh/max opt-in', () => {
    const rows = thinkingMapToRows(undefined)
    expect(rows.filter(r => r.supported).map(r => r.level)).toEqual(['minimal', 'low', 'medium', 'high'])
  })

  it('round-trips a pi thinkingLevelMap', () => {
    const map = { minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' }
    const rows = thinkingMapToRows(map)
    expect(rows.map(r => [r.level, r.supported, r.value])).toEqual([
      ['minimal', false, ''],
      ['low', true, ''],
      ['medium', false, ''],
      ['high', true, ''],
      ['xhigh', false, ''],
      ['max', true, ''],
    ])
    expect(rowsToThinkingMap(rows)).toEqual({ minimal: null, medium: null, max: 'max' })
  })

  it('keeps custom wire values and the off key from the base map', () => {
    const rows = thinkingMapToRows({ high: 'very-high' })
    expect(rows.find(r => r.level === 'high')?.value).toBe('very-high')
    expect(rowsToThinkingMap(rows, { off: null })).toEqual({ off: null, high: 'very-high' })
  })

  it('returns null when every level uses the default', () => {
    expect(rowsToThinkingMap(thinkingMapToRows(undefined))).toBeNull()
  })

  it('compares maps independent of key order', () => {
    expect(thinkingMapsEqual({ low: 'low', max: 'max' }, { max: 'max', low: 'low' })).toBe(true)
    expect(thinkingMapsEqual(null, undefined)).toBe(true)
    expect(thinkingMapsEqual({ low: null }, {})).toBe(false)
  })
})

describe('parsePiModelSpec', () => {
  const config = JSON.stringify({
    providers: {
      gateway: {
        models: [
          {
            id: 'DeepSeek-V4-Flash-0731',
            name: 'DeepSeek V4 Flash 0731',
            contextWindow: 1048576,
            maxTokens: 393216,
            reasoning: true,
            thinkingLevelMap: { minimal: null, low: 'low', max: 'max' },
          },
          { id: 'Qwen3.8-27B-FP8', input: ['text', 'image'], maxTokens: 131072 },
        ],
      },
    },
  })

  it('extracts the matching model from a full pi models.json', () => {
    expect(parsePiModelSpec(config, 'DeepSeek-V4-Flash-0731')).toEqual({
      name: 'DeepSeek V4 Flash 0731',
      contextWindow: 1048576,
      maxTokens: 393216,
      reasoning: true,
      input: ['text'],
      thinkingLevelMap: { minimal: null, low: 'low', max: 'max' },
    })
    expect(parsePiModelSpec(config, 'Qwen3.8-27B-FP8')).toEqual({ maxTokens: 131072, input: ['text', 'image'] })
  })

  it('imports per-1M-token costs including cache prices', () => {
    const model = '{"id":"x","cost":{"input":0.28,"output":0.42,"cacheRead":0.028,"cacheWrite":0,"bogus":-1}}'
    expect(parsePiModelSpec(model, 'x')?.cost).toEqual({ input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0 })
  })

  it('accepts a single model object', () => {
    expect(parsePiModelSpec('{"id":"x","reasoning":false}', 'x')).toEqual({ reasoning: false, input: ['text'] })
  })

  it('returns null for invalid JSON or unknown models', () => {
    expect(parsePiModelSpec('{nope', 'x')).toBeNull()
    expect(parsePiModelSpec(config, 'missing')).toBeNull()
  })
})
