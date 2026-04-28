export const TASK_DEFAULT_DATE_RANGE_DAYS = 3

export function formatDateInputValue(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function createDefaultTaskDateRange(to: Date = new Date()) {
  const from = new Date(to)
  from.setDate(to.getDate() - (TASK_DEFAULT_DATE_RANGE_DAYS - 1))

  return {
    createdFrom: formatDateInputValue(from),
    createdTo: formatDateInputValue(to),
  }
}

