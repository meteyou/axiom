import { describe, expect, it } from 'vitest'
import { detectMemoryFile, extractMemoryFileName, extractMemoryRelativePath, extractMemoryWriteContent, fileToolKind } from './memoryFileDetection'

describe('detectMemoryFile', () => {
  it('detects SOUL.md read as memory file', () => {
    const result = detectMemoryFile('file_read', { path: '/data/memory/SOUL.md' })
    expect(result.isMemoryFile).toBe(true)
    expect(result.label).toBe('Reading Personality')
    expect(result.icon).toBe('brain')
  })

  it('detects SOUL.md write as memory file', () => {
    const result = detectMemoryFile('file_write', { path: '/data/memory/SOUL.md' })
    expect(result.isMemoryFile).toBe(true)
    expect(result.label).toBe('Writing Personality')
    expect(result.icon).toBe('brain')
  })

  it('detects MEMORY.md as memory file', () => {
    const result = detectMemoryFile('file_read', { path: '/data/memory/MEMORY.md' })
    expect(result.isMemoryFile).toBe(true)
    expect(result.label).toBe('Reading Memory')
  })

  it('detects AGENTS.md as memory file', () => {
    const result = detectMemoryFile('Read', { path: '/data/memory/AGENTS.md' })
    expect(result.isMemoryFile).toBe(true)
    expect(result.label).toBe('Reading Agent Rules')
  })

  it('detects HEARTBEAT.md as memory file', () => {
    const result = detectMemoryFile('file_read', { path: '/data/memory/HEARTBEAT.md' })
    expect(result.isMemoryFile).toBe(true)
    expect(result.label).toBe('Reading Heartbeat Tasks')
  })

  it('detects HEARTBEAT.md write', () => {
    const result = detectMemoryFile('Write', { path: '/data/memory/HEARTBEAT.md' })
    expect(result.isMemoryFile).toBe(true)
    expect(result.label).toBe('Writing Heartbeat Tasks')
  })

  it('detects daily notes', () => {
    const result = detectMemoryFile('file_read', { path: '/data/memory/daily/2026-04-01.md' })
    expect(result.isMemoryFile).toBe(true)
    expect(result.label).toBe('Reading Daily Notes')
  })

  it('detects user profiles', () => {
    const result = detectMemoryFile('file_write', { path: '/data/memory/users/alice.md' })
    expect(result.isMemoryFile).toBe(true)
    expect(result.label).toBe('Writing User Profile')
  })

  it('detects wiki pages and drops the wiki folder from the display path', () => {
    const dev = detectMemoryFile('file_read', { path: '/Users/dev/project/.data/memory/wiki/karpathy-lernpfad.md' })
    expect(dev.isMemoryFile).toBe(true)
    expect(dev.label).toBe('Reading Wiki')
    expect(dev.displayPath).toBe('karpathy-lernpfad.md')

    const prod = detectMemoryFile('file_write', { path: '/data/memory/wiki/notes.md', content: 'x' })
    expect(prod.label).toBe('Writing Wiki')
    expect(prod.displayPath).toBe('notes.md')
  })

  it('falls back to a generic label for unknown memory subfolders', () => {
    const result = detectMemoryFile('file_read', { path: '/data/memory/projects/axiom.md' })
    expect(result.isMemoryFile).toBe(true)
    expect(result.label).toBe('Reading Memory File')
    expect(result.displayPath).toBe('projects/axiom.md')
  })

  it('exposes display paths for core and folder-based memory files', () => {
    expect(detectMemoryFile('file_read', { path: '/data/memory/MEMORY.md' }).displayPath).toBe('MEMORY.md')
    expect(detectMemoryFile('file_read', { path: '/data/memory/daily/2026-04-05.md' }).displayPath).toBe('2026-04-05.md')
    expect(detectMemoryFile('file_read', { path: '/data/memory/users/admin.md' }).displayPath).toBe('admin.md')
  })

  it('returns default for non-memory file paths', () => {
    const result = detectMemoryFile('file_read', { path: '/workspace/src/index.ts' })
    expect(result.isMemoryFile).toBe(false)
    expect(result.icon).toBe('settings')
    expect(detectMemoryFile('file_read', { path: '/workspace/memory/notes.md' }).isMemoryFile).toBe(false)
  })

  it('returns default for non-file tools', () => {
    const result = detectMemoryFile('execute_command', { command: 'ls' })
    expect(result.isMemoryFile).toBe(false)
  })

  it('handles Edit tool name for memory files', () => {
    const result = detectMemoryFile('Edit', { path: '/data/memory/MEMORY.md' })
    expect(result.isMemoryFile).toBe(true)
    expect(result.label).toBe('Editing Memory')
  })

  it('handles file_edit tool name for memory files', () => {
    const result = detectMemoryFile('file_edit', { path: '/data/memory/SOUL.md' })
    expect(result.isMemoryFile).toBe(true)
    expect(result.label).toBe('Editing Personality')
  })

  it('detects memory files for legacy file tool names', () => {
    expect(detectMemoryFile('read_file', { path: '/data/memory/MEMORY.md' }).label).toBe('Reading Memory')
    expect(detectMemoryFile('write_file', { path: '/data/memory/MEMORY.md' }).label).toBe('Writing Memory')
    expect(detectMemoryFile('edit_file', { path: '/data/memory/MEMORY.md' }).label).toBe('Editing Memory')
  })

  it('handles null/undefined toolArgs', () => {
    expect(detectMemoryFile('file_read', null).isMemoryFile).toBe(false)
    expect(detectMemoryFile('file_read', undefined).isMemoryFile).toBe(false)
  })

  it('handles file_path arg key', () => {
    const result = detectMemoryFile('file_read', { file_path: '/data/memory/SOUL.md' })
    expect(result.isMemoryFile).toBe(true)
    expect(result.label).toBe('Reading Personality')
  })
})

