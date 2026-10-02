import { describe, it, expect } from 'vitest'
import { formatJournalRecoveryContext } from './task-recovery-prompt.js'
import type { ToolJournalEntry } from './task-tool-journal.js'

function entry(overrides: Partial<ToolJournalEntry>): ToolJournalEntry {
  return {
    toolCallId: 'call',
    toolName: 'read_file',
    args: '{}',
    status: 'completed',
    result: 'ok',
    replay: 'safe',
    startedAt: '2026-10-02 10:00:00',
    endedAt: '2026-10-02 10:00:01',
    ...overrides,
  }
}

describe('formatJournalRecoveryContext', () => {
  it('lists finished calls with arguments and result previews', () => {
    const context = formatJournalRecoveryContext([
      entry({ toolName: 'read_file', args: '{"path":"README.md"}', result: 'line 1\nline 2' }),
      entry({ toolName: 'shell', args: '{"command":"npm test"}', status: 'error', result: 'Error: 1 failing', replay: 'unsafe' }),
    ])

    expect(context).toContain('The previous run made 2 tool call(s).')
    expect(context).toContain('1. read_file {"path":"README.md"} → completed\n   Result: line 1\n   line 2')
    expect(context).toContain('2. shell {"command":"npm test"} → failed\n   Result: Error: 1 failing')
    expect(context).not.toContain('Interrupted tool calls')
  })

  it('marks interrupted unsafe calls as outcome unknown and safe ones as re-runnable', () => {
    const context = formatJournalRecoveryContext([
      entry({ toolName: 'shell', args: '{"command":"git push"}', status: 'started', result: null, replay: 'unsafe', endedAt: null }),
      entry({ toolName: 'web_fetch', args: '{"url":"https://example.com"}', status: 'started', result: null, replay: 'safe', endedAt: null }),
      entry({ toolName: 'legacy_tool', status: 'started', result: null, replay: null, endedAt: null }),
    ])

    expect(context).toContain('- shell {"command":"git push"}\n  Interrupted; outcome UNKNOWN. Do NOT repeat blindly.')
    expect(context).toContain('- web_fetch {"url":"https://example.com"}\n  Interrupted; safe to re-run.')
    expect(context).toContain('- legacy_tool {}\n  Interrupted; outcome UNKNOWN.')
    expect(context).not.toContain('Finished tool calls')
  })

  it('collapses all but the most recent 25 finished calls to a status line', () => {
    const entries = Array.from({ length: 30 }, (_, i) => entry({
      toolName: `tool_${i + 1}`,
      args: `{"n":${i + 1}}`,
      result: `result ${i + 1}`,
    }))

    const context = formatJournalRecoveryContext(entries)

    expect(context).toContain('5. tool_5 → completed\n6. tool_6 {"n":6} → completed\n   Result: result 6')
    expect(context).not.toContain('result 5')
    expect(context).toContain('30. tool_30 {"n":30} → completed')
  })

  it('caps long arguments and results', () => {
    const context = formatJournalRecoveryContext([
      entry({ toolName: 'write_file', args: 'a'.repeat(600), result: 'b'.repeat(700), replay: 'unsafe' }),
    ])

    expect(context).toContain(`${'a'.repeat(500)}… [truncated 100 chars]`)
    expect(context).toContain(`${'b'.repeat(500)}… [truncated 200 chars]`)
  })
})
