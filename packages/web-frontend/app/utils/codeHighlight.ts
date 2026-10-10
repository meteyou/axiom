import { createHighlighter, type Highlighter } from 'shiki'

const LANG = 'javascript'
const THEMES = { dark: 'github-dark', light: 'github-light' } as const

let highlighterPromise: Promise<Highlighter> | null = null

function getHighlighter() {
  highlighterPromise ??= createHighlighter({
    themes: [THEMES.dark, THEMES.light],
    langs: [LANG],
  })
  return highlighterPromise
}

/**
 * Highlight a script for the codemode card. The single shared highlighter is
 * created lazily on first use, so the shiki engine + grammar only load once
 * the user actually expands a card.
 */
export async function highlightJavaScript(code: string, isDark: boolean): Promise<string> {
  const highlighter = await getHighlighter()
  return highlighter.codeToHtml(code, {
    lang: LANG,
    theme: isDark ? THEMES.dark : THEMES.light,
  })
}
