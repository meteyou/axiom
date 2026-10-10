import crypto from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import type { Sharp } from 'sharp'
import type { Api, ImageContent, Model } from '@earendil-works/pi-ai'
import type { AfterToolCallContext, AgentMessage } from '@earendil-works/pi-agent-core'
import {
  createToolResultImageHook,
  createTranscriptImageBudget,
  detectImageMimeType,
  normalizeToolResultImages,
  omitToolResultStructuredContent,
  prepareImageForLlm,
  redactToolResultImages,
} from './llm-image.js'

function solidImage(width: number, height: number): Sharp {
  return sharp({ create: { width, height, channels: 3, background: { r: 40, g: 120, b: 200 } } })
}

function noiseImage(width: number, height: number): Sharp {
  return sharp(crypto.randomBytes(width * height * 3), { raw: { width, height, channels: 3 } })
}

async function dimensionsOf(image: ImageContent): Promise<{ width?: number; height?: number; format?: string }> {
  const metadata = await sharp(Buffer.from(image.data, 'base64')).metadata()
  return { width: metadata.width, height: metadata.height, format: metadata.format }
}

function expectOk(result: Awaited<ReturnType<typeof prepareImageForLlm>>) {
  if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`)
  return result
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('detectImageMimeType', () => {
  it('recognizes raster formats by magic bytes', async () => {
    expect(detectImageMimeType(await solidImage(4, 4).png().toBuffer())).toBe('image/png')
    expect(detectImageMimeType(await solidImage(4, 4).jpeg().toBuffer())).toBe('image/jpeg')
    expect(detectImageMimeType(await solidImage(4, 4).gif().toBuffer())).toBe('image/gif')
    expect(detectImageMimeType(await solidImage(4, 4).webp().toBuffer())).toBe('image/webp')
    expect(detectImageMimeType(await solidImage(4, 4).tiff().toBuffer())).toBe('image/tiff')
    expect(detectImageMimeType(Buffer.from('\0\0\0\x18ftypheic\0\0\0\0', 'binary'))).toBe('image/heic')
    expect(detectImageMimeType(Buffer.from('\0\0\0\x18ftypavif\0\0\0\0', 'binary'))).toBe('image/avif')
  })

  it('does not treat text or vector markup as an image', () => {
    expect(detectImageMimeType(Buffer.from('hello world'))).toBeNull()
    expect(detectImageMimeType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull()
    expect(detectImageMimeType(Buffer.alloc(0))).toBeNull()
  })
})

describe('prepareImageForLlm', () => {
  it('passes compliant images through byte-for-byte', async () => {
    const png = await solidImage(800, 600).png().toBuffer()
    const result = expectOk(await prepareImageForLlm(png))
    expect(result.image).toEqual({ type: 'image', mimeType: 'image/png', data: png.toString('base64') })
    expect(result.note).toBeUndefined()
  })

  it('ignores the declared type and uses the detected one', async () => {
    const jpeg = await solidImage(10, 10).jpeg().toBuffer()
    const result = expectOk(await prepareImageForLlm(jpeg))
    expect(result.image.mimeType).toBe('image/jpeg')
  })

  it('downscales oversized images and reports the coordinate mapping', async () => {
    const png = await solidImage(3000, 1000).png().toBuffer()
    const result = expectOk(await prepareImageForLlm(png))
    expect(await dimensionsOf(result.image)).toMatchObject({ width: 2000, height: 667 })
    expect(result.note).toContain('original 3000x1000, displayed at 2000x667')
    expect(result.note).toContain('Multiply coordinates by 1.50')
  })

  it('honours model-specific resize limits', async () => {
    const png = await solidImage(1000, 1000).png().toBuffer()
    const result = expectOk(await prepareImageForLlm(png, { maxWidth: 500, maxHeight: 500 }))
    expect(await dimensionsOf(result.image)).toMatchObject({ width: 500, height: 500 })
  })

  it('applies EXIF orientation', async () => {
    const jpeg = await solidImage(200, 100).jpeg().withMetadata({ orientation: 6 }).toBuffer()
    const result = expectOk(await prepareImageForLlm(jpeg))
    expect(result.image.data).not.toBe(jpeg.toString('base64'))
    const metadata = await sharp(Buffer.from(result.image.data, 'base64')).metadata()
    expect({ width: metadata.width, height: metadata.height }).toEqual({ width: 100, height: 200 })
    expect(metadata.orientation ?? 1).toBe(1)
  })

  it('re-encodes images until they fit the byte limit', async () => {
    const png = await noiseImage(600, 600).png().toBuffer()
    const maxBytes = 120 * 1024
    const result = expectOk(await prepareImageForLlm(png, { maxBytes }))
    expect(result.image.mimeType).toBe('image/jpeg')
    expect(result.image.data.length).toBeLessThan(maxBytes)
  })

  it('converts formats providers do not accept', async () => {
    const tiff = await solidImage(64, 64).tiff().toBuffer()
    const result = expectOk(await prepareImageForLlm(tiff))
    expect(result.image.mimeType).toBe('image/png')
    expect(await dimensionsOf(result.image)).toMatchObject({ format: 'png', width: 64, height: 64 })
    expect(result.note).toBe('[Image converted from image/tiff to image/png.]')
  })

  it('rejects SVG and undecodable data', async () => {
    const svg = await prepareImageForLlm(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>'))
    expect(svg).toMatchObject({ ok: false })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const truncatedPng = (await solidImage(500, 500).png().toBuffer()).subarray(0, 40)
    const corrupt = await prepareImageForLlm(truncatedPng)
    expect(corrupt).toEqual({ ok: false, reason: 'the image/png image could not be decoded' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Failed to read image/png metadata (40 bytes)'), expect.any(Error))
  })

  it('rejects HEIC up front when the bundled decoder cannot read it', async () => {
    const heic = Buffer.from('\0\0\0\x18ftypheic\0\0\0\0mif1heic', 'binary')
    const result = await prepareImageForLlm(heic)
    expect(result).toMatchObject({ ok: false })
    if (!sharp.format.heif.input.fileSuffix?.includes('.heic')) {
      expect(result).toEqual({ ok: false, reason: 'HEIC images cannot be decoded on this server; convert it to JPEG or PNG first' })
    }
  })
})

describe('normalizeToolResultImages', () => {
  it('returns the same array when every image is already compliant', async () => {
    const png = await solidImage(16, 16).png().toBuffer()
    const content = [
      { type: 'text' as const, text: 'screenshot' },
      { type: 'image' as const, mimeType: 'image/png', data: png.toString('base64') },
    ]
    expect(await normalizeToolResultImages(content)).toBe(content)
  })

  it('resizes oversized images and replaces unusable ones with a note', async () => {
    const large = await solidImage(2400, 1200).png().toBuffer()
    const content = [
      { type: 'image' as const, mimeType: 'image/png', data: large.toString('base64') },
      { type: 'image' as const, mimeType: 'image/png', data: Buffer.from('not an image').toString('base64') },
    ]
    const normalized = await normalizeToolResultImages(content)
    expect(normalized).not.toBe(content)
    expect(normalized).toHaveLength(3)
    expect(normalized[0].type).toBe('image')
    expect(await dimensionsOf(normalized[0] as ImageContent)).toMatchObject({ width: 2000, height: 1000 })
    expect(normalized[1]).toMatchObject({ type: 'text', text: expect.stringContaining('displayed at 2000x1000') })
    expect(normalized[2]).toMatchObject({ type: 'text', text: expect.stringContaining('[Image omitted:') })
  })
})

describe('createToolResultImageHook', () => {
  it('normalizes tool images with the active model limits', async () => {
    const png = await solidImage(400, 400).png().toBuffer()
    const model = { inputLimits: { images: { resize: { maxWidth: 100, maxHeight: 100 } } } } as unknown as Model<Api>
    const hook = createToolResultImageHook(() => model)
    const override = await hook({
      result: { content: [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }], details: {} },
    } as unknown as AfterToolCallContext)
    const image = override?.content?.[0] as ImageContent
    expect(await dimensionsOf(image)).toMatchObject({ width: 100, height: 100 })
  })

  it('leaves text-only results untouched', async () => {
    const hook = createToolResultImageHook(() => ({}) as Model<Api>)
    const override = await hook({
      result: { content: [{ type: 'text', text: 'ok' }], details: {} },
    } as unknown as AfterToolCallContext)
    expect(override).toBeUndefined()
  })
})

describe('createTranscriptImageBudget', () => {
  function imageBlock(bytes: number): ImageContent {
    return { type: 'image', mimeType: 'image/png', data: 'A'.repeat(bytes) }
  }

  function modelWithLimits(inputLimits: Model<Api>['inputLimits']): Model<Api> {
    return { inputLimits } as Model<Api>
  }

  const omitted = { type: 'text', text: expect.stringContaining('Older image omitted from this request') }

  it('keeps the newest images within the count budget and omits everything older', async () => {
    const transcript = [
      { role: 'user', content: [{ type: 'text', text: 'first' }, imageBlock(10)], timestamp: 1 },
      { role: 'toolResult', toolCallId: 't1', toolName: 'read_file', content: [imageBlock(10)], isError: false, timestamp: 2 },
      { role: 'user', content: [imageBlock(10), imageBlock(10)], timestamp: 3 },
    ] as AgentMessage[]
    const budget = createTranscriptImageBudget(() => modelWithLimits({ images: { maxPerRequest: 2 } }))

    const trimmed = await budget(transcript)

    expect(trimmed[2]).toBe(transcript[2])
    expect((trimmed[1] as { content: unknown[] }).content).toEqual([omitted])
    expect((trimmed[0] as { content: unknown[] }).content).toEqual([{ type: 'text', text: 'first' }, omitted])
    expect((transcript[1] as { content: unknown[] }).content).toEqual([imageBlock(10)])
  })

  it('derives the byte budget from the model request limit', async () => {
    const transcript = [
      { role: 'user', content: [imageBlock(600)], timestamp: 1 },
      { role: 'user', content: [imageBlock(600)], timestamp: 2 },
    ] as AgentMessage[]
    const budget = createTranscriptImageBudget(() => modelWithLimits({ maxRequestBytes: 1000 }))

    const trimmed = await budget(transcript)

    expect((trimmed[0] as { content: unknown[] }).content).toEqual([omitted])
    expect(trimmed[1]).toBe(transcript[1])
  })

  it('returns the transcript untouched when it fits', async () => {
    const transcript = [{ role: 'user', content: [imageBlock(100)], timestamp: 1 }] as AgentMessage[]
    const budget = createTranscriptImageBudget(() => modelWithLimits(undefined))
    expect(await budget(transcript)).toBe(transcript)
  })
})

describe('redactToolResultImages', () => {
  it('replaces base64 payloads without touching the original result', () => {
    const data = Buffer.alloc(4096).toString('base64')
    const result = { content: [{ type: 'text', text: 'hi' }, { type: 'image', mimeType: 'image/png', data }], details: { path: '/x.png' } }
    const redacted = redactToolResultImages(result)
    expect(redacted.content[1]).toEqual({ type: 'image', mimeType: 'image/png', data: '[4 KB image data omitted]' })
    expect(redacted.details).toBe(result.details)
    expect(result.content[1]).toMatchObject({ data })
  })

  it('returns results without images unchanged', () => {
    const result = { content: [{ type: 'text', text: 'hi' }] }
    expect(redactToolResultImages(result)).toBe(result)
    expect(redactToolResultImages(undefined)).toBeUndefined()
  })
})

describe('omitToolResultStructuredContent', () => {
  it('drops structuredContent on a copy without touching the original result', () => {
    const result = { content: [{ type: 'text', text: 'hi\n' }], details: { exitCode: 0 }, structuredContent: { output: 'hi\n', exit_code: 0 } }
    const omitted = omitToolResultStructuredContent(result)
    expect(omitted).toEqual({ content: [{ type: 'text', text: 'hi\n' }], details: { exitCode: 0 } })
    expect(omitted).not.toBe(result)
    expect(omitted.content).toBe(result.content)
    expect(result).toHaveProperty('structuredContent')
  })

  it('returns results without structured content unchanged', () => {
    const result = { content: [{ type: 'text', text: 'hi' }] }
    expect(omitToolResultStructuredContent(result)).toBe(result)
    expect(omitToolResultStructuredContent(undefined)).toBeUndefined()
    expect(omitToolResultStructuredContent('plain')).toBe('plain')
  })
})
