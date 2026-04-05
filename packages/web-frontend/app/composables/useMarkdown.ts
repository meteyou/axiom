import { marked } from 'marked'
import TurndownService from 'turndown'

// Configure marked for clean, minimal output
marked.setOptions({
  breaks: true,
  gfm: true,
})

const renderer = new marked.Renderer()
renderer.link = ({ href, title, tokens }) => {
  const text = marked.Parser.parseInline(tokens)
  const safeHref = href || ''
  const titleAttr = title ? ` title="${title}"` : ''

  return `<a href="${safeHref}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`
}

// Configure turndown for HTML → Markdown conversion (used on copy)
const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  strongDelimiter: '**',
})

/**
 * Render markdown string to HTML and provide copy-as-markdown support.
 */
export function useMarkdown() {
  function renderMarkdown(text: string): string {
    if (!text) return ''
    const html = marked.parse(text, { renderer }) as string
    return html
  }

  /**
   * Attach to a container element to intercept copy events inside `.prose-chat`
   * and place the markdown equivalent into the clipboard.
   */
  function handleCopyAsMarkdown(event: ClipboardEvent) {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) return

    // Check if the selection is inside (or overlaps) a .prose-chat element
    const range = selection.getRangeAt(0)
    const ancestor = range.commonAncestorContainer
    const proseEl =
      ancestor instanceof HTMLElement
        ? ancestor.closest('.prose-chat') ?? ancestor.querySelector('.prose-chat')
        : ancestor.parentElement?.closest('.prose-chat')

    if (!proseEl) return // Not inside rendered markdown — let default copy work

    // Clone the selected fragment and convert HTML → Markdown
    const fragment = range.cloneContents()
    const wrapper = document.createElement('div')
    wrapper.appendChild(fragment)

    const md = turndown.turndown(wrapper.innerHTML)

    event.preventDefault()
    event.clipboardData?.setData('text/plain', md)
    // Also keep the HTML version for rich-paste targets
    event.clipboardData?.setData('text/html', wrapper.innerHTML)
  }

  return { renderMarkdown, handleCopyAsMarkdown }
}
