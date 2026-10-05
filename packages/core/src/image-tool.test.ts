import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { buildImageModel } from './provider-config.js'
import type { ProviderConfig } from './provider-config.js'
import type { ImageGenerationRequest, ImageGenerationResult, ImageModelResolution } from './image-generation.js'
import {
  createGenerateImageTool,
  createImageGenerationTools,
  imageExtensionForMimeType,
  slugifyPrompt,
} from './image-tool.js'
import type { GenerateImageToolDetails } from './image-tool.js'
import { normalizeImageGenerationSettings } from './contracts/settings.js'
import type { ImageGenerationSettingsContract } from './contracts/settings.js'

const IMAGE_BYTES = Buffer.from('generated-image-bytes')
const IMAGE_BASE64 = IMAGE_BYTES.toString('base64')
const FIXED_NOW = new Date(2026, 9, 5, 12, 0, 0)

const provider: ProviderConfig = {
  id: 'or-1',
  name: 'OpenRouter',
  type: 'openai-completions',
  providerType: 'openrouter',
  provider: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'test-key',
  authMethod: 'api-key',
  enabledImageModels: ['recraft/recraft-v4.1', 'recraft/recraft-v4.1-flash'],
}

function resultWith(overrides: Partial<ImageGenerationResult> = {}, modelId = 'recraft/recraft-v4.1'): ImageGenerationResult {
  return {
    model: buildImageModel(provider, modelId),
    images: [{ mimeType: 'image/webp', data: IMAGE_BASE64, generationId: 'gen-1', costUsd: 0.035 }],
    texts: [],
    costUsd: 0.035,
    usage: { input: 44, output: 4175, cacheRead: 0, cacheWrite: 0 },
    requests: [{ costUsd: 0.035, usage: { input: 44, output: 4175, cacheRead: 0, cacheWrite: 0 } }],
    durationMs: 5736,
    errors: [],
    ...overrides,
  }
}

function settingsWith(overrides: Partial<ImageGenerationSettingsContract> = {}): () => ImageGenerationSettingsContract {
  return () => normalizeImageGenerationSettings(overrides)
}

function resolvesTo(modelId: string): (requested: string | undefined) => ImageModelResolution {
  return () => ({ ok: true, provider, modelId })
}

type ToolOutput = { content: Array<{ type: string; text?: string }>; details: GenerateImageToolDetails }

async function run(tool: AgentTool, params: Record<string, unknown>): Promise<ToolOutput> {
  return await tool.execute('call-1', params as never, undefined) as unknown as ToolOutput
}

function textOf(output: ToolOutput): string {
  return output.content.map(part => part.text ?? '').join('\n')
}

