<template>
  <!-- Admin gate -->
  <div v-if="!isAdmin" class="flex h-full flex-col items-center justify-center gap-3 p-10 text-center text-muted-foreground">
    <AppIcon name="lock" size="xl" />
    <h1 class="text-xl font-semibold text-foreground">{{ $t('admin.title') }}</h1>
    <p class="text-sm">{{ $t('admin.description') }}</p>
  </div>

  <!-- Settings page -->
  <div v-else class="flex h-full flex-col overflow-hidden">
    <!-- Header with save action (hidden on secrets tab which has its own save flow) -->
    <PageHeader :title="$t('settings.title')" :subtitle="$t('settings.subtitle')">
      <template v-if="activeTab !== 'secrets'" #actions>
        <Button :disabled="saving || !form" @click="handleSave">
          <span
            v-if="saving"
            class="h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground"
            aria-hidden="true"
          />
          {{ $t('settings.save') }}
        </Button>
      </template>
    </PageHeader>

    <!-- Feedback alerts — only for non-secrets tabs (secrets tab handles its own feedback) -->
    <div v-if="activeTab !== 'secrets' && (error || successMessage)" class="shrink-0 border-b border-border px-6 py-3">
      <Alert v-if="error" variant="destructive">
        <AlertDescription class="flex items-center justify-between">
          <span>{{ error }}</span>
          <button
            type="button"
            class="ml-2 opacity-70 transition-opacity hover:opacity-100"
            :aria-label="$t('aria.closeAlert')"
            @click="clearMessages()"
          >
            <AppIcon name="close" class="h-4 w-4" />
          </button>
        </AlertDescription>
      </Alert>
      <Alert v-if="successMessage" variant="success" :class="error ? 'mt-2' : ''">
        <AlertDescription class="flex items-center justify-between">
          <span>{{ $t('settings.saveSuccess') }}</span>
          <button
            type="button"
            class="ml-2 opacity-70 transition-opacity hover:opacity-100"
            :aria-label="$t('aria.closeAlert')"
            @click="clearMessages()"
          >
            <AppIcon name="close" class="h-4 w-4" />
          </button>
        </AlertDescription>
      </Alert>
    </div>

    <!-- Settings layout: sidebar nav + content -->
    <div class="flex min-h-0 flex-1 flex-col md:flex-row">

      <!-- Tab navigation — horizontal on mobile, vertical sidebar on desktop -->
      <nav
        role="tablist"
        :aria-label="$t('settings.title')"
        class="flex shrink-0 gap-0.5 overflow-x-auto border-b border-border px-3 py-2
               md:w-52 md:flex-col md:overflow-x-visible md:overflow-y-auto md:border-b-0 md:border-r md:px-3 md:py-4"
      >
        <button
          v-for="tab in tabs"
          :key="tab.id"
          role="tab"
          type="button"
          :aria-selected="activeTab === tab.id"
          :class="[
            'flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors',
            'md:w-full',
            activeTab === tab.id
              ? 'bg-accent font-medium text-accent-foreground'
              : 'text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground',
          ]"
          @click="activeTab = tab.id"
        >
          <AppIcon :name="tab.icon" size="sm" />
          <span>{{ tab.label }}</span>
        </button>
      </nav>

      <!-- Content area -->
      <div class="flex-1 overflow-y-auto" role="tabpanel">
        <div class="mx-auto max-w-xl px-6 py-6 md:px-8 md:py-8">

          <!-- Loading skeletons -->
          <div v-if="loading" class="flex flex-col gap-6">
            <div>
              <Skeleton class="mb-2 h-5 w-28" />
              <Skeleton class="h-4 w-72" />
            </div>
            <div>
              <Skeleton class="mb-1.5 h-4 w-24" />
              <Skeleton class="h-10 w-44" />
              <Skeleton class="mt-1.5 h-3 w-56" />
            </div>
            <div>
              <Skeleton class="mb-1.5 h-4 w-20" />
              <Skeleton class="h-10 w-56" />
              <Skeleton class="mt-1.5 h-3 w-48" />
            </div>
          </div>

          <!-- Tab content -->
          <template v-else-if="form">

            <!-- ═══ Agent ═══ -->
            <div v-if="activeTab === 'agent'">
              <div class="mb-8">
                <h2 class="text-lg font-semibold tracking-tight text-foreground">
                  {{ $t('settings.tabs.agent') }}
                </h2>
                <p class="mt-1 text-sm text-muted-foreground">
                  {{ $t('settings.tabs.agentDescription') }}
                </p>
              </div>

              <div class="flex flex-col gap-8">
                <!-- Language -->
                <div class="flex flex-col gap-2">
                  <Label for="language-select">{{ $t('settings.language') }}</Label>
                  <Select id="language-select" v-model="form.language">
                    <option value="match">{{ $t('settings.languageMatch') }}</option>
                    <option value="English">{{ $t('settings.languages.english') }}</option>
                    <option value="German">{{ $t('settings.languages.german') }}</option>
                    <option value="French">{{ $t('settings.languages.french') }}</option>
                    <option value="Spanish">{{ $t('settings.languages.spanish') }}</option>
                    <option value="Italian">{{ $t('settings.languages.italian') }}</option>
                    <option value="Portuguese">{{ $t('settings.languages.portuguese') }}</option>
                    <option value="Dutch">{{ $t('settings.languages.dutch') }}</option>
                    <option value="Russian">{{ $t('settings.languages.russian') }}</option>
                    <option value="Chinese">{{ $t('settings.languages.chinese') }}</option>
                    <option value="Japanese">{{ $t('settings.languages.japanese') }}</option>
                    <option value="Korean">{{ $t('settings.languages.korean') }}</option>
                  </Select>
                  <p class="text-xs text-muted-foreground">{{ $t('settings.languageHint') }}</p>
                </div>

                <!-- Timezone -->
                <div class="flex flex-col gap-2">
                  <Label for="timezone-select">{{ $t('settings.timezone') }}</Label>
                  <Select id="timezone-select" v-model="form.timezone">
                    <option v-for="tz in timezones" :key="tz" :value="tz">{{ tz }}</option>
                  </Select>
                  <p class="text-xs text-muted-foreground">{{ $t('settings.timezoneHint') }}</p>
                </div>

              </div>
            </div>

            <!-- ═══ Memory ═══ -->
            <div v-else-if="activeTab === 'memory'">
              <div class="mb-8">
                <h2 class="text-lg font-semibold tracking-tight text-foreground">
                  {{ $t('settings.tabs.memory') }}
                </h2>
                <p class="mt-1 text-sm text-muted-foreground">
                  {{ $t('settings.tabs.memoryDescription') }}
                </p>
              </div>

              <div class="flex flex-col gap-8">
                <!-- Session timeout -->
                <div class="flex flex-col gap-2">
                  <Label for="session-timeout">{{ $t('settings.sessionTimeout') }}</Label>
                  <div class="flex items-center gap-2">
                    <Input
                      id="session-timeout"
                      v-model.number="form.sessionTimeoutMinutes"
                      type="number"
                      min="1"
                      max="1440"
                      class="w-full"
                    />
                    <span class="text-sm text-muted-foreground">{{ $t('settings.minutes') }}</span>
                  </div>
                  <p class="text-xs text-muted-foreground">{{ $t('settings.sessionTimeoutHint') }}</p>
                  <Alert v-if="form.agentHeartbeat?.enabled" variant="info" class="mt-2">
                    <AlertDescription class="text-xs">
                      <AppIcon name="activity" size="sm" class="mr-1 inline-block align-text-bottom" />
                      {{ $t('settings.sessionSummarySkippedByHeartbeat') }}
                    </AlertDescription>
                  </Alert>
                </div>

                <div class="flex flex-col gap-2">
                  <Label for="upload-retention">Upload retention</Label>
                  <div class="flex items-center gap-2">
                    <Input id="upload-retention" v-model.number="form.uploadRetentionDays" type="number" min="0" class="w-full" />
                    <span class="text-sm text-muted-foreground">{{ $t('settings.days') }}</span>
                  </div>
                  <p class="text-xs text-muted-foreground">Delete uploaded files automatically after this many days. Set to 0 to remove them immediately on cleanup.</p>
                </div>

                <Separator />

                <!-- Enable toggle -->
                <div class="flex items-center justify-between rounded-lg border border-border px-4 py-3">
                  <div class="flex flex-col gap-0.5 pr-4">
                    <Label for="consolidation-enabled" class="cursor-pointer">
                      {{ $t('settings.consolidationEnabled') }}
                    </Label>
                    <p class="text-xs text-muted-foreground">
                      {{ $t('settings.consolidationEnabledHint') }}
                    </p>
                  </div>
                  <Switch
                    id="consolidation-enabled"
                    v-model="form.memoryConsolidation.enabled"
                  />
                </div>

                <!-- Configuration — progressive disclosure -->
                <template v-if="form.memoryConsolidation.enabled">
                  <div class="flex flex-col gap-8">
                    <div class="flex flex-col gap-2">
                      <Label for="consolidation-hour">{{ $t('settings.consolidationRunAtHour') }}</Label>
                      <div class="flex items-center gap-2">
                        <Input
                          id="consolidation-hour"
                          v-model.number="form.memoryConsolidation.runAtHour"
                          type="number"
                          min="0"
                          max="23"
                          class="w-full"
                        />
                        <span class="text-sm text-muted-foreground">{{ $t('settings.oClock') }}</span>
                      </div>
                      <p class="text-xs text-muted-foreground">{{ $t('settings.consolidationRunAtHourHint') }}</p>
                    </div>

                    <div class="flex flex-col gap-2">
                      <Label for="consolidation-days">{{ $t('settings.consolidationLookbackDays') }}</Label>
                      <div class="flex items-center gap-2">
                        <Input
                          id="consolidation-days"
                          v-model.number="form.memoryConsolidation.lookbackDays"
                          type="number"
                          min="1"
                          max="30"
                          class="w-full"
                        />
                        <span class="text-sm text-muted-foreground">{{ $t('settings.days') }}</span>
                      </div>
                      <p class="text-xs text-muted-foreground">{{ $t('settings.consolidationLookbackDaysHint') }}</p>
                    </div>

                    <div class="flex flex-col gap-2">
                      <Label for="consolidation-provider">{{ $t('settings.consolidationProvider') }}</Label>
                      <Select id="consolidation-provider" v-model="form.memoryConsolidation.providerId">
                        <option value="">{{ $t('settings.consolidationProviderDefault') }}</option>
                        <option v-for="p in providers" :key="p.id" :value="p.id">
                          {{ p.name }} ({{ p.defaultModel }})
                        </option>
                      </Select>
                      <p class="text-xs text-muted-foreground">{{ $t('settings.consolidationProviderHint') }}</p>
                    </div>

                    <!-- Manual run + status -->
                    <div class="flex flex-col gap-3 rounded-lg bg-muted/50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                      <div v-if="consolidationStatus" class="text-xs text-muted-foreground">
                        <span class="font-medium">{{ $t('settings.consolidationLastRun') }}:</span>
                        {{ consolidationStatus.lastRun ? new Date(consolidationStatus.lastRun).toLocaleString() : $t('settings.consolidationNeverRun') }}
                        <template v-if="consolidationStatus.lastResult">
                          · <span :class="consolidationStatus.lastResult.updated ? 'text-green-600 dark:text-green-400' : ''">
                            {{ consolidationStatus.lastResult.updated ? $t('settings.consolidationResultUpdated') : $t('settings.consolidationResultNoChange') }}
                          </span>
                        </template>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        class="shrink-0"
                        :disabled="consolidationRunning"
                        @click="handleRunConsolidation"
                      >
                        <span
                          v-if="consolidationRunning"
                          class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-foreground/30 border-t-foreground"
                          aria-hidden="true"
                        />
                        {{ consolidationRunning ? $t('settings.consolidationRunning') : $t('settings.consolidationRunNow') }}
                      </Button>
                    </div>
                  </div>
                </template>
              </div>
            </div>

            <!-- ═══ Agent Heartbeat ═══ -->
            <div v-else-if="activeTab === 'agentHeartbeat'">
              <div class="mb-8">
                <h2 class="text-lg font-semibold tracking-tight text-foreground">
                  {{ $t('settings.tabs.agentHeartbeat') }}
                </h2>
                <p class="mt-1 text-sm text-muted-foreground">
                  {{ $t('settings.tabs.agentHeartbeatDescription') }}
                </p>
              </div>

              <div class="flex flex-col gap-8">
                <!-- Enable toggle -->
                <div class="flex items-center justify-between rounded-lg border border-border px-4 py-3">
                  <div class="flex flex-col gap-0.5 pr-4">
                    <Label for="heartbeat-enabled" class="cursor-pointer">
                      {{ $t('settings.agentHeartbeatEnabled') }}
                    </Label>
                    <p class="text-xs text-muted-foreground">
                      {{ $t('settings.agentHeartbeatEnabledHint') }}
                    </p>
                  </div>
                  <Switch
                    id="heartbeat-enabled"
                    v-model="form.agentHeartbeat.enabled"
                  />
                </div>

                <!-- Configuration — progressive disclosure -->
                <template v-if="form.agentHeartbeat.enabled">
                  <!-- Interval -->
                  <div class="flex flex-col gap-2">
                    <Label for="heartbeat-interval">{{ $t('settings.agentHeartbeatInterval') }}</Label>
                    <div class="flex items-center gap-2">
                      <Input
                        id="heartbeat-interval"
                        v-model.number="form.agentHeartbeat.intervalMinutes"
                        type="number"
                        min="1"
                        max="1440"
                        class="w-full"
                      />
                      <span class="text-sm text-muted-foreground">{{ $t('settings.minutes') }}</span>
                    </div>
                    <p class="text-xs text-muted-foreground">{{ $t('settings.agentHeartbeatIntervalHint') }}</p>
                  </div>

                  <Separator />

                  <!-- Night mode section -->
                  <div>
                    <h3 class="text-base font-semibold tracking-tight text-foreground">
                      {{ $t('settings.agentHeartbeatNightMode') }}
                    </h3>
                    <p class="mt-1 text-sm text-muted-foreground">
                      {{ $t('settings.agentHeartbeatNightModeDescription') }}
                    </p>
                  </div>

                  <!-- Night mode enable -->
                  <div class="flex items-center justify-between rounded-lg border border-border px-4 py-3">
                    <div class="flex flex-col gap-0.5 pr-4">
                      <Label for="heartbeat-night-enabled" class="cursor-pointer">
                        {{ $t('settings.agentHeartbeatNightModeEnabled') }}
                      </Label>
                      <p class="text-xs text-muted-foreground">
                        {{ $t('settings.agentHeartbeatNightModeEnabledHint') }}
                      </p>
                    </div>
                    <Switch
                      id="heartbeat-night-enabled"
                      v-model="form.agentHeartbeat.nightMode.enabled"
                    />
                  </div>

                  <template v-if="form.agentHeartbeat.nightMode.enabled">
                    <!-- Night start hour -->
                    <div class="flex flex-col gap-2">
                      <Label for="heartbeat-night-start">{{ $t('settings.agentHeartbeatNightModeStart') }}</Label>
                      <div class="flex items-center gap-2">
                        <Input
                          id="heartbeat-night-start"
                          v-model.number="form.agentHeartbeat.nightMode.startHour"
                          type="number"
                          min="0"
                          max="23"
                          class="w-full"
                        />
                        <span class="text-sm text-muted-foreground">{{ $t('settings.oClock') }}</span>
                      </div>
                    </div>

                    <!-- Night end hour -->
                    <div class="flex flex-col gap-2">
                      <Label for="heartbeat-night-end">{{ $t('settings.agentHeartbeatNightModeEnd') }}</Label>
                      <div class="flex items-center gap-2">
                        <Input
                          id="heartbeat-night-end"
                          v-model.number="form.agentHeartbeat.nightMode.endHour"
                          type="number"
                          min="0"
                          max="23"
                          class="w-full"
                        />
                        <span class="text-sm text-muted-foreground">{{ $t('settings.oClock') }}</span>
                      </div>
                      <p class="text-xs text-muted-foreground">{{ $t('settings.agentHeartbeatNightModeHoursHint') }}</p>
                    </div>
                  </template>
                </template>
              </div>
            </div>

            <!-- ═══ Health Monitor ═══ -->
            <div v-else-if="activeTab === 'healthMonitor'">
              <div class="mb-8">
                <h2 class="text-lg font-semibold tracking-tight text-foreground">
                  {{ $t('settings.tabs.healthMonitor') }}
                </h2>
                <p class="mt-1 text-sm text-muted-foreground">
                  {{ $t('settings.tabs.healthMonitorDescription') }}
                </p>
              </div>

              <div class="flex flex-col gap-8">
                <!-- Health check interval -->
                <div class="flex flex-col gap-2">
                  <Label for="health-monitor-interval">{{ $t('settings.healthMonitorInterval') }}</Label>
                  <div class="flex items-center gap-2">
                    <Input
                      id="health-monitor-interval"
                      v-model.number="form.healthMonitorIntervalMinutes"
                      type="number"
                      min="1"
                      max="60"
                      class="w-full"
                    />
                    <span class="text-sm text-muted-foreground">{{ $t('settings.minutes') }}</span>
                  </div>
                  <p class="text-xs text-muted-foreground">{{ $t('settings.healthMonitorHint') }}</p>
                </div>

                <!-- Fallback trigger -->
                <div class="flex flex-col gap-2">
                  <Label for="fallback-trigger">{{ $t('settings.healthMonitorFallbackTrigger') }}</Label>
                  <Select id="fallback-trigger" v-model="form.healthMonitor.fallbackTrigger">
                    <option value="down">{{ $t('settings.healthMonitorFallbackTriggerDown') }}</option>
                    <option value="degraded">{{ $t('settings.healthMonitorFallbackTriggerDegraded') }}</option>
                  </Select>
                  <p class="text-xs text-muted-foreground">{{ $t('settings.healthMonitorFallbackTriggerHint') }}</p>
                </div>

                <!-- Failures before fallback -->
                <div class="flex flex-col gap-2">
                  <Label for="failures-before-fallback">{{ $t('settings.healthMonitorFailuresBeforeFallback') }}</Label>
                  <Input
                    id="failures-before-fallback"
                    v-model.number="form.healthMonitor.failuresBeforeFallback"
                    type="number"
                    min="1"
                    class="w-full"
                  />
                  <p class="text-xs text-muted-foreground">{{ $t('settings.healthMonitorFailuresBeforeFallbackHint') }}</p>
                </div>

                <!-- Recovery check interval -->
                <div class="flex flex-col gap-2">
                  <Label for="recovery-check-interval">{{ $t('settings.healthMonitorRecoveryCheckInterval') }}</Label>
                  <div class="flex items-center gap-2">
                    <Input
                      id="recovery-check-interval"
                      v-model.number="form.healthMonitor.recoveryCheckIntervalMinutes"
                      type="number"
                      min="1"
                      class="w-full"
                    />
                    <span class="text-sm text-muted-foreground">{{ $t('settings.minutes') }}</span>
                  </div>
                  <p class="text-xs text-muted-foreground">{{ $t('settings.healthMonitorRecoveryCheckIntervalHint') }}</p>
                </div>

                <!-- Successes before recovery -->
                <div class="flex flex-col gap-2">
                  <Label for="successes-before-recovery">{{ $t('settings.healthMonitorSuccessesBeforeRecovery') }}</Label>
                  <Input
                    id="successes-before-recovery"
                    v-model.number="form.healthMonitor.successesBeforeRecovery"
                    type="number"
                    min="1"
                    class="w-full"
                  />
                  <p class="text-xs text-muted-foreground">{{ $t('settings.healthMonitorSuccessesBeforeRecoveryHint') }}</p>
                </div>

                <Separator />

                <!-- Notification toggles -->
                <div>
                  <h3 class="text-base font-semibold tracking-tight text-foreground">
                    {{ $t('settings.healthMonitorNotifications') }}
                  </h3>
                  <p class="mt-1 text-sm text-muted-foreground">
                    {{ $t('settings.healthMonitorNotificationsDescription') }}
                  </p>
                </div>

                <div class="flex flex-col gap-3">
                  <div
                    v-for="toggle in notificationToggles"
                    :key="toggle.key"
                    class="flex items-center justify-between rounded-lg border border-border px-4 py-3"
                  >
                    <div class="flex flex-col gap-0.5 pr-4">
                      <Label :for="`notify-${toggle.key}`" class="cursor-pointer">
                        {{ toggle.label }}
                      </Label>
                    </div>
                    <Switch
                      :id="`notify-${toggle.key}`"
                      v-model="form.healthMonitor.notifications[toggle.key]"
                    />
                  </div>
                </div>
              </div>
            </div>

            <!-- ═══ Telegram ═══ -->
            <div v-else-if="activeTab === 'telegram'">
              <div class="mb-8">
                <h2 class="text-lg font-semibold tracking-tight text-foreground">
                  {{ $t('settings.tabs.telegram') }}
                </h2>
                <p class="mt-1 text-sm text-muted-foreground">
                  {{ $t('settings.tabs.telegramDescription') }}
                </p>
              </div>

              <div class="flex flex-col gap-8">
                <!-- Enable toggle -->
                <div class="flex items-center justify-between rounded-lg border border-border px-4 py-3">
                  <div class="flex flex-col gap-0.5 pr-4">
                    <Label for="telegram-enabled" class="cursor-pointer">
                      {{ $t('settings.telegramEnabled') }}
                    </Label>
                    <p class="text-xs text-muted-foreground">
                      {{ $t('settings.telegramEnabledHint') }}
                    </p>
                  </div>
                  <Switch
                    id="telegram-enabled"
                    v-model="form.telegramEnabled"
                  />
                </div>

                <!-- Configuration — progressive disclosure -->
                <template v-if="form.telegramEnabled">
                <!-- Bot token -->
                <div class="flex flex-col gap-2">
                  <Label for="telegram-token">{{ $t('settings.telegramBotToken') }}</Label>
                  <Input
                    id="telegram-token"
                    v-model="form.telegramBotToken"
                    type="password"
                    autocomplete="off"
                    :placeholder="$t('settings.telegramBotTokenPlaceholder')"
                  />
                  <p class="text-xs text-muted-foreground">{{ $t('settings.telegramBotTokenHint') }}</p>
                </div>

                <!-- Batching delay -->
                <div class="flex flex-col gap-2">
                  <Label for="batching-delay">{{ $t('settings.batchingDelay') }}</Label>
                  <div class="flex items-center gap-2">
                    <Input
                      id="batching-delay"
                      v-model.number="form.batchingDelayMs"
                      type="number"
                      min="0"
                      max="10000"
                      step="100"
                      class="w-full"
                    />
                    <span class="text-sm text-muted-foreground">ms</span>
                  </div>
                  <p class="text-xs text-muted-foreground">{{ $t('settings.batchingDelayHint') }}</p>
                </div>

                <!-- Telegram users section -->
                <Separator />

                <div class="flex items-start justify-between gap-4">
                  <div>
                    <h3 class="text-base font-semibold tracking-tight text-foreground">
                      {{ $t('settings.telegramUsers') }}
                    </h3>
                    <p class="mt-1 text-sm text-muted-foreground">
                      {{ $t('settings.telegramUsersDescription') }}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    :disabled="telegramUsersLoading"
                    :aria-label="$t('settings.telegramUsersRefresh')"
                    @click="fetchTelegramUsers"
                  >
                    <AppIcon
                      name="refresh"
                      class="h-4 w-4"
                      :class="telegramUsersLoading ? 'animate-spin' : ''"
                    />
                  </Button>
                </div>

                <!-- Loading -->
                <div v-if="telegramUsersLoading" class="flex flex-col gap-2">
                  <Skeleton class="h-[72px] w-full rounded-lg" />
                  <Skeleton class="h-[72px] w-full rounded-lg" />
                </div>

                <!-- Empty state -->
                <div v-else-if="telegramUsers.length === 0" class="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-8 text-center">
                  <AppIcon name="send" size="lg" class="text-muted-foreground/40" />
                  <p class="text-sm text-muted-foreground">{{ $t('settings.telegramUsersEmpty') }}</p>
                </div>

                <!-- User list -->
                <div v-else class="overflow-hidden rounded-lg border border-border">
                  <div
                    v-for="(tgUser, index) in telegramUsers"
                    :key="tgUser.id"
                    :class="[
                      'flex items-center gap-3 px-4 py-3 transition-colors',
                      index > 0 ? 'border-t border-border' : '',
                    ]"
                  >
                    <!-- Avatar -->
                    <img
                      v-if="tgUser.hasAvatar"
                      :src="getTelegramAvatarUrl(tgUser.id)"
                      :alt="tgUser.telegramDisplayName || tgUser.telegramUsername || ''"
                      class="h-9 w-9 shrink-0 rounded-full object-cover"
                      @error="($event.target as HTMLImageElement).style.display = 'none'; ($event.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden')"
                    >
                    <span
                      :class="[
                        'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold',
                        tgUser.hasAvatar ? 'hidden' : '',
                        tgUser.status === 'approved'
                          ? 'bg-success/10 text-success'
                          : tgUser.status === 'pending'
                            ? 'bg-warning/10 text-warning'
                            : 'bg-muted text-muted-foreground',
                      ]"
                    >
                      {{ (tgUser.telegramDisplayName || tgUser.telegramUsername || '?').slice(0, 1).toUpperCase() }}
                    </span>

                    <!-- Info -->
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-2">
                        <span class="truncate font-medium text-foreground">
                          {{ tgUser.telegramDisplayName || tgUser.telegramUsername || tgUser.telegramId }}
                        </span>
                        <Badge
                          :variant="tgUser.status === 'approved' ? 'success' : tgUser.status === 'pending' ? 'warning' : 'destructive'"
                          class="shrink-0"
                        >
                          {{ $t(`settings.telegramUsers${tgUser.status.charAt(0).toUpperCase() + tgUser.status.slice(1)}`) }}
                        </Badge>
                      </div>
                      <div class="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span v-if="tgUser.telegramUsername">@{{ tgUser.telegramUsername }}</span>
                        <span v-else>{{ $t('settings.telegramUsersNoUsername') }}</span>
                        <span class="text-border">·</span>
                        <span class="font-mono">{{ tgUser.telegramId }}</span>
                        <template v-if="tgUser.linkedUsername">
                          <span class="text-border">·</span>
                          <span class="inline-flex items-center gap-1">
                            <AppIcon name="user" size="sm" />
                            {{ tgUser.linkedUsername }}
                          </span>
                        </template>
                      </div>
                    </div>

                    <!-- Primary action: Approve for pending users -->
                    <Button
                      v-if="tgUser.status === 'pending'"
                      size="sm"
                      @click="handleApproveTelegramUser(tgUser.id)"
                    >
                      <AppIcon name="check" size="sm" class="mr-1" />
                      {{ $t('settings.telegramUsersApprove') }}
                    </Button>

                    <!-- Row actions dropdown -->
                    <DropdownMenu>
                      <DropdownMenuTrigger>
                        <Button variant="ghost" size="icon-sm" :aria-label="$t('aria.userMenu')">
                          <AppIcon name="moreVertical" class="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem v-if="tgUser.status !== 'approved'" @click="handleApproveTelegramUser(tgUser.id)">
                          <AppIcon name="check" class="h-4 w-4" />
                          {{ $t('settings.telegramUsersApprove') }}
                        </DropdownMenuItem>
                        <DropdownMenuItem v-if="tgUser.status !== 'rejected'" @click="handleRejectTelegramUser(tgUser.id)">
                          <AppIcon name="close" class="h-4 w-4" />
                          {{ $t('settings.telegramUsersReject') }}
                        </DropdownMenuItem>

                        <!-- User assignment submenu -->
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel>{{ $t('settings.telegramUsersAssignUser') }}</DropdownMenuLabel>
                        <DropdownMenuItem
                          :class="tgUser.userId === null ? 'font-medium' : ''"
                          @click="handleAssignUser(tgUser.id, '')"
                        >
                          {{ $t('settings.telegramUsersUnassigned') }}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          v-for="u in users"
                          :key="u.id"
                          :class="tgUser.userId === u.id ? 'font-medium' : ''"
                          @click="handleAssignUser(tgUser.id, String(u.id))"
                        >
                          <AppIcon name="user" class="h-4 w-4" />
                          {{ u.username }}
                          <AppIcon v-if="tgUser.userId === u.id" name="check" class="ml-auto h-4 w-4" />
                        </DropdownMenuItem>

                        <DropdownMenuSeparator />
                        <DropdownMenuItem destructive @click="handleDeleteTelegramUser(tgUser)">
                          <AppIcon name="trash" class="h-4 w-4" />
                          {{ $t('settings.telegramUsersDelete') }}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
                </template>
              </div>
            </div>

            <!-- ═══ Tasks ═══ -->
            <div v-else-if="activeTab === 'tasks'">
              <div class="mb-8">
                <h2 class="text-lg font-semibold tracking-tight text-foreground">
                  {{ $t('settings.tabs.tasks') }}
                </h2>
                <p class="mt-1 text-sm text-muted-foreground">
                  {{ $t('settings.tabs.tasksDescription') }}
                </p>
              </div>

              <div class="flex flex-col gap-8">
                <!-- General Task Settings -->
                <div>
                  <h3 class="text-base font-semibold tracking-tight text-foreground">
                    {{ $t('settings.tasksGeneral') }}
                  </h3>
                  <p class="mt-1 text-sm text-muted-foreground">
                    {{ $t('settings.tasksGeneralHint') }}
                  </p>
                </div>

                <!-- Default provider -->
                <div class="flex flex-col gap-2">
                  <Label for="tasks-default-provider">{{ $t('settings.tasksDefaultProvider') }}</Label>
                  <Select id="tasks-default-provider" v-model="form.tasks.defaultProvider">
                    <option value="">{{ $t('settings.tasksDefaultProviderActive') }}</option>
                    <option v-for="p in providers" :key="p.id" :value="p.id">
                      {{ p.name }} ({{ p.defaultModel }})
                    </option>
                  </Select>
                  <p class="text-xs text-muted-foreground">{{ $t('settings.tasksDefaultProviderHint') }}</p>
                </div>

                <!-- Max duration -->
                <div class="flex flex-col gap-2">
                  <Label for="tasks-max-duration">{{ $t('settings.tasksMaxDuration') }}</Label>
                  <div class="flex items-center gap-2">
                    <Input
                      id="tasks-max-duration"
                      v-model.number="form.tasks.maxDurationMinutes"
                      type="number"
                      min="1"
                      max="1440"
                      class="w-full"
                    />
                    <span class="text-sm text-muted-foreground">{{ $t('settings.minutes') }}</span>
                  </div>
                  <p class="text-xs text-muted-foreground">{{ $t('settings.tasksMaxDurationHint') }}</p>
                </div>

                <!-- Telegram delivery mode -->
                <div class="flex flex-col gap-2">
                  <Label for="tasks-telegram-delivery">{{ $t('settings.tasksTelegramDelivery') }}</Label>
                  <Select id="tasks-telegram-delivery" v-model="form.tasks.telegramDelivery">
                    <option value="auto">{{ $t('settings.tasksTelegramDeliveryAuto') }}</option>
                    <option value="always">{{ $t('settings.tasksTelegramDeliveryAlways') }}</option>
                  </Select>
                  <p class="text-xs text-muted-foreground">{{ $t('settings.tasksTelegramDeliveryHint') }}</p>
                </div>

                <Separator />

                <!-- Loop Detection Section -->
                <div>
                  <h3 class="text-base font-semibold tracking-tight text-foreground">
                    {{ $t('settings.tasksLoopDetection') }}
                  </h3>
                  <p class="mt-1 text-sm text-muted-foreground">
                    {{ $t('settings.tasksLoopDetectionHint') }}
                  </p>
                </div>

                <!-- Enable toggle -->
                <div class="flex items-center justify-between rounded-lg border border-border px-4 py-3">
                  <div class="flex flex-col gap-0.5 pr-4">
                    <Label for="loop-detection-enabled" class="cursor-pointer">
                      {{ $t('settings.tasksLoopDetectionEnabled') }}
                    </Label>
                    <p class="text-xs text-muted-foreground">
                      {{ $t('settings.tasksLoopDetectionEnabledHint') }}
                    </p>
                  </div>
                  <Switch
                    id="loop-detection-enabled"
                    v-model="form.tasks.loopDetection.enabled"
                  />
                </div>

                <template v-if="form.tasks.loopDetection.enabled">
                  <!-- Detection method -->
                  <div class="flex flex-col gap-2">
                    <Label for="loop-detection-method">{{ $t('settings.tasksLoopDetectionMethod') }}</Label>
                    <Select id="loop-detection-method" v-model="form.tasks.loopDetection.method">
                      <option value="systematic">{{ $t('settings.tasksLoopDetectionMethodSystematic') }}</option>
                      <option value="smart">{{ $t('settings.tasksLoopDetectionMethodSmart') }}</option>
                      <option value="auto">{{ $t('settings.tasksLoopDetectionMethodAuto') }}</option>
                    </Select>
                    <p class="text-xs text-muted-foreground">{{ $t('settings.tasksLoopDetectionMethodHint') }}</p>
                  </div>

                  <!-- Max consecutive failures -->
                  <div class="flex flex-col gap-2">
                    <Label for="loop-max-failures">{{ $t('settings.tasksLoopDetectionMaxFailures') }}</Label>
                    <Input
                      id="loop-max-failures"
                      v-model.number="form.tasks.loopDetection.maxConsecutiveFailures"
                      type="number"
                      min="1"
                      max="20"
                      class="w-full"
                    />
                    <p class="text-xs text-muted-foreground">{{ $t('settings.tasksLoopDetectionMaxFailuresHint') }}</p>
                  </div>

                  <!-- Smart provider (shown when method is smart or auto) -->
                  <template v-if="form.tasks.loopDetection.method !== 'systematic'">
                    <div class="flex flex-col gap-2">
                      <Label for="loop-smart-provider">{{ $t('settings.tasksLoopDetectionSmartProvider') }}</Label>
                      <Select id="loop-smart-provider" v-model="form.tasks.loopDetection.smartProvider">
                        <option value="">{{ $t('settings.tasksLoopDetectionSmartProviderDefault') }}</option>
                        <option v-for="p in providers" :key="p.id" :value="p.id">
                          {{ p.name }} ({{ p.defaultModel }})
                        </option>
                      </Select>
                      <p class="text-xs text-muted-foreground">{{ $t('settings.tasksLoopDetectionSmartProviderHint') }}</p>
                    </div>

                    <!-- Smart check interval -->
                    <div class="flex flex-col gap-2">
                      <Label for="loop-smart-interval">{{ $t('settings.tasksLoopDetectionSmartInterval') }}</Label>
                      <div class="flex items-center gap-2">
                        <Input
                          id="loop-smart-interval"
                          v-model.number="form.tasks.loopDetection.smartCheckInterval"
                          type="number"
                          min="1"
                          max="50"
                          class="w-full"
                        />
                        <span class="text-sm text-muted-foreground">{{ $t('settings.tasksToolCalls') }}</span>
                      </div>
                      <p class="text-xs text-muted-foreground">{{ $t('settings.tasksLoopDetectionSmartIntervalHint') }}</p>
                    </div>
                  </template>
                </template>

                <Separator />

                <!-- Status Updates Section -->
                <div>
                  <h3 class="text-base font-semibold tracking-tight text-foreground">
                    {{ $t('settings.tasksStatusUpdates') }}
                  </h3>
                  <p class="mt-1 text-sm text-muted-foreground">
                    {{ $t('settings.tasksStatusUpdatesHint') }}
                  </p>
                </div>

                <div class="flex flex-col gap-2">
                  <Label for="status-update-interval">{{ $t('settings.tasksStatusUpdateInterval') }}</Label>
                  <div class="flex items-center gap-2">
                    <Input
                      id="status-update-interval"
                      v-model.number="form.tasks.statusUpdateIntervalMinutes"
                      type="number"
                      min="1"
                      max="120"
                      class="w-full"
                    />
                    <span class="text-sm text-muted-foreground">{{ $t('settings.minutes') }}</span>
                  </div>
                  <p class="text-xs text-muted-foreground">{{ $t('settings.tasksStatusUpdateIntervalHint') }}</p>
                </div>
              </div>
            </div>

            <!-- ═══ Secrets ═══ -->
            <div v-else-if="activeTab === 'secrets'">
              <div class="mb-8">
                <h2 class="text-lg font-semibold tracking-tight text-foreground">
                  {{ $t('settings.secretsTitle') }}
                </h2>
                <p class="mt-1 text-sm text-muted-foreground">
                  {{ $t('settings.secretsSubtitle') }}
                </p>
              </div>

              <!-- Secrets feedback alerts -->
              <div v-if="secretsError || secretsSuccess" class="mb-6">
                <Alert v-if="secretsError" variant="destructive">
                  <AlertDescription class="flex items-center justify-between">
                    <span>{{ secretsError }}</span>
                    <button
                      type="button"
                      class="ml-2 opacity-70 transition-opacity hover:opacity-100"
                      :aria-label="$t('aria.closeAlert')"
                      @click="clearSecretsMessages()"
                    >
                      <AppIcon name="close" class="h-4 w-4" />
                    </button>
                  </AlertDescription>
                </Alert>
                <Alert v-if="secretsSuccess" variant="success" :class="secretsError ? 'mt-2' : ''">
                  <AlertDescription class="flex items-center justify-between">
                    <span>{{ secretsSuccess === 'deleted' ? $t('settings.secretsDeleteSuccess') : $t('settings.secretsSaveSuccess') }}</span>
                    <button
                      type="button"
                      class="ml-2 opacity-70 transition-opacity hover:opacity-100"
                      :aria-label="$t('aria.closeAlert')"
                      @click="clearSecretsMessages()"
                    >
                      <AppIcon name="close" class="h-4 w-4" />
                    </button>
                  </AlertDescription>
                </Alert>
              </div>

              <!-- Loading -->
              <div v-if="secretsLoading" class="flex flex-col gap-4">
                <Skeleton class="h-16 w-full rounded-lg" />
                <Skeleton class="h-16 w-full rounded-lg" />
              </div>

              <div v-else class="flex flex-col gap-8">
                <!-- Existing secrets list -->
                <div v-if="secretsList.length > 0" class="overflow-hidden rounded-lg border border-border">
                  <div
                    v-for="(secret, index) in secretsList"
                    :key="secret.key"
                    :class="[
                      'px-4 py-3',
                      index > 0 ? 'border-t border-border' : '',
                    ]"
                  >
                    <div class="flex items-center justify-between gap-3">
                      <div class="flex min-w-0 items-center gap-3">
                        <span class="font-mono text-sm font-medium text-foreground">{{ secret.key }}</span>
                        <span v-if="secret.configured" class="font-mono text-xs text-muted-foreground">
                          {{ secret.maskedValue }}
                        </span>
                        <Badge v-else variant="outline">{{ $t('settings.secretsNotConfigured') }}</Badge>
                      </div>
                      <div class="flex shrink-0 items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          :aria-label="$t('common.edit')"
                          @click="toggleSecretEdit(secret.key)"
                        >
                          <AppIcon name="edit" class="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          class="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          :aria-label="$t('settings.secretsDelete')"
                          @click="secretToDelete = secret.key"
                        >
                          <AppIcon name="trash" class="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                    <!-- Inline update field — shown on edit click -->
                    <div v-if="secretEditOpen.has(secret.key)" class="mt-3 flex flex-col gap-1.5">
                      <Label :for="`secret-edit-${secret.key}`">{{ $t('settings.secretsNewValue') }}</Label>
                      <div class="flex items-center gap-2">
                        <Input
                          :id="`secret-edit-${secret.key}`"
                          v-model="secretEdits[secret.key]"
                          type="password"
                          autocomplete="off"
                          :placeholder="$t('settings.secretsValuePlaceholder')"
                          class="flex-1"
                        />
                        <Button
                          size="sm"
                          :disabled="secretsSaving || !secretEdits[secret.key]"
                          @click="handleSaveSingleSecret(secret.key)"
                        >
                          <span
                            v-if="secretsSaving"
                            class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground"
                            aria-hidden="true"
                          />
                          {{ $t('common.save') }}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          @click="toggleSecretEdit(secret.key)"
                        >
                          {{ $t('common.cancel') }}
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- Empty state -->
                <div v-else class="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-8 text-center">
                  <AppIcon name="key" size="lg" class="text-muted-foreground/40" />
                  <p class="text-sm text-muted-foreground">{{ $t('settings.secretsEmpty') }}</p>
                </div>

                <Separator />

                <!-- Add new secret -->
                <div>
                  <h3 class="text-base font-semibold tracking-tight text-foreground">
                    {{ $t('settings.secretsAdd') }}
                  </h3>
                </div>

                <div class="flex flex-col gap-4">
                  <div class="flex flex-col gap-2">
                    <Label for="new-secret-key">{{ $t('settings.secretsKey') }}</Label>
                    <Input
                      id="new-secret-key"
                      v-model="newSecretKey"
                      :placeholder="$t('settings.secretsKeyPlaceholder')"
                      class="font-mono"
                      @input="newSecretError = validateNewSecretKey(newSecretKey)"
                    />
                    <p v-if="newSecretError" class="text-xs text-destructive">{{ newSecretError }}</p>
                  </div>

                  <div class="flex flex-col gap-2">
                    <Label for="new-secret-value">{{ $t('settings.secretsValue') }}</Label>
                    <Input
                      id="new-secret-value"
                      v-model="newSecretValue"
                      type="password"
                      autocomplete="off"
                      :placeholder="$t('settings.secretsValuePlaceholder')"
                    />
                  </div>
                </div>

                <!-- Save button -->
                <div class="flex justify-end">
                  <Button :disabled="secretsSaving" @click="handleSaveSecrets">
                    <span
                      v-if="secretsSaving"
                      class="h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground"
                      aria-hidden="true"
                    />
                    {{ $t('settings.secretsSave') }}
                  </Button>
                </div>
              </div>

              <!-- Delete confirmation dialog -->
              <ConfirmDialog
                :open="!!secretToDelete"
                :title="$t('settings.secretsDelete')"
                :description="$t('settings.secretsDeleteConfirm', { key: secretToDelete ?? '' })"
                :confirm-label="$t('settings.secretsDelete')"
                destructive
                :loading="secretsSaving"
                @confirm="handleDeleteSecret"
                @cancel="secretToDelete = null"
              />
            </div>

          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { MemoryConsolidationSettings, HealthMonitorNotificationToggles, HealthMonitorSettings, AgentHeartbeatSettings, TasksSettings } from '~/composables/useSettings'
