import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  extractTextFromHtml,
  parseDuckDuckGoLiteHtml,
  searchDuckDuckGo,
  createWebSearchTool,
  createWebFetchTool,
  createBuiltinWebTools,
} from './web-tools.js'

// ─── extractTextFromHtml ─────────────────────────────────────────────────────

describe('extractTextFromHtml', () => {
  it('strips simple HTML tags', () => {
    const html = '<p>Hello <b>world</b></p>'
    const text = extractTextFromHtml(html)
    expect(text).toContain('Hello world')
  })

  it('removes script and style blocks', () => {
    const html = `
      <html>
        <head><style>body { color: red; }</style></head>
        <body>
          <script>alert("hi")</script>
          <p>Visible text</p>
          <script type="text/javascript">var x = 1;</script>
        </body>
      </html>
    `
    const text = extractTextFromHtml(html)
    expect(text).toContain('Visible text')
    expect(text).not.toContain('alert')
    expect(text).not.toContain('color: red')
    expect(text).not.toContain('var x')
  })

  it('removes HTML comments', () => {
    const html = '<p>Before</p><!-- secret comment --><p>After</p>'
    const text = extractTextFromHtml(html)
    expect(text).toContain('Before')
    expect(text).toContain('After')
    expect(text).not.toContain('secret comment')
  })

  it('decodes HTML entities', () => {
    const html = '<p>&amp; &lt; &gt; &quot; &#39; &nbsp;</p>'
    const text = extractTextFromHtml(html)
    expect(text).toContain('& < > " \'')
  })

  it('converts block elements to newlines', () => {
    const html = '<div>Block 1</div><div>Block 2</div>'
    const text = extractTextFromHtml(html)
    expect(text).toContain('Block 1')
    expect(text).toContain('Block 2')
    // Should have newlines between blocks
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
    expect(lines).toContain('Block 1')
    expect(lines).toContain('Block 2')
  })

  it('collapses excessive whitespace', () => {
    const html = '<p>  Too   many    spaces  </p>'
    const text = extractTextFromHtml(html)
    expect(text).toBe('Too many spaces')
  })

  it('collapses excessive newlines', () => {
    const html = '<p>Line 1</p>\n\n\n\n\n<p>Line 2</p>'
    const text = extractTextFromHtml(html)
    // Should not have more than 2 consecutive newlines
    expect(text).not.toMatch(/\n{3,}/)
  })

  it('handles empty input', () => {
    expect(extractTextFromHtml('')).toBe('')
  })

  it('removes noscript blocks', () => {
    const html = '<noscript>Enable JS</noscript><p>Content</p>'
    const text = extractTextFromHtml(html)
    expect(text).not.toContain('Enable JS')
    expect(text).toContain('Content')
  })

  it('decodes numeric HTML entities', () => {
    const html = '<p>&#65;&#66;&#67;</p>'
    const text = extractTextFromHtml(html)
    expect(text).toContain('ABC')
  })
})

// ─── parseDuckDuckGoLiteHtml ─────────────────────────────────────────────────

describe('parseDuckDuckGoLiteHtml', () => {
  const sampleHtml = `
    <table>
      <tr>
        <td>
          <a rel="nofollow" href="https://example.com/page1" class="result-link">Example Page 1</a>
        </td>
      </tr>
      <tr>
        <td class="result-snippet">This is the first result snippet.</td>
      </tr>
      <tr>
        <td>
          <a rel="nofollow" href="https://example.com/page2" class="result-link">Example Page 2</a>
        </td>
      </tr>
      <tr>
        <td class="result-snippet">This is the second result snippet.</td>
      </tr>
      <tr>
        <td>
          <a rel="nofollow" href="https://example.com/page3" class="result-link">Example Page 3</a>
        </td>
      </tr>
      <tr>
        <td class="result-snippet">Third snippet here.</td>
      </tr>
    </table>
  `

  it('parses results with title, url, and snippet', () => {
    const results = parseDuckDuckGoLiteHtml(sampleHtml, 10)
    expect(results).toHaveLength(3)
    expect(results[0]).toEqual({
      title: 'Example Page 1',
      url: 'https://example.com/page1',
      snippet: 'This is the first result snippet.',
    })
    expect(results[1]).toEqual({
      title: 'Example Page 2',
      url: 'https://example.com/page2',
      snippet: 'This is the second result snippet.',
    })
  })

  it('respects count limit', () => {
    const results = parseDuckDuckGoLiteHtml(sampleHtml, 2)
    expect(results).toHaveLength(2)
  })

  it('returns empty array for empty HTML', () => {
    const results = parseDuckDuckGoLiteHtml('<html></html>', 5)
    expect(results).toHaveLength(0)
  })

  it('decodes HTML entities in results', () => {
    const html = `
      <a rel="nofollow" href="https://example.com?a=1&amp;b=2" class="result-link">Title &amp; More</a>
      <td class="result-snippet">Snippet with &lt;code&gt;</td>
    `
    const results = parseDuckDuckGoLiteHtml(html, 5)
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://example.com?a=1&b=2')
    expect(results[0].title).toBe('Title & More')
    expect(results[0].snippet).toBe('Snippet with <code>')
  })

  it('handles missing snippets gracefully', () => {
    const html = `
      <a rel="nofollow" href="https://example.com" class="result-link">No Snippet</a>
    `
    const results = parseDuckDuckGoLiteHtml(html, 5)
    expect(results).toHaveLength(1)
    expect(results[0].snippet).toBe('')
  })
})

