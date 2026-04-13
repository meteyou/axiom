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

    <div class="mx-auto flex w-full max-w-6xl flex-1 flex-col overflow-hidden p-6">
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
          <TabsTrigger value="wiki" @click="switchTab('wiki')">{{ $t('memory.wikiTab') }}</TabsTrigger>
          <TabsTrigger value="core" @click="switchTab('core')">{{ $t('memory.coreMemoryTab') }}</TabsTrigger>
          <TabsTrigger value="projects" @click="switchTab('projects')">{{ $t('memory.projectsTab') }}</TabsTrigger>
          <TabsTrigger value="profile" @click="switchTab('profile')">{{ $t('memory.profileTab') }}</TabsTrigger>
          <TabsTrigger value="soul" @click="switchTab('soul')">{{ $t('memory.soulTab') }}</TabsTrigger>
          <TabsTrigger value="daily" @click="switchTab('daily')">{{ $t('memory.dailyTab') }}</TabsTrigger>
        </TabsList>

        <DateRangePicker
          v-if="activeTab === 'daily'"
          v-model:date-from="dailyDateFrom"
          v-model:date-to="dailyDateTo"
          @change="onDailyRangeChange"
        />
      </div>

      <!-- Wiki tab -->
      <TabsContent value="wiki" class="flex flex-1 flex-col overflow-hidden min-h-0 mt-0">
        <!-- Main layout: sidebar + content -->
        <div class="flex flex-1 gap-4 overflow-hidden min-h-0">
          <!-- Sidebar: page list -->
          <aside class="flex w-64 shrink-0 flex-col overflow-hidden rounded-xl border border-border">
            <!-- Sidebar header -->
            <div class="flex items-center gap-2 border-b border-border px-3 py-2.5">
              <input
                v-model="searchQuery"
                type="text"
                :placeholder="$t('wiki.searchPlaceholder')"
                class="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              >
              <Button
                variant="ghost"
                size="icon"
                class="h-7 w-7 shrink-0"
                :aria-label="$t('wiki.newPage')"
                :title="$t('wiki.newPage')"
                @click="startNewPage"
              >
                <AppIcon name="add" class="h-4 w-4" />
              </Button>
            </div>

            <!-- Page list -->
            <div class="flex-1 overflow-y-auto">
              <div v-if="loading && wikiPages.length === 0" class="flex items-center justify-center py-8 text-sm text-muted-foreground">
                {{ $t('wiki.loading') }}
              </div>
              <div v-else-if="filteredPages.length === 0" class="flex flex-col items-center justify-center gap-2 py-8 px-4 text-center text-muted-foreground">
                <AppIcon name="file" size="xl" class="h-8 w-8 opacity-40" />
                <p class="text-xs">{{ searchQuery ? $t('wiki.noResults') : $t('wiki.empty') }}</p>
              </div>
              <button
                v-for="page in filteredPages"
                :key="page.filename"
                type="button"
                class="flex w-full items-start gap-2 px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                :class="selectedPage === page.name ? 'bg-primary/10 text-primary font-medium' : 'text-foreground/80'"
                @click="openPage(page.name)"
              >
                <AppIcon name="file" class="mt-0.5 shrink-0 text-muted-foreground" />
                <span class="truncate">{{ page.title || page.name }}</span>
              </button>
            </div>

            <!-- Sidebar footer -->
            <div class="border-t border-border px-3 py-2 text-xs text-muted-foreground">
              {{ $t('wiki.pageCount', { count: wikiPages.length }) }}
            </div>
          </aside>

          <!-- Content area -->
          <div class="flex flex-1 flex-col overflow-hidden min-h-0">
            <!-- New page creation form -->
            <div v-if="creatingNewPage" class="mb-3 flex shrink-0 items-center gap-2">
              <Button variant="outline" size="icon" class="h-8 w-8 shrink-0" :aria-label="$t('common.cancel')" @click="cancelNewPage">
                <AppIcon name="arrowLeft" class="h-4 w-4" />
              </Button>
              <input
                ref="newPageNameInput"
                v-model="newPageName"
                type="text"
                :placeholder="$t('wiki.newPageNamePlaceholder')"
                class="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none ring-offset-background focus:ring-2 focus:ring-ring"
                @keydown.enter="confirmNewPage"
                @keydown.escape="cancelNewPage"
              >
              <Button size="sm" :disabled="!newPageName.trim()" @click="confirmNewPage">
                {{ $t('wiki.createPage') }}
              </Button>
            </div>

            <!-- Editor header when page is selected -->
            <div v-else-if="selectedPage" class="mb-3 flex shrink-0 flex-wrap items-center gap-2">
              <Button variant="outline" size="icon" class="h-8 w-8" :aria-label="$t('wiki.backToList')" @click="closePage">
                <AppIcon name="arrowLeft" class="h-4 w-4" />
              </Button>
              <div class="flex-1 min-w-0">
                <span class="block truncate text-base font-bold text-foreground">{{ selectedPage }}</span>
                <p class="text-xs text-muted-foreground">{{ $t('wiki.editorDescription') }}</p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                class="h-8 w-8 text-destructive hover:text-destructive"
                :aria-label="$t('wiki.deletePage')"
                :title="$t('wiki.deletePage')"
                @click="confirmDelete"
              >
                <AppIcon name="trash" class="h-4 w-4" />
              </Button>
            </div>

            <!-- Empty state -->
            <div v-if="!selectedPage && !creatingNewPage" class="flex flex-1 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
              <AppIcon name="file" size="xl" class="h-12 w-12 opacity-30" />
              <div>
                <p class="font-medium text-foreground/70">{{ $t('wiki.selectPageTitle') }}</p>
                <p class="mt-1 text-sm">{{ $t('wiki.selectPageDescription') }}</p>
              </div>
              <Button variant="outline" size="sm" @click="startNewPage">
                <AppIcon name="add" class="mr-2 h-4 w-4" />
                {{ $t('wiki.newPage') }}
              </Button>
            </div>

            <!-- Loading content -->
            <div v-else-if="loading && selectedPage" class="flex flex-1 items-center justify-center py-20 text-sm text-muted-foreground">
              {{ $t('wiki.loading') }}
            </div>

            <!-- Editor -->
            <div v-else-if="selectedPage || creatingNewPage" class="flex flex-1 flex-col overflow-hidden min-h-0">
              <MarkdownEditor
                v-model="pageContent"
                :saving="saving"
                :file-path="selectedPage ? `.data/memory/wiki/${selectedPage}.md` : ''"
                @save="handleSavePage"
              />
            </div>
          </div>
        </div>
      </TabsContent>

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

      <!-- Projects tab -->
      <TabsContent value="projects" class="flex flex-1 flex-col overflow-hidden min-h-0 mt-0">
        <!-- Projects list view -->
        <div v-if="!selectedProject" class="flex flex-1 flex-col overflow-hidden min-h-0">
          <div v-if="loading" class="flex items-center justify-center py-16 text-sm text-muted-foreground">
            {{ $t('memory.loading') }}
          </div>
          <div v-else-if="projectFiles.length === 0" class="flex flex-col items-center justify-center gap-3 py-16 text-center text-muted-foreground">
            <AppIcon name="folder" size="xl" class="h-10 w-10 opacity-40" />
            <p class="text-sm">{{ $t('memory.noProjectFiles') }}</p>
          </div>

          <!-- Table + Pagination -->
          <div v-else class="flex flex-1 flex-col overflow-hidden min-h-0">
            <div class="flex-1 overflow-y-auto min-h-0 rounded-xl border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{{ $t('memory.projectColumnName') }}</TableHead>
                    <TableHead>{{ $t('memory.dailyColumnUpdated') }}</TableHead>
                    <TableHead class="text-right">{{ $t('memory.dailyColumnSize') }}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow
                    v-for="(file, idx) in paginatedProjectFiles"
                    :key="file.name"
                    class="cursor-pointer"
                    :class="idx % 2 === 1 ? 'bg-muted/50' : ''"
                    @click="openProjectFile(file.name)"
                  >
                    <TableCell class="font-semibold">{{ file.name }}</TableCell>
                    <TableCell class="text-muted-foreground">{{ formatDate(file.modifiedAt) }}</TableCell>
                    <TableCell class="text-right text-muted-foreground">{{ formatSize(file.size) }}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>

            <!-- Pagination -->
            <div v-if="projectTotalPages > 1" class="flex shrink-0 items-center justify-between pt-3">
              <span class="text-xs text-muted-foreground">
                {{ $t('memory.dailyPagination', { from: projectPaginationFrom, to: projectPaginationTo, total: projectFiles.length }) }}
              </span>
              <div class="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  :disabled="projectCurrentPage <= 1"
                  :aria-label="$t('memory.dailyPrevPage')"
                  @click="projectCurrentPage--"
                >
                  <AppIcon name="arrowLeft" class="h-4 w-4" />
                </Button>
                <span class="px-2 text-xs text-muted-foreground">
                  {{ projectCurrentPage }} / {{ projectTotalPages }}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  :disabled="projectCurrentPage >= projectTotalPages"
                  :aria-label="$t('memory.dailyNextPage')"
                  @click="projectCurrentPage++"
                >
                  <AppIcon name="arrowRight" class="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        </div>

        <!-- Project editor view -->
        <div v-else class="flex flex-1 flex-col overflow-hidden min-h-0">
          <div class="mb-3 flex shrink-0 flex-wrap items-center gap-3">
            <Button variant="outline" size="icon" class="h-8 w-8" :aria-label="$t('memory.backToList')" @click="closeProjectFile">
              <AppIcon name="arrowLeft" class="h-4 w-4" />
            </Button>
            <div>
              <span class="block text-base font-bold text-foreground">{{ selectedProject }}</span>
              <p class="text-xs text-muted-foreground">{{ $t('memory.projectEditorDescription') }}</p>
            </div>
          </div>

          <div v-if="loading" class="flex flex-1 items-center justify-center py-20 text-sm text-muted-foreground">
            {{ $t('memory.loading') }}
          </div>
          <div v-else class="flex flex-1 flex-col overflow-hidden min-h-0">
            <MarkdownEditor
              v-model="projectContent"
              :saving="saving"
              :file-path="`.data/memory/projects/${selectedProject}.md`"
              @save="handleSaveProject"
            />
          </div>
        </div>
      </TabsContent>
    </Tabs>
    </div>

    <!-- Delete confirmation dialog -->
    <ConfirmDialog
      v-model:open="deleteDialogOpen"
      :title="$t('wiki.deleteConfirmTitle')"
      :description="$t('wiki.deleteConfirmDescription', { name: selectedPage ?? '' })"
      :confirm-label="$t('common.delete')"
      variant="destructive"
      @confirm="handleDeletePage"
    />
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
  loadProfile,
  saveProfile,
  loadDailyFiles,
  loadDailyFile,
  saveDailyFile,
  loadProjectFiles,
  loadProjectFile,
  saveProjectFile,
  clearMessages,
} = useMemory()

