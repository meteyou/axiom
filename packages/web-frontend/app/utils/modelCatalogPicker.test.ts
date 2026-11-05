import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { getModelCatalogPickerView } from './modelCatalogPicker'

const base = { models: [], filteredCount: 0, query: '', loading: false, error: '', allowCustom: true }

describe('getModelCatalogPickerView', () => {
  it('keeps manual entry available when the catalog fetch failed', () => {
    const view = getModelCatalogPickerView({ ...base, error: 'HTTP 404', query: 'whisper-large-v3' })
    expect(view).toEqual({ showError: true, showList: true, showEmpty: false, customId: 'whisper-large-v3', showCustomHint: false })
  })

  it('shows the error with a manual entry hint before a model id is typed', () => {
    const view = getModelCatalogPickerView({ ...base, error: 'HTTP 404' })
    expect(view).toMatchObject({ showError: true, showList: false, customId: '', showCustomHint: true })
  })

  it('offers no manual entry on a failed fetch when custom ids are not allowed', () => {
    const view = getModelCatalogPickerView({ ...base, allowCustom: false, error: 'HTTP 404', query: 'x' })
    expect(view).toMatchObject({ showError: true, showList: false, customId: '', showCustomHint: false })
  })

  it('hides everything but the spinner while loading', () => {
    const view = getModelCatalogPickerView({ ...base, loading: true, error: 'old', query: 'x' })
    expect(view).toEqual({ showError: false, showList: false, showEmpty: false, customId: '', showCustomHint: false })
  })

  it('does not offer a typed id that is already in the catalog or contains spaces', () => {
    const models = [{ id: 'nova-3' }]
    expect(getModelCatalogPickerView({ ...base, models, filteredCount: 1, query: 'NOVA-3' }).customId).toBe('')
    expect(getModelCatalogPickerView({ ...base, models, query: 'nova 3' })).toMatchObject({ customId: '', showEmpty: true })
  })
})

describe('ModelCatalogPicker template', () => {
  const source = fs.readFileSync(path.join(__dirname, '../components/ModelCatalogPicker.vue'), 'utf-8')

  it('renders the error and the model list independently', () => {
    expect(source).toContain('v-if="view.showError"')
    expect(source).toContain('v-if="view.showList"')
    expect(source).not.toMatch(/v-else(-if)?=/)
    expect(source).toContain('v-if="view.customId"')
  })
})
