<template>
  <div class="app-shell">
    <!-- Sidebar overlay for mobile -->
    <div
      v-if="sidebarOpen"
      class="sidebar-overlay"
      @click="sidebarOpen = false"
    />

    <!-- Sidebar -->
    <aside class="sidebar" :class="{ open: sidebarOpen }">
      <div class="sidebar-header">
        <span class="sidebar-logo">🤖</span>
        <span class="sidebar-title">{{ $t('app.title') }}</span>
      </div>

      <nav class="sidebar-nav">
        <NuxtLink to="/" class="nav-item" :class="{ active: route.path === '/' }" @click="sidebarOpen = false">
          <span class="nav-icon">💬</span>
          <span>{{ $t('nav.chat') }}</span>
        </NuxtLink>
        <NuxtLink to="/dashboard" class="nav-item placeholder" @click="sidebarOpen = false">
          <span class="nav-icon">📊</span>
          <span>{{ $t('nav.dashboard') }}</span>
        </NuxtLink>
        <NuxtLink to="/memory" class="nav-item placeholder" @click="sidebarOpen = false">
          <span class="nav-icon">🧠</span>
          <span>{{ $t('nav.memory') }}</span>
        </NuxtLink>
        <NuxtLink to="/providers" class="nav-item" :class="{ active: route.path === '/providers' }" @click="sidebarOpen = false">
          <span class="nav-icon">🔌</span>
          <span>{{ $t('nav.providers') }}</span>
        </NuxtLink>
        <NuxtLink to="/usage" class="nav-item placeholder" @click="sidebarOpen = false">
          <span class="nav-icon">📈</span>
          <span>{{ $t('nav.usage') }}</span>
        </NuxtLink>
        <NuxtLink to="/logs" class="nav-item" :class="{ active: route.path === '/logs' }" @click="sidebarOpen = false">
          <span class="nav-icon">📋</span>
          <span>{{ $t('nav.logs') }}</span>
        </NuxtLink>
        <NuxtLink to="/settings" class="nav-item placeholder" @click="sidebarOpen = false">
          <span class="nav-icon">⚙️</span>
          <span>{{ $t('nav.settings') }}</span>
        </NuxtLink>
      </nav>
    </aside>

    <!-- Main content area -->
    <div class="main-area">
      <!-- Header -->
      <header class="app-header">
        <button class="menu-toggle" @click="sidebarOpen = !sidebarOpen" aria-label="Toggle menu">
          <span class="hamburger">☰</span>
        </button>

        <div class="header-status">
          <span class="status-dot" :class="statusClass" />
          <span class="status-text">{{ statusText }}</span>
        </div>

        <div class="header-actions">
          <div class="user-menu" @click="userMenuOpen = !userMenuOpen">
            <span class="user-avatar">{{ userInitial }}</span>
            <span class="user-name">{{ user?.username }}</span>

            <div v-if="userMenuOpen" class="user-dropdown">
              <button class="dropdown-item" @click="handleLogout">
                {{ $t('auth.logout') }}
              </button>
            </div>
          </div>
        </div>
      </header>

      <!-- Page content -->
      <main class="page-content">
        <slot />
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
const route = useRoute()
const { t } = useI18n()
const { user, logout } = useAuth()
const { connectionStatus } = useChat()

const sidebarOpen = ref(false)
const userMenuOpen = ref(false)

const userInitial = computed(() => {
  return user.value?.username?.charAt(0).toUpperCase() || '?'
})

const statusClass = computed(() => {
  switch (connectionStatus.value) {
    case 'connected': return 'online'
    case 'connecting': return 'connecting'
    default: return 'offline'
  }
})

const statusText = computed(() => {
  switch (connectionStatus.value) {
    case 'connected': return t('status.online')
    case 'connecting': return t('status.connecting')
    default: return t('status.offline')
  }
})

function handleLogout() {
  userMenuOpen.value = false
  logout()
}

// Close user menu on click outside
if (import.meta.client) {
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    if (!target.closest('.user-menu')) {
      userMenuOpen.value = false
    }
  })
}
</script>

<style scoped>
.app-shell {
  display: flex;
  height: 100%;
  overflow: hidden;
}

/* Sidebar overlay (mobile) */
.sidebar-overlay {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 90;
}

/* Sidebar */
.sidebar {
  width: var(--sidebar-width);
  background: var(--color-bg-secondary);
  border-right: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  z-index: 100;
}

.sidebar-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border);
}

.sidebar-logo {
  font-size: 24px;
}

.sidebar-title {
  font-size: 18px;
  font-weight: 700;
  color: var(--color-text);
}

.sidebar-nav {
  flex: 1;
  padding: 12px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  color: var(--color-text-secondary);
  font-size: 14px;
  font-weight: 500;
  transition: all 0.15s ease;
  text-decoration: none;
}

.nav-item:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}

.nav-item.active,
.nav-item.router-link-exact-active {
  background: var(--color-primary-bg);
  color: var(--color-primary);
}

.nav-item.placeholder {
  opacity: 0.5;
}

.nav-icon {
  font-size: 18px;
  width: 24px;
  text-align: center;
}

/* Main area */
.main-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

/* Header */
.app-header {
  height: var(--header-height);
  display: flex;
  align-items: center;
  padding: 0 16px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  flex-shrink: 0;
  gap: 12px;
}

.menu-toggle {
  display: none;
  background: none;
  border: none;
  color: var(--color-text);
  font-size: 24px;
  padding: 4px;
}

.hamburger {
  line-height: 1;
}

.header-status {
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-dot.online {
  background: var(--color-success);
  box-shadow: 0 0 6px var(--color-success);
}

.status-dot.connecting {
  background: var(--color-warning);
  animation: pulse 1.5s ease-in-out infinite;
}

.status-dot.offline {
  background: var(--color-text-muted);
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.status-text {
  font-size: 13px;
  color: var(--color-text-secondary);
}

.header-actions {
  margin-left: auto;
}

.user-menu {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  padding: 6px 10px;
  border-radius: 8px;
  transition: background 0.15s ease;
}

.user-menu:hover {
  background: var(--color-bg-tertiary);
}

.user-avatar {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--color-primary);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 600;
}

.user-name {
  font-size: 14px;
  color: var(--color-text);
}

.user-dropdown {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  min-width: 150px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 4px;
  z-index: 200;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
}

.dropdown-item {
  display: block;
  width: 100%;
  padding: 8px 12px;
  background: none;
  border: none;
  color: var(--color-text);
  font-size: 14px;
  text-align: left;
  border-radius: 6px;
  transition: background 0.15s ease;
}

.dropdown-item:hover {
  background: var(--color-bg-tertiary);
}

/* Page content */
.page-content {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* Mobile responsive */
@media (max-width: 768px) {
  .sidebar {
    position: fixed;
    left: 0;
    top: 0;
    bottom: 0;
    transform: translateX(-100%);
    transition: transform 0.25s ease;
  }

  .sidebar.open {
    transform: translateX(0);
  }

  .sidebar-overlay {
    display: block;
  }

  .menu-toggle {
    display: block;
  }

  .user-name {
    display: none;
  }
}
</style>
