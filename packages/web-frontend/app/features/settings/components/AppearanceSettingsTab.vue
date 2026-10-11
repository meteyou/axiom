<template>
  <div>
    <div class="mb-8">
      <h2 class="text-lg font-semibold tracking-tight text-foreground">
        {{ $t('settings.tabs.appearance') }}
      </h2>
      <p class="mt-1 text-sm text-muted-foreground">
        {{ $t('settings.tabs.appearanceDescription') }}
      </p>
    </div>

    <div class="flex flex-col gap-2">
      <Label id="appearance-logo-label">{{ $t('settings.appearanceLogo') }}</Label>
      <div role="radiogroup" aria-labelledby="appearance-logo-label" class="grid grid-cols-3 gap-3">
        <button
          v-for="logo in SETTINGS_APP_LOGOS"
          :key="logo"
          type="button"
          role="radio"
          :aria-checked="settings.logo === logo"
          :data-logo="logo"
          class="flex flex-col items-center gap-2 rounded-lg border px-3 py-4 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          :class="settings.logo === logo
            ? 'border-primary bg-primary/[0.06] font-medium text-foreground'
            : 'border-border text-muted-foreground hover:border-primary/40 hover:text-foreground'"
          @click="settings.logo = logo"
        >
          <img :src="APP_LOGO_ASSETS[logo].src" alt="" class="h-12 w-12" draggable="false">
          <span>{{ $t(`settings.appearanceLogoOptions.${logo}`) }}</span>
        </button>
      </div>
      <p class="text-xs text-muted-foreground">{{ $t('settings.appearanceLogoHint') }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { SETTINGS_APP_LOGOS } from '@axiom/core/contracts'
import type { AppearanceSettings } from '~/composables/useSettings'
import { APP_LOGO_ASSETS } from '~/utils/appLogo'

const settings = defineModel<AppearanceSettings>({ required: true })
</script>
