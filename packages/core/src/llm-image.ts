import type { AgentMessage, AgentOptions } from '@earendil-works/pi-agent-core'
import type { Api, ImageContent, Model, ModelImageResizeOptions, TextContent } from '@earendil-works/pi-ai'
import sharp from 'sharp'
import type { Metadata } from 'sharp'

const DEFAULT_LLM_IMAGE_LIMITS: Required<ModelImageResizeOptions> = {
  maxWidth: 2000,
  maxHeight: 2000,
  // Base64 payload size; leaves headroom below Anthropic's 5 MB per-image limit.
  maxBytes: 4.5 * 1024 * 1024,
  jpegQuality: 80,
}

const PROVIDER_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const LOSSLESS_SOURCE_MIME_TYPES = new Set(['image/png', 'image/gif', 'image/tiff'])
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'])
const AVIF_BRANDS = new Set(['avif', 'avis'])
const FALLBACK_JPEG_QUALITIES = [70, 55, 40]
const HEIC_DECODABLE = sharp.format.heif.input.fileSuffix?.includes('.heic') ?? false

// Gemini caps inline request payloads at 20 MB, and the transcript's text has
// to fit next to the images.
const DEFAULT_REQUEST_IMAGE_BYTES = 16 * 1024 * 1024
const DEFAULT_REQUEST_IMAGE_COUNT = 50
const OMITTED_OLDER_IMAGE_TEXT = '[Older image omitted from this request to stay within the provider\'s image limits. Re-read the file if you need to see it again.]'

export type LlmImageResult =
  | { ok: true; image: ImageContent; note?: string }
  | { ok: false; reason: string }

type ToolResultContent = Array<TextContent | ImageContent>

interface EncodedImage {
  data: Buffer
  mimeType: string
  width: number
  height: number
}

function startsWithBytes(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false
  return signature.every((byte, index) => bytes[offset + index] === byte)
}

function startsWithAscii(bytes: Uint8Array, text: string, offset = 0): boolean {
  if (bytes.length < offset + text.length) return false
  for (let index = 0; index < text.length; index++) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false
  }
  return true
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

/**
 * Identify a raster image by its magic bytes. Declared MIME types and file
 * extensions are untrusted, so this is the only signal used to decide whether
 * bytes may become an LLM image block.
 */
export function detectImageMimeType(bytes: Uint8Array): string | null {
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWithAscii(bytes, 'GIF87a') || startsWithAscii(bytes, 'GIF89a')) return 'image/gif'
  if (startsWithAscii(bytes, 'RIFF') && startsWithAscii(bytes, 'WEBP', 8)) return 'image/webp'
  if (startsWithBytes(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWithBytes(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return 'image/tiff'
  if (startsWithAscii(bytes, 'ftyp', 4) && bytes.length >= 12) {
    const brand = readAscii(bytes, 8, 4)
    if (AVIF_BRANDS.has(brand)) return 'image/avif'
    if (HEIF_BRANDS.has(brand)) return 'image/heic'
  }
  return null
}

function resolveLimits(resize?: ModelImageResizeOptions): Required<ModelImageResizeOptions> {
  return {
    maxWidth: resize?.maxWidth ?? DEFAULT_LLM_IMAGE_LIMITS.maxWidth,
    maxHeight: resize?.maxHeight ?? DEFAULT_LLM_IMAGE_LIMITS.maxHeight,
    maxBytes: resize?.maxBytes ?? DEFAULT_LLM_IMAGE_LIMITS.maxBytes,
    jpegQuality: resize?.jpegQuality ?? DEFAULT_LLM_IMAGE_LIMITS.jpegQuality,
  }
}

function base64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4
}

function fitWithin(width: number, height: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  let targetWidth = width
  let targetHeight = height
  if (targetWidth > maxWidth) {
    targetHeight = Math.max(1, Math.round((targetHeight * maxWidth) / targetWidth))
    targetWidth = maxWidth
  }
  if (targetHeight > maxHeight) {
    targetWidth = Math.max(1, Math.round((targetWidth * maxHeight) / targetHeight))
    targetHeight = maxHeight
  }
  return { width: targetWidth, height: targetHeight }
}

function toImageContent(data: Buffer, mimeType: string): ImageContent {
  return { type: 'image', data: data.toString('base64'), mimeType }
}

async function encodeWithinLimits(
  bytes: Buffer,
  size: { width: number; height: number },
  preferPng: boolean,
  limits: Required<ModelImageResizeOptions>,
): Promise<EncodedImage | null> {
  const jpegQualities = [limits.jpegQuality, ...FALLBACK_JPEG_QUALITIES.filter((quality) => quality < limits.jpegQuality)]
  let target = fitWithin(size.width, size.height, limits.maxWidth, limits.maxHeight)

  while (true) {
    const { data: pixels, info } = await sharp(bytes)
      .autoOrient()
      .resize(target.width, target.height, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true })
    const fromPixels = () => sharp(pixels, { raw: { width: info.width, height: info.height, channels: info.channels } })
    const dimensions = { width: info.width, height: info.height }

    const encoders: Array<() => Promise<EncodedImage>> = []
    if (preferPng) {
      encoders.push(async () => ({ data: await fromPixels().png().toBuffer(), mimeType: 'image/png', ...dimensions }))
    }
    for (const quality of jpegQualities) {
      encoders.push(async () => ({
        data: await fromPixels().flatten({ background: '#ffffff' }).jpeg({ quality }).toBuffer(),
        mimeType: 'image/jpeg',
        ...dimensions,
      }))
    }

    for (const encode of encoders) {
      const encoded = await encode()
      if (base64Length(encoded.data.length) < limits.maxBytes) return encoded
    }

    if (target.width === 1 && target.height === 1) return null
    target = {
      width: Math.max(1, Math.floor(target.width * 0.75)),
      height: Math.max(1, Math.floor(target.height * 0.75)),
    }
  }
}

