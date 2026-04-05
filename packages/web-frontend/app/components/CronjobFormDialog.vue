<template>
  <Dialog :open="open" @update:open="$emit('close')">
    <DialogContent class="max-w-lg max-h-[85vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{{ mode === 'create' ? $t('cronjobs.createTitle') : $t('cronjobs.editTitle') }}</DialogTitle>
        <DialogDescription>{{ mode === 'create' ? $t('cronjobs.createDescription') : $t('cronjobs.editDescription') }}</DialogDescription>
      </DialogHeader>

      <form class="space-y-4" @submit.prevent="onSubmit">
        <!-- Name -->
        <div class="space-y-2">
          <Label for="cronjob-name">{{ $t('cronjobs.form.name') }}</Label>
          <Input
            id="cronjob-name"
            v-model="form.name"
            :placeholder="$t('cronjobs.form.namePlaceholder')"
            required
          />
        </div>

        <!-- Prompt -->
        <div class="space-y-2">
          <Label for="cronjob-prompt">{{ $t('cronjobs.form.prompt') }}</Label>
          <textarea
            id="cronjob-prompt"
            v-model="form.prompt"
            rows="4"
            class="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            :placeholder="$t('cronjobs.form.promptPlaceholder')"
            required
          />
        </div>

        <!-- Schedule -->
        <div class="space-y-2">
          <Label for="cronjob-schedule">{{ $t('cronjobs.form.schedule') }}</Label>
          <Input
            id="cronjob-schedule"
            v-model="form.schedule"
            placeholder="0 9 * * *"
            required
          />
          <p class="text-xs text-muted-foreground">
            {{ $t('cronjobs.form.scheduleHelp') }}
          </p>
        </div>

        <!-- Action Type -->
        <div class="space-y-2">
          <Label for="cronjob-action-type">{{ $t('cronjobs.form.actionType') }}</Label>
          <Select v-model="form.actionType">
            <SelectTrigger id="cronjob-action-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="task">{{ $t('cronjobs.form.actionTypeTask') }}</SelectItem>
              <SelectItem value="injection">{{ $t('cronjobs.form.actionTypeInjection') }}</SelectItem>
            </SelectContent>
          </Select>
          <p class="text-xs text-muted-foreground">
            {{ form.actionType === 'injection' ? $t('cronjobs.form.actionTypeInjectionHelp') : $t('cronjobs.form.actionTypeTaskHelp') }}
          </p>
        </div>

        <!-- Provider (only for task type) -->
        <div v-if="form.actionType !== 'injection'" class="space-y-2">
          <Label for="cronjob-provider">{{ $t('cronjobs.form.provider') }}</Label>
          <Select v-model="form.provider">
            <SelectTrigger id="cronjob-provider">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">{{ $t('cronjobs.form.defaultProvider') }}</SelectItem>
              <SelectItem
                v-for="p in providers"
                :key="p.id"
                :value="p.name"
              >
                {{ p.name }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <!-- Advanced Section (Collapsible) — only for task type -->
        <div v-if="form.actionType !== 'injection'" class="border border-border rounded-md">
          <button
            type="button"
            class="flex w-full items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted/50 transition-colors"
            @click="advancedOpen = !advancedOpen"
          >
            <span class="flex items-center gap-2">
              {{ $t('cronjobs.form.advanced') }}
              <Badge v-if="hasOverrides" variant="outline" class="text-xs">
                {{ $t('cronjobs.form.customized') }}
              </Badge>
            </span>
            <AppIcon
              name="chevronDown"
              size="sm"
              class="text-muted-foreground transition-transform"
              :class="{ 'rotate-180': advancedOpen }"
            />
          </button>

          <div v-if="advancedOpen" class="border-t border-border px-4 py-4 space-y-5">
            <!-- Tool Overrides -->
            <div class="space-y-3">
              <Label>{{ $t('cronjobs.form.toolOverrides') }}</Label>
              <p class="text-xs text-muted-foreground">
                {{ $t('cronjobs.form.toolOverridesHelp') }}
              </p>
              <div class="space-y-2">
                <div
                  v-for="tool in availableTools"
                  :key="tool"
                  class="flex items-center justify-between py-1"
                >
                  <span class="text-sm font-mono">{{ tool }}</span>
                  <Switch
                    :checked="!disabledTools.includes(tool)"
                    @update:checked="(val: boolean) => toggleTool(tool, val)"
                  />
                </div>
              </div>
            </div>

            <Separator />

            <!-- Skill Overrides -->
            <div class="space-y-3">
              <Label>{{ $t('cronjobs.form.skillOverrides') }}</Label>
              <p class="text-xs text-muted-foreground">
                {{ $t('cronjobs.form.skillOverridesHelp') }}
              </p>
              <div v-if="availableSkills.length > 0" class="space-y-2">
                <div
                  v-for="skill in availableSkills"
                  :key="skill"
                  class="flex items-center justify-between py-1"
                >
                  <span class="text-sm">{{ skill }}</span>
                  <Switch
                    :checked="!disabledSkills.includes(skill)"
                    @update:checked="(val: boolean) => toggleSkill(skill, val)"
                  />
                </div>
              </div>
              <p v-else class="text-xs text-muted-foreground italic">
                {{ $t('cronjobs.form.noSkills') }}
              </p>
            </div>

            <Separator />

            <!-- System Prompt Override -->
            <div class="space-y-2">
              <Label for="cronjob-system-prompt">{{ $t('cronjobs.form.systemPromptOverride') }}</Label>
              <p class="text-xs text-muted-foreground">
                {{ $t('cronjobs.form.systemPromptOverrideHelp') }}
              </p>
              <textarea
                id="cronjob-system-prompt"
                v-model="form.systemPromptOverride"
                rows="5"
                class="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 font-mono"
                :placeholder="$t('cronjobs.form.systemPromptPlaceholder')"
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" @click="$emit('close')">
            {{ $t('common.cancel') }}
          </Button>
          <Button type="submit" :disabled="loading">
            {{ loading ? $t('common.saving') : (mode === 'create' ? $t('common.create') : $t('common.save')) }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import type { Cronjob } from '~/composables/useCronjobs'

const props = defineProps<{
  open: boolean
  mode: 'create' | 'edit'
  cronjob?: Cronjob | null
  loading: boolean
}>()

const emit = defineEmits<{
  close: []
  submit: [form: {
    name: string
    prompt: string
    schedule: string
    actionType?: 'task' | 'injection'
    provider?: string
    toolsOverride?: string | null
    skillsOverride?: string | null
    systemPromptOverride?: string | null
  }]
}>()

const { providers, fetchProviders } = useProviders()

const advancedOpen = ref(false)

/** Well-known tools available to task agents */
const availableTools = [
  'shell',
  'read_file',
  'write_file',
  'list_files',
  'web_search',
  'web_fetch',
  'memory_read',
  'memory_write',
]

/** Available skills — loaded from backend or statically known */
const availableSkills = ref<string[]>([
  'brave-search',
  'web-browser',
  'github',
])

const form = reactive({
  name: '',
  prompt: '',
  schedule: '',
  actionType: 'task' as 'task' | 'injection',
  provider: '',
  systemPromptOverride: '',
})

const disabledTools = ref<string[]>([])
const disabledSkills = ref<string[]>([])

const hasOverrides = computed(() => {
  return disabledTools.value.length > 0
    || disabledSkills.value.length > 0
    || (form.systemPromptOverride && form.systemPromptOverride.trim().length > 0)
})

watch(() => props.open, (isOpen) => {
  if (isOpen) {
    fetchProviders()
    if (props.mode === 'edit' && props.cronjob) {
      form.name = props.cronjob.name
      form.prompt = props.cronjob.prompt
      form.schedule = props.cronjob.schedule
      form.actionType = props.cronjob.actionType ?? 'task'
      form.provider = props.cronjob.provider ?? ''
      form.systemPromptOverride = props.cronjob.systemPromptOverride ?? ''

      // Parse tool overrides
      if (props.cronjob.toolsOverride) {
        try {
          disabledTools.value = JSON.parse(props.cronjob.toolsOverride)
        } catch {
          disabledTools.value = []
        }
      } else {
        disabledTools.value = []
      }

      // Parse skill overrides
      if (props.cronjob.skillsOverride) {
        try {
          disabledSkills.value = JSON.parse(props.cronjob.skillsOverride)
        } catch {
          disabledSkills.value = []
        }
      } else {
        disabledSkills.value = []
      }

      // Auto-expand advanced section if there are overrides
      advancedOpen.value = disabledTools.value.length > 0
        || disabledSkills.value.length > 0
        || (form.systemPromptOverride?.trim().length ?? 0) > 0
    } else {
      form.name = ''
      form.prompt = ''
      form.schedule = ''
      form.actionType = 'task'
      form.provider = ''
      form.systemPromptOverride = ''
      disabledTools.value = []
      disabledSkills.value = []
      advancedOpen.value = false
    }
  }
})

function toggleTool(tool: string, enabled: boolean) {
  if (enabled) {
    disabledTools.value = disabledTools.value.filter(t => t !== tool)
  } else {
    if (!disabledTools.value.includes(tool)) {
      disabledTools.value.push(tool)
    }
  }
}

function toggleSkill(skill: string, enabled: boolean) {
  if (enabled) {
    disabledSkills.value = disabledSkills.value.filter(s => s !== skill)
  } else {
    if (!disabledSkills.value.includes(skill)) {
      disabledSkills.value.push(skill)
    }
  }
}

function onSubmit() {
  emit('submit', {
    name: form.name,
    prompt: form.prompt,
    schedule: form.schedule,
    actionType: form.actionType,
    provider: form.actionType === 'injection' ? undefined : (form.provider || undefined),
    toolsOverride: form.actionType === 'injection' ? null : (
      disabledTools.value.length > 0 ? JSON.stringify(disabledTools.value) : null
    ),
    skillsOverride: form.actionType === 'injection' ? null : (
      disabledSkills.value.length > 0 ? JSON.stringify(disabledSkills.value) : null
    ),
    systemPromptOverride: form.actionType === 'injection' ? null : (form.systemPromptOverride?.trim() || null),
  })
}
</script>
