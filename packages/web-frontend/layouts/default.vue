<template>
  <div class="app-shell">
    <div
      v-if="sidebarOpen"
      class="sidebar-overlay"
      @click="sidebarOpen = false"
    />

    <aside class="sidebar" :class="{ open: sidebarOpen }">
      <div class="sidebar-header">
        <span class="sidebar-logo">🤖</span>
        <div>
          <span class="sidebar-title">{{ $t('app.title') }}</span>
          <p class="sidebar-subtitle">{{ isAdmin ? $t('app.adminConsole') : $t('app.workspace') }}</p>
        </div>
      </div>

      <nav class="sidebar-nav">
        <NuxtLink to="/" class="nav-item" :class="navClass('/')" @click="sidebarOpen = false">
          <span class="nav-icon">💬</span>
          <span>{{ $t('nav.chat') }}</span>
        </NuxtLink>

        <template v-if="isAdmin">
          <NuxtLink to="/dashboard" class="nav-item" :class="navClass('/dashboard')" @click="sidebarOpen = false">
            <span class="nav-icon">📊</span>
            <span>{{ $t('nav.dashboard') }}</span>
          </NuxtLink>
          <NuxtLink to="/memory" class="nav-item" :class="navClass('/memory')" @click="sidebarOpen = false">
            <span class="nav-icon">🧠</span>
            <span>{{ $t('nav.memory') }}</span>
          </NuxtLink>
          <NuxtLink to="/providers" class="nav-item" :class="navClass('/providers')" @click="sidebarOpen = false">
            <span class="nav-icon">🔌</span>
            <span>{{ $t('nav.providers') }}</span>
          </NuxtLink>
          <NuxtLink to="/usage" class="nav-item" :class="navClass('/usage')" @click="sidebarOpen = false">
            <span class="nav-icon">📈</span>
            <span>{{ $t('nav.usage') }}</span>
          </NuxtLink>
          <NuxtLink to="/logs" class="nav-item" :class="navClass('/logs')" @click="sidebarOpen = false">
            <span class="nav-icon">📋</span>
            <span>{{ $t('nav.logs') }}</span>
          </NuxtLink>
          <NuxtLink to="/settings" class="nav-item" :class="navClass('/settings')" @click="sidebarOpen = false">
            <span class="nav-icon">⚙️</span>
            <span>{{ $t('nav.settings') }}</span>
          </NuxtLink>
          <NuxtLink to="/users" class="nav-item" :class="navClass('/users')" @click="sidebarOpen = false">
            <span class="nav-icon">👥</span>
            <span>{{ $t('nav.users') }}</span>
          </NuxtLink>
        </template>
      </nav>

      <div class="sidebar-footer">
        <span class="role-badge" :class="isAdmin ? 'admin' : 'user'">
          {{ isAdmin ? $t('roles.admin') : $t('roles.user') }}
        </span>
      </div>
    </aside>

    <div class="main-area">
      <header class="app-header">
        <button class="menu-toggle" @click="sidebarOpen = !sidebarOpen" :aria-label="$t('app.toggleMenu')">
          <span class="hamburger">☰</span>
        </button>

        <div class="header-status">
          <span class="status-dot" :class="statusClass" />
          <span class="status-text">{{ statusText }}</span>
        </div>

        <div class="header-actions">
          <div class="user-menu" @click="userMenuOpen = !userMenuOpen">
            <span class="user-avatar">{{ userInitial }}</span>
            <div class="user-meta">
              <span class="user-name">{{ user?.username }}</span>
              <span class="user-role">{{ isAdmin ? $t('roles.admin') : $t('roles.user') }}</span>
            </div>

            <div v-if="userMenuOpen" class="user-dropdown">
              <button class="dropdown-item" @click="handleLogout">
                {{ $t('auth.logout') }}
              </button>
            </div>
          </div>
        </div>
      </header>

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
const isAdmin = computed(() => user.value?.role === 'admin')

const userInitial = computed(() => user.value?.username?.charAt(0).toUpperCase() || '?')

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

function navClass(path: string) {
  return {
    active: route.path === path,
  }
}

function handleLogout() {
  userMenuOpen.value = false
  logout()
}

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

.sidebar-overlay {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  z-index: 90;
}

.sidebar {
  width: var(--sidebar-width);
  background:
    radial-gradient(circle at top left, rgba(99, 102, 241, 0.18), transparent 32%),
    linear-gradient(180deg, rgba(255, 255, 255, 0.02), transparent 24%),
    var(--color-bg-secondary);
  border-right: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  z-index: 100;
}

.sidebar-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 18px 20px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.sidebar-logo {
  width: 40px;
  height: 40px;
  border-radius: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgba(99, 102, 241, 0.14);
  box-shadow: inset 0 0 0 1px rgba(129, 140, 248, 0.2);
  font-size: 20px;
}

.sidebar-title {
  display: block;
  font-size: 18px;
  font-weight: 700;
  color: var(--color-text);
}

.sidebar-subtitle {
  margin-top: 2px;
  font-size: 12px;
  color: var(--color-text-muted);
}

.sidebar-nav {
  flex: 1;
  padding: 14px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 12px;
  border-radius: 10px;
  color: var(--color-text-secondary);
  font-size: 14px;
  font-weight: 500;
  transition: all 0.15s ease;
  text-decoration: none;
}

.nav-item:hover {
  background: rgba(255, 255, 255, 0.04);
  color: var(--color-text);
  transform: translateX(2px);
}

.nav-item.active,
.nav-item.router-link-exact-active {
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.18), rgba(99, 102, 241, 0.08));
  color: #c7d2fe;
  box-shadow: inset 0 0 0 1px rgba(129, 140, 248, 0.2);
}

.nav-icon {
  font-size: 18px;
  width: 24px;
  text-align: center;
}

.sidebar-footer {
  padding: 16px 20px 20px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.role-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.role-badge.admin {
  background: rgba(245, 158, 11, 0.14);
  color: #fbbf24;
}

.role-badge.user {
  background: rgba(34, 197, 94, 0.14);
  color: #4ade80;
}

.main-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.app-header {
  height: var(--header-height);
  display: flex;
  align-items: center;
  padding: 0 16px;
  border-bottom: 1px solid var(--color-border);
  background: rgba(15, 17, 23, 0.88);
  backdrop-filter: blur(12px);
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
  gap: 10px;
  cursor: pointer;
  padding: 6px 10px;
  border-radius: 12px;
  transition: background 0.15s ease;
}

.user-menu:hover {
  background: var(--color-bg-tertiary);
}

.user-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--color-primary), #8b5cf6);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 600;
}

.user-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.user-name {
  font-size: 14px;
  color: var(--color-text);
}

.user-role {
  font-size: 11px;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.user-dropdown {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  min-width: 160px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  padding: 6px;
  z-index: 200;
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.35);
}

.dropdown-item {
  display: block;
  width: 100%;
  padding: 10px 12px;
  background: none;
  border: none;
  color: var(--color-text);
  font-size: 14px;
  text-align: left;
  border-radius: 8px;
  transition: background 0.15s ease;
}

.dropdown-item:hover {
  background: var(--color-bg-tertiary);
}

.page-content {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

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

  .user-meta {
    display: none;
  }
}
</style>
