import type { ToolJournalEntry } from './task-tool-journal.js'
import { truncateJournalText } from './task-tool-journal.js'

const DETAILED_CALL_LIMIT = 25
const ARGS_PREVIEW_CHARS = 500
const RESULT_PREVIEW_CHARS = 500

const SAFE_TO_RERUN_NOTE = 'Interrupted; safe to re-run.'
const OUTCOME_UNKNOWN_NOTE = 'Interrupted; outcome UNKNOWN. Do NOT repeat blindly. '
  + 'Verify the current state first (e.g. check `git log`/remote, sent folder, file contents) and only then decide.'

function indentContinuationLines(text: string, indent: string): string {
  return text.replace(/\n/g, `\n${indent}`)
}

function formatCallHeadline(entry: ToolJournalEntry): string {
  const args = entry.args ? ` ${truncateJournalText(entry.args, ARGS_PREVIEW_CHARS)}` : ''
  return `${entry.toolName}${indentContinuationLines(args, '   ')}`
}

function outcomeLabel(entry: ToolJournalEntry): string {
  return entry.status === 'error' ? 'failed' : 'completed'
}

function formatFinishedCallSummary(entry: ToolJournalEntry, position: number): string {
  return `${position}. ${entry.toolName} → ${outcomeLabel(entry)}`
}

function formatFinishedCallDetails(entry: ToolJournalEntry, position: number): string {
  const result = truncateJournalText(entry.result ?? '', RESULT_PREVIEW_CHARS)
  return `${position}. ${formatCallHeadline(entry)} → ${outcomeLabel(entry)}\n   Result: ${indentContinuationLines(result, '   ')}`
}

function formatInterruptedCall(entry: ToolJournalEntry): string {
  const note = entry.replay === 'safe' ? SAFE_TO_RERUN_NOTE : OUTCOME_UNKNOWN_NOTE
  return `- ${formatCallHeadline(entry)}\n  ${note}`
}

function formatFinishedCalls(finished: ToolJournalEntry[]): string[] {
  const summarizedCount = Math.max(0, finished.length - DETAILED_CALL_LIMIT)
  return finished.map((entry, i) => i < summarizedCount
    ? formatFinishedCallSummary(entry, i + 1)
    : formatFinishedCallDetails(entry, i + 1))
}

/**
 * Builds the resume instructions for a task whose previous run was killed by
 * a server restart, based on its tool journal (oldest entry first).
 */
export function formatJournalRecoveryContext(entries: ToolJournalEntry[]): string {
  const finished = entries.filter(entry => entry.status !== 'started')
  const interrupted = entries.filter(entry => entry.status === 'started')

  const sections = [
    `This task was interrupted by a server restart. The previous run made ${entries.length} tool call(s). `
      + 'Do not redo work that already completed.',
  ]

  if (finished.length > 0) {
    sections.push(`Finished tool calls (oldest first):\n${formatFinishedCalls(finished).join('\n')}`)
  }

  if (interrupted.length > 0) {
    sections.push(`Interrupted tool calls (started, never finished):\n${interrupted.map(formatInterruptedCall).join('\n')}`)
  }

  sections.push('Continue the task from this state.')

  return `<recovery_context>\n${sections.join('\n\n')}\n</recovery_context>`
}
