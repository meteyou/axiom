<template>
  <div class="flex h-full flex-col overflow-hidden">
    <PageHeader :title="$t('memory.title')" :subtitle="$t('memory.subtitle')" />

    <div class="mx-auto flex w-full max-w-6xl flex-1 flex-col overflow-hidden p-6">
      <!-- Error / success banners -->
      <Alert v-if="error" variant="destructive" class="mb-3 shrink-0">
        <AlertDescription class="flex items-center justify-between">
          <span>{{ error }}</span>
          <button type="button" class="ml-2 opacity-70 transition-opacity hover:opacity-100" :aria-label="$t('aria.closeAlert')" @click="clearMessages()">
            <AppIcon name="close" class="h-4 w-4" />
          </button>
        </AlertDescription>
      </Alert>

      <Alert v-if="successMessage" variant="success" class="mb-3 shrink-0">
        <AlertDescription class="flex items-center justify-between">
          <span>{{ $t('memory.saveSuccess') }}</span>
          <button type="button" class="ml-2 opacity-70 transition-opacity hover:opacity-100" :aria-label="$t('aria.closeAlert')" @click="clearMessages()">
            <AppIcon name="close" class="h-4 w-4" />
          </button>
        </AlertDescription>
      </Alert>

      <!-- Tabs -->
      <Tabs v-model="activeTab" class="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div class="mb-4 flex shrink-0 flex-wrap items-center gap-3">
          <TabsList class="self-start">
            <TabsTrigger value="wiki" @click="switchTab('wiki')">{{ $t('memory.wikiTab') }}</TabsTrigger>
            <TabsTrigger value="core" @click="switchTab('core')">{{ $t('memory.coreMemoryTab') }}</TabsTrigger>
            <TabsTrigger value="facts" @click="switchTab('facts')">{{ $t('memory.factsTab') }}</TabsTrigger>
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
        <TabsContent value="wiki" class="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
          <!-- Main layout: sidebar + content -->
          <div class="flex min-h-0 flex-1 gap-4 overflow-hidden">
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
                <div v-else-if="filteredPages.length === 0" class="flex flex-col items-center justify-center gap-2 px-4 py-8 text-center text-muted-foreground">
                  <AppIcon name="file" size="xl" class="h-8 w-8 opacity-40" />
                  <p class="text-xs">{{ searchQuery ? $t('wiki.noResults') : $t('wiki.empty') }}</p>
                </div>
                <button
                  v-for="page in filteredPages"
                  :key="page.filename"
                  type="button"
                  class="flex w-full items-start gap-2 px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                  :class="selectedPage === page.name ? 'bg-primary/10 font-medium text-primary' : 'text-foreground/80'"
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
            <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
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
                <div class="min-w-0 flex-1">
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
              <div v-else-if="selectedPage || creatingNewPage" class="flex min-h-0 flex-1 flex-col overflow-hidden">
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
        <TabsContent value="soul" class="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
          <div v-if="loading" class="flex flex-1 items-center justify-center py-20 text-sm text-muted-foreground">
            {{ $t('memory.loading') }}
          </div>
          <div v-else class="flex min-h-0 flex-1 flex-col overflow-hidden">
            <MarkdownEditor
              v-model="soulContent"
              :saving="saving"
              file-path=".data/memory/SOUL.md"
              @save="handleSaveSoul"
            />
          </div>
        </TabsContent>

        <!-- Core Memory tab -->
        <TabsContent value="core" class="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
          <div v-if="loading" class="flex flex-1 items-center justify-center py-20 text-sm text-muted-foreground">
            {{ $t('memory.loading') }}
          </div>
          <div v-else class="flex min-h-0 flex-1 flex-col overflow-hidden">
            <MarkdownEditor
              v-model="coreMemoryContent"
              :saving="saving"
              file-path=".data/memory/MEMORY.md"
              @save="handleSaveCoreMemory"
            />
          </div>
        </TabsContent>

        <!-- Profile tab -->
        <TabsContent value="profile" class="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
          <div v-if="loading" class="flex flex-1 items-center justify-center py-20 text-sm text-muted-foreground">
            {{ $t('memory.loading') }}
          </div>
          <div v-else class="flex min-h-0 flex-1 flex-col overflow-hidden">
            <MarkdownEditor
              v-model="profileContent"
              :saving="saving"
              :file-path="`.data/memory/users/${profileUsername || 'profile'}.md`"
              @save="handleSaveProfile"
            />
          </div>
        </TabsContent>

        <!-- Facts tab -->
        <TabsContent value="facts" class="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
          <MemoryFactsTab />
        </TabsContent>

        <!-- Daily tab -->
        <TabsContent value="daily" class="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
          <!-- Daily list view (table) -->
          <div v-if="!selectedDaily" class="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div v-if="loading" class="flex items-center justify-center py-16 text-sm text-muted-foreground">
              {{ $t('memory.loading') }}
            </div>
            <div v-else-if="filteredDailyFiles.length === 0" class="flex flex-col items-center justify-center gap-3 py-16 text-center text-muted-foreground">
              <AppIcon name="calendar" size="xl" class="h-10 w-10 opacity-40" />
              <p class="text-sm">{{ $t('memory.noDailyFilesInRange') }}</p>
            </div>

            <!-- Table + Pagination -->
            <div v-else class="flex min-h-0 flex-1 flex-col overflow-hidden">
              <div class="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border">
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
          <div v-else class="flex min-h-0 flex-1 flex-col overflow-hidden">
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
            <div v-else class="flex min-h-0 flex-1 flex-col overflow-hidden">
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
import { useMemoryWorkspace } from '~/features/memory/composables/useMemoryWorkspace'

const {
  loading,
  saving,
  error,
  successMessage,
  clearMessages,
  activeTab,
  wikiPages,
  selectedPage,
  pageContent,
  searchQuery,
  creatingNewPage,
  newPageName,
  newPageNameInput,
  deleteDialogOpen,
  filteredPages,
  selectedDaily,
  soulContent,
  coreMemoryContent,
  profileContent,
  profileUsername,
  dailyContent,
  dailyDateFrom,
  dailyDateTo,
  currentPage,
  filteredDailyFiles,
  totalPages,
  paginatedDailyFiles,
  paginationFrom,
  paginationTo,
  switchTab,
  onDailyRangeChange,
  openPage,
  closePage,
  startNewPage,
  cancelNewPage,
  confirmNewPage,
  handleSavePage,
  confirmDelete,
  handleDeletePage,
  handleSaveSoul,
  handleSaveCoreMemory,
  handleSaveProfile,
  handleSaveDaily,
  openDailyFile,
  closeDailyFile,
  formatSize,
  formatDate,
} = useMemoryWorkspace()
</script>