import type { TelegramUser } from '~/composables/useTelegramUsers'

/* ── Auth ── */
const { user } = useAuth()
const isAdmin = computed(() => user.value?.role === 'admin')

/* ── Tab routing — persisted in URL query for deep-linking ── */
const route = useRoute()
const router = useRouter()
const { t } = useI18n()

const timezones = [
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Europe/Madrid',
  'Europe/Rome',
  'Europe/Amsterdam',
  'Europe/Zurich',
  'Europe/Vienna',
  'Europe/Warsaw',
  'Europe/Moscow',
  'Europe/Istanbul',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Bangkok',
  'Asia/Singapore',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Australia/Sydney',
  'Pacific/Auckland',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Sao_Paulo',
  'America/Argentina/Buenos_Aires',
]

const VALID_TABS = ['agent', 'memory', 'agentHeartbeat', 'healthMonitor', 'telegram', 'tasks', 'secrets'] as const
type TabId = (typeof VALID_TABS)[number]

const activeTab = computed<TabId>({
  get() {
    const raw = route.query.tab as string
    return VALID_TABS.includes(raw as TabId) ? (raw as TabId) : 'agent'
  },
  set(value: TabId) {
    router.replace({ query: { tab: value } })
  },
})

const tabs = computed(() => [
  { id: 'agent' as TabId, icon: 'bot', label: t('settings.tabs.agent') },
  { id: 'healthMonitor' as TabId, icon: 'activity', label: t('settings.tabs.healthMonitor') },
  { id: 'memory' as TabId, icon: 'brain', label: t('settings.tabs.memory') },
  { id: 'agentHeartbeat' as TabId, icon: 'activity', label: t('settings.tabs.agentHeartbeat') },
  { id: 'secrets' as TabId, icon: 'key', label: t('settings.tabs.secrets') },
  { id: 'tasks' as TabId, icon: 'bot', label: t('settings.tabs.tasks') },
  { id: 'telegram' as TabId, icon: 'send', label: t('settings.tabs.telegram') },
])