function describeReencoding(
  sourceMimeType: string,
  original: { width: number; height: number },
  encoded: EncodedImage,
): string | undefined {
  const notes: string[] = []
  if (!PROVIDER_IMAGE_MIME_TYPES.has(sourceMimeType)) {
    notes.push(`[Image converted from ${sourceMimeType} to ${encoded.mimeType}.]`)
  }
  if (encoded.width !== original.width || encoded.height !== original.height) {
    const scale = (original.width / encoded.width).toFixed(2)
    notes.push(`[Image: original ${original.width}x${original.height}, displayed at ${encoded.width}x${encoded.height}. Multiply coordinates by ${scale} to map to original image.]`)
  }
  return notes.length > 0 ? notes.join('\n') : undefined
}

/**
 * Turn raw image bytes into an image block every vision provider accepts:
 * PNG/JPEG/GIF/WebP, EXIF-oriented, within the dimension and base64 size
 * limits. Images that already comply are passed through byte-for-byte.
 *
 * Callers must not send the original bytes when this fails — an image the
 * provider rejects stays in the transcript and breaks every later turn.
 */
export async function prepareImageForLlm(bytes: Buffer, resize?: ModelImageResizeOptions): Promise<LlmImageResult> {
  const limits = resolveLimits(resize)
  const sourceMimeType = detectImageMimeType(bytes)
  if (!sourceMimeType) {
    return { ok: false, reason: 'not a supported raster image (PNG, JPEG, GIF, WebP, TIFF or AVIF)' }
  }
  if (sourceMimeType === 'image/heic' && !HEIC_DECODABLE) {
    return { ok: false, reason: 'HEIC images cannot be decoded on this server; convert it to JPEG or PNG first' }
  }

  // Bytes come from users and tools. sharp reports unreadable input only as
  // generic Errors, so every failure below is logged and turned into a text
  // hint instead of an image block the provider would reject.
  let metadata: Metadata
  try {
    metadata = await sharp(bytes).metadata()
  } catch (err) {
    console.warn(`[llm-image] Failed to read ${sourceMimeType} metadata (${bytes.length} bytes):`, err)
    return { ok: false, reason: `the ${sourceMimeType} image could not be decoded` }
  }

  const original = metadata.autoOrient
  const providerReady = PROVIDER_IMAGE_MIME_TYPES.has(sourceMimeType) && base64Length(bytes.length) < limits.maxBytes
  const withinDimensions = original.width <= limits.maxWidth && original.height <= limits.maxHeight
  if (providerReady && withinDimensions && (metadata.orientation ?? 1) === 1) {
    return { ok: true, image: toImageContent(bytes, sourceMimeType) }
  }

  const preferPng = metadata.hasAlpha || LOSSLESS_SOURCE_MIME_TYPES.has(sourceMimeType)
  let encoded: EncodedImage | null
  try {
    encoded = await encodeWithinLimits(bytes, original, preferPng, limits)
  } catch (err) {
    console.warn(`[llm-image] Failed to re-encode ${sourceMimeType} image (${original.width}x${original.height}, ${bytes.length} bytes):`, err)
    return { ok: false, reason: `the ${sourceMimeType} image could not be processed` }
  }
  if (!encoded) return { ok: false, reason: 'the image could not be reduced below the size limit' }

  const note = describeReencoding(sourceMimeType, original, encoded)
  return { ok: true, image: toImageContent(encoded.data, encoded.mimeType), ...(note && { note }) }
}

