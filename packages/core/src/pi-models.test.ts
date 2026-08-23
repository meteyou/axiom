import { describe, expect, it } from 'vitest'
import type { Api } from '@earendil-works/pi-ai'
import type { BuiltinProvider } from '@earendil-works/pi-ai/providers/all'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { SUPPORTED_APIS } from './pi-models.js'
import { PROVIDER_TYPE_PRESETS } from './provider-config.js'

describe('pi-models api coverage', () => {
  it('implements every preset apiType', () => {
    for (const preset of Object.values(PROVIDER_TYPE_PRESETS)) {
      expect(
        SUPPORTED_APIS.has(preset.apiType as Api),
        `preset "${preset.type}" uses unimplemented api "${preset.apiType}"`,
      ).toBe(true)
    }
  })

  it('implements every wire api the catalog-resolved presets can dispatch to', () => {
    for (const preset of Object.values(PROVIDER_TYPE_PRESETS)) {
      if (!preset.piAiProvider) continue
      if (preset.authMethod !== 'oauth' && !preset.resolveModelsFromCatalog) continue

      for (const model of getBuiltinModels(preset.piAiProvider as BuiltinProvider)) {
        expect(
          SUPPORTED_APIS.has(model.api),
          `catalog model "${preset.piAiProvider}/${model.id}" uses unimplemented api "${model.api}"`,
        ).toBe(true)
      }
    }
  })
})