/* ── Settings state ── */
const {
  settings,
  loading,
  saving,
  error,
  successMessage,
  fetchSettings,
  updateSettings,
  clearMessages,
} = useSettings()

/* ── Providers (consolidation dropdown) ── */
const { providers, fetchProviders } = useProviders()

/* ── Users (for telegram user assignment) ── */
const { users, fetchUsers } = useUsers()
const { refreshAvatar } = useUserAvatar()

/* ── Telegram users ── */
const {
  telegramUsers,
  loading: telegramUsersLoading,
  fetchTelegramUsers,
  updateTelegramUser,
  deleteTelegramUser,
} = useTelegramUsers()

/* ── Secrets ── */
const {
  secrets: secretsList,
  loading: secretsLoading,
  saving: secretsSaving,
  error: secretsError,
  successMessage: secretsSuccess,
  fetchSecrets,
  updateSecrets,
  removeSecret,
  clearMessages: clearSecretsMessages,
} = useSecrets()

/** Inline editing state for existing secrets */
const secretEdits = ref<Record<string, string>>({})

/** Which secrets have their edit field expanded */
const secretEditOpen = ref<Set<string>>(new Set())

/** State for adding a new secret */
const newSecretKey = ref('')
const newSecretValue = ref('')
const newSecretError = ref<string | null>(null)

