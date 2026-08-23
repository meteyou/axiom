import { describe, it, expect } from 'vitest'
import {
  DEFAULT_STALL_ABORT_MS,
  DEFAULT_STALL_WARN_MS,
  PROVIDER_STALL_KIND,
  buildProviderStallMetadata,
  formatProviderStallContent,
  loadStallThresholds,
  parseProviderStallMetadata,
} from './provider-stall.js'

describe('provider stall metadata', () => {
  it('round-trips an unresolved stall', () => {
    const metadata = buildProviderStallMetadata({ startedAt: '2026-01-01T00:00:00.000Z', durationMs: 30_000 })
    expect(metadata).toEqual({
      kind: PROVIDER_STALL_KIND,
      startedAt: '2026-01-01T00:00:00.000Z',
      resolvedAt: null,
      durationMs: 30_000,
      outcome: null,
    })
    expect(parseProviderStallMetadata(JSON.stringify(metadata))).toEqual(metadata)
  })

  it('round-trips a resolved stall', () => {
    const metadata = buildProviderStallMetadata({
      messageId: 12,
      startedAt: '2026-01-01T00:00:00.000Z',
      resolvedAt: '2026-01-01T00:00:42.000Z',
      durationMs: 42_000,
      outcome: 'recovered',
    })
    expect(parseProviderStallMetadata(JSON.stringify(metadata))).toEqual({
      kind: PROVIDER_STALL_KIND,
      startedAt: '2026-01-01T00:00:00.000Z',
      resolvedAt: '2026-01-01T00:00:42.000Z',
      durationMs: 42_000,
      outcome: 'recovered',
    })
  })

  it('ignores metadata of other kinds and unparsable input', () => {
    expect(parseProviderStallMetadata(null)).toBeNull()
    expect(parseProviderStallMetadata('not json')).toBeNull()
    expect(parseProviderStallMetadata(JSON.stringify({ kind: 'thinking' }))).toBeNull()
  })

  it('drops an unknown outcome instead of trusting it', () => {
    const parsed = parseProviderStallMetadata(JSON.stringify({
      kind: PROVIDER_STALL_KIND,
      startedAt: '2026-01-01T00:00:00.000Z',
      outcome: 'exploded',
    }))
    expect(parsed?.outcome).toBeNull()
  })

  it('formats a distinct message per stall state', () => {
    const base = { startedAt: '2026-01-01T00:00:00.000Z', durationMs: 30_000 }
    expect(formatProviderStallContent(base)).toContain('has not responded for 30s')
    expect(formatProviderStallContent({ ...base, durationMs: 42_000, outcome: 'recovered' }))
      .toContain('recovered after 42s')
    expect(formatProviderStallContent({ ...base, durationMs: 90_000, outcome: 'aborted' }))
      .toContain('stopped responding')
  })
})

describe('loadStallThresholds', () => {
  it('defaults to 30s warn / 90s abort when the settings file has no watchdog section', () => {
    expect(loadStallThresholds(() => ({}))).toEqual({
      warnMs: DEFAULT_STALL_WARN_MS,
      abortMs: DEFAULT_STALL_ABORT_MS,
    })
  })

  it('applies configured overrides', () => {
    expect(loadStallThresholds(() => ({ watchdog: { stallWarnMs: 5_000, stallAbortMs: 20_000 } }))).toEqual({
      warnMs: 5_000,
      abortMs: 20_000,
    })
  })

  it('falls back per field for invalid values and unreadable config', () => {
    expect(loadStallThresholds(() => ({ watchdog: { stallWarnMs: 0, stallAbortMs: 'soon' } }))).toEqual({
      warnMs: DEFAULT_STALL_WARN_MS,
      abortMs: DEFAULT_STALL_ABORT_MS,
    })
    expect(loadStallThresholds(() => { throw new Error('no config dir') })).toEqual({
      warnMs: DEFAULT_STALL_WARN_MS,
      abortMs: DEFAULT_STALL_ABORT_MS,
    })
  })
})
