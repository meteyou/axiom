export interface ConsolidationResult {
  /** Whether MEMORY.md was actually updated */
  updated: boolean
  /** The new MEMORY.md content (only if updated) */
  newContent?: string
  /** Number of daily files that were reviewed */
  dailyFilesReviewed: number
  /** Reason if not updated */
  reason?: string
  /** Token usage from the LLM call */
  usage?: {
    input: number
    output: number
  }
}