/** Delete confirmation */
const secretToDelete = ref<string | null>(null)

function toggleSecretEdit(key: string) {
  const s = new Set(secretEditOpen.value)
  if (s.has(key)) {
    s.delete(key)
    delete secretEdits.value[key]
  } else {
    s.add(key)
  }
  secretEditOpen.value = s
}

function resetSecretEdits() {
  secretEdits.value = {}
  secretEditOpen.value = new Set()
  newSecretKey.value = ''
  newSecretValue.value = ''
  newSecretError.value = null
}

function validateNewSecretKey(key: string): string | null {
  if (!key) return null
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) return t('settings.secretsKeyInvalid')
  if (secretsList.value.some(s => s.key === key)) return t('settings.secretsKeyExists')
  return null
}

async function handleSaveSingleSecret(key: string) {
  const value = secretEdits.value[key]
  if (!value) return

  const ok = await updateSecrets({ [key]: value })
  if (ok) {
    toggleSecretEdit(key)
    setTimeout(() => { secretsSuccess.value = null }, 3000)
  }
}

async function handleSaveSecrets() {
  const updates: Record<string, string> = {}

  // Collect edits for existing secrets
  for (const [key, value] of Object.entries(secretEdits.value)) {
    if (value) updates[key] = value
  }

  // Add new secret if provided
  if (newSecretKey.value) {
    const err = validateNewSecretKey(newSecretKey.value)
    if (err) {
      newSecretError.value = err
      return
    }
    if (newSecretValue.value) {
      updates[newSecretKey.value] = newSecretValue.value
    }
  }

  if (Object.keys(updates).length === 0) return

  const ok = await updateSecrets(updates)
  if (ok) {
    resetSecretEdits()
    setTimeout(() => { secretsSuccess.value = null }, 3000)
  }
}