describe('generate_image tool', () => {
  let workspace: string
  let dataDir: string
  let db: Database
  const originalWorkspace = process.env.WORKSPACE_DIR
  const originalDataDir = process.env.DATA_DIR

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-image-tool-ws-'))
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-image-tool-data-'))
    process.env.WORKSPACE_DIR = workspace
    process.env.DATA_DIR = dataDir
    db = initDatabase(path.join(dataDir, 'test.db'))
  })

  afterEach(() => {
    db.close()
    fs.rmSync(workspace, { recursive: true, force: true })
    fs.rmSync(dataDir, { recursive: true, force: true })
    if (originalWorkspace !== undefined) process.env.WORKSPACE_DIR = originalWorkspace
    else delete process.env.WORKSPACE_DIR
    if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir
    else delete process.env.DATA_DIR
  })

  function createTool(
    generate: (request: ImageGenerationRequest) => Promise<ImageGenerationResult>,
    modelId = 'recraft/recraft-v4.1',
    settings: Partial<ImageGenerationSettingsContract> = {},
  ) {
    return createGenerateImageTool({
      db,
      getSessionId: () => 'session-1',
      readSettings: settingsWith(settings),
      generate,
      resolveModel: resolvesTo(modelId),
      now: () => FIXED_NOW,
    })
  }

  it('saves the image with a sidecar and returns paths, size, cost and duration but no image data', async () => {
    const generate = vi.fn(async () => resultWith())
    const output = await run(createTool(generate), { prompt: 'Sailboat on an alpine lake at sunrise', aspect_ratio: '1:1' })

    const relativePath = path.join('images', '2026-10-05', 'sailboat-on-an-alpine-lake-at.webp')
    const absolutePath = path.join(workspace, relativePath)
    expect(fs.readFileSync(absolutePath)).toEqual(IMAGE_BYTES)

    const sidecar = JSON.parse(fs.readFileSync(`${absolutePath}.json`, 'utf-8')) as Record<string, unknown>
    expect(sidecar).toMatchObject({
      model: 'recraft/recraft-v4.1',
      provider: 'OpenRouter',
      prompt: 'Sailboat on an alpine lake at sunrise',
      params: { aspectRatio: '1:1', n: 1, inputImages: [] },
      mimeType: 'image/webp',
      durationMs: 5736,
      costUsd: 0.035,
      generationId: 'gen-1',
    })

    const text = textOf(output)
    expect(text).toContain(relativePath)
    expect(text).toContain('image/webp')
    expect(text).toContain('$0.0350')
    expect(text).toContain('5.7 s')
    expect(text).toContain('send_file_to_user')
    expect(JSON.stringify(output)).not.toContain(IMAGE_BASE64)
    expect(output.details).toMatchObject({ model: 'recraft/recraft-v4.1', costUsd: 0.035, durationMs: 5736 })
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      provider,
      modelId: 'recraft/recraft-v4.1',
      prompt: 'Sailboat on an alpine lake at sunrise',
      parameters: { aspectRatio: '1:1' },
      count: 1,
      inputImages: [],
    }))
  })

  it('books the billed cost in token_usage on the current session', async () => {
    await run(createTool(async () => resultWith()), { prompt: 'p' })
    const row = db.prepare('SELECT provider, model, prompt_tokens, completion_tokens, estimated_cost, session_id FROM token_usage').get()
    expect(row).toEqual({
      provider: 'openrouter',
      model: 'recraft/recraft-v4.1',
      prompt_tokens: 44,
      completion_tokens: 4175,
      estimated_cost: 0.035,
      session_id: 'session-1',
    })
  })

  it('numbers multiple variants and never overwrites earlier files', async () => {
    const twoImages = resultWith({
      images: [
        { mimeType: 'image/png', data: IMAGE_BASE64 },
        { mimeType: 'image/png', data: IMAGE_BASE64 },
      ],
    })
    const tool = createTool(async () => twoImages)
    await run(tool, { prompt: 'Logo', n: 2 })
    const second = await run(tool, { prompt: 'Logo', n: 2 })

    const dir = path.join(workspace, 'images', '2026-10-05')
    expect(fs.readdirSync(dir).sort()).toEqual([
      'logo-1.png', 'logo-1.png.json', 'logo-2-1.png', 'logo-2-1.png.json',
      'logo-2-2.png', 'logo-2-2.png.json', 'logo-2.png', 'logo-2.png.json',
    ])
    expect(second.details.files?.map(f => path.basename(f.path))).toEqual(['logo-2-1.png', 'logo-2-2.png'])
  })

  it('books one token_usage row per request', async () => {
    const usage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 }
    await run(createTool(async () => resultWith({
      costUsd: 0.07,
      requests: [{ costUsd: 0.03, usage }, { costUsd: 0.04, usage }],
    })), { prompt: 'p', n: 2 })
    expect(db.prepare('SELECT estimated_cost FROM token_usage ORDER BY id').all()).toEqual([
      { estimated_cost: 0.03 },
      { estimated_cost: 0.04 },
    ])
  })

  it('declares and enforces the configured max variants', async () => {
    const generate = vi.fn(async () => resultWith())
    const tool = createTool(generate, 'recraft/recraft-v4.1', { maxVariants: 2 })
    const n = (tool.parameters as unknown as { properties: { n: { maximum: number; description: string } } }).properties.n
    expect(n.maximum).toBe(2)
    expect(n.description).toContain('1-2')

    const refused = await run(tool, { prompt: 'p', n: 3 })
    expect(refused.details.error).toBe(true)
    expect(textOf(refused)).toContain('n must be an integer from 1 to 2')
    expect(generate).not.toHaveBeenCalled()

    await run(tool, { prompt: 'p', n: 2 })
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ count: 2 }))
  })

  it('defaults to at most 4 variants', async () => {
    const generate = vi.fn(async () => resultWith())
    expect(textOf(await run(createTool(generate), { prompt: 'p', n: 5 }))).toContain('from 1 to 4')
    expect(generate).not.toHaveBeenCalled()
  })

  it('saves images in the configured output folder', async () => {
    const tool = createTool(async () => resultWith(), 'recraft/recraft-v4.1', { outputDir: 'assets/generated' })
    expect(tool.description).toContain('assets/generated/YYYY-MM-DD/')

    const output = await run(tool, { prompt: 'Logo' })
    const relativePath = path.join('assets', 'generated', '2026-10-05', 'logo.webp')
    expect(fs.existsSync(path.join(workspace, relativePath))).toBe(true)
    expect(output.details.files?.[0]?.path).toBe(relativePath)
    expect(fs.existsSync(path.join(workspace, 'images'))).toBe(false)
  })

  it('refuses to run while image generation is switched off', async () => {
    const generate = vi.fn(async () => resultWith())
    const output = await run(createTool(generate, 'recraft/recraft-v4.1', { enabled: false }), { prompt: 'p' })
    expect(output.details.error).toBe(true)
    expect(textOf(output)).toContain('switched off')
    expect(generate).not.toHaveBeenCalled()
  })

  it('loads input_images from the workspace as base64 image content', async () => {
    fs.writeFileSync(path.join(workspace, 'source.png'), IMAGE_BYTES)
    const generate = vi.fn(async () => resultWith())
    await run(createTool(generate), { prompt: 'make it blue', input_images: ['source.png'] })
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      inputImages: [{ type: 'image', mimeType: 'image/png', data: IMAGE_BASE64 }],
    }))
  })

  it('rejects missing or unsupported input images and models without image input', async () => {
    const generate = vi.fn(async () => resultWith())
    const tool = createTool(generate)

    expect(textOf(await run(tool, { prompt: 'p', input_images: ['missing.png'] }))).toMatch(/not found/)
    fs.writeFileSync(path.join(workspace, 'logo.svg'), '<svg/>')
    expect(textOf(await run(tool, { prompt: 'p', input_images: ['logo.svg'] }))).toMatch(/PNG, JPEG, WebP or GIF/)

    fs.writeFileSync(path.join(workspace, 'source.png'), IMAGE_BYTES)
    const textOnlyInput = createTool(generate, 'recraft/recraft-v4.1-flash')
    expect(textOf(await run(textOnlyInput, { prompt: 'p', input_images: ['source.png'] }))).toMatch(/does not accept input images/)
    expect(generate).not.toHaveBeenCalled()
  })

  it('validates prompt and aspect ratio', async () => {
    const generate = vi.fn(async () => resultWith())
    const tool = createTool(generate)
    expect((await run(tool, { prompt: '   ' })).details.error).toBe(true)
    expect(textOf(await run(tool, { prompt: 'p', aspect_ratio: 'wide' }))).toMatch(/aspect_ratio/)
    expect(generate).not.toHaveBeenCalled()
  })

  it('returns the model resolution error', async () => {
    const tool = createGenerateImageTool({
      readSettings: settingsWith(),
      generate: vi.fn(),
      resolveModel: () => ({ ok: false, error: 'Image model "x" is not enabled.' }),
    })
    const output = await run(tool, { prompt: 'p', model: 'x' })
    expect(output.details.error).toBe(true)
    expect(textOf(output)).toContain('Image model "x" is not enabled.')
  })

  it('surfaces generation errors with the reported cost and writes no files', async () => {
    const output = await run(createTool(async () => resultWith({
      images: [],
      errors: ['The model returned no image.'],
      texts: ['Content policy refusal'],
      costUsd: 0.01,
      requests: [{ costUsd: 0.01, usage: { input: 44, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    })), { prompt: 'p' })

    expect(output.details.error).toBe(true)
    expect(textOf(output)).toContain('The model returned no image.')
    expect(textOf(output)).toContain('$0.0100')
    expect(textOf(output)).toContain('Content policy refusal')
    expect(fs.existsSync(path.join(workspace, 'images'))).toBe(false)
    expect(db.prepare('SELECT estimated_cost FROM token_usage').get()).toEqual({ estimated_cost: 0.01 })
  })

  it('reports partial failures next to the saved images', async () => {
    const output = await run(createTool(async () => resultWith({ errors: ['Provider timeout'] })), { prompt: 'p', n: 2 })
    expect(textOf(output)).toContain('1 of 2 requests failed: Provider timeout')
    expect(output.details.files).toHaveLength(1)
  })

  it('is only registered while an image model is usable', () => {
    fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true })
    const providersPath = path.join(dataDir, 'config', 'providers.json')

    fs.writeFileSync(providersPath, JSON.stringify({ providers: [{ ...provider, enabledImageModels: [] }] }))
    expect(createImageGenerationTools()).toEqual([])

    fs.writeFileSync(providersPath, JSON.stringify({ providers: [provider] }))
    expect(createImageGenerationTools().map(tool => tool.name)).toEqual(['generate_image'])

    fs.writeFileSync(providersPath, JSON.stringify({ providers: [{ ...provider, disabled: true }] }))
    expect(createImageGenerationTools()).toEqual([])
  })

  it('is not registered while image generation is switched off, even with usable image models', () => {
    const configDir = path.join(dataDir, 'config')
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(path.join(configDir, 'providers.json'), JSON.stringify({ providers: [provider] }))
    const writeSettings = (enabled: boolean) => fs.writeFileSync(
      path.join(configDir, 'settings.json'),
      JSON.stringify({ imageGeneration: { enabled } }),
    )

    writeSettings(false)
    expect(createImageGenerationTools()).toEqual([])

    writeSettings(true)
    expect(createImageGenerationTools().map(tool => tool.name)).toEqual(['generate_image'])
  })
})

describe('image file naming', () => {
  it('derives the extension from the mime type', () => {
    expect(imageExtensionForMimeType('image/png')).toBe('png')
    expect(imageExtensionForMimeType('image/jpeg')).toBe('jpg')
    expect(imageExtensionForMimeType('image/webp')).toBe('webp')
    expect(imageExtensionForMimeType('image/svg+xml')).toBe('svg')
    expect(imageExtensionForMimeType('IMAGE/PNG; charset=binary')).toBe('png')
    expect(imageExtensionForMimeType('image/avif')).toBe('avif')
    expect(imageExtensionForMimeType('application/octet-stream')).toBe('bin')
  })

  it('slugifies prompts to short ascii stems', () => {
    expect(slugifyPrompt('Größe: Ein Café am See, Sonnenaufgang, Aquarell')).toBe('grosse-ein-cafe-am-see-sonnenaufgang')
    expect(slugifyPrompt('!!!')).toBe('image')
  })
})
