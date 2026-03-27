<script setup lang="ts">
const props = defineProps<{
  modelValue: string
  saving?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'save'): void
}>()

const { t } = useI18n()

const previewMode = ref<'edit' | 'preview' | 'split'>('split')

const content = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})

function renderMarkdown(text: string): string {
  if (!text) return ''
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>')
    .replace(/\n{2,}/g, '<br/><br/>')
    .replace(/\n/g, '<br/>')
}
</script>

<template>
  <div class="flex flex-1 flex-col overflow-hidden min-h-0">
    <!-- Toolbar -->
    <div class="mb-2.5 flex shrink-0 items-center gap-1.5">
      <button
        v-for="mode in (['edit', 'preview', 'split'] as const)"
        :key="mode"
        type="button"
        :data-active="previewMode === mode"
        class="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[active=true]:border-primary/30 data-[active=true]:bg-primary/10 data-[active=true]:text-primary"
        @click="previewMode = mode"
      >
        {{ mode === 'edit' ? t('memory.edit') : mode === 'preview' ? t('memory.preview') : t('memory.split') }}
      </button>
    </div>

    <!-- Editor + preview area -->
    <div
      class="flex flex-1 gap-3 overflow-hidden min-h-0"
      :class="{
        'flex-col sm:flex-row': previewMode === 'split',
      }"
    >
      <!-- Editor pane -->
      <textarea
        v-if="previewMode !== 'preview'"
        v-model="content"
        :placeholder="t('memory.editorPlaceholder')"
        spellcheck="false"
        :class="[
          'resize-none rounded-xl border border-border bg-card p-4 font-mono text-sm text-foreground placeholder:text-muted-foreground leading-relaxed',
          'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background',
          'transition-colors overflow-y-auto',
          previewMode === 'split' ? 'flex-1 min-h-0 sm:w-1/2' : 'w-full flex-1 min-h-0',
        ]"
      />

      <!-- Preview pane -->
      <div
        v-if="previewMode !== 'edit'"
        :class="[
          'overflow-y-auto rounded-xl border border-border bg-card p-4 text-sm text-foreground leading-relaxed',
          'prose prose-sm max-w-none dark:prose-invert',
          previewMode === 'split' ? 'flex-1 min-h-0 sm:w-1/2' : 'w-full flex-1 min-h-0',
        ]"
        v-html="renderMarkdown(content)"
      />
    </div>

    <!-- Footer -->
    <div class="flex shrink-0 justify-end pt-3">
      <Button :disabled="saving" @click="$emit('save')">
        <span
          v-if="saving"
          class="mr-1.5 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground"
          aria-hidden="true"
        />
        {{ t('memory.save') }}
      </Button>
    </div>
  </div>
</template>