async function handleDeleteSecret() {
  if (!secretToDelete.value) return
  const ok = await removeSecret(secretToDelete.value)
  secretToDelete.value = null
  if (ok) {
    setTimeout(() => { secretsSuccess.value = null }, 3000)
  }
}

function getTelegramAvatarUrl(telegramUserId: number): string {
  const config = useRuntimeConfig()
  const { getAccessToken } = useAuth()
  const token = getAccessToken()
  return `${config.public.apiBase}/api/telegram-users/${telegramUserId}/avatar${token ? `?token=${token}` : ''}`
}

async function handleApproveTelegramUser(id: number) {
  await updateTelegramUser(id, { status: 'approved' })
}

async function handleRejectTelegramUser(id: number) {
  await updateTelegramUser(id, { status: 'rejected' })
}

async function handleAssignUser(telegramUserId: number, userIdStr: string) {
  const userId = userIdStr ? parseInt(userIdStr, 10) : null
  await updateTelegramUser(telegramUserId, { userId })
  refreshAvatar()
}

async function handleDeleteTelegramUser(tgUser: TelegramUser) {
  const name = tgUser.telegramDisplayName || tgUser.telegramUsername || tgUser.telegramId
  if (!confirm(t('settings.telegramUsersDeleteConfirm', { name }))) return
  await deleteTelegramUser(tgUser.id)
  refreshAvatar()
}

