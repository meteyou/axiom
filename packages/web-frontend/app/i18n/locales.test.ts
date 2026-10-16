import { describe, expect, it } from 'vitest'
import { SYSTEM_PROMPT_SECTION_KEYS } from '@axiom/core/contracts'
import de from './locales/de.json'
import en from './locales/en.json'

describe.each([['en', en], ['de', de]])('%s locale', (_name, messages) => {
  it('labels every system prompt section of the context breakdown', () => {
    const labels = Object.keys(messages.chat.context.breakdown.sections)
    expect(labels.sort()).toEqual([...SYSTEM_PROMPT_SECTION_KEYS].sort())
  })
})
