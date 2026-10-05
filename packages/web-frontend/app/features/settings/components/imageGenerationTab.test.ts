import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const readComponent = (name: string) => fs.readFileSync(path.join(__dirname, name), 'utf-8')

function tabTemplate(source: string, tabId: string): string {
  const start = source.indexOf(`activeTab === '${tabId}'`)
  const end = source.indexOf('v-else-if="activeTab ===', start + 1)
  expect(start).toBeGreaterThan(-1)
  return source.slice(start, end)
}

describe('image generation settings placement', () => {
  const workspace = readComponent('SettingsWorkspace.vue')

  it('has its own settings tab', () => {
    expect(workspace).toContain("'imageGeneration'")
    expect(tabTemplate(workspace, 'imageGeneration')).toContain('v-model="form.imageGeneration"')
  })

  it('keeps every image generation field out of the Tasks tab', () => {
    expect(tabTemplate(workspace, 'tasks')).not.toMatch(/imageGeneration/i)
  })

  it('edits the default image model in the image generation tab', () => {
    const tab = readComponent('ImageGenerationSettingsTab.vue')
    for (const field of ['enabled', 'defaultModel', 'maxVariants', 'outputDir']) {
      expect(tab).toContain(`settings.${field}`)
    }
    expect(tab).toContain('maxCostInput')
  })
})
