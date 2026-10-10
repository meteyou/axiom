<template>
  <div class="flex h-full flex-col overflow-hidden">
    <PageHeader :title="$t('memory.title')" :subtitle="$t('memory.userSubtitle')" />

    <div class="mx-auto flex w-full max-w-6xl flex-1 flex-col overflow-hidden p-6">
      <Alert v-if="error" variant="destructive" class="mb-3 shrink-0">
        <AlertDescription class="flex items-center justify-between">
          <span>{{ error }}</span>
          <button type="button" class="ml-2 opacity-70 transition-opacity hover:opacity-100" :aria-label="$t('aria.closeAlert')" @click="error = null">
            <AppIcon name="close" class="h-4 w-4" />
          </button>
        </AlertDescription>
      </Alert>

      <Alert v-if="saved" variant="success" class="mb-3 shrink-0">
        <AlertDescription>{{ $t('memory.saveSuccess') }}</AlertDescription>
      </Alert>

      <Tabs v-model="activeTab" class="flex min-h-0 flex-1 flex-col overflow-hidden">
        <TabsList class="mb-4 shrink-0 self-start">
          <TabsTrigger value="profile">{{ $t('memory.profileTab') }}</TabsTrigger>
          <TabsTrigger value="daily">{{ $t('memory.dailyTab') }}</TabsTrigger>
          <TabsTrigger value="facts">{{ $t('memory.factsTab') }}</TabsTrigger>
          <TabsTrigger value="wiki">{{ $t('memory.wikiTab') }}</TabsTrigger>
        </TabsList>

        <TabsContent value="profile" class="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
          <MarkdownEditor v-model="profileContent" :saving="saving" @save="saveProfile" />
        </TabsContent>

        <TabsContent value="daily" class="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
          <div class="flex min-h-0 flex-1 gap-4 overflow-hidden">
            <aside class="w-56 shrink-0 overflow-y-auto rounded-xl border border-border py-1">
              <p v-if="dailyFiles.length === 0" class="px-4 py-8 text-center text-xs text-muted-foreground">{{ $t('memory.noDaily') }}</p>
              <button
                v-for="file in dailyFiles"
                :key="file.date"
                type="button"
                class="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted"
                :class="selectedDaily === file.date ? 'bg-muted font-medium' : ''"
                @click="openDaily(file.date)"
              >
                {{ file.date }}
              </button>
            </aside>
            <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
              <MarkdownEditor v-if="selectedDaily" v-model="dailyContent" :saving="saving" @save="saveDaily" />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="facts" class="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
          <MemoryFactsTab />
        </TabsContent>

        <TabsContent value="wiki" class="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
          <p class="mb-3 shrink-0 text-xs text-muted-foreground">{{ $t('memory.wikiShared') }}</p>
          <div class="flex min-h-0 flex-1 gap-4 overflow-hidden">
            <aside class="flex w-64 shrink-0 flex-col overflow-hidden rounded-xl border border-border">
              <div class="flex items-center gap-2 border-b border-border px-3 py-2.5">
                <input
                  v-model="wikiSearch"
                  type="text"
                  :placeholder="$t('memory.searchPlaceholder')"
                  class="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                >
                <Button variant="ghost" size="icon" class="h-7 w-7 shrink-0" :title="$t('memory.newWikiPage')" :aria-label="$t('memory.newWikiPage')" @click="startNewWiki">
                  <AppIcon name="add" class="h-4 w-4" />
                </Button>
              </div>
              <div class="flex-1 overflow-y-auto py-1">
                <p v-if="filteredWiki.length === 0" class="px-4 py-8 text-center text-xs text-muted-foreground">{{ $t('memory.noWiki') }}</p>
                <button
                  v-for="page in filteredWiki"
                  :key="page.name"
                  type="button"
                  class="block w-full truncate px-3 py-1.5 text-left text-sm hover:bg-muted"
                  :class="selectedWiki === page.name ? 'bg-muted font-medium' : ''"
                  @click="openWiki(page.name)"
                >
                  {{ page.title }}
                </button>
              </div>
            </aside>
            <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
              <div v-if="creatingWiki" class="mb-3 flex shrink-0 items-center gap-2">
                <input
                  v-model="newWikiName"
                  type="text"
                  :placeholder="$t('memory.wikiPageName')"
                  class="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
                  @keydown.enter="confirmNewWiki"
                  @keydown.escape="creatingWiki = false"
                >
                <Button size="sm" :disabled="!newWikiName.trim()" @click="confirmNewWiki">{{ $t('memory.createPage') }}</Button>
              </div>
              <template v-else-if="selectedWiki">
                <div class="mb-3 flex shrink-0 items-center justify-between gap-2">
                  <span class="truncate text-base font-bold">{{ selectedWiki }}</span>
                  <Button variant="ghost" size="icon" class="h-8 w-8 text-destructive hover:text-destructive" :title="$t('memory.deletePage')" :aria-label="$t('memory.deletePage')" @click="deleteDialogOpen = true">
                    <AppIcon name="trash" class="h-4 w-4" />
                  </Button>
                </div>
                <MarkdownEditor v-model="wikiContent" :saving="saving" @save="saveWiki" />
              </template>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>

    <ConfirmDialog
      v-model:open="deleteDialogOpen"
      :title="$t('memory.deleteConfirmTitle')"
      :description="$t('memory.deleteConfirmDescription', { name: selectedWiki ?? '' })"
      :confirm-label="$t('common.delete')"
      variant="destructive"
      @confirm="deleteWiki"
      @cancel="deleteDialogOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
