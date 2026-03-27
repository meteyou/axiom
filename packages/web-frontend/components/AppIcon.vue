<template>
  <component
    :is="iconComponent"
    :size="iconSize"
    :stroke-width="1.8"
    class="block shrink-0"
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
  ChevronsUpDown,
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
  Moon,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  Send,
  Settings,
  Sparkles,
  Square,
  Sun,
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
  chevronsUpDown: ChevronsUpDown,
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
  moon: Moon,
  plug: PlugZap,
  refresh: RefreshCw,
  send: Send,
  settings: Settings,
  sparkles: Sparkles,
  square: Square,
  success: CircleCheck,
  sun: Sun,
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
