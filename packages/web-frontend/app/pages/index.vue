<template>
  <div
    class="relative flex h-full flex-col overflow-hidden"
    @dragenter.prevent="handleDragEnter"
    @dragover.prevent="handleDragOver"
    @dragleave.prevent="handleDragLeave"
    @drop.prevent="handleDrop"
  >
    <!-- Drag & drop overlay -->
    <Transition
      enter-active-class="transition duration-150 ease-out"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition duration-100 ease-in"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="isDraggingFiles"
        class="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
      >
        <div class="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-primary/60 bg-primary/[0.06] px-10 py-8 text-primary shadow-lg">
          <AppIcon name="paperclip" class="h-10 w-10" />
          <p class="text-sm font-medium">{{ $t('chat.dropFilesHere') }}</p>
        </div>
      </div>
    </Transition>
    <!--
      Chat toolbar — uses the shared <PageHeader> (slim variant, no title)
      so on mobile the action buttons teleport into the layout header and
      the second bar disappears entirely.
    -->
    <PageHeader>
      <!--
        Connection status dot (desktop-only): lives in the default slot so
        it renders on the LEFT side of the toolbar. On mobile it's not
        needed — the global status indicator is hidden there too, and the
        Send button's disabled state already communicates offline state.
      -->
      <div class="flex items-center gap-2 text-sm text-muted-foreground">
        <span
          class="h-2 w-2 shrink-0 rounded-full"
          :class="{
            'bg-success shadow-[0_0_6px_hsl(var(--success))]': connectionStatus === 'connected',
            'bg-warning animate-pulse': connectionStatus === 'connecting',
            'bg-muted-foreground': connectionStatus === 'disconnected',
          }"
        />
        <span class="hidden sm:inline">{{ chatStatusText }}</span>
      </div>
      <template #actions>
        <Button variant="outline" size="sm" class="gap-2 hover:border-destructive hover:text-destructive" :disabled="!isStreaming" @click="handleStop">
          <AppIcon name="square" class="h-4 w-4" />
          <span class="hidden sm:inline">{{ $t('chat.stop') }}</span>
        </Button>
        <Button variant="outline" size="sm" class="gap-2" :disabled="isStreaming || sessionResetting" @click="handleNewSession">
          <AppIcon name="sparkles" class="h-4 w-4" />
          <span class="hidden sm:inline">{{ $t('chat.newSession') }}</span>
        </Button>
        <Popover v-model:open="filterOpen">
          <PopoverTrigger as-child>
            <Button variant="outline" size="sm" class="gap-2">
              <AppIcon name="settings" class="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent class="w-64">
            <div class="flex flex-col gap-3">
              <p class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{{ $t('chat.displayFilters') }}</p>
              <div class="flex items-center justify-between gap-3">
                <Label class="cursor-pointer text-sm" for="filter-thinking">{{ $t('chat.filterThinking') }}</Label>
                <Switch id="filter-thinking" v-model:checked="showThinking" />
              </div>
              <div class="flex items-center justify-between gap-3">
                <Label class="cursor-pointer text-sm" for="filter-tools">{{ $t('chat.filterToolCalls') }}</Label>
                <Switch id="filter-tools" v-model:checked="showToolCalls" />
              </div>
              <div class="flex items-center justify-between gap-3">
                <Label class="cursor-pointer text-sm" for="filter-injections">{{ $t('chat.filterInjections') }}</Label>
                <Switch id="filter-injections" v-model:checked="showInjections" />
              </div>
              <div class="flex items-center justify-between gap-3">
                <Label class="cursor-pointer text-sm" for="filter-summaries">{{ $t('chat.filterSessionSummaries') }}</Label>
                <Switch id="filter-summaries" v-model:checked="showSessionSummaries" />
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </template>
    </PageHeader>

    <div ref="messagesContainer" class="relative flex flex-1 flex-col gap-4 overflow-y-auto p-4" @scroll="onMessagesScroll" @copy="handleCopyAsMarkdown">
      <div v-if="loadingHistory" class="flex flex-col gap-3">
        <div class="flex items-start gap-3 self-start"><Skeleton class="h-8 w-8 shrink-0 rounded-full" /><div class="space-y-2"><Skeleton class="h-4 w-48 rounded-xl" /><Skeleton class="h-4 w-64 rounded-xl" /></div></div>
      </div>
      <div v-else-if="messages.length === 0" class="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
        <AppIcon name="chat" class="h-10 w-10 opacity-40" />
        <p class="text-sm">{{ $t('chat.noMessages') }}</p>
      </div>
      <template v-else>
        <div
          v-for="(msg, i) in filteredMessages"
          :key="i"
          :class="[
            // Mobile: messages fill the available width (minus avatar + gap
            // or the pl-11 offset for tool cards). On sm+ screens we cap them
            // so bubbles don't span edge-to-edge on wider viewports.
            msg.role === 'divider' ? 'w-full' : (msg.role === 'tool' || (msg.role === 'system' && msg.isTaskResult) || msg.isThinking) ? 'self-start w-full max-w-full sm:max-w-[75%] pl-11' : 'flex max-w-full gap-3 sm:max-w-[75%]',
            {
              'self-end flex-row-reverse': msg.role === 'user',
              'self-start': msg.role === 'assistant' && !msg.isThinking,
              'self-center max-w-full sm:max-w-[85%]': msg.role === 'system' && !msg.isTaskResult,
            },
          ]"
        >
          <!-- Session divider -->
          <template v-if="msg.role === 'divider'">
            <!-- Collapsible summary card -->
            <div v-if="msg.content && showSessionSummaries" class="w-full max-w-none px-2 mb-1">
              <div class="mx-auto max-w-lg">
                <button
                  class="group flex w-full items-center gap-2 rounded-t-lg border border-border/60 bg-muted/30 px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/50"
                  :class="{ 'rounded-b-lg': !expandedSummaries.has(String(msg.id ?? i)) }"
                  @click="toggleSummary(String(msg.id ?? i))"
                >
                  <svg
                    class="h-3 w-3 shrink-0 transition-transform duration-200"
                    :class="{ 'rotate-90': expandedSummaries.has(String(msg.id ?? i)) }"
                    viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                  ><polyline points="9 18 15 12 9 6" /></svg>
                  <AppIcon name="file" size="sm" class="h-3 w-3 shrink-0 opacity-50" />
                  <span class="font-medium">{{ $t('chat.sessionSummary') }}</span>
                </button>
                <div
                  v-if="expandedSummaries.has(String(msg.id ?? i))"
                  class="rounded-b-lg border border-t-0 border-border/60 bg-muted/10 px-4 py-3"
                >
                  <p class="text-xs leading-relaxed text-muted-foreground/80">
                    {{ msg.content }}
                  </p>
                </div>
              </div>
            </div>
            <!-- New Session divider line (always visible) -->
            <div class="w-full max-w-none px-2">
              <div class="relative flex items-center py-2">
                <div class="grow border-t border-border" />
                <div class="mx-4 flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                  <AppIcon name="sparkles" class="h-3 w-3" />
                  <span>{{ $t('chat.newSessionDivider') }}</span>
                </div>
                <div class="grow border-t border-border" />
              </div>
            </div>
          </template>

          <!-- Thinking card (clickable/expandable) -->
          <template v-else-if="msg.isThinking">
            <div class="w-full overflow-hidden rounded-lg border border-border">
              <button
                class="group flex w-full items-center gap-2 bg-muted/30 px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/60"
                :class="{ 'border-b border-border': expandedThinking.has(String(msg.id ?? i)) }"
                @click="toggleThinking(String(msg.id ?? i))"
              >
                <svg class="h-3 w-3 shrink-0 transition-transform duration-200" :class="{ 'rotate-90': expandedThinking.has(String(msg.id ?? i)) }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6" /></svg>
                <AppIcon name="sparkles" class="h-3 w-3 shrink-0 opacity-60" />
                <span class="font-medium">{{ $t('chat.thinking') }}</span>
                <span v-if="msg.streaming" class="ml-2 inline-flex items-center gap-1">
                  <span class="h-1 w-1 animate-pulse rounded-full bg-current opacity-60" />
                  <span class="h-1 w-1 animate-pulse rounded-full bg-current opacity-60" />
                  <span class="h-1 w-1 animate-pulse rounded-full bg-current opacity-60" />
                </span>
              </button>
              <div v-if="expandedThinking.has(String(msg.id ?? i))" class="bg-background text-xs">
                <div class="max-h-80 overflow-y-auto px-3 py-2">
                  <p class="whitespace-pre-wrap break-words text-muted-foreground">{{ msg.content }}</p>
                </div>
              </div>
            </div>
          </template>

          <!-- Tool call card (clickable/expandable) -->
          <template v-else-if="msg.role === 'tool' && msg.toolData">
            <div class="w-full overflow-hidden rounded-lg border border-border">
              <button class="group flex w-full items-center gap-2 bg-muted/30 px-3 py-1.5 text-left text-xs text-muted-foreground" :class="{ 'border-b border-border': expandedTools.has(msg.toolData!.toolCallId) }" @click="toggleTool(msg.toolData!.toolCallId)">
                <svg class="h-3 w-3 shrink-0 transition-transform duration-200" :class="{ 'rotate-90': expandedTools.has(msg.toolData!.toolCallId) }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6" /></svg>
                <AppIcon :name="toolIconName(msg.toolData!)" class="h-3 w-3 shrink-0 opacity-60" />
                <span class="font-medium">{{ toolDisplayName(msg.toolData!) }}</span>
              </button>
              <div v-if="expandedTools.has(msg.toolData!.toolCallId)" class="bg-background text-xs">
                <div v-if="!isToolSkillLoad(msg.toolData!) && !hasMemoryView(msg.toolData!)" class="border-b border-border px-3 py-2"><p class="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Input</p><ToolDataDisplay :data="msg.toolData!.toolArgs" /></div>
                <template v-if="isEditFileTool(msg.toolData!) && getToolEdits(msg.toolData!) && getToolMemoryInfo(msg.toolData!).isMemoryFile">
                  <div class="max-h-80 overflow-y-auto">
                    <MemoryEditsDiff
                      :edits="getToolEdits(msg.toolData!)!"
                      :file-name="getToolMemoryFileName(msg.toolData!)"
                    />
                  </div>
                </template>
                <template v-else-if="getToolMemoryDiff(msg.toolData!)">
                  <div class="max-h-80 overflow-y-auto">
                    <MemoryFileDiff
                      :before="getToolMemoryDiff(msg.toolData!)!.before"
                      :after="getToolMemoryDiff(msg.toolData!)!.after"
                      :file-name="getToolMemoryFileName(msg.toolData!)"
                    />
                  </div>
                </template>
                <template v-else-if="getToolMemoryWriteContent(msg.toolData!) !== null">
                  <div class="max-h-80 overflow-y-auto">
                    <MemoryFileDiff
                      before=""
                      :after="getToolMemoryWriteContent(msg.toolData!)!"
                      :file-name="getToolMemoryFileName(msg.toolData!)"
                    />
                  </div>
                </template>
                <div v-else class="max-h-80 overflow-y-auto px-3 py-2">
                  <p class="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Output</p><ToolDataDisplay :data="msg.toolData!.toolResult" :is-error="msg.toolData!.toolIsError" />
                </div>
              </div>
            </div>
          </template>

          <!-- Task result notification (collapsible card) -->
          <template v-else-if="msg.role === 'system' && msg.isTaskResult">
            <div class="w-full overflow-hidden rounded-lg border border-border">
              <button
                class="group flex w-full items-center gap-2 bg-muted/30 px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/60"
                :class="{ 'border-b border-border': expandedInjections.has(i) }"
                @click="toggleInjection(i)"
              >
                <svg class="h-3 w-3 shrink-0 transition-transform duration-200" :class="{ 'rotate-90': expandedInjections.has(i) }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6" /></svg>
                <AppIcon name="zap" class="h-3 w-3 shrink-0 opacity-60" />
                <span class="font-medium">{{ msg.taskResultName ?? 'Background Task' }}</span>
                <span v-if="msg.taskResultDuration" class="ml-1 text-[10px] text-muted-foreground/60">({{ msg.taskResultDuration }}min)</span>
                <span
                  class="ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium"
                  :class="msg.taskResultStatus === 'failed'
                    ? 'bg-destructive/10 text-destructive'
                    : msg.taskResultStatus === 'question'
                      ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                      : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'"
                >
                  {{ msg.taskResultStatus === 'failed' ? 'Failed' : msg.taskResultStatus === 'question' ? 'Question' : 'Completed' }}
                </span>
              </button>
              <div v-if="expandedInjections.has(i)" class="bg-background text-xs">
                <div class="max-h-60 overflow-y-auto px-3 py-2">
                  <div class="prose-chat break-words text-xs text-foreground" v-html="renderMarkdown(taskResultBody(msg.content))" />
                </div>
              </div>
            </div>
          </template>

          <template v-else>
            <div class="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground">
              <template v-if="msg.role === 'user'">
                <img v-if="userAvatarUrl && !avatarFailed" :src="userAvatarUrl" :alt="user?.username" class="h-8 w-8 rounded-full object-cover" @error="onAvatarError">
                <span v-else-if="user?.username" class="text-xs font-semibold">{{ userInitial }}</span>
                <AppIcon v-else name="user" class="h-4 w-4" />
              </template>
              <AppIcon v-else-if="msg.role === 'assistant'" name="bot" class="h-4 w-4" />
              <AppIcon v-else name="info" class="h-4 w-4" />
              <!-- Telegram badge (source or delivered) -->
              <span
                v-if="msg.source === 'telegram' || msg.telegramDelivered"
                class="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[#2AABEE] text-white shadow-sm"
                :title="msg.source === 'telegram' ? (msg.senderName ? `via Telegram (${msg.senderName})` : 'via Telegram') : 'Also sent via Telegram'"
              >
                <svg class="h-2 w-2" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 0C5.37 0 0 5.37 0 12s5.37 12 12 12 12-5.37 12-12S18.63 0 12 0zm5.53 7.18l-1.97 9.3c-.15.67-.54.83-1.09.52l-3.01-2.22-1.45 1.4c-.16.16-.3.3-.61.3l.22-3.05 5.55-5.02c.24-.22-.05-.34-.38-.13l-6.87 4.33-2.96-.93c-.64-.2-.66-.64.13-.95l11.57-4.46c.54-.19 1.01.13.87.91z"/>
                </svg>
              </span>
            </div>
            <div class="min-w-0 rounded-2xl px-4 py-2.5 text-sm leading-relaxed" :class="{
              'rounded-br-sm border border-primary/[0.22] bg-primary/[0.12] text-foreground': msg.role === 'user' && msg.source !== 'telegram',
              'rounded-br-sm border border-[#2AABEE]/30 bg-[#2AABEE]/10 text-foreground': msg.role === 'user' && msg.source === 'telegram',
              'rounded-bl-sm border border-border bg-muted text-foreground': msg.role === 'assistant' && !msg.telegramDelivered,
              'rounded-bl-sm border border-[#2AABEE]/30 bg-[#2AABEE]/10 text-foreground': msg.role === 'assistant' && msg.telegramDelivered,
              'rounded-lg border border-border bg-muted/50 text-muted-foreground text-xs': msg.role === 'system',
            }">
              <!-- Telegram label (source or delivered) -->
              <p v-if="msg.source === 'telegram'" class="mb-1 text-xs font-medium text-[#2AABEE]">
                via Telegram{{ msg.senderName ? ` (${msg.senderName})` : '' }}
              </p>
              <p v-else-if="msg.telegramDelivered" class="mb-1 text-xs font-medium text-[#2AABEE]">
                via Telegram
              </p>
              <!-- Reply-to quote bubble (WhatsApp/Telegram style). Shown above the
                   user message body when the incoming Telegram message replied to
                   another message. -->
              <div
                v-if="msg.role === 'user' && msg.replyContext"
                class="mb-1.5 rounded-md border-l-2 border-primary/60 bg-background/60 px-2 py-1 text-xs text-muted-foreground"
              >
                <span class="whitespace-pre-wrap break-words">[Replying to: "{{ msg.replyContext }}"]</span>
              </div>
              <div v-if="msg.role === 'assistant'" class="prose-chat break-words" v-html="renderMarkdown(msg.content ?? '')" />
              <p v-else class="whitespace-pre-wrap break-words">{{ msg.content }}</p>
              <ChatAttachments v-if="msg.attachments?.length" :attachments="msg.attachments" />
              <div v-if="msg.streaming" class="mt-1.5 flex items-center gap-1"><span class="h-1.5 w-1.5 animate-pulse rounded-full bg-current opacity-60" /><span class="h-1.5 w-1.5 animate-pulse rounded-full bg-current opacity-60" /><span class="h-1.5 w-1.5 animate-pulse rounded-full bg-current opacity-60" /></div>
              <div v-if="msg.timestamp && !msg.streaming" class="mt-1 flex items-center justify-end gap-1.5">
                <button
                  v-if="ttsEnabled && msg.role === 'assistant' && msg.content"
                  type="button"
                  class="inline-flex items-center justify-center rounded-md p-0.5 text-muted-foreground/50 transition-colors hover:text-muted-foreground"
                  :title="ttsPlayingIndex === i ? $t('chat.ttsStop') : $t('chat.ttsPlay')"
                  @click.stop="handleTtsPlay(msg.content, i)"
                >
                  <AppIcon v-if="ttsLoading && ttsPlayingIndex === i" name="loader" size="sm" class="animate-spin" />
                  <AppIcon v-else-if="ttsPlayingIndex === i" name="square" size="sm" />
                  <AppIcon v-else name="volume" size="sm" />
                </button>
                <span class="text-[10px] leading-none text-muted-foreground/70">{{ formatMessageTime(msg.timestamp) }}</span>
              </div>
            </div>
          </template>
        </div>
      </template>
    </div>

    <Transition enter-active-class="transition duration-200 ease-out" enter-from-class="translate-y-2 opacity-0" enter-to-class="translate-y-0 opacity-100" leave-active-class="transition duration-150 ease-in" leave-from-class="translate-y-0 opacity-100" leave-to-class="translate-y-2 opacity-0">
      <button v-if="!isNearBottom" class="absolute bottom-28 right-6 z-10 flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-md" @click="jumpToBottom">
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
    </Transition>

    <div class="shrink-0 border-t border-border bg-background p-3">
      <form class="flex flex-col gap-2" @submit.prevent="handleSend">
        <!-- Pending files row -->
        <div v-if="pendingFiles.length" class="flex flex-wrap gap-2">
          <div
            v-for="(file, index) in pendingFiles"
            :key="`${file.name}-${index}`"
            class="inline-flex items-center gap-2 rounded-full border border-border bg-muted px-3 py-1 text-xs"
          >
            <span>{{ file.name }}</span>
            <button type="button" class="text-muted-foreground hover:text-foreground" @click="removePendingFile(index)">×</button>
          </div>
        </div>

        <div class="flex items-end gap-2">
          <!-- ── Composer box ────────────────────────────────────────────────
               Brain button (left, admin-only) | Textarea | Paperclip (right)
               Buttons use mb-[7px] so they sit centered against the
               single-line textarea height of 42px: (42-28)/2 = 7px -->
          <div class="flex flex-1 items-end rounded-xl border border-input bg-background px-1 transition-colors focus-within:border-ring focus-within:ring-1 focus-within:ring-ring">
            <!-- Thinking-level / Brain button (left inside box, admin-only) -->
            <Popover v-if="isAdmin" v-model:open="thinkingLevelPickerOpen">
              <PopoverTrigger as-child>
                <button
                  type="button"
                  class="mb-[7px] flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-40"
                  :class="thinkingBrainColorClass"
                  :disabled="thinkingLevelSaving"
                  :title="$t('chat.thinkingLevelTooltip')"
                  :aria-label="$t('chat.thinkingLevelTooltip')"
                >
                  <AppIcon
                    :name="thinkingLevelSaving ? 'loader' : 'brain'"
                    class="h-4 w-4 transition-colors"
                    :class="thinkingLevelSaving ? 'animate-spin' : ''"
                  />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" class="w-56 p-1">
                <p class="px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {{ $t('settings.thinkingLevel') }}
                </p>
                <button
                  v-for="lvl in THINKING_LEVELS"
                  :key="lvl"
                  type="button"
                  class="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                  :class="currentThinkingLevel === lvl ? 'bg-accent/60 text-accent-foreground' : 'text-foreground'"
                  :disabled="thinkingLevelSaving"
                  @click="handleThinkingLevelChange(lvl)"
                >
                  <div class="flex items-center gap-2">
                    <span
                      class="h-2 w-2 shrink-0 rounded-full"
                      :class="{
                        'bg-muted-foreground': lvl === 'off',
                        'bg-foreground': lvl === 'minimal',
                        'bg-yellow-500': lvl === 'low',
                        'bg-orange-500': lvl === 'medium',
                        'bg-red-500': lvl === 'high',
                        'bg-red-600': lvl === 'xhigh',
                      }"
                    />
                    <span>{{ $t(`chat.thinkingLevelMenu.${lvl}`) }}</span>
                  </div>
                  <AppIcon v-if="currentThinkingLevel === lvl" name="check" class="h-4 w-4 text-primary" />
                </button>
              </PopoverContent>
            </Popover>

            <!-- Textarea -->
            <textarea
              ref="inputRef"
              v-model="inputText"
              class="min-h-[42px] max-h-[150px] flex-1 resize-none bg-transparent py-2.5 pr-1 text-sm outline-none placeholder:text-muted-foreground"
              :class="isAdmin ? 'pl-2' : 'pl-3'"
              :placeholder="$t('chat.placeholder')"
              rows="1"
              @keydown.enter.exact.prevent="handleSend"
              @input="autoResize"
            />

            <!-- File attachment button (right inside box) -->
            <label class="mb-[7px] flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground">
              <input class="hidden" type="file" multiple @change="handleFileSelection">
              <AppIcon name="paperclip" class="h-4 w-4" />
            </label>
          </div>

          <!-- ── Mic button ─────────────────────────────────────────────────
               Mobile: shown only when textarea is empty (swaps to send button
               as soon as the user starts typing — Telegram/WhatsApp style).
               Desktop (sm+): always shown alongside the send button. -->
          <button
            v-if="sttEnabled"
            type="button"
            class="h-[42px] w-[42px] shrink-0 select-none items-center justify-center rounded-xl border transition-colors"
            :class="[
              hasText ? 'hidden sm:inline-flex' : 'inline-flex',
              sttRecording
                ? 'border-destructive bg-destructive/10 text-destructive animate-pulse-recording'
                : sttTranscribing
                  ? 'border-primary bg-primary/10 text-primary'
                  : sttError
                    ? 'border-destructive text-destructive'
                    : 'border-input text-muted-foreground hover:bg-muted',
            ]"
            :title="sttRecording ? $t('chat.micRecording') : sttTranscribing ? $t('chat.micTranscribing') : sttError === 'permission_denied' ? $t('chat.micPermissionDenied') : sttError === 'recording_too_short' ? $t('chat.micTooShort') : sttError ? $t('chat.micError') : $t('chat.micTooltip')"
            :disabled="sttTranscribing"
            @mousedown="handleMicDown"
            @mouseup="handleMicUp"
            @mouseleave="handleMicUp"
            @touchstart="handleMicDown"
            @touchend="handleMicUp"
          >
            <AppIcon v-if="sttTranscribing" name="loader" class="h-4 w-4 animate-spin" />
            <AppIcon v-else name="mic" class="h-4 w-4" />
          </button>

          <!-- ── Send button ─────────────────────────────────────────────────
               Mobile: icon-only square button, shown when text is present
               (or when STT is disabled — then always visible as sole action).
               Desktop (sm+): text label, always shown alongside the mic. -->
          <Button
            type="submit"
            :disabled="!hasText || connectionStatus !== 'connected'"
            class="h-[42px] w-[42px] shrink-0 rounded-xl p-0 sm:w-auto sm:px-4"
            :class="(!hasText && sttEnabled) ? 'hidden sm:inline-flex' : 'inline-flex'"
          >
            <AppIcon name="send" class="h-4 w-4 sm:hidden" />
            <span class="hidden sm:inline">{{ $t('chat.send') }}</span>
          </Button>
        </div>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ChatMessage, ToolCallData } from '~/composables/useChat'
