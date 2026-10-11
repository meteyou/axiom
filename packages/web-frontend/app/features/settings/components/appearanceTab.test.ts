import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const readComponent = (name: string) => fs.readFileSync(path.join(__dirname, name), 'utf-8')

describe('appearance settings tab', () => {
  it('binds the logo picker to the appearance settings of the form', () => {
    const workspace = readComponent('SettingsWorkspace.vue')
    expect(workspace).toContain("'appearance'")
    expect(workspace).toMatch(/<AppearanceSettingsTab\s+v-else-if="activeTab === 'appearance'"\s+v-model="form.appearance"/)
  })

  it('offers every logo variant from the settings contract', () => {
    const tab = readComponent('AppearanceSettingsTab.vue')
    expect(tab).toContain('v-for="logo in SETTINGS_APP_LOGOS"')
    expect(tab).toContain('@click="settings.logo = logo"')
  })
})
