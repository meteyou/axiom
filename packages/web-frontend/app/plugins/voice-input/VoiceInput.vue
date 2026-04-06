<template>
  <!-- Wrapper: record button + variants popover -->
  <div class="relative flex items-end">
    <!-- Variants popover (shown above the button after processing, only when rewrite is enabled) -->
    <Transition
      enter-active-class="transition duration-150 ease-out"
      enter-from-class="translate-y-1 opacity-0"
      enter-to-class="translate-y-0 opacity-100"
      leave-active-class="transition duration-100 ease-in"
      leave-from-class="translate-y-0 opacity-100"
      leave-to-class="translate-y-1 opacity-0"
    >
      <div
        v-if="showVariants"
        ref="variantsPanel"
        class="absolute bottom-full mb-2 right-0 z-50 min-w-[280px] max-w-[360px] rounded-lg border border-border bg-popover p-2 shadow-lg text-popover-foreground"
        @keydown.esc="closeVariants"
      >
        <p class="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {{ $t('voice.selectVariant') }}
        </p>
        <button
          v-for="variant in allVariants"
          :key="variant.key"
          class="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus:outline-none focus:bg-accent"
          @click="selectVariant(variant.text)"
        >
          <span class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {{ variant.label }}
          </span>
          <span class="line-clamp-2 leading-snug text-foreground">{{ variant.text }}</span>
        </button>
      </div>
    </Transition>

    <!-- Inline toast notification -->
    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="translate-y-1 opacity-0"
      enter-to-class="translate-y-0 opacity-100"
      leave-active-class="transition duration-150 ease-in"
      leave-from-class="translate-y-0 opacity-100"
      leave-to-class="translate-y-1 opacity-0"
    >
      <div
        v-if="toast"
        class="absolute bottom-full mb-10 right-0 z-50 max-w-[280px] rounded-lg border px-3 py-2 text-xs shadow-md"
        :class="{
          'border-destructive/40 bg-destructive/10 text-destructive': toast.type === 'error',
          'border-warning/40 bg-warning/10 text-warning-foreground': toast.type === 'warning',
          'border-border bg-popover text-popover-foreground': toast.type === 'info',
        }"
      >
        {{ toast.message }}
      </div>
    </Transition>

    <!-- Record button -->
    <button
      type="button"
      :title="buttonTitle"
      :disabled="isProcessing"
      class="inline-flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
      :class="buttonClass"
      @click="handleClick"
    >
      <!-- Pulsing recording ring -->
      <span
        v-if="isRecording"
        class="absolute h-[42px] w-[42px] rounded-xl border-2 border-destructive animate-ping opacity-60 pointer-events-none"
      />
      <component :is="buttonIcon" class="h-4 w-4" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { Mic, Square, Loader2 } from 'lucide-vue-next'
import { onClickOutside } from '@vueuse/core'

// ── i18n & shared state ───────────────────────────────────────────────────────

const { t } = useI18n()
const { apiFetch } = useApi()
const { setText } = useChatInput()

// ── State machine ─────────────────────────────────────────────────────────────

type VoiceState = 'idle' | 'recording' | 'processing' | 'done'
const state = ref<VoiceState>('idle')

const isIdle = computed(() => state.value === 'idle')
const isRecording = computed(() => state.value === 'recording')
const isProcessing = computed(() => state.value === 'processing')
const showVariants = computed(() => state.value === 'done')

// ── Variants data ─────────────────────────────────────────────────────────────

const rawTranscript = ref('')
const rewriteEnabled = ref(false)
const variants = ref<{ corrected: string; rewritten: string; formal: string; short: string } | null>(null)

const allVariants = computed(() => {
  const items = []
  if (variants.value) {
    items.push({ key: 'corrected', label: t('voice.variants.corrected'), text: variants.value.corrected })
    items.push({ key: 'rewritten', label: t('voice.variants.rewritten'), text: variants.value.rewritten })
    items.push({ key: 'formal', label: t('voice.variants.formal'), text: variants.value.formal })
    items.push({ key: 'short', label: t('voice.variants.short'), text: variants.value.short })
  }
  // Raw transcript is always shown as last option in the popover
  if (rawTranscript.value) {
    items.push({ key: 'raw', label: t('voice.variants.raw'), text: rawTranscript.value })
  }
  return items
})

// ── Button appearance ─────────────────────────────────────────────────────────

const buttonIcon = computed(() => {
  if (isRecording.value) return Square
  if (isProcessing.value) return Loader2
  return Mic
})

