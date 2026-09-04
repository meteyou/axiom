import type { Ref } from 'vue'
import type { Cronjob } from '~/composables/useCronjobs'
import { formatCronjobProvider, type ProviderLike } from '../utils/formatProvider'
import { getCronjobScheduleType } from '../utils/scheduleType'

export const CRONJOB_DEFAULT_PROVIDER_FILTER = '__default__'
export const CRONJOB_NEVER_RAN_FILTER = '__never__'

export type CronjobEnabledFilter = '' | 'enabled' | 'disabled'

const DEFAULT_FILTERS = {
  search: '',
  provider: '',
  actionType: '',
  enabled: 'enabled' as CronjobEnabledFilter,
  lastRunStatus: '',
  scheduleType: '',
}

type CronjobFilters = typeof DEFAULT_FILTERS
type CronjobPredicate = (cj: Cronjob) => boolean

function matchesSearch(cj: Cronjob, query: string): boolean {
  const haystack = [cj.name, cj.prompt, ...(cj.attachedSkills ?? [])].join('\n').toLowerCase()
  return haystack.includes(query)
}

function matchesLastRunStatus(cj: Cronjob, filter: string): boolean {
  if (filter === CRONJOB_NEVER_RAN_FILTER) return !cj.lastRunAt
  return cj.lastRunStatus === filter
}

function matchesProvider(cj: Cronjob, filter: string): boolean {
  if (cj.actionType !== 'task') return false
  if (filter === CRONJOB_DEFAULT_PROVIDER_FILTER) return !cj.provider
  return cj.provider === filter
}

function buildPredicates(filters: CronjobFilters): CronjobPredicate[] {
  const predicates: CronjobPredicate[] = []
  const query = filters.search.trim().toLowerCase()

  if (filters.enabled) predicates.push(cj => cj.enabled === (filters.enabled === 'enabled'))
  if (filters.actionType) predicates.push(cj => cj.actionType === filters.actionType)
  if (filters.provider) predicates.push(cj => matchesProvider(cj, filters.provider))
  if (filters.lastRunStatus) predicates.push(cj => matchesLastRunStatus(cj, filters.lastRunStatus))
  if (filters.scheduleType) predicates.push(cj => getCronjobScheduleType(cj.schedule) === filters.scheduleType)
  if (query) predicates.push(cj => matchesSearch(cj, query))

  return predicates
}

export function useCronjobFilters(cronjobs: Ref<Cronjob[]>, providers: Ref<ProviderLike[]>) {
  const filters = reactive({ ...DEFAULT_FILTERS })

  const activeFilterCount = computed(() =>
    (Object.keys(DEFAULT_FILTERS) as Array<keyof typeof DEFAULT_FILTERS>)
      .filter(key => filters[key] !== DEFAULT_FILTERS[key])
      .length,
  )

  const hasDefaultProviderOption = computed(() =>
    cronjobs.value.some(cj => cj.actionType === 'task' && !cj.provider),
  )

  const providerOptions = computed(() => {
    const values = new Set<string>()
    for (const cj of cronjobs.value) {
      if (cj.actionType === 'task' && cj.provider) values.add(cj.provider)
    }
    return [...values]
      .map(value => ({ value, label: formatCronjobProvider(value, providers.value) }))
      .sort((a, b) => a.label.localeCompare(b.label))
  })

  const filteredCronjobs = computed(() => {
    const predicates = buildPredicates(filters)
    return cronjobs.value.filter(cj => predicates.every(matches => matches(cj)))
  })

  function resetFilters() {
    Object.assign(filters, DEFAULT_FILTERS)
  }

  return {
    filters,
    activeFilterCount,
    hasDefaultProviderOption,
    providerOptions,
    filteredCronjobs,
    resetFilters,
  }
}
