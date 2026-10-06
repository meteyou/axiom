import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import { createReadFileTool, READ_FILE_MAX_BYTES, READ_FILE_MAX_LINES } from './read-file-tool.js'

describe('read_file tool', () => {
  let workspace: string
  let previousWorkspace: string | undefined

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-read-file-'))
    previousWorkspace = process.env.WORKSPACE_DIR
    process.env.WORKSPACE_DIR = workspace
  })

  afterEach(() => {
    if (previousWorkspace === undefined) delete process.env.WORKSPACE_DIR
    else process.env.WORKSPACE_DIR = previousWorkspace
    fs.rmSync(workspace, { recursive: true, force: true })
  })

  function read(params: { path: string; offset?: number; limit?: number }): Promise<AgentToolResult<Record<string, unknown>>> {
    return createReadFileTool().execute('call-1', params)
  }

  function text(result: AgentToolResult<unknown>): string {
    return result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  }

  it('reads text files relative to the workspace', async () => {
    fs.writeFileSync(path.join(workspace, 'notes.txt'), 'line 1\nline 2')
    const result = await read({ path: 'notes.txt' })
    expect(text(result)).toBe('line 1\nline 2')
    expect(result.details).toEqual({ path: path.join(workspace, 'notes.txt'), size: 13 })
  })

  it('truncates long files and points at the next offset', async () => {
    const lines = Array.from({ length: READ_FILE_MAX_LINES + 500 }, (_, index) => `row ${index + 1}`)
    fs.writeFileSync(path.join(workspace, 'big.txt'), lines.join('\n'))

    const first = text(await read({ path: 'big.txt' }))
    expect(first).toContain(`row ${READ_FILE_MAX_LINES}\n`)
    expect(first).not.toContain(`row ${READ_FILE_MAX_LINES + 1}\n`)
    expect(first).toContain(`[Showing lines 1-${READ_FILE_MAX_LINES} of ${lines.length}. Use offset=${READ_FILE_MAX_LINES + 1} to continue.]`)

    const rest = text(await read({ path: 'big.txt', offset: READ_FILE_MAX_LINES + 1 }))
    expect(rest.startsWith(`row ${READ_FILE_MAX_LINES + 1}\n`)).toBe(true)
    expect(rest.endsWith(`row ${lines.length}`)).toBe(true)
  })

  it('caps output by bytes', async () => {
    const line = 'x'.repeat(1000)
    fs.writeFileSync(path.join(workspace, 'wide.txt'), Array.from({ length: 100 }, () => line).join('\n'))
    const output = text(await read({ path: 'wide.txt' }))
    const shownLines = Math.floor((READ_FILE_MAX_BYTES + 1) / 1001)
    expect(output).toContain(`[Showing lines 1-${shownLines} of 100. Use offset=${shownLines + 1} to continue.]`)
  })

  it('honours offset and limit', async () => {
    fs.writeFileSync(path.join(workspace, 'list.txt'), 'a\nb\nc\nd\ne')
    expect(text(await read({ path: 'list.txt', offset: 2, limit: 2 }))).toBe('b\nc\n\n[2 more lines in file. Use offset=4 to continue.]')
    expect(text(await read({ path: 'list.txt', offset: 9 }))).toBe('Error reading file: Offset 9 is beyond end of file (5 lines total)')
  })

  it('attaches images instead of dumping their bytes as text', async () => {
    const png = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: '#336699' } }).png().toBuffer()
    fs.writeFileSync(path.join(workspace, 'shot.dat'), png)

    const result = await read({ path: 'shot.dat' })
    expect(result.content).toHaveLength(2)
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringMatching(/^Read image file \[image\/png\]\n\[Image: original 3000x1500, displayed at 2000x1000/) })
    expect(result.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' })
    expect(result.details).toMatchObject({ image: true, mimeType: 'image/png', size: png.length })
  })

  it('reports images that cannot be prepared without attaching them', async () => {
    fs.writeFileSync(path.join(workspace, 'broken.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await read({ path: 'broken.png' })
    warn.mockRestore()
    expect(result.content).toEqual([{ type: 'text', text: 'Read image file [image/png]\n[Image omitted: the image/png image could not be decoded.]' }])
  })

  it('refuses to dump other binary files', async () => {
    fs.writeFileSync(path.join(workspace, 'archive.bin'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0xff]))
    const result = await read({ path: 'archive.bin' })
    expect(text(result)).toContain('[Binary file (7 bytes) cannot be displayed as text.')
    expect(result.details).toMatchObject({ binary: true })
  })

  it('returns an error result for missing files', async () => {
    const result = await read({ path: 'missing.txt' })
    expect(text(result)).toMatch(/^Error reading file: ENOENT/)
    expect(result.details).toEqual({ error: true })
  })
})
