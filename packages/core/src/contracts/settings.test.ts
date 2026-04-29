import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS_CONTRACT,
  normalizeSettingsContract,
  withLegacySettingsPayloadCompatibility,
} from './settings.js'

describe('settings contracts', () => {
  it('normalizes missing sections with canonical defaults', () => {
    const normalized = normalizeSettingsContract({
      sessionTimeoutMinutes: 30,
      language: 'de',
      healthMonitor: {
        notifications: {
          degradedToHealthy: true,
        },
      },
      stt: {
        rewrite: {
          enabled: true,
        },
      },
    })

    expect(normalized.sessionTimeoutMinutes).toBe(30)
    expect(normalized.language).toBe('de')
    expect(normalized.healthMonitor.notifications.degradedToHealthy).toBe(true)
    expect(normalized.healthMonitor.notifications.healthyToDown)
      .toBe(DEFAULT_SETTINGS_CONTRACT.healthMonitor.notifications.healthyToDown)
    expect(normalized.stt.rewrite.enabled).toBe(true)
    expect(normalized.stt.rewrite.providerId).toBe('')
    expect(normalized.tasks.loopDetection.method)
      .toBe(DEFAULT_SETTINGS_CONTRACT.tasks.loopDetection.method)
  })

  it('accepts legacy healthMonitor.intervalMinutes payloads', () => {
    const payload = withLegacySettingsPayloadCompatibility({
      language: 'en',
      healthMonitor: {
        intervalMinutes: 9,
      },
    })

    expect(payload.healthMonitorIntervalMinutes).toBe(9)
  })

  it('does not overwrite explicit healthMonitorIntervalMinutes with legacy values', () => {
    const payload = withLegacySettingsPayloadCompatibility({
      healthMonitorIntervalMinutes: 4,
      healthMonitor: {
        intervalMinutes: 9,
      },
    })

    expect(payload.healthMonitorIntervalMinutes).toBe(4)
  })

  it('uses legacy task status interval when only the new enabled flag is present', () => {
    const normalized = normalizeSettingsContract({
      tasks: {
        statusUpdates: { enabled: true },
        statusUpdateIntervalMinutes: 5,
      },
    } as unknown as Parameters<typeof normalizeSettingsContract>[0])

    expect(normalized.tasks.statusUpdates).toEqual({
      enabled: true,
      intervalMinutes: 5,
    })
  })

  describe('thinking level', () => {
    it('defaults both thinking levels to "off"', () => {
      expect(DEFAULT_SETTINGS_CONTRACT.thinkingLevel).toBe('off')
      expect(DEFAULT_SETTINGS_CONTRACT.tasks.backgroundThinkingLevel).toBe('off')
    })

    it('preserves valid thinking levels on normalization', () => {
      const normalized = normalizeSettingsContract({
        thinkingLevel: 'medium',
        tasks: {
          backgroundThinkingLevel: 'low',
        },
      })

      expect(normalized.thinkingLevel).toBe('medium')
      expect(normalized.tasks.backgroundThinkingLevel).toBe('low')
    })

    it('falls back to defaults when thinking level values are invalid', () => {
      const normalized = normalizeSettingsContract({
        // @ts-expect-error — deliberately passing an unsupported value
        thinkingLevel: 'extreme',
        tasks: {
          // @ts-expect-error — deliberately passing an unsupported value
          backgroundThinkingLevel: '',
        },
      })

      expect(normalized.thinkingLevel).toBe('off')
      expect(normalized.tasks.backgroundThinkingLevel).toBe('off')
    })
  })
})