import { SETTINGS_THINKING_LEVELS, type SettingsThinkingLevel } from '@axiom/core/contracts'
import { useSettingsApi } from '~/api/settings'
const { t } = useI18n()
const { apiFetch } = useApi()
const { user } = useAuth()
const isAdmin = computed(() => user.value?.role === 'admin')
const settingsApi = useSettingsApi()

/* ── Thinking level quick-switch in the composer ──
   Backed by the same `thinkingLevel` setting as the Settings page; changes are
   live-applied to the agent (see `AgentCore.setThinkingLevel`). Admin-only
   because the main agent is single-tenant — flipping this affects everyone's
   next turn. */
const THINKING_LEVELS = SETTINGS_THINKING_LEVELS
const currentThinkingLevel = ref<SettingsThinkingLevel>('off')
const thinkingLevelPickerOpen = ref(false)
const thinkingLevelSaving = ref(false)

// Brain button color encodes thinking intensity (no text label needed):
// off=gray, minimal=white, low→xhigh progressively to red
const thinkingBrainColorClass = computed(() => {
  const map: Record<SettingsThinkingLevel, string> = {
    off: 'text-muted-foreground',
    minimal: 'text-foreground',
    low: 'text-yellow-500 dark:text-yellow-400',
    medium: 'text-orange-500 dark:text-orange-400',
    high: 'text-red-500 dark:text-red-400',
    xhigh: 'text-red-600 dark:text-red-500',
  }
  return map[currentThinkingLevel.value] ?? 'text-muted-foreground'
})

