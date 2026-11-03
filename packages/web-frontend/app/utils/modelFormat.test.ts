import { describe, expect, it } from 'vitest'
import { formatVoiceModelPrice, fromVoicePriceInput, toVoicePriceInput } from './modelFormat'

describe('voice model prices', () => {
  it('keeps TTS prices per 1M characters', () => {
    expect(toVoicePriceInput('tts', 15)).toBe(15)
    expect(fromVoicePriceInput('tts', 15)).toBe(15)
  })

  it('enters STT prices per minute and stores them per 1M audio seconds', () => {
    expect(fromVoicePriceInput('stt', 0.006)).toBeCloseTo(100, 6)
    expect(toVoicePriceInput('stt', 100)).toBe(0.006)
    expect(formatVoiceModelPrice('stt', 100)).toBe('$0.006 / min')
  })
})
