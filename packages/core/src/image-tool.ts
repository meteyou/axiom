import fs from 'node:fs'
import path from 'node:path'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { ImageContent } from '@earendil-works/pi-ai'
import { StringEnum, Type } from '@earendil-works/pi-ai'
import type { Database } from './database.js'
import type { ImageGenerationSettingsContract } from './contracts/settings.js'
import {
  generateImagesWithProvider,
  isImageGenerationAvailable,
  planImageGeneration,
  readImageGenerationSettings,
  resolveImageModel,
} from './image-generation.js'
import type {
  GeneratedImage,
  ImageBilling,
  ImageGenerationParameters,
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageModelResolution,
} from './image-generation.js'
import { IMAGE_BACKGROUNDS, IMAGE_QUALITIES } from './image-backends.js'
import type { ProviderConfig } from './provider-config.js'
import type { ImageBackground, ImageQuality } from './image-backends.js'
import { logTokenUsage } from './token-logger.js'
import { getWorkspaceDir } from './workspace.js'

export const GENERATE_IMAGE_TOOL_NAME = 'generate_image'

const MAX_INPUT_IMAGES = 8
const MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024
const ASPECT_RATIO_PATTERN = /^\d{1,2}:\d{1,2}$/

const INPUT_IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

const EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
}

export interface GenerateImageToolOptions {
  db?: Database
  /** Session the generation cost is booked on in `token_usage`; background tools have none. */
  getSessionId?: () => string | null | undefined
  /** Test seams. */
  readSettings?: () => ImageGenerationSettingsContract
  generate?: (request: ImageGenerationRequest) => Promise<ImageGenerationResult>
  resolveModel?: (requested: string | undefined) => ImageModelResolution
  now?: () => Date
}

interface GenerateImageParams {
  prompt: string
  model?: string
  aspect_ratio?: string
  quality?: string
  background?: string
  n?: number
  input_images?: string[]
}

export interface SavedImageFile {
  path: string
  absolutePath: string
  sidecarPath: string
  mimeType: string
  bytes: number
}

export interface GenerateImageToolDetails {
  files?: SavedImageFile[]
  provider?: string
  model?: string
  costUsd?: number | null
  billing?: ImageBilling
  durationMs?: number
  errors?: string[]
  notes?: string[]
  error?: boolean
}

type GenerateImageToolResult = AgentToolResult<GenerateImageToolDetails>

/** `generate_image` is only registered while image generation is on and at least one image model is usable. */
export function createImageGenerationTools(options: GenerateImageToolOptions = {}): AgentTool[] {
  return isImageGenerationAvailable() ? [createGenerateImageTool(options)] : []
}

export function imageExtensionForMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase().split(';')[0]!.trim()
  const known = EXTENSION_BY_MIME_TYPE[normalized]
  if (known) return known
  const subtype = normalized.startsWith('image/') ? normalized.slice('image/'.length).replace(/[^a-z0-9]/g, '') : ''
  return subtype || 'bin'
}

export function slugifyPrompt(prompt: string): string {
  const slug = prompt
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 6)
    .join('-')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return slug || 'image'
}

function formatLocalDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function resolveWorkspacePath(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(getWorkspaceDir(), filePath)
}

function errorResult(message: string, extra: Partial<GenerateImageToolDetails> = {}): GenerateImageToolResult {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    details: { error: true, ...extra },
  }
}

function loadInputImages(paths: string[]): ImageContent[] {
  if (paths.length > MAX_INPUT_IMAGES) {
    throw new Error(`At most ${MAX_INPUT_IMAGES} input images are supported per call.`)
  }
  return paths.map((inputPath) => {
    const absolutePath = resolveWorkspacePath(inputPath)
    const extension = path.extname(absolutePath).toLowerCase()
    if (extension === '.svg') {
      throw new Error(`Input image "${inputPath}" is an SVG; image models only accept raster input. Generate again with a refined prompt or edit the SVG markup directly.`)
    }
    const mimeType = INPUT_IMAGE_MIME_TYPES[extension]
    if (!mimeType) {
      throw new Error(`Input image "${inputPath}" must be a PNG, JPEG, WebP or GIF file.`)
    }
    let stat: fs.Stats
    try {
      stat = fs.statSync(absolutePath)
    } catch {
      throw new Error(`Input image "${inputPath}" not found.`)
    }
    if (!stat.isFile()) throw new Error(`Input image "${inputPath}" is not a file.`)
    if (stat.size > MAX_INPUT_IMAGE_BYTES) {
      throw new Error(`Input image "${inputPath}" is larger than ${MAX_INPUT_IMAGE_BYTES / 1024 / 1024} MB.`)
    }
    return { type: 'image', mimeType, data: fs.readFileSync(absolutePath).toString('base64') }
  })
}

/**
 * Picks a file stem that collides with nothing already in `directory`, so a
 * repeated prompt never overwrites earlier results or their sidecars.
 */
