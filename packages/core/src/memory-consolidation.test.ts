import { describe, it, expect, afterEach } from 'vitest'
import {
  readDailyFilesForConsolidation,
  buildConsolidationPrompt,
} from './memory-consolidation.js'
import { ensureMemoryStructure, appendToDailyFile } from './memory.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('memory-consolidation', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  function makeTmpDir(): string {
    tmpDir = path.join(os.tmpdir(), `axiom-consolidation-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    return tmpDir
  }

  describe('readDailyFilesForConsolidation', () => {
    it('returns empty array when no daily files exist', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const files = readDailyFilesForConsolidation(3, dir)
      expect(files).toEqual([])
    })

    it('reads daily files with content', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      appendToDailyFile('\nUser prefers dark mode\n', undefined, dir)

      const files = readDailyFilesForConsolidation(3, dir)
      expect(files.length).toBe(1)
      expect(files[0].content).toContain('User prefers dark mode')
    })

    it('skips daily files with only the header', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      // Create a daily file with only the header
      const today = new Date().toISOString().split('T')[0]
      const dailyDir = path.join(dir, 'daily')
      fs.writeFileSync(path.join(dailyDir, `${today}.md`), `# Daily Memory — ${today}`, 'utf-8')

      const files = readDailyFilesForConsolidation(3, dir)
      expect(files.length).toBe(0)
    })

    it('returns files sorted oldest-first', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)
      const dailyDir = path.join(dir, 'daily')

      const now = new Date()
      for (let i = 2; i >= 0; i--) {
        const d = new Date(now)
        d.setDate(d.getDate() - i)
        const dateStr = d.toISOString().split('T')[0]
        fs.writeFileSync(
          path.join(dailyDir, `${dateStr}.md`),
          `# Daily Memory — ${dateStr}\n\nEntry for day -${i}\n`,
          'utf-8',
        )
      }

      const files = readDailyFilesForConsolidation(3, dir)
      expect(files.length).toBe(3)
      // Oldest first
      expect(files[0].content).toContain('day -2')
      expect(files[2].content).toContain('day -0')
    })
  })

  describe('buildConsolidationPrompt', () => {
    it('builds a valid context with system prompt and user message', () => {
      const currentMemory = '# Agent Memory\n\n## Learned Lessons\n\n(none yet)\n'
      const dailyEntries = [
        { date: '2025-03-25', content: '# Daily Memory — 2025-03-25\n\nUser prefers dark mode' },
        { date: '2025-03-26', content: '# Daily Memory — 2025-03-26\n\nUser speaks German' },
      ]

      const context = buildConsolidationPrompt(currentMemory, dailyEntries)

      expect(context.systemPrompt).toContain('memory consolidation')
      expect(context.messages).toHaveLength(1)
      expect(context.messages[0].role).toBe('user')

      const userContent = context.messages[0].content as string
      expect(userContent).toContain('Agent Memory')
      expect(userContent).toContain('2025-03-25')
      expect(userContent).toContain('User prefers dark mode')
      expect(userContent).toContain('2025-03-26')
      expect(userContent).toContain('User speaks German')
      expect(userContent).toContain('NO_UPDATE')
    })

    it('embeds consolidation rules in the system prompt when provided', () => {
      const currentMemory = '# Agent Memory\n'
      const dailyEntries = [
        { date: '2025-03-25', content: 'Some entry' },
      ]
      const rules = '## Custom Rules\n- Always promote project names\n- Ignore small talk'

      const context = buildConsolidationPrompt(currentMemory, dailyEntries, rules)

      expect(context.systemPrompt).toContain('Custom Rules')
      expect(context.systemPrompt).toContain('Always promote project names')
      expect(context.systemPrompt).toContain('Ignore small talk')
    })

    it('uses fallback rules when no consolidation rules are provided', () => {
      const currentMemory = '# Agent Memory\n'
      const dailyEntries = [
        { date: '2025-03-25', content: 'Some entry' },
      ]

      const context = buildConsolidationPrompt(currentMemory, dailyEntries)

      expect(context.systemPrompt).toContain('Be selective')
      expect(context.systemPrompt).toContain('Consolidation Rules')
    })

    it('includes all daily entries in chronological order', () => {
      const dailyEntries = [
        { date: '2025-03-24', content: 'Entry 1' },
        { date: '2025-03-25', content: 'Entry 2' },
        { date: '2025-03-26', content: 'Entry 3' },
      ]

      const context = buildConsolidationPrompt('# Memory', dailyEntries)
      const userContent = context.messages[0].content as string

      const idx1 = userContent.indexOf('2025-03-24')
      const idx2 = userContent.indexOf('2025-03-25')
      const idx3 = userContent.indexOf('2025-03-26')
      expect(idx1).toBeLessThan(idx2)
      expect(idx2).toBeLessThan(idx3)
    })
  })
})