import type { MemoryDailyFile, MemoryWikiFile } from '~/api/memory'
import { useMemoryApi } from '~/api/memory'

const memoryApi = useMemoryApi()

const activeTab = ref('profile')
const error = ref<string | null>(null)
const saved = ref(false)
const saving = ref(false)

const profileContent = ref('')
const dailyFiles = ref<MemoryDailyFile[]>([])
const selectedDaily = ref<string | null>(null)
const dailyContent = ref('')
const wikiFiles = ref<MemoryWikiFile[]>([])
const wikiSearch = ref('')
const selectedWiki = ref<string | null>(null)
const wikiContent = ref('')
const creatingWiki = ref(false)
const newWikiName = ref('')
const deleteDialogOpen = ref(false)

const filteredWiki = computed(() => {
  const query = wikiSearch.value.trim().toLowerCase()
  if (!query) return wikiFiles.value
  return wikiFiles.value.filter((page) => page.name.toLowerCase().includes(query) || page.title.toLowerCase().includes(query))
})

async function run(action: () => Promise<void>, flagSaved = false) {
  error.value = null
  saved.value = false
  try {
    await action()
    if (flagSaved) {
      saved.value = true
      setTimeout(() => { saved.value = false }, 3000)
    }
  } catch (err) {
    error.value = (err as Error).message
  }
}

async function withSaving(action: () => Promise<void>) {
  saving.value = true
  await run(action, true)
  saving.value = false
}

const saveProfile = () => withSaving(async () => { await memoryApi.updateProfile(profileContent.value) })

const openDaily = (date: string) => run(async () => {
  dailyContent.value = (await memoryApi.getDaily(date)).content
  selectedDaily.value = date
})
const saveDaily = () => withSaving(async () => {
  if (selectedDaily.value) await memoryApi.updateDaily(selectedDaily.value, dailyContent.value)
})

async function refreshWiki() {
  wikiFiles.value = (await memoryApi.listWiki()).files
}
const openWiki = (name: string) => run(async () => {
  creatingWiki.value = false
  wikiContent.value = (await memoryApi.getWikiPage(name)).content
  selectedWiki.value = name
})
const saveWiki = () => withSaving(async () => {
  if (!selectedWiki.value) return
  await memoryApi.updateWikiPage(selectedWiki.value, wikiContent.value)
  await refreshWiki()
})
function startNewWiki() {
  newWikiName.value = ''
  creatingWiki.value = true
}
const confirmNewWiki = () => run(async () => {
  const name = newWikiName.value.trim().replace(/\.md$/, '')
  if (!name) return
  await refreshWiki()
  const existing = wikiFiles.value.find((page) => page.name.toLowerCase() === name.toLowerCase())
  if (existing) {
    await openWiki(existing.name)
    return
  }
  await memoryApi.updateWikiPage(name, '')
  await refreshWiki()
  await openWiki(name)
})
const deleteWiki = () => run(async () => {
  deleteDialogOpen.value = false
  if (!selectedWiki.value) return
  await memoryApi.deleteWikiPage(selectedWiki.value)
  selectedWiki.value = null
  wikiContent.value = ''
  await refreshWiki()
})

onMounted(() => run(async () => {
  const [profile, daily] = await Promise.all([memoryApi.getProfile(), memoryApi.listDaily(), refreshWiki()])
  profileContent.value = profile.content
  dailyFiles.value = daily.files
}))
</script>