async function loadThinkingLevel() {
  if (!isAdmin.value) return
  try {
    const settings = await settingsApi.getSettings()
    if (settings.thinkingLevel && (SETTINGS_THINKING_LEVELS as readonly string[]).includes(settings.thinkingLevel)) {
      currentThinkingLevel.value = settings.thinkingLevel as SettingsThinkingLevel
    }
  } catch {
    // keep default 'off' if we can't reach the endpoint
  }
}

async function handleThinkingLevelChange(level: SettingsThinkingLevel) {
  if (level === currentThinkingLevel.value) {
    thinkingLevelPickerOpen.value = false
    return
  }
  const previous = currentThinkingLevel.value
  currentThinkingLevel.value = level // optimistic
  thinkingLevelPickerOpen.value = false
  thinkingLevelSaving.value = true
  try {
    await settingsApi.updateSettings({ thinkingLevel: level })
  } catch {
    // rollback on failure
    currentThinkingLevel.value = previous
  } finally {
    thinkingLevelSaving.value = false
  }
}
const { userAvatarUrl, avatarFailed, userInitial, onAvatarError } = useUserAvatar()
const { renderMarkdown, handleCopyAsMarkdown } = useMarkdown()
const { isSkillLoad, getSkillName } = useSkillDetection()
function isToolSkillLoad(toolData: ToolCallData): boolean { return isSkillLoad(toolData.toolName, toolData.toolArgs) }
function getToolMemoryInfo(toolData: ToolCallData) { return detectMemoryFile(toolData.toolName, toolData.toolArgs) }
function getToolMemoryDiff(toolData: ToolCallData) { return extractMemoryDiff(toolData.toolResult) }
function getToolEdits(toolData: ToolCallData) { return extractEditsFromArgs(toolData.toolArgs) }
function getToolMemoryFileName(toolData: ToolCallData) { return extractMemoryFileName(toolData.toolArgs) ?? undefined }
function isEditFileTool(toolData: ToolCallData) { return toolData.toolName === 'edit_file' || toolData.toolName === 'Edit' }
function getToolMemoryWriteContent(toolData: ToolCallData) { return extractMemoryWriteContent(toolData.toolName, toolData.toolArgs) }
function hasMemoryView(toolData: ToolCallData) {
  return (isEditFileTool(toolData) && getToolEdits(toolData) && getToolMemoryInfo(toolData).isMemoryFile)
    || getToolMemoryDiff(toolData) !== null
    || getToolMemoryWriteContent(toolData) !== null
}
function toolDisplayName(toolData: ToolCallData): string {
  if (isToolSkillLoad(toolData)) return `Load Skill: ${getSkillName(toolData.toolArgs)}`
  const memInfo = getToolMemoryInfo(toolData)
  if (memInfo.isMemoryFile) return memInfo.label
  return toolData.toolName
}
function toolIconName(toolData: ToolCallData): string {
  if (isToolSkillLoad(toolData)) return 'puzzle'
  const memInfo = getToolMemoryInfo(toolData)
  if (memInfo.isMemoryFile) return memInfo.icon
  return 'settings'
}
const filterOpen = ref(false)
const FILTER_STORAGE_KEY = 'axiom-chat-filters'