/* ── Consolidation runtime ── */
const { apiFetch } = useApi()

interface ConsolidationStatus {
  lastRun: string | null
  lastResult: { updated: boolean; reason?: string } | null
}

const consolidationRunning = ref(false)
const consolidationStatus = ref<ConsolidationStatus | null>(null)

async function fetchConsolidationStatus() {
  try {
    consolidationStatus.value = await apiFetch<ConsolidationStatus>(
      '/api/memory/consolidation/status',
    )
  } catch {
    // Status display is optional — fail silently
  }
}

async function handleRunConsolidation() {
  consolidationRunning.value = true
  try {
    const result = await apiFetch<{ updated: boolean; reason?: string }>(
      '/api/memory/consolidation/run',
      { method: 'POST' },
    )
    consolidationStatus.value = {
      lastRun: new Date().toISOString(),
      lastResult: result,
    }
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    consolidationRunning.value = false
  }
}

/* ── Form state ── */
interface SettingsForm {
  sessionTimeoutMinutes: number
  language: string
  timezone: string
  healthMonitorIntervalMinutes: number
  batchingDelayMs: number
  uploadRetentionDays: number
  telegramEnabled: boolean
  telegramBotToken: string
  healthMonitor: HealthMonitorSettings
  memoryConsolidation: MemoryConsolidationSettings
  agentHeartbeat: AgentHeartbeatSettings
  tasks: TasksSettings
}

