import { describe, expect, it } from 'vitest'
import { buildImageCatalogModelPatch, formatImageCost, formatPerMillionPrice } from './imageModelCatalog'

describe('buildImageCatalogModelPatch', () => {
  it('keeps the live name, modalities and output price', () => {
    expect(buildImageCatalogModelPatch({
      id: 'vendor/x',
      name: 'Vendor X',
      input: ['text'],
      output: ['image', 'text'],
      pricing: { textInput: 0.5, imageInput: 0.5, imageOutput: 60 },
    })).toEqual({ name: 'Vendor X', input: ['text'], output: ['image', 'text'], cost: { output: 60 } })
  })

  it('skips a name that only repeats the id and a missing price', () => {
    expect(buildImageCatalogModelPatch({ id: 'gpt-image-2', name: 'gpt-image-2', input: ['text', 'image'], output: ['image'] }))
      .toEqual({ input: ['text', 'image'], output: ['image'] })
  })
})

describe('price formatting', () => {
  it('shows prices per 1M tokens', () => {
    expect(formatPerMillionPrice(30)).toBe('$30.00 / 1M')
    expect(formatPerMillionPrice(8.383234)).toBe('$8.38 / 1M')
  })

  it('shows image costs with three decimals below ten cents', () => {
    expect(formatImageCost(0.0349)).toBe('$0.035')
    expect(formatImageCost(0.125)).toBe('$0.13')
  })
})
