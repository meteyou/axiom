export type MemoryTab = 'soul' | 'core' | 'facts' | 'profile' | 'daily' | 'wiki'

export interface MemoryWikiFile {
  filename: string
  name: string
  title: string
  aliases: string[]
  size: number
  modifiedAt: string
}

export interface MemoryDailyFile {
  filename: string
  date: string
  size: number
  modifiedAt: string
}

export function useMemoryWorkspace() {
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
    clearMessages,
  } = useMemory()

  const {
    loadWikiPages,
    loadWikiPage,
    saveWikiPage,
    deleteWikiPage,
  } = useWiki()

  const activeTab = ref<MemoryTab>('wiki')

  // Wiki state
  const wikiPages = ref<MemoryWikiFile[]>([])
  const selectedPage = ref<string | null>(null)
  const pageContent = ref('')
  const searchQuery = ref('')
  const creatingNewPage = ref(false)
  const newPageName = ref('')
  const newPageNameInput = ref<HTMLInputElement | null>(null)
  const deleteDialogOpen = ref(false)

  const filteredPages = computed(() => {
    if (!searchQuery.value.trim()) return wikiPages.value
    const query = searchQuery.value.toLowerCase()

    return wikiPages.value.filter(page =>
      page.name.toLowerCase().includes(query)
      || page.title.toLowerCase().includes(query)
      || page.aliases.some(alias => alias.toLowerCase().includes(query)),
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

    if (!/^[\w.-]+$/.test(name)) {
      error.value = 'Page name may only contain letters, digits, hyphens, underscores, and dots.'
      return
    }

    creatingNewPage.value = false
    newPageName.value = ''
    selectedPage.value = name
    pageContent.value = `# ${name}\n\n`

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
  const dailyFiles = ref<MemoryDailyFile[]>([])
  const selectedDaily = ref<string | null>(null)

  const formatIsoDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

  const today = new Date()
  const sevenDaysAgo = new Date(today)
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6)

  const dailyDateFrom = ref(formatIsoDate(sevenDaysAgo))
  const dailyDateTo = ref(formatIsoDate(today))

  const PAGE_SIZE = 10
  const currentPage = ref(1)

  const filteredDailyFiles = computed(() => {
    if (!dailyDateFrom.value && !dailyDateTo.value) return dailyFiles.value

    return dailyFiles.value.filter((file) => {
      if (dailyDateFrom.value && file.date < dailyDateFrom.value) return false
      if (dailyDateTo.value && file.date > dailyDateTo.value) return false
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

  async function switchTab(tab: MemoryTab) {
    clearMessages()
    activeTab.value = tab

    if (tab === 'wiki') {
      await refreshPages()
      return
    }

    if (tab === 'soul') {
      soulContent.value = await loadSoul()
      return
    }

    if (tab === 'core') {
      coreMemoryContent.value = await loadCoreMemory()
      return
    }

    if (tab === 'profile') {
      const profile = await loadProfile()
      profileContent.value = profile.content
      profileUsername.value = profile.username
      return
    }

    if (tab === 'facts') {
      return
    }

    if (tab === 'daily') {
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
    await refreshPages()
  })

  return {
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
  }
}
