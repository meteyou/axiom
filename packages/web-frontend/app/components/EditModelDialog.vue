<template>
  <Dialog :open="open" @update:open="(v: boolean) => { if (!v) emit('close') }">
    <DialogContent class="max-h-[90vh] max-w-lg overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{{ $t('providers.editModelDialogTitle') }}</DialogTitle>
        <DialogDescription>
          {{ $t('providers.editModelDialogDescription') }}
        </DialogDescription>
      </DialogHeader>

      <div v-if="provider && modelId" class="flex flex-col gap-4">
        <!-- Model identity -->
        <div class="flex items-start justify-between gap-3">
          <div class="flex min-w-0 flex-col gap-0.5">
            <span class="text-sm font-medium text-foreground">{{ provider.name }}</span>
            <span class="truncate font-mono text-xs text-muted-foreground">{{ modelId }}</span>
          </div>
          <button
            v-if="specsEditable"
            type="button"
            class="shrink-0 text-xs text-primary hover:underline"
            @click="showImport = !showImport"
          >
            {{ $t('providers.editModelImportToggle') }}
          </button>
        </div>

        <!-- pi models.json import -->
        <div v-if="specsEditable && showImport" class="flex flex-col gap-1.5 rounded-md border border-border p-3">
          <Label for="model-import">{{ $t('providers.editModelImportLabel') }}</Label>
          <textarea
            id="model-import"
            v-model="importText"
            rows="5"
            class="flex w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            :placeholder="$t('providers.editModelImportPlaceholder')"
          />
          <div class="flex items-center justify-between gap-2">
            <span v-if="importError" class="text-xs text-destructive">{{ importError }}</span>
            <span v-else class="text-xs text-muted-foreground">{{ $t('providers.editModelImportHint') }}</span>
            <Button type="button" size="sm" variant="outline" :disabled="!importText.trim()" @click="applyImport">
              {{ $t('providers.editModelImportApply') }}
            </Button>
          </div>
        </div>

        <!-- Display name -->
        <div v-if="specsEditable" class="flex flex-col gap-1.5">
          <Label for="model-name">{{ $t('providers.editModelNameLabel') }}</Label>
          <Input id="model-name" v-model="form.name" type="text" :placeholder="spec?.name ?? modelId" class="text-sm" />
        </div>

        <!-- Description -->
        <div class="flex flex-col gap-1.5">
          <Label for="model-description">{{ $t('providers.editModelDescriptionLabel') }}</Label>
          <textarea
            id="model-description"
            v-model="form.description"
            rows="3"
            class="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            :placeholder="$t('providers.editModelDescriptionPlaceholder')"
          />
        </div>

        <template v-if="specsEditable">
          <!-- Token limits -->
          <div class="flex flex-col gap-2">
            <Label>{{ $t('providers.editModelLimitsSection') }}</Label>
            <div class="grid grid-cols-2 gap-2">
              <div class="flex flex-col gap-1">
                <Label for="model-context-window" class="text-xs text-muted-foreground">
                  {{ $t('providers.editModelContextWindow') }}
                </Label>
                <Input
                  id="model-context-window"
                  v-model="form.contextWindow"
                  type="number"
                  min="1"
                  step="1"
                  inputmode="numeric"
                  :placeholder="spec ? String(spec.contextWindow) : ''"
                  class="text-sm"
                />
              </div>
              <div class="flex flex-col gap-1">
                <Label for="model-max-tokens" class="text-xs text-muted-foreground">
                  {{ $t('providers.editModelMaxTokens') }}
                </Label>
                <Input
                  id="model-max-tokens"
                  v-model="form.maxTokens"
                  type="number"
                  min="1"
                  step="1"
                  inputmode="numeric"
                  :placeholder="spec ? String(spec.maxTokens) : ''"
                  class="text-sm"
                />
              </div>
            </div>
          </div>

          <!-- Capabilities -->
          <div class="flex flex-col gap-3">
            <Label>{{ $t('providers.editModelCapabilitiesSection') }}</Label>
            <label class="flex items-center justify-between gap-3 text-sm">
              <span class="flex flex-col">
                <span>{{ $t('providers.editModelImageInput') }}</span>
                <span class="text-xs text-muted-foreground">{{ $t('providers.editModelImageInputHint') }}</span>
              </span>
              <Switch v-model:checked="form.imageInput" />
            </label>
            <label class="flex items-center justify-between gap-3 text-sm">
              <span class="flex flex-col">
                <span>{{ $t('providers.editModelReasoning') }}</span>
                <span class="text-xs text-muted-foreground">{{ $t('providers.editModelReasoningHint') }}</span>
              </span>
              <Switch v-model:checked="form.reasoning" />
            </label>
          </div>

          <!-- Thinking level map -->
          <div v-if="form.reasoning" class="flex flex-col gap-2">
            <Label>{{ $t('providers.editModelThinkingSection') }}</Label>
            <div class="divide-y divide-border rounded-md border border-border">
              <div
                v-for="row in form.thinkingRows"
                :key="row.level"
                class="flex items-center gap-3 px-3 py-1.5"
              >
                <input
                  :id="`thinking-${row.level}`"
                  v-model="row.supported"
                  type="checkbox"
                  class="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                >
                <label :for="`thinking-${row.level}`" class="w-20 shrink-0 font-mono text-xs">{{ row.level }}</label>
                <Input
                  v-model="row.value"
                  type="text"
                  :disabled="!row.supported"
                  :placeholder="row.level"
                  :aria-label="$t('providers.editModelThinkingValue', { level: row.level })"
                  class="h-7 text-xs"
                />
              </div>
            </div>
            <p class="text-xs text-muted-foreground">{{ $t('providers.editModelThinkingHint') }}</p>
          </div>
        </template>

        <!-- Cost -->
        <div class="flex flex-col gap-2">
          <Label>{{ $t('providers.editModelCostSection') }}</Label>
          <div class="grid grid-cols-2 gap-2">
            <div class="flex flex-col gap-1">
              <Label for="model-cost-input" class="text-xs text-muted-foreground">
                {{ $t('providers.editModelCostInput') }}
              </Label>
              <Input
                id="model-cost-input"
                v-model="form.costInput"
                type="number"
                min="0"
                step="0.01"
                inputmode="decimal"
                :placeholder="costPlaceholder('input')"
                class="text-sm"
              />
            </div>
            <div class="flex flex-col gap-1">
              <Label for="model-cost-output" class="text-xs text-muted-foreground">
                {{ $t('providers.editModelCostOutput') }}
              </Label>
              <Input
                id="model-cost-output"
                v-model="form.costOutput"
                type="number"
                min="0"
                step="0.01"
                inputmode="decimal"
                :placeholder="costPlaceholder('output')"
                class="text-sm"
              />
            </div>
          </div>

          <div v-if="showCacheFields" class="grid grid-cols-2 gap-2">
            <div class="flex flex-col gap-1">
              <Label for="model-cost-cache-read" class="text-xs text-muted-foreground">
                {{ $t('providers.editModelCostCacheRead') }}
              </Label>
              <Input
                id="model-cost-cache-read"
                v-model="form.costCacheRead"
                type="number"
                min="0"
                step="0.01"
                inputmode="decimal"
                :placeholder="costPlaceholder('cacheRead')"
                class="text-sm"
              />
            </div>
            <div class="flex flex-col gap-1">
              <Label for="model-cost-cache-write" class="text-xs text-muted-foreground">
                {{ $t('providers.editModelCostCacheWrite') }}
              </Label>
              <Input
                id="model-cost-cache-write"
                v-model="form.costCacheWrite"
                type="number"
                min="0"
                step="0.01"
                inputmode="decimal"
                :placeholder="costPlaceholder('cacheWrite')"
                class="text-sm"
              />
            </div>
          </div>
          <p class="text-xs text-muted-foreground">{{ $t('providers.editModelCostHint') }}</p>
        </div>
      </div>

      <div v-if="provider && modelId" class="flex flex-col gap-2">
        <Label>{{ $t('providers.editModelCompactionSection') }}</Label>
        <div class="grid grid-cols-2 gap-2">
          <div class="flex flex-col gap-1">
            <Label for="model-compaction-reserve" class="text-xs text-muted-foreground">
              {{ $t('providers.editModelCompactionReserve') }}
            </Label>
            <Input
              id="model-compaction-reserve"
              v-model="form.compactionReserveTokens"
              type="number"
              min="1"
              step="1"
              inputmode="numeric"
              :placeholder="$t('providers.editModelCompactionGlobal')"
              class="text-sm"
            />
          </div>
          <div class="flex flex-col gap-1">
            <Label for="model-compaction-keep" class="text-xs text-muted-foreground">
              {{ $t('providers.editModelCompactionKeep') }}
            </Label>
            <Input
              id="model-compaction-keep"
              v-model="form.compactionKeepRecentTokens"
              type="number"
              min="1"
              step="1"
              inputmode="numeric"
              :placeholder="$t('providers.editModelCompactionGlobal')"
              class="text-sm"
            />
          </div>
        </div>
        <p class="text-xs text-muted-foreground">{{ $t('providers.editModelCompactionHint') }}</p>
        <p v-if="compactionWarningScopes.length > 0" class="text-xs text-destructive">
          {{ $t('providers.compactionWarning', { scopes: compactionWarningScopes }) }}
        </p>
      </div>

      <p v-if="provider && modelId" class="text-xs text-muted-foreground">{{ $t('providers.editModelOverrideHint') }}</p>

      <DialogFooter>
        <Button
          v-if="hasOverrides"
          variant="ghost"
          class="sm:mr-auto"
          :disabled="saving"
          @click="handleReset"
        >
          {{ $t('providers.editModelReset') }}
        </Button>
        <Button variant="outline" :disabled="saving" @click="emit('close')">
          {{ $t('providers.cancel') }}
        </Button>
        <Button :disabled="!canSave || saving" @click="handleSave">
          <span
            v-if="saving"
            class="mr-1.5 h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground"
          />
          {{ $t('providers.editModelSave') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import type { Provider } from '~/features/providers/composables/useProviders'
import type { ModelThinkingLevelMapContract, ProviderModelUpdatePayloadContract } from '@axiom/core/contracts'
import {
  parsePiModelSpec,
  rowsToThinkingMap,
  thinkingMapsEqual,
  thinkingMapToRows,
  type ThinkingLevelRow,
} from '~/utils/modelSpecForm'

const props = defineProps<{
  open: boolean
  provider: Provider | null
  modelId: string | null
}>()

const emit = defineEmits<{
  close: []
  saved: []
}>()

const { updateProviderModel, presets } = useProviders()
const { t } = useI18n()

const form = reactive({
  name: '',
  description: '',
  contextWindow: '',
  maxTokens: '',
  imageInput: true,
  reasoning: false,
  thinkingRows: [] as ThinkingLevelRow[],
  costInput: '',
  costOutput: '',
  costCacheRead: '',
  costCacheWrite: '',
  compactionReserveTokens: '',
  compactionKeepRecentTokens: '',
})
const saving = ref(false)
const showImport = ref(false)
const importText = ref('')
const importError = ref('')

let initialImageInput = true
let initialReasoning = false
let initialThinkingMap: ModelThinkingLevelMapContract | null = null

const existingEntry = computed(() =>
  props.provider?.models?.find(m => m.id === props.modelId),
)

const spec = computed(() =>
  props.provider && props.modelId ? props.provider.modelSpecs?.[props.modelId] : undefined,
)

const specsEditable = computed(() =>
  Boolean(props.provider && presets.value[props.provider.providerType]?.editableModelSpecs),
)

/** Effective cost (override → catalog); shown as placeholder for empty fields. */
const resolvedCost = computed(() =>
  (props.provider && props.modelId ? props.provider.modelCosts?.[props.modelId] : undefined)
  ?? existingEntry.value?.cost,
)

const OVERRIDE_KEYS = ['name', 'contextWindow', 'maxTokens', 'reasoning', 'input', 'thinkingLevelMap', 'cost', 'compaction'] as const

const compactionWarningScopes = computed(() =>
  (spec.value?.compactionWarnings ?? []).map(scope => t(`providers.compactionScopes.${scope}`)).join(', '),
)

const hasOverrides = computed(() => {
  const entry = existingEntry.value
  return Boolean(entry && OVERRIDE_KEYS.some(key => entry[key] !== undefined))
})

const isAnthropicProvider = computed(() => {
  const pt = props.provider?.providerType
  return pt === 'anthropic' || pt === 'anthropic-oauth'
})

const showCacheFields = computed(() => {
  if (specsEditable.value) return true
  const cost = resolvedCost.value
  if (cost && (cost.cacheRead != null || cost.cacheWrite != null)) return true
  return isAnthropicProvider.value
})

function costPlaceholder(field: 'input' | 'output' | 'cacheRead' | 'cacheWrite'): string {
  const cost = resolvedCost.value
  if (!cost) return '0.00'
  const value = cost[field]
  return value != null ? String(value) : '0.00'
}

function parseCostField(value: string): number | undefined {
  const trimmed = String(value ?? '').trim()
  if (trimmed === '') return undefined
  const num = Number(trimmed)
  if (!Number.isFinite(num) || num < 0) return undefined
  return num
}

function parsePositiveInteger(value: string): number | undefined {
  const trimmed = String(value ?? '').trim()
  if (trimmed === '') return undefined
  const num = Number(trimmed)
  return Number.isInteger(num) && num > 0 ? num : undefined
}

const canSave = computed(() => {
  // Gates on the dialog having a target provider and model. The server
  // enforces non-empty patches (at least a description or cost field).
  return Boolean(props.provider && props.modelId)
})

/**
 * A filled field is an override; clearing a field that had an override sends
 * `null` so the value follows the catalog again.
 */
function overrideChange<T>(next: T | undefined, current: T | undefined): T | null | undefined {
  if (next === undefined) return current === undefined ? undefined : null
  return next === current ? undefined : next
}

function applySpecPatch(payload: ProviderModelUpdatePayloadContract) {
  const entry = existingEntry.value
  const name = form.name.trim()
  if (name !== (entry?.name ?? '')) payload.name = name

  const contextWindow = overrideChange(parsePositiveInteger(form.contextWindow), entry?.contextWindow)
  if (contextWindow !== undefined) payload.contextWindow = contextWindow
  const maxTokens = overrideChange(parsePositiveInteger(form.maxTokens), entry?.maxTokens)
  if (maxTokens !== undefined) payload.maxTokens = maxTokens

  if (form.imageInput !== initialImageInput) payload.input = form.imageInput ? ['text', 'image'] : ['text']
  if (form.reasoning !== initialReasoning) payload.reasoning = form.reasoning

  if (form.reasoning) {
    const thinkingLevelMap = rowsToThinkingMap(form.thinkingRows, initialThinkingMap ?? undefined)
    if (!thinkingMapsEqual(thinkingLevelMap, initialThinkingMap)) payload.thinkingLevelMap = thinkingLevelMap
  }
}

function buildCompactionPatch(): ProviderModelUpdatePayloadContract['compaction'] {
  const current = existingEntry.value?.compaction
  const patch: NonNullable<ProviderModelUpdatePayloadContract['compaction']> = {}
  const reserveTokens = overrideChange(parsePositiveInteger(form.compactionReserveTokens), current?.reserveTokens)
  if (reserveTokens !== undefined) patch.reserveTokens = reserveTokens
  const keepRecentTokens = overrideChange(parsePositiveInteger(form.compactionKeepRecentTokens), current?.keepRecentTokens)
  if (keepRecentTokens !== undefined) patch.keepRecentTokens = keepRecentTokens
  return Object.keys(patch).length > 0 ? patch : undefined
}

async function handleSave() {
  if (!props.provider || !props.modelId) return
  saving.value = true
  try {
    const payload: ProviderModelUpdatePayloadContract = {
      description: form.description,
    }
    if (specsEditable.value) applySpecPatch(payload)

    const currentCost = existingEntry.value?.cost
    const fields = {
      input: form.costInput,
      output: form.costOutput,
      cacheRead: form.costCacheRead,
      cacheWrite: form.costCacheWrite,
    } as const
    const cost: NonNullable<ProviderModelUpdatePayloadContract['cost']> = {}
    for (const [key, raw] of Object.entries(fields) as [keyof typeof fields, string][]) {
      const change = overrideChange(parseCostField(raw), currentCost?.[key])
      if (change !== undefined) cost[key] = change
    }
    if (Object.keys(cost).length > 0) payload.cost = cost

    const compaction = buildCompactionPatch()
    if (compaction) payload.compaction = compaction

    const result = await updateProviderModel(props.provider.id, props.modelId, payload)
    if (result) {
      emit('saved')
      emit('close')
    }
  } finally {
    saving.value = false
  }
}

async function handleReset() {
  if (!props.provider || !props.modelId) return
  saving.value = true
  try {
    const result = await updateProviderModel(props.provider.id, props.modelId, {
      name: '',
      contextWindow: null,
      maxTokens: null,
      reasoning: null,
      input: null,
      thinkingLevelMap: null,
      cost: { input: null, output: null, cacheRead: null, cacheWrite: null },
      compaction: null,
    })
    if (result) {
      emit('saved')
      emit('close')
    }
  } finally {
    saving.value = false
  }
}

function applyImport() {
  if (!props.modelId) return
  const imported = parsePiModelSpec(importText.value, props.modelId)
  if (!imported) {
    importError.value = t('providers.editModelImportError', { id: props.modelId })
    return
  }
  importError.value = ''
  if (imported.name) form.name = imported.name
  if (imported.contextWindow) form.contextWindow = String(imported.contextWindow)
  if (imported.maxTokens) form.maxTokens = String(imported.maxTokens)
  if (imported.input) form.imageInput = imported.input.includes('image')
  if (imported.reasoning !== undefined) form.reasoning = imported.reasoning
  if (imported.thinkingLevelMap) form.thinkingRows = thinkingMapToRows(imported.thinkingLevelMap)
  if (imported.cost) {
    const { input, output, cacheRead, cacheWrite } = imported.cost
    if (input !== undefined) form.costInput = String(input)
    if (output !== undefined) form.costOutput = String(output)
    if (cacheRead !== undefined) form.costCacheRead = String(cacheRead)
    if (cacheWrite !== undefined) form.costCacheWrite = String(cacheWrite)
  }
  showImport.value = false
  importText.value = ''
}

function loadFromEntry() {
  const entry = existingEntry.value
  const resolvedSpec = spec.value
  form.name = entry?.name ?? ''
  form.description = entry?.description ?? ''
  form.contextWindow = entry?.contextWindow != null ? String(entry.contextWindow) : ''
  form.maxTokens = entry?.maxTokens != null ? String(entry.maxTokens) : ''

  initialImageInput = (resolvedSpec?.input ?? entry?.input ?? ['text', 'image']).includes('image')
  initialReasoning = resolvedSpec?.reasoning ?? entry?.reasoning ?? false
  const thinkingMap = resolvedSpec?.thinkingLevelMap ?? entry?.thinkingLevelMap
  form.thinkingRows = thinkingMapToRows(thinkingMap)
  initialThinkingMap = rowsToThinkingMap(form.thinkingRows, thinkingMap)
  form.imageInput = initialImageInput
  form.reasoning = initialReasoning

  form.costInput = entry?.cost?.input != null ? String(entry.cost.input) : ''
  form.costOutput = entry?.cost?.output != null ? String(entry.cost.output) : ''
  form.costCacheRead = entry?.cost?.cacheRead != null ? String(entry.cost.cacheRead) : ''
  form.costCacheWrite = entry?.cost?.cacheWrite != null ? String(entry.cost.cacheWrite) : ''
  form.compactionReserveTokens = entry?.compaction?.reserveTokens != null ? String(entry.compaction.reserveTokens) : ''
  form.compactionKeepRecentTokens = entry?.compaction?.keepRecentTokens != null ? String(entry.compaction.keepRecentTokens) : ''

  showImport.value = false
  importText.value = ''
  importError.value = ''
}

watch(
  () => [props.open, props.provider?.id, props.modelId] as const,
  ([isOpen]) => {
    if (isOpen) {
      loadFromEntry()
    }
  },
  { immediate: true },
)
</script>
