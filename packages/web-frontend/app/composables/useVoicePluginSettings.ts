/**
 * Composable for persisting and reading Voice Plugin settings from localStorage.
 *
 * Settings are stored under the key `voice-plugin-settings` and are reactive
 * so any component can read the latest values after a save.
 */

export interface VoicePluginSettings {
  /** URL of the Whisper inference endpoint */
  whisperUrl: string
  /** Whether Ollama rewriting is enabled */
  rewriteEnabled: boolean
  /** Base URL of the Ollama instance */
  ollamaUrl: string
  /** Ollama model to use for rewriting */
  ollamaModel: string
  /** System prompt sent to Ollama for rewriting */
  rewritePrompt: string
}

const STORAGE_KEY = 'voice-plugin-settings'

const DEFAULTS: VoicePluginSettings = {
  whisperUrl: 'https://whisper.jansohn.xyz/inference',
  rewriteEnabled: false,
  ollamaUrl: 'http://192.168.10.222:11434',
  ollamaModel: 'qwen3:32b',
  rewritePrompt: `You are a prompt architect. The user has dictated a voice message that should become a prompt for an AI assistant.

Your task:
- Convert the transcribed speech into a single, clean, optimized prompt
- Remove filler words, repetitions, and spoken artifacts
- Preserve the full intent and all relevant details
- Output ONLY the optimized prompt — no explanations, no alternatives, no labels

Transcript: {{transcript}}`,
}

/** Reactive shared state — initialised once from localStorage */
const _settings = ref<VoicePluginSettings>({ ...DEFAULTS })
let _initialised = false

function _init() {
  if (_initialised || !import.meta.client) return
  _initialised = true
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<VoicePluginSettings>
      _settings.value = { ...DEFAULTS, ...parsed }
    }
  } catch {
    // Ignore — use defaults
  }
}

export function useVoicePluginSettings() {
  _init()

  /** Current settings (reactive) */
  const settings = computed(() => _settings.value)

  /**
   * Persist new settings to localStorage and update reactive state.
   */
  function saveSettings(next: VoicePluginSettings) {
    _settings.value = { ...next }
    if (import.meta.client) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    }
  }

  /** Reset to defaults without persisting (caller must call saveSettings to persist) */
  function getDefaults(): VoicePluginSettings {
    return { ...DEFAULTS }
  }

  return {
    settings,
    saveSettings,
    getDefaults,
  }
}
