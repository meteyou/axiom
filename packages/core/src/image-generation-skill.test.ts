import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { getProjectRootDir } from './config.js'
import { createGenerateImageTool } from './image-tool.js'
import { extractFrontmatter, parseSkillMd } from './skill-parser.js'

const skillPath = path.join(getProjectRootDir(), 'data', 'skills_agent', 'image-generation', 'SKILL.md')

describe('bundled image-generation skill', () => {
  const content = fs.readFileSync(skillPath, 'utf-8')

  it('is versioned for entrypoint auto-updates and hidden without the generate_image tool', () => {
    const parsed = parseSkillMd(content)
    expect(parsed.name).toBe('image-generation')
    expect(parsed.requiresToolsets).toEqual(['generate_image'])
    expect(extractFrontmatter(content).frontmatter?.version).toBe('1.0.0')
  })

  it('is referenced by the generate_image tool description', () => {
    expect(createGenerateImageTool().description).toContain('image-generation skill')
  })
})