function loadFilters() {
  try {
    const stored = localStorage.getItem(FILTER_STORAGE_KEY)
    if (stored) return JSON.parse(stored)
  } catch { /* ignore */ }
  return null
}

function saveFilters() {
  localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify({
    showToolCalls: showToolCalls.value,
    showInjections: showInjections.value,
    showSessionSummaries: showSessionSummaries.value,
    showThinking: showThinking.value,
  }))
}

const savedFilters = loadFilters()
const showToolCalls = ref(savedFilters?.showToolCalls ?? true)
const showInjections = ref(savedFilters?.showInjections ?? false)
const showSessionSummaries = ref(savedFilters?.showSessionSummaries ?? false)
// Thinking blocks default to visible (but collapsed) — mirrors TaskViewer behaviour.
const showThinking = ref(savedFilters?.showThinking ?? true)

watch([showToolCalls, showInjections, showSessionSummaries, showThinking], () => saveFilters())
const expandedSummaries = ref<Set<string>>(new Set())
function toggleSummary(id: string) { const updated = new Set(expandedSummaries.value); updated.has(id) ? updated.delete(id) : updated.add(id); expandedSummaries.value = updated }

const filteredMessages = computed(() => {
  return messages.value.filter((msg) => {
    if (!showToolCalls.value && msg.role === 'tool' && msg.toolData) return false
    if (!showInjections.value && msg.role === 'system' && msg.isTaskResult) return false
    if (!showThinking.value && msg.isThinking) return false
    return true
  })
})
const expandedTools = ref<Set<string>>(new Set())
function toggleTool(toolCallId: string) { const updated = new Set(expandedTools.value); updated.has(toolCallId) ? updated.delete(toolCallId) : updated.add(toolCallId); expandedTools.value = updated }
const expandedInjections = ref<Set<number>>(new Set())
function toggleInjection(index: number) { const updated = new Set(expandedInjections.value); updated.has(index) ? updated.delete(index) : updated.add(index); expandedInjections.value = updated }
// Thinking blocks default to collapsed per-message. We keep a Set of expanded IDs
// (the DB row id when loaded from history, otherwise the array index fallback)
// mirroring how tool calls/injections/summaries are toggled.
const expandedThinking = ref<Set<string>>(new Set())
function toggleThinking(id: string) { const updated = new Set(expandedThinking.value); updated.has(id) ? updated.delete(id) : updated.add(id); expandedThinking.value = updated }
function taskResultBody(content: string): string {
  const lines = (content ?? '').split('\n')
  const bodyLines = lines.slice(1)
  while (bodyLines.length > 0 && bodyLines[0]!.trim() === '') bodyLines.shift()
  return bodyLines.join('\n') || content
}
const { messages, connectionStatus, isStreaming, connect, disconnect, sendMessage, newSession, stopTask } = useChat()
const { playingIndex: ttsPlayingIndex, loading: ttsLoading, ttsEnabled, fetchTtsSettings, play: ttsPlay, stop: ttsStop } = useTts()
const { recording: sttRecording, transcribing: sttTranscribing, error: sttError, sttEnabled, fetchSttSettings, startRecording: sttStartRecording, stopAndTranscribe: sttStopAndTranscribe, cleanup: sttCleanup } = useStt()

