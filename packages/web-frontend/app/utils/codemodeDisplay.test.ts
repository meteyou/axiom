import { describe, expect, it } from 'vitest'
import {
  codemodeCallsFromResult,
  codemodeCallsToDisplay,
  codemodeCollapsedSummary,
  codemodeOutputText,
  codemodeScriptCode,
  toCodemodeCallRows,
  type CodemodeNestedCall,
} from './codemodeDisplay'

const calls: CodemodeNestedCall[] = [
  { id: 'p/read_file/1', name: 'read_file', status: 'ok', durationMs: 12, args: { path: 'src/index.ts' } },
  { id: 'p/read_file/2', name: 'read_file', status: 'error', durationMs: 340, errorPreview: 'ENOENT: no such file' },
  { id: 'p/web_search/1', name: 'web_search', status: 'running' },
]

describe('toCodemodeCallRows', () => {
  it('formats names with the existing tool-name formatting', () => {
    const rows = toCodemodeCallRows(calls)
    expect(rows.map(row => row.displayName)).toEqual(['Read file', 'Read file', 'Web search'])
  })

  it('keeps the raw name, status, duration and error preview', () => {
    const rows = toCodemodeCallRows(calls)
    expect(rows[0]).toEqual({
      id: 'p/read_file/1',
      name: 'read_file',
      displayName: 'Read file',
      summary: 'src/index.ts',
      status: 'ok',
      durationMs: 12,
      errorPreview: undefined,
    })
    expect(rows[1]!.errorPreview).toBe('ENOENT: no such file')
    expect(rows[1]!.durationMs).toBe(340)
    expect(rows[2]!.status).toBe('running')
  })

  it('builds the summary line from the existing per-tool summaries', () => {
    const rows = toCodemodeCallRows([
      { id: '1', name: 'email_read', status: 'ok', args: { uid: 42, folder: 'INBOX' } },
      { id: '2', name: 'shell', status: 'ok', args: { command: 'cd /workspace && ls' } },
      { id: '3', name: 'list_files', status: 'ok', args: { path: 'docs' } },
    ])
    expect(rows.map(row => row.summary)).toEqual(['uid: 42 · folder: INBOX', 'ls', 'docs'])
  })

  it('returns a null summary when the snapshot carries no args', () => {
    const rows = toCodemodeCallRows([{ id: '1', name: 'read_file', status: 'ok' }])
    expect(rows[0]!.summary).toBeNull()
  })

  it('tolerates null and undefined input', () => {
    expect(toCodemodeCallRows(null)).toEqual([])
    expect(toCodemodeCallRows(undefined)).toEqual([])
  })
})

describe('codemodeCollapsedSummary', () => {
  it('counts calls and deduplicates tool names in first-seen order', () => {
    expect(codemodeCollapsedSummary(calls)).toEqual({ count: 3, toolNames: ['Read file', 'Web search'] })
  })

  it('returns zero and no names for empty input', () => {
    expect(codemodeCollapsedSummary([])).toEqual({ count: 0, toolNames: [] })
    expect(codemodeCollapsedSummary(null)).toEqual({ count: 0, toolNames: [] })
  })

  it('lists every distinct name', () => {
    expect(codemodeCollapsedSummary([
      { id: '1', name: 'web_search', status: 'ok' },
      { id: '2', name: 'read_file', status: 'ok' },
      { id: '3', name: 'shell', status: 'cancelled' },
    ]).toolNames).toEqual(['Web search', 'Read file', 'Shell'])
  })
})

describe('codemodeScriptCode', () => {
  it('extracts the code argument', () => {
    expect(codemodeScriptCode({ code: 'await tools.read_file({ path: "a" })' })).toBe('await tools.read_file({ path: "a" })')
  })

  it('returns an empty string when the code is missing or not a string', () => {
    expect(codemodeScriptCode({})).toBe('')
    expect(codemodeScriptCode({ code: 42 })).toBe('')
    expect(codemodeScriptCode(null)).toBe('')
  })
})

