import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS_CONTRACT,
  getSupportedTtsResponseFormats,
  normalizeAppLogo,
  normalizeSttSettings,
  normalizeTtsSettings,
  resolveTtsResponseFormat,
  normalizeImageGenerationSettings,
  normalizeImageOutputDir,
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

  it('defaults watchdog, retry and the telegram stall toggle, and keeps overrides', () => {
    const defaults = normalizeSettingsContract({})

    expect(defaults.watchdog).toEqual({ stallWarnMs: 30_000, stallAbortMs: 90_000 })
    expect(defaults.retry).toEqual({ enabled: true, maxRetries: 3, baseDelayMs: 2_000 })
    expect(defaults.telegram.sendStallWarnings).toBe(false)

    const overridden = normalizeSettingsContract({
      watchdog: { stallWarnMs: 5_000 },
      retry: { enabled: false, maxRetries: 0 },
      telegram: { sendStallWarnings: true },
    })

    expect(overridden.watchdog).toEqual({ stallWarnMs: 5_000, stallAbortMs: 90_000 })
    expect(overridden.retry).toEqual({ enabled: false, maxRetries: 0, baseDelayMs: 2_000 })
    expect(overridden.telegram.sendStallWarnings).toBe(true)
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

  it('defaults codemode switches to off and keeps explicit overrides', () => {
    const defaults = normalizeSettingsContract({})
    expect(defaults.codemode).toEqual({ mainAgent: false, tasks: false })
    expect(DEFAULT_SETTINGS_CONTRACT.codemode).toEqual({ mainAgent: false, tasks: false })

    const overridden = normalizeSettingsContract({
      codemode: { mainAgent: true, tasks: true },
    })
    expect(overridden.codemode).toEqual({ mainAgent: true, tasks: true })

    // Non-boolean values fall back to off so a hand-edited file cannot enable it.
    const invalid = normalizeSettingsContract({
      codemode: { mainAgent: 'yes', tasks: 1 },
    } as unknown as Parameters<typeof normalizeSettingsContract>[0])
    expect(invalid.codemode).toEqual({ mainAgent: false, tasks: false })
  })

  it('defaults image generation to on with 4 variants and the images folder', () => {
    expect(normalizeSettingsContract({}).imageGeneration).toEqual({
      enabled: true,
      defaultModel: '',
      maxVariants: 4,
      outputDir: 'images',
    })
  })

  it('replaces invalid hand-edited image generation values with defaults', () => {
    expect(normalizeImageGenerationSettings({
      enabled: false,
      defaultModel: ' or-1:recraft/recraft-v4.1 ',
      maxVariants: 11,
      outputDir: '../outside',
    })).toEqual({
      enabled: false,
      defaultModel: 'or-1:recraft/recraft-v4.1',
      maxVariants: 4,
      outputDir: 'images',
    })
    expect(normalizeImageGenerationSettings({ maxVariants: 10, outputDir: './art/' }))
      .toMatchObject({ maxVariants: 10, outputDir: 'art' })
  })

  it('keeps image output folders inside the workspace', () => {
    expect(normalizeImageOutputDir('images')).toBe('images')
    expect(normalizeImageOutputDir(' ./assets//generated/ ')).toBe('assets/generated')
    expect(normalizeImageOutputDir('assets\\generated')).toBe('assets/generated')
    expect(normalizeImageOutputDir('a/../b')).toBe('b')
    expect(normalizeImageOutputDir('../images')).toBeNull()
    expect(normalizeImageOutputDir('a/../../images')).toBeNull()
    expect(normalizeImageOutputDir('/data/images')).toBeNull()
    expect(normalizeImageOutputDir('C:\\images')).toBeNull()
    expect(normalizeImageOutputDir('.')).toBeNull()
    expect(normalizeImageOutputDir('')).toBeNull()
  })

  it('defaults the app logo to prism and keeps the other variants', () => {
    expect(normalizeSettingsContract({}).appearance).toEqual({ logo: 'prism' })
    expect(normalizeSettingsContract({ appearance: { logo: 'raccoon' } }).appearance.logo).toBe('raccoon')
    expect(normalizeSettingsContract({ appearance: { logo: 'robot' } }).appearance.logo).toBe('robot')
  })

  it('falls back to prism for unknown app logo values', () => {
    expect(normalizeAppLogo('unicorn')).toBe('prism')
    expect(normalizeAppLogo('')).toBe('prism')
    expect(normalizeAppLogo(undefined)).toBe('prism')
    expect(normalizeAppLogo(42)).toBe('prism')
  })

  it('reads the agent tool switches as opt-in', () => {
    expect(normalizeTtsSettings(undefined).agentTool).toBe(false)
    expect(normalizeSttSettings(undefined).agentTool).toBe(false)
    expect(normalizeTtsSettings({ agentTool: true }).agentTool).toBe(true)
    expect(normalizeSttSettings({ agentTool: true }).agentTool).toBe(true)
  })

  it('limits TTS formats to what the provider type returns', () => {
    expect(getSupportedTtsResponseFormats('openrouter')).toEqual(['mp3'])
    expect(getSupportedTtsResponseFormats('xai')).toEqual(['mp3', 'wav'])
    expect(getSupportedTtsResponseFormats('openai')).toEqual(['mp3', 'wav', 'opus', 'flac'])
    expect(getSupportedTtsResponseFormats(undefined)).toEqual(['mp3', 'wav', 'opus', 'flac'])

    expect(resolveTtsResponseFormat('openrouter', 'opus')).toBe('mp3')
    expect(resolveTtsResponseFormat('xai', 'wav')).toBe('wav')
    expect(resolveTtsResponseFormat('mistral', 'opus')).toBe('opus')
  })

  it('drops formats that cannot be chunked for text above the provider input cap', () => {
    expect(getSupportedTtsResponseFormats('deepgram')).toEqual(['mp3', 'wav', 'opus', 'flac'])
    expect(getSupportedTtsResponseFormats('deepgram', 2000)).toEqual(['mp3', 'wav', 'opus', 'flac'])
    expect(getSupportedTtsResponseFormats('deepgram', 2001)).toEqual(['mp3', 'wav'])
    expect(getSupportedTtsResponseFormats('openai', 4000)).toEqual(['mp3', 'wav', 'opus', 'flac'])

    expect(resolveTtsResponseFormat('deepgram', 'opus', 3000)).toBe('mp3')
    expect(resolveTtsResponseFormat('deepgram', 'wav', 3000)).toBe('wav')
    expect(resolveTtsResponseFormat('deepgram', 'opus', 500)).toBe('opus')
  })
})