const {
  loadWikiPages,
  loadWikiPage,
  saveWikiPage,
  deleteWikiPage,
} = useWiki()

const activeTab = ref<'soul' | 'core' | 'profile' | 'daily' | 'projects' | 'wiki'>('wiki')

// Wiki state
interface WikiFile {
  filename: string
  name: string
  title: string
  aliases: string[]
  size: number
  modifiedAt: string
}

const wikiPages = ref<WikiFile[]>([])
const selectedPage = ref<string | null>(null)
const pageContent = ref('')
const searchQuery = ref('')
const creatingNewPage = ref(false)
const newPageName = ref('')
const newPageNameInput = ref<HTMLInputElement | null>(null)
const deleteDialogOpen = ref(false)

const filteredPages = computed(() => {
  if (!searchQuery.value.trim()) return wikiPages.value
  const q = searchQuery.value.toLowerCase()
  return wikiPages.value.filter(p =>
    p.name.toLowerCase().includes(q) ||
    p.title.toLowerCase().includes(q) ||
    p.aliases.some(a => a.toLowerCase().includes(q)),
  )
})

async function refreshPages() {
  wikiPages.value = await loadWikiPages()
}

async function openPage(name: string) {
  clearMessages()
  creatingNewPage.value = false
  selectedPage.value = name
  pageContent.value = await loadWikiPage(name)
}