const buttonClass = computed(() => {
  if (isRecording.value) {
    return 'relative border-destructive bg-destructive/10 text-destructive hover:bg-destructive/20'
  }
  if (isProcessing.value) {
    return 'border-input bg-background text-muted-foreground [&>svg]:animate-spin'
  }
  if (showVariants.value) {
    return 'border-primary bg-primary/10 text-primary hover:bg-primary/20'
  }
  return 'border-input bg-background text-muted-foreground hover:bg-muted'
})

const buttonTitle = computed(() => {
  if (isRecording.value) return t('voice.stopRecording')
  if (isProcessing.value) return t('voice.processing')
  if (showVariants.value) return t('voice.selectVariant')
  return t('voice.startRecording')
})

// ── MediaRecorder ─────────────────────────────────────────────────────────────

let mediaRecorder: MediaRecorder | null = null
let audioChunks: BlobPart[] = []

async function startRecording() {
  // Close any existing variant panel first
  closeVariants()

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (err) {
    console.error('[VoiceInput] Microphone access denied:', err)
    showToast(t('voice.errorMicNotAvailable'), 'error')
    return
  }

  audioChunks = []
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm'

  mediaRecorder = new MediaRecorder(stream, { mimeType })

  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      audioChunks.push(event.data)
    }
  }

  mediaRecorder.onstop = async () => {
    // Stop all tracks to release the microphone
    stream.getTracks().forEach((track) => track.stop())

    const audioBlob = new Blob(audioChunks, { type: mimeType })
    await processAudio(audioBlob, mimeType)
  }

  mediaRecorder.start()
  state.value = 'recording'
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop()
    state.value = 'processing'
  }
}

// ── API calls ─────────────────────────────────────────────────────────────────

async function processAudio(blob: Blob, mimeType: string) {
  state.value = 'processing'

  // Step 1: Transcribe
  let transcript: string
  try {
    const formData = new FormData()
    const extension = mimeType.includes('ogg') ? 'ogg' : 'webm'
    formData.append('audio', blob, `recording.${extension}`)

    const result = await apiFetch<{ transcript: string; rewriteEnabled: boolean }>('/api/plugins/voice/transcribe', {
      method: 'POST',
      body: formData,
    })
    transcript = result.transcript
    rewriteEnabled.value = result.rewriteEnabled ?? false
  } catch (err) {
    console.error('[VoiceInput] Transcription error:', err)
    showToast(t('voice.errorWhisper'), 'error')
    state.value = 'idle'
    return
  }

  rawTranscript.value = transcript

  // Standard flow: write "[Diktat] <transcript>" directly into the chat input
  if (!rewriteEnabled.value) {
    setText(`[Diktat] ${transcript}`)
    state.value = 'idle'
    return
  }

  // Optional rewrite flow (only when VOICE_REWRITE_ENABLED=true on the server)
  // Step 2: Rewrite (Ollama) — graceful fallback to raw transcript only
  try {
    const result = await apiFetch<{ corrected: string; rewritten: string; formal: string; short: string }>(
      '/api/plugins/voice/rewrite',
      {
        method: 'POST',
        body: JSON.stringify({ transcript }),
      },
    )
    variants.value = result
  } catch (err) {
    // Ollama not reachable — just show raw transcript in popover
    console.warn('[VoiceInput] Ollama rewrite failed, falling back to raw transcript:', err)
    variants.value = null
    showToast(t('voice.errorOllamaFallback'), 'warning')
  }

  state.value = 'done'
}

// ── Variant selection ─────────────────────────────────────────────────────────

function selectVariant(text: string) {
  setText(text)
  closeVariants()
}

function closeVariants() {
  if (state.value === 'done') {
    state.value = 'idle'
  }
  variants.value = null
  rawTranscript.value = ''
}

// ── Click handler ─────────────────────────────────────────────────────────────

function handleClick() {
  if (isRecording.value) {
    stopRecording()
  } else if (isIdle.value) {
    startRecording()
  }
  // ignore clicks while processing or showing variants (panel handles variant selection)
}

// ── Click-outside to close variants panel ─────────────────────────────────────

const variantsPanel = ref<HTMLElement | null>(null)
onClickOutside(variantsPanel, () => {
  if (showVariants.value) {
    closeVariants()
  }
})

// ── ESC key to close variants ─────────────────────────────────────────────────

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && showVariants.value) {
    closeVariants()
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

// ── Toast helper ──────────────────────────────────────────────────────────────

type ToastType = 'error' | 'warning' | 'info'
const toast = ref<{ message: string; type: ToastType } | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null

function showToast(message: string, type: ToastType = 'info') {
  if (toastTimer) clearTimeout(toastTimer)
  toast.value = { message, type }
  toastTimer = setTimeout(() => {
    toast.value = null
  }, 4000)
}
</script>
