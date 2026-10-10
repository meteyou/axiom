import { describe, expect, it } from 'vitest'
import { getDefaultConsolidationContent, stripAdminOnlyBlocks } from './memory.js'

describe('CONSOLIDATION.md template', () => {
  it('has admin_only sections and the shared MEMORY.md rule', () => {
    const template = getDefaultConsolidationContent()
    expect(template).toContain('<admin_only>')
    expect(template).toContain('MEMORY.md is shared by all users')
  })

  it('strips admin_only blocks for user runs', () => {
    const stripped = stripAdminOnlyBlocks(getDefaultConsolidationContent())
    expect(stripped).not.toContain('admin_only')
    expect(stripped).not.toContain('Wiki lint')
    expect(stripped).toContain('MEMORY.md is shared by all users')
  })
})