/**
 * Normalize images that tools put into their results. Returns the original
 * array when nothing changed. Unusable images are replaced by a text note
 * instead of being forwarded to the provider.
 */
export async function normalizeToolResultImages(
  content: ToolResultContent,
  resize?: ModelImageResizeOptions,
): Promise<ToolResultContent> {
  if (!content.some((block) => block.type === 'image')) return content

  const normalized: ToolResultContent = []
  let changed = false
  for (const block of content) {
    if (block.type !== 'image') {
      normalized.push(block)
      continue
    }
    const prepared = await prepareImageForLlm(Buffer.from(block.data, 'base64'), resize)
    if (!prepared.ok) {
      normalized.push({ type: 'text', text: `[Image omitted: ${prepared.reason}.]` })
      changed = true
      continue
    }
    if (prepared.image.data === block.data && prepared.image.mimeType === block.mimeType && !prepared.note) {
      normalized.push(block)
      continue
    }
    normalized.push(prepared.image)
    if (prepared.note) normalized.push({ type: 'text', text: prepared.note })
    changed = true
  }
  return changed ? normalized : content
}

/** `afterToolCall` hook that keeps oversized or unsupported tool images out of the transcript. */
export function createToolResultImageHook(getModel: () => Model<Api>): NonNullable<AgentOptions['afterToolCall']> {
  return async ({ result }) => {
    const content = result.content as ToolResultContent | undefined
    if (!content) return undefined
    const normalized = await normalizeToolResultImages(content, getModel().inputLimits?.images?.resize)
    if (normalized === content) return undefined
    return {
      content: normalized,
      ...(result.structuredContent !== undefined && { structuredContent: result.structuredContent }),
    }
  }
}

/**
 * Keep the newest images of the transcript within a per-request byte and
 * count budget and replace everything older with a text note. Images stay in
 * the stored transcript; only the outgoing request is trimmed, so a long
 * session with many images cannot grow past the provider's request limits.
 */
function limitTranscriptImages<T extends AgentMessage>(
  messages: T[],
  budget: { maxBytes: number; maxCount: number },
): T[] {
  let count = 0
  let bytes = 0
  let exhausted = false
  let result: T[] | undefined

  for (let index = messages.length - 1; index >= 0; index--) {
    const content = (messages[index] as { content?: unknown }).content
    if (!Array.isArray(content) || !content.some(isImageBlock)) continue

    let replaced = false
    const nextContent = content.map((block) => {
      if (!isImageBlock(block)) return block
      if (!exhausted && count + 1 <= budget.maxCount && bytes + block.data.length <= budget.maxBytes) {
        count += 1
        bytes += block.data.length
        return block
      }
      exhausted = true
      replaced = true
      return { type: 'text', text: OMITTED_OLDER_IMAGE_TEXT }
    })
    if (replaced) {
      result ??= [...messages]
      result[index] = { ...messages[index], content: nextContent }
    }
  }
  return result ?? messages
}

/** `transformContext` hook that applies {@link limitTranscriptImages} with the active model's limits. */
export function createTranscriptImageBudget(getModel: () => Model<Api>): NonNullable<AgentOptions['transformContext']> {
  return async (messages) => {
    const limits = getModel().inputLimits
    return limitTranscriptImages(messages, {
      maxBytes: limits?.maxRequestBytes ? Math.floor(limits.maxRequestBytes * 0.75) : DEFAULT_REQUEST_IMAGE_BYTES,
      maxCount: limits?.images?.maxPerRequest ?? DEFAULT_REQUEST_IMAGE_COUNT,
    })
  }
}

/**
 * Copy of a tool result with base64 image payloads replaced by a size marker.
 * Tool results are persisted and streamed to clients; the image itself only
 * belongs in the LLM transcript.
 */
export function redactToolResultImages<T>(result: T): T {
  const content = (result as { content?: unknown } | null | undefined)?.content
  if (!Array.isArray(content) || !content.some(isImageBlock)) return result
  return {
    ...result,
    content: content.map((block) => isImageBlock(block)
      ? { type: 'image', mimeType: block.mimeType, data: `[${base64DecodedKb(block.data)} KB image data omitted]` }
      : block),
  }
}

function isImageBlock(block: unknown): block is ImageContent {
  return typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'image'
    && typeof (block as { data?: unknown }).data === 'string'
}

function base64DecodedKb(data: string): number {
  return Math.round((data.length * 3) / 4 / 1024)
}
