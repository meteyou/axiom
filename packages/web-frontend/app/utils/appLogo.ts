import { normalizeAppLogo, type AppLogo } from '@axiom/core/contracts'

export interface AppLogoAsset {
  src: string
  favicon: string
}

export const APP_LOGO_ASSETS: Record<AppLogo, AppLogoAsset> = {
  prism: { src: '/logos/prism.svg', favicon: '/logos/prism.svg' },
  raccoon: { src: '/logos/raccoon.svg', favicon: '/logos/raccoon-favicon.svg' },
  robot: { src: '/logos/robot.svg', favicon: '/logos/robot.svg' },
}

export function resolveAppLogoAsset(logo: unknown): AppLogoAsset {
  return APP_LOGO_ASSETS[normalizeAppLogo(logo)]
}
