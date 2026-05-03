import type { TtsSettings } from './useSettings'

export interface MistralVoice {
  id: string
  name: string
  languages: string[]
  isPreset: boolean
}

let audioElement: HTMLAudioElement | null = null
let currentBlobUrl: string | null = null

export function useTts() {
  const { apiFetch } = useApi()
  const { getAccessToken } = useAuth()
  const config = useRuntimeConfig()

  /** Index of the message currently being played */
  const playingIndex = useState<number | null>('tts_playing_index', () => null)
  /** Whether audio is currently loading (fetching from server) */
  const loading = useState<boolean>('tts_loading', () => false)
  /** TTS settings (cached) */
  const ttsSettings = useState<TtsSettings | null>('tts_settings', () => null)
  /** Whether TTS is enabled */
  const ttsEnabled = computed(() => ttsSettings.value?.enabled ?? false)
  /** Mistral voices (fetched from API) */
  const mistralVoices = useState<MistralVoice[]>('tts_mistral_voices', () => [])
  /** Whether voices are loading */
  const voicesLoading = useState<boolean>('tts_voices_loading', () => false)
  /**
   * Last playback error (server message or network failure). Cleared on
   * each new `play()` call. Surfaced inline in the chat so a failed
   * “Read aloud” click doesn't look like a dead button — the most common
   * Deepgram failure mode (text >2000 chars) used to disappear into the
   * console.
   */
  const error = useState<string | null>('tts_error', () => null)

  /** Fetch TTS settings from the server */
  async function fetchTtsSettings(): Promise<void> {
    try {
      ttsSettings.value = await apiFetch<TtsSettings>('/api/tts/settings')
    } catch {
      ttsSettings.value = null
    }
  }

  /** Fetch available Mistral voices */
  async function fetchMistralVoices(): Promise<void> {
    voicesLoading.value = true
    try {
      const data = await apiFetch<{ voices: MistralVoice[] }>('/api/tts/voices')
      mistralVoices.value = data.voices
    } catch {
      mistralVoices.value = []
    } finally {
      voicesLoading.value = false
    }
  }

  /** Stop any currently playing audio */
  function stop() {
    if (audioElement) {
      audioElement.pause()
      audioElement.removeAttribute('src')
      audioElement.load()
      audioElement = null
    }
    if (currentBlobUrl) {
      URL.revokeObjectURL(currentBlobUrl)
      currentBlobUrl = null
    }
    playingIndex.value = null
    loading.value = false
  }

  /** Clear the last error banner (e.g. when the user dismisses it). */
  function clearError() {
    error.value = null
  }

  /**
   * Play TTS for the given text.
   * If the same index is already playing, stop it (toggle behavior).
   */
  async function play(text: string, messageIndex: number) {
    // Toggle behavior: clicking the speaker on an already-playing message stops it.
    if (playingIndex.value === messageIndex) {
      stop()
      return
    }

    stop()
    error.value = null

    if (!text.trim()) return

    loading.value = true
    playingIndex.value = messageIndex

    try {
      const token = getAccessToken()
      const apiBase = config.public.apiBase as string

      const response = await fetch(`${apiBase}/api/tts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ text }),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' })) as { error?: string }
        throw new Error(errorData.error ?? `HTTP ${response.status}`)
      }

      const blob = await response.blob()
      currentBlobUrl = URL.createObjectURL(blob)

      audioElement = new Audio(currentBlobUrl)
      audioElement.onended = () => {
        stop()
      }
      audioElement.onerror = () => {
        stop()
      }

      await audioElement.play()
      loading.value = false
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('TTS playback failed:', err)
      error.value = message
      stop()
    }
  }

  return {
    playingIndex,
    loading,
    ttsEnabled,
    ttsSettings,
    mistralVoices,
    voicesLoading,
    error,
    fetchTtsSettings,
    fetchMistralVoices,
    play,
    stop,
    clearError,
  }
}
