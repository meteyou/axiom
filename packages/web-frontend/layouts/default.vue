<template>
  <!-- Mobile sidebar overlay -->
  <Transition
    enter-active-class="transition-opacity duration-200 ease-out"
    enter-from-class="opacity-0"
    enter-to-class="opacity-100"
    leave-active-class="transition-opacity duration-150 ease-in"
    leave-from-class="opacity-100"
    leave-to-class="opacity-0"
  >
    <div
      v-if="sidebarOpen"
      class="fixed inset-0 z-40 bg-black/55 md:hidden"
      aria-hidden="true"
      @click="sidebarOpen = false"
    />
  </Transition>

  <div class="flex h-full overflow-hidden">
    <!-- Sidebar -->
    <Transition
      enter-active-class="transition-transform duration-250 ease-out"
      enter-from-class="-translate-x-full"
      enter-to-class="translate-x-0"
      leave-active-class="transition-transform duration-200 ease-in"
      leave-from-class="translate-x-0"
      leave-to-class="-translate-x-full"
    >
      <aside
        v-show="sidebarOpen || !isMobile"
        class="fixed inset-y-0 left-0 z-50 flex w-[260px] flex-col border-r border-sidebar-border bg-sidebar md:static md:z-auto"
      >
        <!-- Sidebar header -->
        <div class="flex items-center gap-3 border-b border-sidebar-border/60 px-5 py-[18px]">
          <AppLogo />
          <div class="min-w-0">
            <span class="block truncate text-[18px] font-bold text-sidebar-foreground">
              {{ $t('app.title') }}
            </span>
            <p class="mt-0.5 text-xs text-muted-foreground">
              {{ isAdmin ? $t('app.adminConsole') : $t('app.workspace') }}
            </p>
          </div>
        </div>

        <!-- Navigation -->
        <nav class="flex flex-1 flex-col gap-1 overflow-y-auto p-2.5 py-3.5">
          <NuxtLink
            to="/"
            :class="navItemClass('/')"
            @click="closeSidebarOnMobile"
          >
            <AppIcon name="chat" class="shrink-0" />
            <span>{{ $t('nav.chat') }}</span>
          </NuxtLink>

          <template v-if="isAdmin">
            <NuxtLink
              to="/dashboard"
              :class="navItemClass('/dashboard')"
              @click="closeSidebarOnMobile"
            >
              <AppIcon name="dashboard" class="shrink-0" />
              <span>{{ $t('nav.dashboard') }}</span>
            </NuxtLink>

            <NuxtLink
              to="/memory"
              :class="navItemClass('/memory')"
              @click="closeSidebarOnMobile"
            >
              <AppIcon name="brain" class="shrink-0" />
              <span>{{ $t('nav.memory') }}</span>
            </NuxtLink>

            <NuxtLink
              to="/providers"
              :class="navItemClass('/providers')"
              @click="closeSidebarOnMobile"
            >
              <AppIcon name="plug" class="shrink-0" />
              <span>{{ $t('nav.providers') }}</span>
            </NuxtLink>

            <NuxtLink
              to="/usage"
              :class="navItemClass('/usage')"
              @click="closeSidebarOnMobile"
            >
              <AppIcon name="trendDown" class="shrink-0" />
              <span>{{ $t('nav.usage') }}</span>
            </NuxtLink>

            <NuxtLink
              to="/logs"
              :class="navItemClass('/logs')"
              @click="closeSidebarOnMobile"
            >
              <AppIcon name="logs" class="shrink-0" />
              <span>{{ $t('nav.logs') }}</span>
            </NuxtLink>

            <NuxtLink
              to="/settings"
              :class="navItemClass('/settings')"
              @click="closeSidebarOnMobile"
            >
              <AppIcon name="settings" class="shrink-0" />
              <span>{{ $t('nav.settings') }}</span>
            </NuxtLink>

            <NuxtLink
              to="/users"
              :class="navItemClass('/users')"
              @click="closeSidebarOnMobile"
            >
              <AppIcon name="users" class="shrink-0" />
              <span>{{ $t('nav.users') }}</span>
            </NuxtLink>
          </template>
        </nav>

        <!-- Sidebar footer — user menu -->
        <div class="border-t border-sidebar-border/60">
          <DropdownMenu class="block w-full">
            <DropdownMenuTrigger>
              <div
                class="flex w-full cursor-pointer items-center gap-2.5 px-4 py-3 hover:bg-sidebar-accent transition-colors"
                :aria-label="$t('aria.userMenu')"
              >
                <!-- Avatar -->
                <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary ring-1 ring-primary/25">
                  {{ userInitial }}
                </span>
                <!-- Name + role -->
                <div class="flex min-w-0 flex-1 flex-col">
                  <span class="truncate text-sm font-medium text-sidebar-foreground leading-none">{{ user?.username }}</span>
                  <span class="mt-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                    {{ isAdmin ? $t('roles.admin') : $t('roles.user') }}
                  </span>
                </div>
                <!-- Open indicator -->
                <AppIcon name="chevronsUpDown" size="sm" class="shrink-0 text-muted-foreground" />
              </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center" side="top" class="w-[calc(260px-1.5rem)]">
              <DropdownMenuLabel>
                {{ user?.username }}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive @click="handleLogout">
                <AppIcon name="close" size="sm" />
                {{ $t('auth.logout') }}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>
    </Transition>

    <!-- Main area -->
    <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
      <!-- Header -->
      <header class="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background/90 px-4 backdrop-blur-md">
        <!-- Mobile hamburger -->
        <button
          type="button"
          class="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
          :aria-label="$t('aria.toggleSidebar')"
          @click="sidebarOpen = !sidebarOpen"
        >
          <AppIcon name="menu" size="xl" />
        </button>

        <!-- Connection status -->
        <div class="flex items-center gap-2">
          <span
            class="h-2 w-2 shrink-0 rounded-full"
            :class="statusDotClass"
            :aria-label="statusText"
          />
          <span class="hidden text-sm text-muted-foreground sm:block">{{ statusText }}</span>
        </div>

        <!-- Spacer -->
        <div class="flex-1" />

        <!-- Theme toggle -->
        <Tooltip>
          <TooltipTrigger>
            <button
              type="button"
              class="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
              :aria-label="$t('aria.themeToggle')"
              @click="toggleTheme"
            >
              <AppIcon :name="isDark ? 'sun' : 'moon'" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {{ isDark ? $t('theme.switchToLight') : $t('theme.switchToDark') }}
          </TooltipContent>
        </Tooltip>
      </header>

      <!-- Page content -->
      <main class="flex flex-1 flex-col overflow-hidden">
        <slot />
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useMediaQuery } from '@vueuse/core'

