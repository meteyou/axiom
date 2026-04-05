import { describe, expect, it } from 'vitest'
import { useMarkdown } from './useMarkdown'

describe('useMarkdown', () => {
  it('renders markdown links with target=_blank and safe rel attributes', () => {
    const { renderMarkdown } = useMarkdown()

    const html = renderMarkdown('[OpenAI](https://openai.com)')

    expect(html).toContain('href="https://openai.com"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })
})
