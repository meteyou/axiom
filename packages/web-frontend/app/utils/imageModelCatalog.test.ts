import { describe, expect, it } from 'vitest'
import { buildImageCatalogModelPatch, formatImageOutputPrice } from './imageModelCatalog'

describe('buildImageCatalogModelPatch', () => {
  it('keeps the live name and modalities', () => {
    expect(buildImageCatalogModelPatch({ id: 'vendor/x', name: 'Vendor X', input: ['text'], output: ['image', 'text'] }))
      .toEqual({ name: 'Vendor X', input: ['text'], output: ['image', 'text'] })
  })

  it('skips a name that only repeats the id', () => {
    expect(buildImageCatalogModelPatch({ id: 'gpt-image-2', name: 'gpt-image-2', input: ['text', 'image'], output: ['image'] }))
      .toEqual({ input: ['text', 'image'], output: ['image'] })
  })
})

describe('formatImageOutputPrice', () => {
  it('shows the image output price per 1M tokens', () => {
    expect(formatImageOutputPrice({ textInput: 5, imageInput: 8, imageOutput: 30 })).toBe('$30.00 / 1M')
  })
})