const route = useRoute()
const { user, logout } = useAuth()
const { connectionStatus } = useChat()
const { isDark, toggle: toggleTheme } = useTheme()

const sidebarOpen = ref(false)
const isMobile = useMediaQuery('(max-width: 767px)')

const isAdmin = computed(() => user.value?.role === 'admin')
const userInitial = computed(() => user.value?.username?.charAt(0).toUpperCase() ?? '?')

const statusDotClass = computed(() => {
  switch (connectionStatus.value) {
    case 'connected': return 'bg-success shadow-[0_0_6px_hsl(var(--success))]'
    case 'connecting': return 'bg-warning animate-pulse'
    default: return 'bg-muted-foreground'
  }
})

const { t } = useI18n()
const statusText = computed(() => {
  switch (connectionStatus.value) {
    case 'connected': return t('status.online')
    case 'connecting': return t('status.connecting')
    default: return t('status.offline')
  }
})

function navItemClass(path: string) {
  const isActive = route.path === path
  return [
    'flex items-center gap-3 rounded-lg px-3 py-[11px] text-sm font-medium transition-all duration-150 no-underline',
    isActive
      ? 'bg-primary/10 text-primary ring-1 ring-primary/20'
      : 'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
  ]
}

function closeSidebarOnMobile() {
  if (isMobile.value) {
    sidebarOpen.value = false
  }
}

function handleLogout() {
  logout()
}

// Close sidebar when route changes on mobile
watch(route, () => {
  if (isMobile.value) {
    sidebarOpen.value = false
  }
})
</script>
