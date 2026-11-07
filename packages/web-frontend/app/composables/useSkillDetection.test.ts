import { describe, expect, it } from 'vitest'
import { useSkillDetection } from './useSkillDetection'

describe('useSkillDetection', () => {
  const { isSkillLoad, getSkillName } = useSkillDetection()

  it('detects SKILL.md loads for the current and the legacy read tool', () => {
    const input = { path: '/data/skills_agent/wiki/SKILL.md' }
    expect(isSkillLoad('file_read', input)).toBe(true)
    expect(isSkillLoad('read_file', input)).toBe(true)
    expect(isSkillLoad('read_file', JSON.stringify(input))).toBe(true)
    expect(getSkillName(input)).toBe('wiki')
  })

  it('ignores other tools and other files', () => {
    expect(isSkillLoad('file_write', { path: '/data/skills_agent/wiki/SKILL.md' })).toBe(false)
    expect(isSkillLoad('file_read', { path: '/data/memory/MEMORY.md' })).toBe(false)
  })
})
