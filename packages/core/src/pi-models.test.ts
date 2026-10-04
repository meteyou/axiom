import { describe, expect, it, vi } from 'vitest'
import type { Api } from '@earendil-works/pi-ai'
import { registerSessionResourceCleanup } from '@earendil-works/pi-ai'
import type { BuiltinProvider } from '@earendil-works/pi-ai/providers/all'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { SUPPORTED_APIS, releaseProviderSession } from './pi-models.js'
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

describe('releaseProviderSession', () => {
  function withCleanupSpy(run: (cleanup: ReturnType<typeof vi.fn>) => void): void {
    const cleanup = vi.fn()
    const unregister = registerSessionResourceCleanup(cleanup)
    try {
      run(cleanup)
    } finally {
      unregister()
    }
  }

  it('forwards the session id to pi-ai session cleanup', () => {
    withCleanupSpy((cleanup) => {
      releaseProviderSession('sess-A')
      expect(cleanup).toHaveBeenCalledWith('sess-A')
    })
  })

  it('never triggers the global cleanup for a missing session id', () => {
    withCleanupSpy((cleanup) => {
      releaseProviderSession(undefined)
      releaseProviderSession(null)
      releaseProviderSession('')
      expect(cleanup).not.toHaveBeenCalled()
    })
  })

  it('swallows cleanup failures', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const unregister = registerSessionResourceCleanup(() => { throw new Error('boom') })
    try {
      expect(() => releaseProviderSession('sess-A')).not.toThrow()
      expect(errSpy).toHaveBeenCalled()
    } finally {
      unregister()
      errSpy.mockRestore()
    }
  })
})