const form = ref<SettingsForm | null>(null)

function hydrateForm() {
  if (!settings.value) return
  const s = settings.value
  form.value = {
    sessionTimeoutMinutes: s.sessionTimeoutMinutes,
    language: s.language,
    timezone: s.timezone,
    healthMonitorIntervalMinutes: s.healthMonitorIntervalMinutes,
    batchingDelayMs: s.batchingDelayMs,
    uploadRetentionDays: s.uploadRetentionDays,
    telegramEnabled: s.telegramEnabled,
    telegramBotToken: s.telegramBotToken,
    healthMonitor: {
      fallbackTrigger: s.healthMonitor.fallbackTrigger,
      failuresBeforeFallback: s.healthMonitor.failuresBeforeFallback,
      recoveryCheckIntervalMinutes: s.healthMonitor.recoveryCheckIntervalMinutes,
      successesBeforeRecovery: s.healthMonitor.successesBeforeRecovery,
      notifications: { ...s.healthMonitor.notifications },
    },
    memoryConsolidation: { ...s.memoryConsolidation },
    agentHeartbeat: { ...s.agentHeartbeat, nightMode: { ...s.agentHeartbeat.nightMode } },
    tasks: { ...s.tasks, loopDetection: { ...s.tasks.loopDetection } },
  }
}

