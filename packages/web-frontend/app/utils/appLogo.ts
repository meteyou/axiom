import { normalizeAppLogo, type AppLogo } from '@axiom/core/contracts'

export interface AppLogoAsset {
  src: string
  favicon: string
  appleTouchIcon: string
}

export const APP_LOGO_ASSETS: Record<AppLogo, AppLogoAsset> = {
  prism: { src: '/logos/prism.svg', favicon: '/logos/prism.svg', appleTouchIcon: '/icons/prism-180.png' },
  raccoon: { src: '/logos/raccoon.svg', favicon: '/logos/raccoon-favicon.svg', appleTouchIcon: '/icons/raccoon-180.png' },
  robot: { src: '/logos/robot.svg', favicon: '/logos/robot.svg', appleTouchIcon: '/icons/robot-180.png' },
}

export function resolveAppLogoAsset(logo: unknown): AppLogoAsset {
  return APP_LOGO_ASSETS[normalizeAppLogo(logo)]
}
