import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { SETTINGS_APP_LOGOS } from '@axiom/core/contracts'
import { APP_LOGO_ASSETS, resolveAppLogoAsset } from './appLogo'

const publicDir = path.resolve(__dirname, '../../public')

describe('app logo assets', () => {
  it('maps every logo variant to its own image and favicon', () => {
    expect(resolveAppLogoAsset('prism')).toEqual({ src: '/logos/prism.svg', favicon: '/logos/prism.svg' })
    expect(resolveAppLogoAsset('raccoon')).toEqual({ src: '/logos/raccoon.svg', favicon: '/logos/raccoon-favicon.svg' })
    expect(resolveAppLogoAsset('robot')).toEqual({ src: '/logos/robot.svg', favicon: '/logos/robot.svg' })
  })

  it('falls back to the prism logo for missing or unknown values', () => {
    expect(resolveAppLogoAsset(undefined)).toBe(APP_LOGO_ASSETS.prism)
    expect(resolveAppLogoAsset(null)).toBe(APP_LOGO_ASSETS.prism)
    expect(resolveAppLogoAsset('unicorn')).toBe(APP_LOGO_ASSETS.prism)
  })

  it('ships every referenced file in the public directory', () => {
    for (const logo of SETTINGS_APP_LOGOS) {
      const { src, favicon } = APP_LOGO_ASSETS[logo]
      expect(fs.existsSync(path.join(publicDir, src))).toBe(true)
      expect(fs.existsSync(path.join(publicDir, favicon))).toBe(true)
    }
  })
})
