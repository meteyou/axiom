<template>
  <!-- Admin gate -->
  <div v-if="!isAdmin" class="flex h-full flex-col items-center justify-center gap-3 p-10 text-center text-muted-foreground">
    <AppIcon name="lock" size="xl" class="h-10 w-10" />
    <h1 class="text-xl font-semibold text-foreground">{{ $t('admin.title') }}</h1>
    <p class="text-sm">{{ $t('admin.description') }}</p>
  </div>

  <!-- Page body -->
  <div v-else class="flex h-full flex-col overflow-hidden">
    <PageHeader :title="$t('plugins.title')" :subtitle="$t('plugins.subtitle')" />

    <div class="mx-auto flex w-full max-w-5xl flex-1 flex-col overflow-hidden p-6">
      <!-- Info banner: API coming soon -->
      <div class="mb-4 flex items-center gap-2.5 rounded-lg border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground shrink-0">
        <AppIcon name="info" class="h-4 w-4 shrink-0 text-muted-foreground/70" />
        <span>{{ $t('plugins.comingSoon') }}</span>
      </div>

      <!-- Empty state -->
      <div v-if="plugins.length === 0" class="flex flex-1 flex-col items-center justify-center gap-4 py-20 text-center text-muted-foreground">
        <AppIcon name="blocks" size="xl" class="h-12 w-12 opacity-40" />
        <p class="text-sm font-medium text-foreground">{{ $t('plugins.noPlugins') }}</p>
      </div>

      <!-- Plugin list -->
      <div v-else class="flex-1 space-y-3 overflow-y-auto min-h-0">
        <Card v-for="plugin in plugins" :key="plugin.id" class="transition-colors">
          <div class="flex items-center gap-4 p-4">
            <!-- Icon -->
            <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
              <AppIcon name="blocks" class="h-5 w-5 text-muted-foreground" />
            </div>

            <!-- Info -->
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-semibold text-foreground truncate">{{ plugin.name }}</span>
                <span class="text-xs text-muted-foreground">v{{ plugin.version }}</span>
                <!-- Status badge -->
                <span
                  class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset"
                  :class="pluginEnabled(plugin.id)
                    ? 'bg-success/10 text-success ring-success/20'
                    : 'bg-muted text-muted-foreground ring-border'"
                >
                  {{ pluginEnabled(plugin.id) ? $t('plugins.enabled') : $t('plugins.disabled') }}
                </span>
              </div>
              <p v-if="plugin.description" class="mt-0.5 text-sm text-muted-foreground line-clamp-2">
                {{ plugin.description }}
              </p>
            </div>

            <!-- Toggle switch -->
            <Switch
              :checked="pluginEnabled(plugin.id)"
              :aria-label="pluginEnabled(plugin.id) ? $t('plugins.enabled') : $t('plugins.disabled')"
              @update:checked="(val: boolean) => togglePlugin(plugin.id, val)"
            />
          </div>
        </Card>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { pluginEnabledStates, setPluginEnabled } from '~/utils/pluginRegistry'

const { user } = useAuth()
const isAdmin = computed(() => user.value?.role === 'admin')

// Static plugin metadata list (UI metadata only; enabled state comes from the registry)
const plugins = [
  {
    id: 'voice-input',
    name: 'Voice Input',
    version: '1.0.0',
    description: 'Record audio and transcribe it via Whisper. Inserts transcription with [Diktat] prefix into the chat input.',
  },
]

/** Read the current enabled state for a plugin from the reactive registry */
function pluginEnabled(id: string): boolean {
  return pluginEnabledStates.value[id] !== false
}

/** Toggle a plugin and persist the choice to localStorage */
function togglePlugin(id: string, val: boolean): void {
  setPluginEnabled(id, val)
  if (import.meta.client) {
    localStorage.setItem(`plugin:${id}`, JSON.stringify(val))
  }
}
</script>