function handleTtsPlay(content: string, index: number) {
  ttsPlay(content, index)
}
const chatStatusText = computed(() => connectionStatus.value === 'connected' ? t('chat.statusConnected') : connectionStatus.value === 'connecting' ? t('chat.statusConnecting') : t('chat.statusDisconnected'))
const inputText = ref('')
const pendingFiles = ref<File[]>([])
// True when there's text or pending files — drives mic↔send swap on mobile
const hasText = computed(() => inputText.value.trim().length > 0 || pendingFiles.value.length > 0)
const inputRef = ref<HTMLTextAreaElement | null>(null)
const messagesContainer = ref<HTMLDivElement | null>(null)
const loadingHistory = ref(false)
const isNearBottom = ref(true)
const SCROLL_THRESHOLD = 120
function onMessagesScroll() { const el = messagesContainer.value; if (!el) return; isNearBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_THRESHOLD }
function jumpToBottom() { isNearBottom.value = true; nextTick(() => scrollToBottom()) }
onMounted(async () => { connect(); await Promise.all([loadHistory(), fetchTtsSettings(), fetchSttSettings(), loadThinkingLevel()]) })
onUnmounted(() => { disconnect(); ttsStop(); sttCleanup() })
watch(() => messages.value.length, () => {
  if (isNearBottom.value) nextTick(() => scrollToBottom())
  // Reset sessionResetting flag when a divider appears (session_end received)
  const last = messages.value[messages.value.length - 1]
  if (last?.role === 'divider') sessionResetting.value = false
})
watch(() => messages.value[messages.value.length - 1]?.content?.length ?? 0, () => { if (isNearBottom.value) nextTick(() => scrollToBottom()) })
async function loadHistory() {
  loadingHistory.value = true
  try {
    const data = await apiFetch<{ messages: Array<{ id: number; role: 'user' | 'assistant' | 'tool' | 'system'; content: string; metadata?: string; timestamp: string; session_id: string; source?: string | null; session_type?: string | null }> }>('/api/chat/history?limit=50')
    if (data.messages?.length) {
      messages.value = data.messages.reverse().map((m) => {
        const meta = (() => { try { return JSON.parse(m.metadata || '{}') } catch { return {} } })()
        const attachments = (Array.isArray(meta.files) ? meta.files : []) as ChatMessage['attachments']
        // Source comes from the joined `sessions.source` column (web/telegram/telegram-group/rest/...).
        // Telegram messages render with a Telegram badge; everything else has no badge.
        const source = (m.source === 'telegram' || m.source === 'telegram-group') ? 'telegram' as const : undefined

        // Reconstruct tool messages with toolData from metadata
        if (m.role === 'tool' && meta.toolName) {
          return {
            id: m.id, role: 'tool' as const, content: m.content, timestamp: m.timestamp, source,
            toolData: { toolName: meta.toolName, toolCallId: meta.toolCallId ?? '', toolArgs: meta.toolArgs, toolResult: meta.toolResult, toolIsError: meta.toolIsError },
          } as ChatMessage
        }

        // Parse system messages with session_divider metadata as dividers
        if (m.role === 'system' && meta.type === 'session_divider') {
          return {
            id: m.id, role: 'divider' as const, content: meta.summary ?? '', timestamp: m.timestamp, source,
          } as ChatMessage
        }

        // Parse task result notifications from metadata
        if (m.role === 'system' && meta.type === 'task_result') {
          return {
            id: m.id, role: 'system' as const, content: m.content, timestamp: m.timestamp, source,
            isTaskResult: true,
            taskResultName: meta.taskName ?? 'Background Task',
            taskResultStatus: meta.taskResultStatus ?? meta.taskStatus ?? 'completed',
            taskResultDuration: meta.durationMinutes,
          } as ChatMessage
        }

        // Parse thinking blocks (assistant messages with metadata.kind === 'thinking').
        // Persisted live by ws-chat so they survive a page reload.
        if (m.role === 'assistant' && meta.kind === 'thinking') {
          return {
            id: m.id, role: 'assistant' as const, content: m.content, timestamp: m.timestamp, source,
            isThinking: true,
          } as ChatMessage
        }

        // Parse telegramDelivered and isTaskInjection from metadata
        const base: ChatMessage = { id: m.id, role: m.role, content: m.content, timestamp: m.timestamp, source, attachments }
        if (m.role === 'assistant' && meta.telegramDelivered) {
          base.telegramDelivered = true
        }
        if (meta.type === 'task_injection_response') {
          base.isTaskInjection = true
        }
        // Reply-to context (Telegram reply-to-message) lives in metadata.replyContext
        // so the quote bubble survives a page reload.
        if (m.role === 'user' && typeof meta.replyContext === 'string' && meta.replyContext) {
          base.replyContext = meta.replyContext
        }
        return base
      })
    }
  } finally { loadingHistory.value = false; nextTick(() => scrollToBottom()) }
}
async function handleSend() {
  const files = [...pendingFiles.value]
  const text = inputText.value
  if ((!text.trim() && files.length === 0) || connectionStatus.value !== 'connected') return
  await sendMessage(text, files)
  inputText.value = ''
  pendingFiles.value = []
  if (inputRef.value) inputRef.value.style.height = 'auto'
}
const sessionResetting = ref(false)
function handleNewSession() {
  if (sessionResetting.value) return
  sessionResetting.value = true
  newSession()
}
function handleStop() { stopTask() }
function scrollToBottom() { if (messagesContainer.value) messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight }
function autoResize() { const el = inputRef.value; if (!el) return; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 150) + 'px' }
function handleFileSelection(event: Event) { const target = event.target as HTMLInputElement; const files = Array.from(target.files || []); pendingFiles.value = [...pendingFiles.value, ...files]; target.value = '' }
function removePendingFile(index: number) { pendingFiles.value.splice(index, 1) }

