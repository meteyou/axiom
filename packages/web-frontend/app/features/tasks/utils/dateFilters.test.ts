import { describe, expect, it } from 'vitest'
import { createDefaultTaskDateRange, formatDateInputValue } from './dateFilters'

describe('task date filters', () => {
  it('keeps date input labels on the local calendar day', () => {
    expect(formatDateInputValue(new Date(2026, 2, 28, 15, 30, 0))).toBe('2026-03-28')
  })

  it('creates the default three-day date input range', () => {
    expect(createDefaultTaskDateRange(new Date(2026, 2, 28, 15, 30, 0))).toEqual({
      createdFrom: '2026-03-26',
      createdTo: '2026-03-28',
    })
  })

})