// ─── searchDuckDuckGo ────────────────────────────────────────────────────────

describe('searchDuckDuckGo', () => {
  it('calls DuckDuckGo lite with correct parameters', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <a rel="nofollow" href="https://example.com" class="result-link">Test Result</a>
        <td class="result-snippet">Test snippet</td>
      `,
    })

    const results = await searchDuckDuckGo('test query', 5, mockFetch)

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, options] = mockFetch.mock.calls[0]
    expect(url).toBe('https://lite.duckduckgo.com/lite/')
    expect(options.method).toBe('POST')
    expect(options.body).toContain('q=test+query')

    expect(results).toHaveLength(1)
    expect(results[0].title).toBe('Test Result')
  })

  it('throws on non-OK response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    })

    await expect(searchDuckDuckGo('test', 5, mockFetch)).rejects.toThrow('HTTP 503')
  })

  it('returns empty array when no results found', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '<html><body>No results</body></html>',
    })

    const results = await searchDuckDuckGo('asdfghjkl', 5, mockFetch)
    expect(results).toHaveLength(0)
  })
})

// ─── createWebSearchTool ─────────────────────────────────────────────────────

describe('createWebSearchTool', () => {
  it('creates a tool with correct metadata', () => {
    const tool = createWebSearchTool()
    expect(tool.name).toBe('web_search')
    expect(tool.label).toBe('Web Search')
    expect(tool.description).toBeTruthy()
    expect(tool.execute).toBeInstanceOf(Function)
  })

  it('executes search and returns formatted results', async () => {
    // We need to mock the global fetch for this tool since it uses searchDuckDuckGo internally
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <a rel="nofollow" href="https://example.com" class="result-link">Example</a>
        <td class="result-snippet">Example snippet</td>
      `,
    }) as unknown as typeof fetch

    try {
      const tool = createWebSearchTool()
      const result = await tool.execute('test-id', { query: 'test' })

      expect(result.content[0].type).toBe('text')
      const text = (result.content[0] as { type: 'text'; text: string }).text
      expect(text).toContain('Example')
      expect(text).toContain('https://example.com')
      expect(result.details.count).toBe(1)
      expect(result.details.provider).toBe('duckduckgo')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('handles search errors gracefully', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error')) as unknown as typeof fetch

    try {
      const tool = createWebSearchTool()
      const result = await tool.execute('test-id', { query: 'test' })

      const text = (result.content[0] as { type: 'text'; text: string }).text
      expect(text).toContain('Search failed')
      expect(text).toContain('Network error')
      expect(result.details.error).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('returns no results message when search yields nothing', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '<html></html>',
    }) as unknown as typeof fetch

    try {
      const tool = createWebSearchTool()
      const result = await tool.execute('test-id', { query: 'nonexistent' })

      const text = (result.content[0] as { type: 'text'; text: string }).text
      expect(text).toContain('No results found')
      expect(result.details.count).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

// ─── createWebFetchTool ──────────────────────────────────────────────────────

describe('createWebFetchTool', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  it('creates a tool with correct metadata', () => {
    const tool = createWebFetchTool()
    expect(tool.name).toBe('web_fetch')
    expect(tool.label).toBe('Web Fetch')
    expect(tool.description).toBeTruthy()
    expect(tool.execute).toBeInstanceOf(Function)
  })

  it('fetches and extracts text from HTML', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map([['content-type', 'text/html']]) as unknown as Headers,
      text: async () => '<html><body><h1>Hello</h1><p>World</p><script>bad()</script></body></html>',
    }) as unknown as typeof fetch

    try {
      const tool = createWebFetchTool()
      const result = await tool.execute('test-id', { url: 'https://example.com' })

      const text = (result.content[0] as { type: 'text'; text: string }).text
      expect(text).toContain('Hello')
      expect(text).toContain('World')
      expect(text).not.toContain('bad()')
      expect(result.details.truncated).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('returns plain text as-is for non-HTML content', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map([['content-type', 'text/plain']]) as unknown as Headers,
      text: async () => 'Just plain text content',
    }) as unknown as typeof fetch

    try {
      const tool = createWebFetchTool()
      const result = await tool.execute('test-id', { url: 'https://example.com/file.txt' })

      const text = (result.content[0] as { type: 'text'; text: string }).text
      expect(text).toBe('Just plain text content')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('respects maxLength truncation', async () => {
    const longContent = 'A'.repeat(1000)
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map([['content-type', 'text/plain']]) as unknown as Headers,
      text: async () => longContent,
    }) as unknown as typeof fetch

    try {
      const tool = createWebFetchTool()
      const result = await tool.execute('test-id', { url: 'https://example.com', maxLength: 100 })

      const text = (result.content[0] as { type: 'text'; text: string }).text
      expect(text.length).toBeLessThan(1000)
      expect(text).toContain('[Content truncated at 100 characters]')
      expect(result.details.truncated).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('uses default maxLength of 50000', async () => {
    const longContent = 'B'.repeat(60000)
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map([['content-type', 'text/plain']]) as unknown as Headers,
      text: async () => longContent,
    }) as unknown as typeof fetch

    try {
      const tool = createWebFetchTool()
      const result = await tool.execute('test-id', { url: 'https://example.com' })

      const text = (result.content[0] as { type: 'text'; text: string }).text
      expect(text).toContain('[Content truncated at 50000 characters]')
      expect(result.details.truncated).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('handles HTTP errors', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: new Map() as unknown as Headers,
    }) as unknown as typeof fetch

    try {
      const tool = createWebFetchTool()
      const result = await tool.execute('test-id', { url: 'https://example.com/missing' })

      const text = (result.content[0] as { type: 'text'; text: string }).text
      expect(text).toContain('HTTP 404')
      expect(result.details.error).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('handles network errors', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch

    try {
      const tool = createWebFetchTool()
      const result = await tool.execute('test-id', { url: 'https://example.com' })

      const text = (result.content[0] as { type: 'text'; text: string }).text
      expect(text).toContain('Failed to fetch URL')
      expect(text).toContain('ECONNREFUSED')
      expect(result.details.error).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

// ─── createBuiltinWebTools ───────────────────────────────────────────────────

describe('createBuiltinWebTools', () => {
  it('creates both tools by default (no config)', () => {
    const tools = createBuiltinWebTools()
    expect(tools).toHaveLength(2)
    expect(tools.map(t => t.name)).toEqual(['web_search', 'web_fetch'])
  })

  it('creates both tools when both enabled', () => {
    const tools = createBuiltinWebTools({
      webSearch: { enabled: true, provider: 'duckduckgo' },
      webFetch: { enabled: true },
    })
    expect(tools).toHaveLength(2)
  })

  it('excludes web_search when disabled', () => {
    const tools = createBuiltinWebTools({
      webSearch: { enabled: false },
      webFetch: { enabled: true },
    })
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('web_fetch')
  })

  it('excludes web_fetch when disabled', () => {
    const tools = createBuiltinWebTools({
      webSearch: { enabled: true },
      webFetch: { enabled: false },
    })
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('web_search')
  })

  it('excludes both when both disabled', () => {
    const tools = createBuiltinWebTools({
      webSearch: { enabled: false },
      webFetch: { enabled: false },
    })
    expect(tools).toHaveLength(0)
  })

  it('handles partial config (only webSearch)', () => {
    const tools = createBuiltinWebTools({
      webSearch: { enabled: true },
    })
    expect(tools).toHaveLength(2) // webFetch defaults to enabled
  })

  it('handles empty config object', () => {
    const tools = createBuiltinWebTools({})
    expect(tools).toHaveLength(2) // Both default to enabled
  })
})
