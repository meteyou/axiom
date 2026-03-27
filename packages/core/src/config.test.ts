import { describe, it, expect, afterEach } from 'vitest'
import { ensureConfigTemplates, loadConfig } from './config.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('config', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  function makeTmpDir(): string {
    tmpDir = path.join(os.tmpdir(), `openagent-config-test-${Date.now()}`)
    return tmpDir
  }

  it('creates template config files', () => {
    const dir = makeTmpDir()
    ensureConfigTemplates(dir)

    expect(fs.existsSync(path.join(dir, 'providers.json'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'settings.json'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'telegram.json'))).toBe(true)
  })

  it('settings.json has correct defaults', () => {
    const dir = makeTmpDir()
    ensureConfigTemplates(dir)

    const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8'))
    expect(settings.sessionTimeoutMinutes).toBe(15)
    expect(settings.language).toBe('en')
    expect(settings.yoloMode).toBe(true)
    expect(settings.tokenPriceTable['gpt-4o'].input).toBe(2.5)
    expect(settings.tokenPriceTable['gpt-4o'].output).toBe(10)
  })

  it('does not overwrite existing config files', () => {
    const dir = makeTmpDir()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'settings.json'), '{"custom": true}', 'utf-8')

    ensureConfigTemplates(dir)

    const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8'))
    expect(settings.custom).toBe(true)
  })

  it('loadConfig reads and parses JSON', () => {
    const dir = makeTmpDir()
    process.env.DATA_DIR = path.dirname(dir)

    // We need config dir to be under DATA_DIR/config
    const configDir = path.join(path.dirname(dir), 'config')
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(path.join(configDir, 'test.json'), '{"hello": "world"}', 'utf-8')

    const data = loadConfig<{ hello: string }>('test.json')
    expect(data.hello).toBe('world')

    delete process.env.DATA_DIR
  })
})