watch(settings, hydrateForm)

/* ── Notification toggles ── */
const notificationToggles = computed(() => [
  { key: 'healthyToDegraded' as keyof HealthMonitorNotificationToggles, label: t('settings.healthMonitorNotifyHealthyToDegraded') },
  { key: 'degradedToHealthy' as keyof HealthMonitorNotificationToggles, label: t('settings.healthMonitorNotifyDegradedToHealthy') },
  { key: 'degradedToDown' as keyof HealthMonitorNotificationToggles, label: t('settings.healthMonitorNotifyDegradedToDown') },
  { key: 'healthyToDown' as keyof HealthMonitorNotificationToggles, label: t('settings.healthMonitorNotifyHealthyToDown') },
  { key: 'downToFallback' as keyof HealthMonitorNotificationToggles, label: t('settings.healthMonitorNotifyDownToFallback') },
  { key: 'fallbackToHealthy' as keyof HealthMonitorNotificationToggles, label: t('settings.healthMonitorNotifyFallbackToHealthy') },
])

/* ── Save ── */
async function handleSave() {
  if (!form.value) return
  const success = await updateSettings(form.value)
  if (!success) return

  hydrateForm()
  setTimeout(() => {
    successMessage.value = null
  }, 3000)
}

/* ── Init ── */
onMounted(async () => {
  if (!isAdmin.value) return
  await Promise.all([
    fetchSettings(),
    fetchProviders(),
    fetchUsers(),
    fetchTelegramUsers(),
    fetchConsolidationStatus(),
    fetchSecrets(),
  ])
  hydrateForm()
})
</script>