// ── Drag & drop file upload ─────────────────────────────────────────
// We use a counter for dragenter/dragleave because those events bubble
// up through every child element, which would otherwise cause the overlay
// to flicker on/off whenever the cursor crosses a nested boundary.
const isDraggingFiles = ref(false)
const dragCounter = ref(0)

function dragHasFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types
  if (!types) return false
  // Different browsers report 'Files' in slightly different ways; a plain
  // includes check works for all of Chromium, Firefox and Safari.
  return Array.from(types).includes('Files')
}

function handleDragEnter(event: DragEvent) {
  if (!dragHasFiles(event)) return
  dragCounter.value++
  isDraggingFiles.value = true
}

function handleDragOver(event: DragEvent) {
  if (!dragHasFiles(event)) return
  // Signal to the browser that we accept this drop (shows the "copy" cursor).
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
}

function handleDragLeave(event: DragEvent) {
  if (!dragHasFiles(event)) return
  dragCounter.value = Math.max(0, dragCounter.value - 1)
  if (dragCounter.value === 0) isDraggingFiles.value = false
}

function handleDrop(event: DragEvent) {
  dragCounter.value = 0
  isDraggingFiles.value = false
  const files = Array.from(event.dataTransfer?.files ?? [])
  if (files.length === 0) return
  pendingFiles.value = [...pendingFiles.value, ...files]
}

// ── STT push-to-talk ──────────────────────────────────────────────────
const sttErrorTimeout = ref<ReturnType<typeof setTimeout> | null>(null)

function handleMicDown(event: MouseEvent | TouchEvent) {
  event.preventDefault()
  sttStartRecording()
}

async function handleMicUp() {
  if (!sttRecording.value) return
  const text = await sttStopAndTranscribe()
  if (text) {
    inputText.value = text
    await handleSend()
  }
}

// Auto-clear STT errors after 3 seconds
watch(sttError, (val) => {
  if (sttErrorTimeout.value) clearTimeout(sttErrorTimeout.value)
  if (val) {
    sttErrorTimeout.value = setTimeout(() => { sttError.value = null }, 3000)
  }
})
function formatMessageTime(timestamp: string): string { const d = new Date(timestamp); if (isNaN(d.getTime())) return ''; return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) }

</script>