describe('codemodeCallsFromResult', () => {
  const result = {
    content: [{ type: 'text', text: 'Script completed' }],
    details: {
      calls: [
        { id: 'p/1', name: 'read_file', status: 'ok', durationMs: 10 },
        { id: 'p/2', name: 'shell', status: 'cancelled' },
      ],
    },
  }

  it('reads the persisted nested calls from the result details', () => {
    expect(codemodeCallsFromResult(result)).toEqual([
      { id: 'p/1', name: 'read_file', status: 'ok', durationMs: 10, errorPreview: undefined },
      { id: 'p/2', name: 'shell', status: 'cancelled', durationMs: undefined, errorPreview: undefined },
    ])
  })

  it('returns null when the result has no call list', () => {
    expect(codemodeCallsFromResult(null)).toBeNull()
    expect(codemodeCallsFromResult({})).toBeNull()
    expect(codemodeCallsFromResult({ details: {} })).toBeNull()
  })

  it('keeps the persisted args so the display rows can build summary lines', () => {
    const persisted = {
      details: {
        calls: [
          { id: 'p/1', name: 'read_file', status: 'ok', durationMs: 10, args: { path: 'src/index.ts' } },
          { id: 'p/2', name: 'shell', status: 'error', args: { command: 'cd /workspace && ls' } },
        ],
      },
    }
    const rows = toCodemodeCallRows(codemodeCallsFromResult(persisted))
    expect(rows.map(row => row.summary)).toEqual(['src/index.ts', 'ls'])
  })

  it('keeps the persisted error preview so a reloaded card matches the live one', () => {
    const persisted = {
      details: {
        calls: [
          { id: 'p/1', name: 'read_file', status: 'error', durationMs: 40, errorPreview: 'ENOENT: no such file or directory' },
        ],
      },
    }
    const rows = toCodemodeCallRows(codemodeCallsFromResult(persisted))
    expect(rows[0]!.errorPreview).toBe('ENOENT: no such file or directory')
  })
})

describe('codemodeCallsToDisplay', () => {
  // Stale live snapshot: the last progress event still shows call p/2 as
  // running, because the script ended (rejection/timeout) before it finished.
  const staleLive: CodemodeNestedCall[] = [
    { id: 'p/1', name: 'read_file', status: 'ok', durationMs: 10 },
    { id: 'p/2', name: 'shell', status: 'running' },
  ]
  const result = {
    content: [{ type: 'text', text: 'Script failed' }],
    details: {
      calls: [
        { id: 'p/1', name: 'read_file', status: 'ok', durationMs: 10 },
        { id: 'p/2', name: 'shell', status: 'cancelled' },
      ],
    },
  }

  it('shows the live snapshot while the result is missing', () => {
    expect(codemodeCallsToDisplay(staleLive, undefined)).toEqual(staleLive)
    expect(codemodeCallsToDisplay(undefined, undefined)).toEqual([])
  })

  it('prefers the final result calls once the result is in, over the retained live snapshot', () => {
    expect(codemodeCallsToDisplay(staleLive, result)).toEqual([
      { id: 'p/1', name: 'read_file', status: 'ok', durationMs: 10, errorPreview: undefined },
      { id: 'p/2', name: 'shell', status: 'cancelled', durationMs: undefined, errorPreview: undefined },
    ])
  })

  it('shows no calls for a result without a call list', () => {
    expect(codemodeCallsToDisplay(staleLive, {})).toEqual([])
    expect(codemodeCallsToDisplay(staleLive, { details: {} })).toEqual([])
  })
})

describe('codemodeOutputText', () => {
  it('joins the text blocks of the tool result', () => {
    const result = {
      content: [
        { type: 'text', text: 'Script completed' },
        { type: 'text', text: 'line one' },
      ],
    }
    expect(codemodeOutputText(result)).toBe('Script completed\nline one')
  })

  it('returns null before the result is in', () => {
    expect(codemodeOutputText(null)).toBeNull()
    expect(codemodeOutputText({ content: [] })).toBeNull()
    expect(codemodeOutputText('not an object')).toBeNull()
  })
})