function closePage() {
  selectedPage.value = null
  pageContent.value = ''
  clearMessages()
}

function startNewPage() {
  clearMessages()
  creatingNewPage.value = true
  newPageName.value = ''
  selectedPage.value = null
  pageContent.value = ''
  nextTick(() => {
    newPageNameInput.value?.focus()
  })
}

function cancelNewPage() {
  creatingNewPage.value = false
  newPageName.value = ''
}

async function confirmNewPage() {
  const name = newPageName.value.trim().replace(/\.md$/i, '').replace(/\s+/g, '-')
  if (!name) return

  // Validate: alphanumeric, hyphens, underscores, dots
  if (!/^[\w.-]+$/.test(name)) {
    error.value = 'Page name may only contain letters, digits, hyphens, underscores, and dots.'
    return
  }

  creatingNewPage.value = false
  newPageName.value = ''
  selectedPage.value = name
  pageContent.value = `# ${name}\n\n`
  // Save immediately so the page appears in the list
  const saved = await saveWikiPage(name, pageContent.value)
  if (saved) {
    await refreshPages()
    autoHideSuccess()
  }
}

async function handleSavePage() {
  if (!selectedPage.value) return
  const saved = await saveWikiPage(selectedPage.value, pageContent.value)
  if (saved) {
    const currentPageName = selectedPage.value
    await refreshPages()
    selectedPage.value = currentPageName
    autoHideSuccess()
  }
}

