export interface ModelCatalogPickerViewInput {
  models: ReadonlyArray<{ id: string }>
  filteredCount: number
  query: string
  loading: boolean
  error: string
  allowCustom: boolean
}

export interface ModelCatalogPickerView {
  showError: boolean
  showList: boolean
  showEmpty: boolean
  /** Typed model id offered for manual entry, or `''` when none is offered. */
  customId: string
  /** The catalog failed, but a model id can still be typed into the search. */
  showCustomHint: boolean
}

/** Manual entry does not depend on the optional catalog fetch, so it stays available when that fails. */
export function getModelCatalogPickerView(input: ModelCatalogPickerViewInput): ModelCatalogPickerView {
  const query = input.query.trim()
  const customAllowed = input.allowCustom && !input.loading
  const customId = customAllowed && query && !/\s/.test(query)
    && !input.models.some(model => model.id.toLowerCase() === query.toLowerCase())
    ? query
    : ''
  const showError = !input.loading && !!input.error
  return {
    showError,
    showList: !input.loading && (!showError || !!customId),
    showEmpty: !input.loading && !showError && input.filteredCount === 0 && !customId,
    customId,
    showCustomHint: showError && customAllowed && !customId,
  }
}
