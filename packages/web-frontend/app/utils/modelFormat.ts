export function formatModelCost(value: number): string {
  if (value >= 0.01) return value.toFixed(2)
  return value.toFixed(3)
}

export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = Math.round((tokens / 1_000_000) * 10) / 10
    return `${millions}M`
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`
  return String(tokens)
}

function formatUsd(value: number): string {
  return value >= 1 ? value.toFixed(2) : String(Number(value.toPrecision(2)))
}

/**
 * Voice prices are stored as USD per 1M units (TTS characters, STT audio
 * seconds) but entered like providers quote them: per 1M characters for TTS,
 * per minute of audio for STT.
 */
export function toVoicePriceInput(kind: 'stt' | 'tts', costPerMillion: number): number {
  return kind === 'tts' ? costPerMillion : Number(((costPerMillion * 60) / 1_000_000).toPrecision(6))
}

export function fromVoicePriceInput(kind: 'stt' | 'tts', value: number): number {
  return kind === 'tts' ? value : (value / 60) * 1_000_000
}

/** `costPerMillion` is USD per 1M input characters (TTS) or audio seconds (STT). */
export function formatVoiceModelPrice(kind: 'stt' | 'tts', costPerMillion: number): string {
  return kind === 'tts'
    ? `$${formatUsd(costPerMillion)} / 1M chars`
    : `$${formatUsd(costPerMillion * 60 / 1_000_000)} / min`
}
