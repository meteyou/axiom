<template>
  <!-- Admin gate -->
  <div v-if="!isAdmin" class="flex h-full flex-col items-center justify-center gap-3 p-10 text-center text-muted-foreground">
    <AppIcon name="lock" size="xl" class="h-10 w-10" />
    <h1 class="text-xl font-semibold text-foreground">{{ $t('admin.title') }}</h1>
    <p class="text-sm">{{ $t('admin.description') }}</p>
  </div>

  <!-- Page body -->
  <div v-else class="flex h-full flex-col overflow-hidden">
    <PageHeader :title="$t('memory.title')" :subtitle="$t('memory.subtitle')" />

    <div class="mx-auto flex w-full max-w-5xl flex-1 flex-col overflow-hidden p-3 sm:p-6">
    <!-- Error / success banners -->
    <Alert v-if="error" variant="destructive" class="mb-3 shrink-0">
      <AlertDescription class="flex items-center justify-between">
        <span>{{ error }}</span>
        <button type="button" class="ml-2 opacity-70 hover:opacity-100 transition-opacity" :aria-label="$t('aria.closeAlert')" @click="clearMessages()">
          <AppIcon name="close" class="h-4 w-4" />
        </button>
      </AlertDescription>
    </Alert>

    <Alert v-if="successMessage" variant="success" class="mb-3 shrink-0">
      <AlertDescription class="flex items-center justify-between">
        <span>{{ $t('memory.saveSuccess') }}</span>
        <button type="button" class="ml-2 opacity-70 hover:opacity-100 transition-opacity" :aria-label="$t('aria.closeAlert')" @click="clearMessages()">
          <AppIcon name="close" class="h-4 w-4" />
        </button>
      </AlertDescription>
    </Alert>

    <!-- Tabs -->
    <Tabs v-model="activeTab" class="flex flex-1 flex-col overflow-hidden min-h-0">
      <div class="mb-4 flex shrink-0 flex-wrap items-center gap-3">
        <TabsList class="self-start">
          <TabsTrigger value="soul" @click="switchTab('soul')">{{ $t('memory.soulTab') }}</TabsTrigger>
          <TabsTrigger value="core" @click="switchTab('core')">{{ $t('memory.coreMemoryTab') }}</TabsTrigger>
          <TabsTrigger value="agents" @click="switchTab('agents')">{{ $t('memory.agentRulesTab') }}</TabsTrigger>
          <TabsTrigger value="heartbeat" @click="switchTab('heartbeat')">{{ $t('memory.heartbeatTab') }}</TabsTrigger>
          <TabsTrigger value="profile" @click="switchTab('profile')">{{ $t('memory.profileTab') }}</TabsTrigger>
          <TabsTrigger value="daily" @click="switchTab('daily')">{{ $t('memory.dailyTab') }}</TabsTrigger>
        </TabsList>

        <DateRangePicker
          v-if="activeTab === 'daily'"
          v-model:date-from="dailyDateFrom"
          v-model:date-to="dailyDateTo"
          @change="onDailyRangeChange"
        />
      </div>

      <!-- Soul tab -->
      <TabsContent value="soul" class="flex flex-1 flex-col overflow-hidden min-h-0 mt-0">
        <div v-if="loading" class="flex flex-1 items-center justify-center py-20 text-sm text-muted-foreground">
          {{ $t('memory.loading') }}
        </div>
        <div v-else class="flex flex-1 flex-col overflow-hidden min-h-0">
          <MarkdownEditor
            v-model="soulContent"
            :saving="saving"
            file-path=".data/memory/SOUL.md"
            @save="handleSaveSoul"
          />
        </div>
      </TabsContent>

      <!-- Core Memory tab -->
      <TabsContent value="core" class="flex flex-1 flex-col overflow-hidden min-h-0 mt-0">
        <div v-if="loading" class="flex flex-1 items-center justify-center py-20 text-sm text-muted-foreground">
          {{ $t('memory.loading') }}
        </div>
        <div v-else class="flex flex-1 flex-col overflow-hidden min-h-0">
          <MarkdownEditor
            v-model="coreMemoryContent"
            :saving="saving"
            file-path=".data/memory/MEMORY.md"
            @save="handleSaveCoreMemory"
          />
        </div>
      </TabsContent>

      <!-- Agent Rules tab -->
      <TabsContent value="agents" class="flex flex-1 flex-col overflow-hidden min-h-0 mt-0">
        <div v-if="loading" class="flex flex-1 items-center justify-center py-20 text-sm text-muted-foreground">
          {{ $t('memory.loading') }}
        </div>
        <div v-else class="flex flex-1 flex-col overflow-hidden min-h-0">
          <MarkdownEditor
            v-model="agentRulesContent"
            :saving="saving"
            file-path=".data/memory/AGENTS.md"
            @save="handleSaveAgentRules"
          />
        </div>
      </TabsContent>

      <!-- Heartbeat tab -->
      <TabsContent value="heartbeat" class="flex flex-1 flex-col overflow-hidden min-h-0 mt-0">
        <div v-if="loading" class="flex flex-1 items-center justify-center py-20 text-sm text-muted-foreground">
          {{ $t('memory.loading') }}
        </div>
        <div v-else class="flex flex-1 flex-col overflow-hidden min-h-0">
          <MarkdownEditor
            v-model="heartbeatContent"
            :saving="saving"
            file-path=".data/memory/HEARTBEAT.md"
            @save="handleSaveHeartbeat"
          />
        </div>
      </TabsContent>

      <!-- Profile tab -->
      <TabsContent value="profile" class="flex flex-1 flex-col overflow-hidden min-h-0 mt-0">
        <div v-if="loading" class="flex flex-1 items-center justify-center py-20 text-sm text-muted-foreground">
          {{ $t('memory.loading') }}
        </div>
        <div v-else class="flex flex-1 flex-col overflow-hidden min-h-0">
          <MarkdownEditor
            v-model="profileContent"
            :saving="saving"
            :file-path="`.data/memory/users/${profileUsername || 'profile'}.md`"
            @save="handleSaveProfile"
          />
        </div>
      </TabsContent>

      <!-- Daily tab -->
      <TabsContent value="daily" class="flex flex-1 flex-col overflow-hidden min-h-0 mt-0">
        <!-- Daily list view (table) -->
        <div v-if="!selectedDaily" class="flex flex-1 flex-col overflow-hidden min-h-0">
          <div v-if="loading" class="flex items-center justify-center py-16 text-sm text-muted-foreground">
            {{ $t('memory.loading') }}
          </div>
          <div v-else-if="filteredDailyFiles.length === 0" class="flex flex-col items-center justify-center gap-3 py-16 text-center text-muted-foreground">
            <AppIcon name="calendar" size="xl" class="h-10 w-10 opacity-40" />
            <p class="text-sm">{{ $t('memory.noDailyFilesInRange') }}</p>
          </div>

          <!-- Table + Pagination -->
          <div v-else class="flex flex-1 flex-col overflow-hidden min-h-0">
            <div class="flex-1 overflow-y-auto min-h-0 rounded-xl border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{{ $t('memory.dailyColumnDate') }}</TableHead>
                    <TableHead>{{ $t('memory.dailyColumnUpdated') }}</TableHead>
                    <TableHead class="text-right">{{ $t('memory.dailyColumnSize') }}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow
                    v-for="(file, idx) in paginatedDailyFiles"
                    :key="file.date"
                    class="cursor-pointer"
                    :class="idx % 2 === 1 ? 'bg-muted/50' : ''"
                    @click="openDailyFile(file.date)"
                  >
                    <TableCell class="font-semibold">{{ file.date }}</TableCell>
                    <TableCell class="text-muted-foreground">{{ formatDate(file.modifiedAt) }}</TableCell>
                    <TableCell class="text-right text-muted-foreground">{{ formatSize(file.size) }}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>

            <!-- Pagination -->
            <div v-if="totalPages > 1" class="flex shrink-0 items-center justify-between pt-3">
              <span class="text-xs text-muted-foreground">
                {{ $t('memory.dailyPagination', { from: paginationFrom, to: paginationTo, total: filteredDailyFiles.length }) }}
              </span>
              <div class="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  :disabled="currentPage <= 1"
                  :aria-label="$t('memory.dailyPrevPage')"
                  @click="currentPage--"
                >
                  <AppIcon name="arrowLeft" class="h-4 w-4" />
                </Button>
                <span class="px-2 text-xs text-muted-foreground">
                  {{ currentPage }} / {{ totalPages }}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  :disabled="currentPage >= totalPages"
                  :aria-label="$t('memory.dailyNextPage')"
                  @click="currentPage++"
                >
                  <AppIcon name="arrowRight" class="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        </div>

        <!-- Daily editor view -->
        <div v-else class="flex flex-1 flex-col overflow-hidden min-h-0">
          <div class="mb-3 flex shrink-0 flex-wrap items-center gap-3">
            <Button variant="outline" size="icon" class="h-8 w-8" :aria-label="$t('memory.backToList')" @click="closeDailyFile">
              <AppIcon name="arrowLeft" class="h-4 w-4" />
            </Button>
            <div>
              <span class="block text-base font-bold text-foreground">{{ selectedDaily }}</span>
              <p class="text-xs text-muted-foreground">{{ $t('memory.dailyEditorDescription') }}</p>
            </div>
          </div>

          <div v-if="loading" class="flex flex-1 items-center justify-center py-20 text-sm text-muted-foreground">
            {{ $t('memory.loading') }}
          </div>
          <div v-else class="flex flex-1 flex-col overflow-hidden min-h-0">
            <MarkdownEditor
              v-model="dailyContent"
              :saving="saving"
              :file-path="`.data/memory/daily/${selectedDaily}.md`"
              @save="handleSaveDaily"
            />
          </div>
        </div>
      </TabsContent>
    </Tabs>
    </div>
  </div>