function planFileNames(directory: string, slug: string, images: GeneratedImage[]): string[] {
  const namesFor = (stem: string) => images.map((image, index) => {
    const suffix = images.length > 1 ? `-${index + 1}` : ''
    return `${stem}${suffix}.${imageExtensionForMimeType(image.mimeType)}`
  })
  const isFree = (names: string[]) => names.every(name =>
    !fs.existsSync(path.join(directory, name)) && !fs.existsSync(path.join(directory, `${name}.json`)),
  )
  let names = namesFor(slug)
  for (let attempt = 2; !isFree(names); attempt++) {
    names = namesFor(`${slug}-${attempt}`)
  }
  return names
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatCost(result: ImageGenerationResult): string {
  const { costUsd, billing } = result
  if (billing === 'subscription') return 'included in the ChatGPT subscription (counts toward its usage limits)'
  if (costUsd !== null) return billing === 'estimated' ? `~$${costUsd.toFixed(4)} (estimated from list prices)` : `$${costUsd.toFixed(4)}`
  if (billing === 'reported') return 'not reported by the provider'
  return result.usage.input + result.usage.output > 0 ? 'unknown (no list price for this model)' : 'none (no tokens were reported)'
}

function parseOption<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined | null {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return undefined
  return (allowed as readonly string[]).includes(normalized) ? normalized as T : null
}

function parseParameters(params: GenerateImageParams): { ok: true; value: ImageGenerationParameters } | { ok: false; error: string } {
  const aspectRatio = params.aspect_ratio?.trim() || undefined
  if (aspectRatio && !ASPECT_RATIO_PATTERN.test(aspectRatio)) {
    return { ok: false, error: `aspect_ratio must look like "16:9", got "${params.aspect_ratio}".` }
  }
  const quality = parseOption<ImageQuality>(params.quality, IMAGE_QUALITIES)
  if (quality === null) return { ok: false, error: `quality must be one of ${IMAGE_QUALITIES.join(', ')}.` }
  const background = parseOption<ImageBackground>(params.background, IMAGE_BACKGROUNDS)
  if (background === null) return { ok: false, error: `background must be one of ${IMAGE_BACKGROUNDS.join(', ')}.` }
  return {
    ok: true,
    value: {
      ...(aspectRatio && { aspectRatio }),
      ...(quality && { quality }),
      ...(background && { background }),
    },
  }
}

function bookImageUsage(db: Database, result: ImageGenerationResult, sessionId: string | undefined): void {
  for (const request of result.requests) {
    logTokenUsage(db, {
      provider: result.model.provider,
      model: result.model.id,
      promptTokens: request.usage.input,
      completionTokens: request.usage.output,
      cacheRead: request.usage.cacheRead,
      cacheWrite: request.usage.cacheWrite,
      estimatedCost: request.costUsd ?? 0,
      sessionId,
    })
  }
}

interface SaveContext {
  /** Normalized to stay inside the workspace (normalizeImageOutputDir). */
  outputDir: string
  createdAt: Date
  provider: ProviderConfig
  modelId: string
  prompt: string
  params: Record<string, unknown>
}

function saveGeneratedImages(result: ImageGenerationResult, context: SaveContext): SavedImageFile[] {
  const directory = path.join(getWorkspaceDir(), context.outputDir, formatLocalDate(context.createdAt))
  fs.mkdirSync(directory, { recursive: true })
  const fileNames = planFileNames(directory, slugifyPrompt(context.prompt), result.images)

  return result.images.map((image, index) => {
    const absolutePath = path.join(directory, fileNames[index]!)
    const buffer = Buffer.from(image.data, 'base64')
    fs.writeFileSync(absolutePath, buffer)
    const sidecarPath = `${absolutePath}.json`
    fs.writeFileSync(sidecarPath, `${JSON.stringify({
      model: context.modelId,
      provider: context.provider.name,
      providerId: context.provider.id,
      prompt: context.prompt,
      params: context.params,
      mimeType: image.mimeType,
      bytes: buffer.length,
      durationMs: result.durationMs,
      costUsd: image.costUsd ?? null,
      billing: result.billing,
      generationId: image.generationId ?? null,
      createdAt: context.createdAt.toISOString(),
    }, null, 2)}\n`, 'utf-8')
    return {
      path: path.relative(getWorkspaceDir(), absolutePath),
      absolutePath,
      sidecarPath,
      mimeType: image.mimeType,
      bytes: buffer.length,
    }
  })
}

export function createGenerateImageTool(options: GenerateImageToolOptions = {}): AgentTool {
  const generate = options.generate ?? generateImagesWithProvider
  const resolveModel = options.resolveModel ?? ((requested: string | undefined) => resolveImageModel(requested))
  const now = options.now ?? (() => new Date())
  const readSettings = options.readSettings ?? readImageGenerationSettings
  const declared = readSettings()

  return {
    name: GENERATE_IMAGE_TOOL_NAME,
    label: 'Generate Image',
    description:
      'Generate images with an enabled image generation model (listed under "Image generation models" in available_providers). '
      + `Files are saved in the workspace under ${declared.outputDir}/YYYY-MM-DD/ with a JSON sidecar; the result lists paths, format, `
      + 'size, the cost (or the subscription usage) and the duration, never image data. To edit or vary an existing image, pass it via '
      + 'input_images instead of generating from scratch. Deliver results to the user with send_file_to_user. '
      + 'Load the image-generation skill before the first use for prompt writing, model choice and cost guidance.',
    parameters: Type.Object({
      prompt: Type.String({ description: 'Detailed description of the image: subject, composition, style, colours, any text that must appear.' }),
      model: Type.Optional(Type.String({
        description: 'Image model as "<provider>:<model id>" or a model id from the image generation model list. Defaults to the default image model.',
      })),
      aspect_ratio: Type.Optional(Type.String({
        description: 'Aspect ratio such as "1:1", "16:9", "9:16", "4:3" or "3:2". Not every model honours it; the result notes any adjustment.',
      })),
      quality: Type.Optional(StringEnum(IMAGE_QUALITIES, {
        description: 'Rendering quality (OpenAI GPT Image models via API key). Higher quality costs more and takes longer. Other models ignore it.',
      })),
      background: Type.Optional(StringEnum(IMAGE_BACKGROUNDS, {
        description: '"transparent" for a PNG with alpha channel, e.g. logos and cut-outs (OpenAI GPT Image models). Other models ignore it.',
      })),
      n: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: declared.maxVariants,
        description: `Number of variants (1-${declared.maxVariants}, default 1). Each variant is billed separately.`,
      })),
      input_images: Type.Optional(Type.Array(Type.String(), {
        description: `Workspace-relative (or absolute) paths of PNG/JPEG/WebP/GIF images to edit, combine or use as reference (max ${MAX_INPUT_IMAGES}).`,
      })),
    }),
    execute: async (_toolCallId, rawParams, signal): Promise<GenerateImageToolResult> => {
      const settings = readSettings()
      if (!settings.enabled) return errorResult('Image generation is switched off under Settings → Image generation.')

      const params = rawParams as GenerateImageParams
      const prompt = params.prompt?.trim()
      if (!prompt) return errorResult('prompt must not be empty.')

      const parsedParameters = parseParameters(params)
      if (!parsedParameters.ok) return errorResult(parsedParameters.error)
      const parameters = parsedParameters.value
      const count = params.n ?? 1
      if (!Number.isInteger(count) || count < 1 || count > settings.maxVariants) {
        return errorResult(`n must be an integer from 1 to ${settings.maxVariants} (Settings → Image generation → Max variants per call).`)
      }

      const resolution = resolveModel(params.model)
      if (!resolution.ok) return errorResult(resolution.error)
      const { provider, modelId } = resolution

      let inputImages: ImageContent[] = []
      try {
        inputImages = loadInputImages(params.input_images ?? [])
        const plan = planImageGeneration(provider, modelId, parameters, inputImages.length)
        if (!plan.ok) return errorResult(plan.error)
      } catch (err) {
        return errorResult((err as Error).message)
      }

      let result: ImageGenerationResult
      try {
        result = await generate({
          provider,
          modelId,
          prompt,
          inputImages,
          parameters,
          count,
          signal,
        })
      } catch (err) {
        return errorResult(`Image generation failed: ${(err as Error).message}`)
      }

      if (options.db) bookImageUsage(options.db, result, options.getSessionId?.() ?? undefined)

      const summary = {
        provider: provider.name,
        model: modelId,
        costUsd: result.costUsd,
        billing: result.billing,
        durationMs: result.durationMs,
        errors: result.errors,
        notes: result.notes,
      }
      const cost = `Cost: ${formatCost(result)}.`
      const trailer = [
        ...result.notes.map(note => `Note: ${note}`),
        ...(result.usageNote ? [result.usageNote] : []),
        ...(result.texts.length > 0 ? [`Model text: ${result.texts.join(' ')}`] : []),
      ]

      if (result.images.length === 0) {
        return errorResult(
          [`${result.errors.join(' ') || 'The model returned no image.'} ${cost}`, ...trailer].join('\n'),
          summary,
        )
      }

      const files = saveGeneratedImages(result, {
        outputDir: settings.outputDir,
        createdAt: now(),
        provider,
        modelId,
        prompt,
        params: {
          aspectRatio: parameters.aspectRatio ?? null,
          quality: parameters.quality ?? null,
          background: parameters.background ?? null,
          n: count,
          inputImages: params.input_images ?? [],
        },
      })

      const lines = [
        `Generated ${files.length} image${files.length === 1 ? '' : 's'} with ${provider.name}: ${modelId} in ${(result.durationMs / 1000).toFixed(1)} s. ${cost}`,
        ...files.map(file => `- ${file.path} (${file.mimeType}, ${formatBytes(file.bytes)})`),
      ]
      if (result.errors.length > 0) {
        lines.push(`${result.errors.length} of ${count} requests failed: ${result.errors.join(' | ')}`)
      }
      lines.push(...trailer)
      lines.push(`Paths are relative to ${getWorkspaceDir()}. Deliver them with send_file_to_user; never paste image data into the chat.`)

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details: { ...summary, files },
      }
    },
  }
}
