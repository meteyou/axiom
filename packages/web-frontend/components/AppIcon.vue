<template>
  <component
    :is="iconComponent"
    :size="iconSize"
    :stroke-width="1.8"
    class="app-icon"
    aria-hidden="true"
  />
</template>

<script setup lang="ts">
import {
  Activity,
  Bot,
  Brain,
  CalendarDays,
  ChartColumnIncreasing,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleX,
  Compass,
  FileText,
  Info,
  LayoutDashboard,
  LockKeyhole,
  Logs,
  Menu,
  MessageSquare,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  Send,
  Settings,
  Sparkles,
  Square,
  Trash2,
  User,
  Users,
  Wrench,
  X,
} from 'lucide-vue-next'

const iconMap = {
  activity: Activity,
  add: Plus,
  arrowLeft: ChevronLeft,
  arrowRight: ChevronRight,
  bot: Bot,
  brain: Brain,
  calendar: CalendarDays,
  chat: MessageSquare,
  chevronDown: ChevronDown,
  chevronRight: ChevronRight,
  close: X,
  compass: Compass,
  dashboard: LayoutDashboard,
  edit: Pencil,
  file: FileText,
  info: Info,
  lock: LockKeyhole,
  logs: Logs,
  menu: Menu,
  plug: PlugZap,
  refresh: RefreshCw,
  send: Send,
  settings: Settings,
  sparkles: Sparkles,
  square: Square,
  success: CircleCheck,
  trendDown: ChartColumnIncreasing,
  users: Users,
  user: User,
  warning: CircleX,
  wrench: Wrench,
  trash: Trash2,
} as const

const props = withDefaults(defineProps<{
  name: string
  size?: 'sm' | 'md' | 'lg' | 'xl' | number
}>(), {
  size: 'md',
})

const iconComponent = computed(() => iconMap[props.name as keyof typeof iconMap] ?? Wrench)
const iconSize = computed(() => {
  if (typeof props.size === 'number') return props.size

  switch (props.size) {
    case 'sm': return 14
    case 'lg': return 20
    case 'xl': return 24
    default: return 16
  }
})
</script>

<style scoped>
.app-icon {
  display: block;
  flex-shrink: 0;
}
</style>