</template>

<script setup lang="ts">
const { user } = useAuth()
const isAdmin = computed(() => user.value?.role === 'admin')

const {
  loading,
  saving,
  error,
  successMessage,
  loadSoul,
  saveSoul,
  loadCoreMemory,
  saveCoreMemory,
  loadAgentRules,
  saveAgentRules,
  loadHeartbeat,
  saveHeartbeat,
  loadProfile,
  saveProfile,
  loadDailyFiles,
  loadDailyFile,
  saveDailyFile,
  clearMessages,
} = useMemory()

const activeTab = ref<'soul' | 'core' | 'agents' | 'heartbeat' | 'profile' | 'daily'>('soul')

const soulContent = ref('')
const coreMemoryContent = ref('')
const agentRulesContent = ref('')
const heartbeatContent = ref('')
const profileContent = ref('')
const profileUsername = ref('')
const dailyContent = ref('')
const dailyFiles = ref<{ filename: string; date: string; size: number; modifiedAt: string }[]>([])
const selectedDaily = ref<string | null>(null)

// Date range filter — default to last 7 days
const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const today = new Date()
const sevenDaysAgo = new Date(today)
sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6)
const dailyDateFrom = ref(fmt(sevenDaysAgo))
const dailyDateTo = ref(fmt(today))