function confirmDelete() {
  deleteDialogOpen.value = true
}

async function handleDeletePage() {
  if (!selectedPage.value) return
  const deleted = await deleteWikiPage(selectedPage.value)
  if (deleted) {
    selectedPage.value = null
    pageContent.value = ''
    await refreshPages()
  }
  deleteDialogOpen.value = false
}

// Memory state
const soulContent = ref('')
const coreMemoryContent = ref('')
const profileContent = ref('')
const profileUsername = ref('')
const dailyContent = ref('')
const dailyFiles = ref<{ filename: string; date: string; size: number; modifiedAt: string }[]>([])
const selectedDaily = ref<string | null>(null)
const projectContent = ref('')
const projectFiles = ref<{ filename: string; name: string; size: number; modifiedAt: string }[]>([])
const selectedProject = ref<string | null>(null)

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

// Project pagination
const projectCurrentPage = ref(1)
const projectTotalPages = computed(() => Math.max(1, Math.ceil(projectFiles.value.length / PAGE_SIZE)))
const paginatedProjectFiles = computed(() => {
  const start = (projectCurrentPage.value - 1) * PAGE_SIZE
  return projectFiles.value.slice(start, start + PAGE_SIZE)
})
const projectPaginationFrom = computed(() => {
  if (projectFiles.value.length === 0) return 0
  return (projectCurrentPage.value - 1) * PAGE_SIZE + 1
})
const projectPaginationTo = computed(() => Math.min(projectCurrentPage.value * PAGE_SIZE, projectFiles.value.length))

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

  if (tab === 'wiki') {
    await refreshPages()
  } else if (tab === 'soul') {
    soulContent.value = await loadSoul()
  } else if (tab === 'core') {
    coreMemoryContent.value = await loadCoreMemory()
  } else if (tab === 'profile') {
    const profile = await loadProfile()
    profileContent.value = profile.content
    profileUsername.value = profile.username
  } else if (tab === 'daily') {
    await refreshDailyFiles()
  } else if (tab === 'projects') {
    await refreshProjectFiles()
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

async function refreshProjectFiles() {
  selectedProject.value = null
  projectCurrentPage.value = 1
  projectFiles.value = await loadProjectFiles()
}

async function openProjectFile(name: string) {
  clearMessages()
  selectedProject.value = name
  projectContent.value = await loadProjectFile(name)
}

function closeProjectFile() {
  selectedProject.value = null
  projectContent.value = ''
  clearMessages()
}

async function handleSaveProject() {
  if (!selectedProject.value) return
  const saved = await saveProjectFile(selectedProject.value, projectContent.value)
  if (saved) {
    const currentName = selectedProject.value
    await refreshProjectFiles()
    selectedProject.value = currentName
  }
  autoHideSuccess()
}

function autoHideSuccess() {
  setTimeout(() => {
    successMessage.value = null
  }, 3000)
}

onMounted(async () => {
  if (!isAdmin.value) return
  await refreshPages()
})
</script>
