<template>
  <!-- Admin gate -->
  <div v-if="!isAdmin" class="flex h-full flex-col items-center justify-center gap-3 p-10 text-center text-muted-foreground">
    <AppIcon name="lock" size="xl" class="h-10 w-10" />
    <h1 class="text-xl font-semibold text-foreground">{{ $t('admin.title') }}</h1>
    <p class="text-sm">{{ $t('admin.description') }}</p>
  </div>

  <!-- Page body -->
  <div v-else class="flex h-full flex-col overflow-hidden">
    <PageHeader :title="$t('wiki.title')" :subtitle="$t('wiki.subtitle')" />

    <div class="mx-auto flex w-full max-w-6xl flex-1 flex-col overflow-hidden p-6 gap-4">
      <!-- Error / success banners -->
      <Alert v-if="error" variant="destructive" class="shrink-0">
        <AlertDescription class="flex items-center justify-between">
          <span>{{ error }}</span>
          <button type="button" class="ml-2 opacity-70 hover:opacity-100 transition-opacity" :aria-label="$t('aria.closeAlert')" @click="clearMessages()">
            <AppIcon name="close" class="h-4 w-4" />
          </button>
        </AlertDescription>
      </Alert>

      <Alert v-if="successMessage" variant="success" class="shrink-0">
        <AlertDescription class="flex items-center justify-between">
          <span>{{ $t('wiki.saveSuccess') }}</span>
          <button type="button" class="ml-2 opacity-70 hover:opacity-100 transition-opacity" :aria-label="$t('aria.closeAlert')" @click="clearMessages()">
            <AppIcon name="close" class="h-4 w-4" />
          </button>
        </AlertDescription>
      </Alert>

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
  loadWikiPages,
  loadWikiPage,
  saveWikiPage,
  deleteWikiPage,
  clearMessages,
} = useWiki()

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
    const currentPage = selectedPage.value
    await refreshPages()
    selectedPage.value = currentPage
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