// Pagination
const PAGE_SIZE = 10
const currentPage = ref(1)

const filteredDailyFiles = computed(() => {
  if (!dailyDateFrom.value && !dailyDateTo.value) return dailyFiles.value
  return dailyFiles.value.filter((f) => {
    if (dailyDateFrom.value && f.date < dailyDateFrom.value) return false
    if (dailyDateTo.value && f.date > dailyDateTo.value) return false
    return true
  })
})

const totalPages = computed(() => Math.max(1, Math.ceil(filteredDailyFiles.value.length / PAGE_SIZE)))

const paginatedDailyFiles = computed(() => {
  const start = (currentPage.value - 1) * PAGE_SIZE
  return filteredDailyFiles.value.slice(start, start + PAGE_SIZE)
})

const paginationFrom = computed(() => {
  if (filteredDailyFiles.value.length === 0) return 0
  return (currentPage.value - 1) * PAGE_SIZE + 1
})

const paginationTo = computed(() => Math.min(currentPage.value * PAGE_SIZE, filteredDailyFiles.value.length))

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

async function switchTab(tab: typeof activeTab.value) {
  clearMessages()
  activeTab.value = tab

  if (tab === 'soul') {
    soulContent.value = await loadSoul()
  } else if (tab === 'core') {
    coreMemoryContent.value = await loadCoreMemory()
  } else if (tab === 'agents') {
    agentRulesContent.value = await loadAgentRules()
  } else if (tab === 'heartbeat') {
    heartbeatContent.value = await loadHeartbeat()
  } else if (tab === 'profile') {
    const profile = await loadProfile()
    profileContent.value = profile.content
    profileUsername.value = profile.username
  } else if (tab === 'daily') {
    await refreshDailyFiles()
  }
}

async function refreshDailyFiles() {
  selectedDaily.value = null
  currentPage.value = 1
  dailyFiles.value = await loadDailyFiles()
}

function onDailyRangeChange() {
  currentPage.value = 1
}

async function handleSaveSoul() {
  await saveSoul(soulContent.value)
  autoHideSuccess()
}

async function handleSaveCoreMemory() {
  await saveCoreMemory(coreMemoryContent.value)
  autoHideSuccess()
}

async function handleSaveAgentRules() {
  await saveAgentRules(agentRulesContent.value)
  autoHideSuccess()
}

async function handleSaveHeartbeat() {
  await saveHeartbeat(heartbeatContent.value)
  autoHideSuccess()
}

async function handleSaveProfile() {
  await saveProfile(profileContent.value)
  autoHideSuccess()
}

async function handleSaveDaily() {
  if (!selectedDaily.value) return
  const saved = await saveDailyFile(selectedDaily.value, dailyContent.value)
  if (saved) {
    const currentDate = selectedDaily.value
    await refreshDailyFiles()
    selectedDaily.value = currentDate
  }
  autoHideSuccess()
}

async function openDailyFile(date: string) {
  clearMessages()
  selectedDaily.value = date
  dailyContent.value = await loadDailyFile(date)
}

function closeDailyFile() {
  selectedDaily.value = null
  dailyContent.value = ''
  clearMessages()
}

function autoHideSuccess() {
  setTimeout(() => {
    successMessage.value = null
  }, 3000)
}

onMounted(async () => {
  if (!isAdmin.value) return
  soulContent.value = await loadSoul()
})
</script>
