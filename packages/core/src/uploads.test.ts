import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'
import { buildUploadPromptContext, getUploadRetentionDays, saveUpload } from './uploads.js'

describe('getUploadRetentionDays', () => {
  let tmpDir: string
  let prevDataDir: string | undefined

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-uploads-test-'))
    fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
    prevDataDir = process.env.DATA_DIR
    process.env.DATA_DIR = tmpDir
  })

  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = prevDataDir
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function writeSettings(value: object): void {
    fs.writeFileSync(
      path.join(tmpDir, 'config', 'settings.json'),
      JSON.stringify(value, null, 2),
      'utf-8',
    )
  }

  it('reads the new uploads.retentionDays nested field', () => {
    writeSettings({ uploads: { retentionDays: 7 } })
    expect(getUploadRetentionDays()).toBe(7)
  })

  it('falls back to the legacy top-level uploadRetentionDays when the new field is absent', () => {
    // Simulates an upgraded install: the user customised the old top-level
    // field and never opened the Uploads panel after the upgrade.
    writeSettings({ uploadRetentionDays: 14 })
    expect(getUploadRetentionDays()).toBe(14)
  })

  it('prefers the new uploads.retentionDays over the legacy field when both are present', () => {
    writeSettings({ uploads: { retentionDays: 7 }, uploadRetentionDays: 14 })
    expect(getUploadRetentionDays()).toBe(7)
  })

  it('returns the 30-day default when neither field is present', () => {
    writeSettings({})
    expect(getUploadRetentionDays()).toBe(30)
  })

  it('ignores invalid values and falls back to the default', () => {
    writeSettings({ uploads: { retentionDays: -1 }, uploadRetentionDays: 'nope' })
    expect(getUploadRetentionDays()).toBe(30)
  })

  it('ignores an invalid new field but still honors a valid legacy field', () => {
    writeSettings({ uploads: { retentionDays: -5 }, uploadRetentionDays: 21 })
    expect(getUploadRetentionDays()).toBe(21)
  })
})

describe('buildUploadPromptContext', () => {
  let tmpDir: string
  let prevDataDir: string | undefined

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-upload-prompt-test-'))
    prevDataDir = process.env.DATA_DIR
    process.env.DATA_DIR = tmpDir
  })

  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = prevDataDir
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('attaches provider-safe images and tells the agent where every upload lives', async () => {
    const png = await sharp({ create: { width: 4000, height: 2000, channels: 3, background: '#224466' } }).png().toBuffer()
    const image = saveUpload({ buffer: png, originalName: 'photo.png', mimeType: 'image/png', source: 'web' })
    const doc = saveUpload({ buffer: Buffer.from('%PDF-1.4'), originalName: 'doc.pdf', mimeType: 'application/pdf', source: 'web' })

    const context = await buildUploadPromptContext([image, doc])

    expect(context.images).toHaveLength(1)
    const resized = await sharp(Buffer.from(context.images[0].data, 'base64')).metadata()
    expect({ width: resized.width, height: resized.height }).toEqual({ width: 2000, height: 1000 })
    expect(context.hints).toEqual([
      `[Uploaded image: photo.png (image/png) at ${path.join(tmpDir, 'uploads', image.relativePath)}]`,
      '[Image: original 4000x2000, displayed at 2000x1000. Multiply coordinates by 2.00 to map to original image.]',
      `[Uploaded file: doc.pdf (application/pdf, 8 bytes) at ${path.join(tmpDir, 'uploads', doc.relativePath)}]`,
    ])
  })

  it('never forwards images the provider would reject', async () => {
    const svg = saveUpload({
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>'),
      originalName: 'logo.svg',
      mimeType: 'image/svg+xml',
      source: 'web',
    })

    const context = await buildUploadPromptContext([svg])

    expect(context.images).toEqual([])
    expect(context.hints).toHaveLength(1)
    expect(context.hints[0]).toContain('[Uploaded image: logo.svg (image/svg+xml')
    expect(context.hints[0]).toContain('Not attached for viewing: not a supported raster image')
  })

  it('reports uploads that disappeared from disk', async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#000' } }).png().toBuffer()
    const image = saveUpload({ buffer: png, originalName: 'gone.png', mimeType: 'image/png', source: 'telegram' })
    fs.rmSync(path.join(tmpDir, 'uploads', image.relativePath))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const context = await buildUploadPromptContext([image])
    consoleError.mockRestore()

    expect(context).toEqual({ images: [], hints: ['[Image upload failed to read: gone.png]'] })
  })
})
