import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { getProjectRootDir } from './config.js'
import { normalizeImageGenerationSettings } from './contracts/settings.js'
import { createGenerateImageTool } from './image-tool.js'
import { extractFrontmatter, parseSkillMd } from './skill-parser.js'
import { filterAndAnnotateAgentSkills } from './agent-skills.js'

const skillPath = path.join(getProjectRootDir(), 'data', 'skills_agent', 'image-generation', 'SKILL.md')

describe('bundled image-generation skill', () => {
  const content = fs.readFileSync(skillPath, 'utf-8')

  it('is versioned for entrypoint auto-updates and hidden without the image_generate tool', () => {
    const parsed = parseSkillMd(content)
    expect(parsed.name).toBe('image-generation')
    expect(parsed.requiresToolsets).toEqual(['image_generate'])
    expect(extractFrontmatter(content).frontmatter?.version).toBe('1.1.0')
  })

  it('is referenced by the image_generate tool description', () => {
    const tool = createGenerateImageTool({ readSettings: () => normalizeImageGenerationSettings(undefined) })
    expect(tool.description).toContain('image-generation skill')
  })

  it('stays out of <available_skills> unless image_generate is an active tool', () => {
    const parsed = parseSkillMd(content)
    const entry = { name: parsed.name, description: parsed.description, location: skillPath, requiresToolsets: parsed.requiresToolsets }
    const visibleWith = (activeTools: string[]) =>
      filterAndAnnotateAgentSkills([entry], { platform: 'linux', activeTools: new Set(activeTools) }).map(s => s.name)

    expect(visibleWith(['web_fetch'])).toEqual([])
    expect(visibleWith(['web_fetch', 'image_generate'])).toEqual(['image-generation'])
  })
})