describe('extractMemoryFileName', () => {
  it('returns canonical path for core memory files', () => {
    expect(extractMemoryFileName({ path: '/data/memory/SOUL.md' })).toBe('/data/memory/SOUL.md')
    expect(extractMemoryFileName({ path: '/data/memory/MEMORY.md' })).toBe('/data/memory/MEMORY.md')
    expect(extractMemoryFileName({ path: '/data/memory/AGENTS.md' })).toBe('/data/memory/AGENTS.md')
    expect(extractMemoryFileName({ path: '/data/memory/HEARTBEAT.md' })).toBe('/data/memory/HEARTBEAT.md')
  })

  it('normalizes dev paths to canonical /data/memory/ prefix', () => {
    expect(extractMemoryFileName({ path: '/Users/dev/project/.data/memory/users/admin.md' })).toBe('/data/memory/users/admin.md')
    expect(extractMemoryFileName({ path: '/home/user/axiom/.data/memory/SOUL.md' })).toBe('/data/memory/SOUL.md')
    expect(extractMemoryFileName({ path: '/Users/dev/project/.data/memory/daily/2026-04-05.md' })).toBe('/data/memory/daily/2026-04-05.md')
  })

  it('returns null for non-memory paths', () => {
    expect(extractMemoryFileName({ path: '/workspace/src/index.ts' })).toBeNull()
    expect(extractMemoryFileName(null)).toBeNull()
    expect(extractMemoryFileName(undefined)).toBeNull()
  })
})

describe('extractMemoryRelativePath', () => {
  it('strips everything up to the memory root', () => {
    expect(extractMemoryRelativePath({ path: '/Users/dev/project/.data/memory/MEMORY.md' })).toBe('MEMORY.md')
    expect(extractMemoryRelativePath({ path: '/data/memory/wiki/llm-systems.md' })).toBe('wiki/llm-systems.md')
    expect(extractMemoryRelativePath({ path: '/data/memory/daily/2026-04-05.md' })).toBe('daily/2026-04-05.md')
  })

  it('falls back to the file name for config files', () => {
    expect(extractMemoryRelativePath({ path: '/data/config/AGENTS.md' })).toBe('AGENTS.md')
  })

  it('returns null for non-memory paths', () => {
    expect(extractMemoryRelativePath({ path: '/workspace/src/index.ts' })).toBeNull()
    expect(extractMemoryRelativePath(null)).toBeNull()
  })
})

describe('fileToolKind', () => {
  it('classifies current, legacy and capitalized file tool names', () => {
    expect(fileToolKind('file_read')).toBe('read')
    expect(fileToolKind('read_file')).toBe('read')
    expect(fileToolKind('Read')).toBe('read')
    expect(fileToolKind('file_write')).toBe('write')
    expect(fileToolKind('write_file')).toBe('write')
    expect(fileToolKind('file_edit')).toBe('edit')
    expect(fileToolKind('edit_file')).toBe('edit')
  })

  it('returns null for other tools', () => {
    expect(fileToolKind('file_list')).toBeNull()
    expect(fileToolKind('shell')).toBeNull()
    expect(fileToolKind('constructor')).toBeNull()
  })
})

describe('extractMemoryWriteContent', () => {
  it('returns the content of memory writes for current and legacy names', () => {
    const args = { path: '/data/memory/MEMORY.md', content: '# Memory' }
    expect(extractMemoryWriteContent('file_write', args)).toBe('# Memory')
    expect(extractMemoryWriteContent('write_file', args)).toBe('# Memory')
    expect(extractMemoryWriteContent('file_edit', args)).toBeNull()
  })
})
