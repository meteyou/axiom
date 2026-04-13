import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  isExtractableType,
  extractTextContent,
  saveUploadWithExtraction,
} from './uploads.js'


describe('isExtractableType', () => {
  it('returns true for application/pdf', () => {
    expect(isExtractableType('application/pdf')).toBe(true)
  })

  it('returns true for text/plain', () => {
    expect(isExtractableType('text/plain')).toBe(true)
  })

  it('returns true for text/markdown', () => {
    expect(isExtractableType('text/markdown')).toBe(true)
  })

  it('returns true for text/csv', () => {
    expect(isExtractableType('text/csv')).toBe(true)
  })

  it('returns true for application/json', () => {
    expect(isExtractableType('application/json')).toBe(true)
  })

  it('returns false for image/png', () => {
    expect(isExtractableType('image/png')).toBe(false)
  })

  it('returns false for application/octet-stream', () => {
    expect(isExtractableType('application/octet-stream')).toBe(false)
  })

  it('returns false for application/zip', () => {
    expect(isExtractableType('application/zip')).toBe(false)
  })
})


describe('extractTextContent', () => {
  it('extracts UTF-8 text from text/plain buffer', async () => {
    const buf = Buffer.from('Hello, world!', 'utf-8')
    const result = await extractTextContent(buf, 'text/plain')
    expect(result).toBe('Hello, world!')
  })

  it('extracts text from text/markdown buffer', async () => {
    const md = '# Title\n\nSome paragraph text.'
    const buf = Buffer.from(md, 'utf-8')
    const result = await extractTextContent(buf, 'text/markdown')
    expect(result).toBe(md)
  })

  it('extracts text from text/csv buffer', async () => {
    const csv = 'name,age\nAlice,30\nBob,25'
    const buf = Buffer.from(csv, 'utf-8')
    const result = await extractTextContent(buf, 'text/csv')
    expect(result).toBe(csv)
  })

  it('extracts text from application/json buffer', async () => {
    const json = '{"key":"value","num":42}'
    const buf = Buffer.from(json, 'utf-8')
    const result = await extractTextContent(buf, 'application/json')
    expect(result).toBe(json)
  })

  it('returns null for empty text/plain buffer', async () => {
    const buf = Buffer.from('   ', 'utf-8')
    const result = await extractTextContent(buf, 'text/plain')
    expect(result).toBeNull()
  })

  it('returns null for unsupported MIME type', async () => {
    const buf = Buffer.from('binary data')
    const result = await extractTextContent(buf, 'application/octet-stream')
    expect(result).toBeNull()
  })

  it('returns null for image MIME type', async () => {
    const buf = Buffer.alloc(100)
    const result = await extractTextContent(buf, 'image/png')
    expect(result).toBeNull()
  })
})


describe('saveUploadWithExtraction', () => {
  let tempDataDir: string
  let previousDataDir: string | undefined

  beforeEach(() => {
    previousDataDir = process.env.DATA_DIR
    tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openagent-uploads-test-'))
    process.env.DATA_DIR = tempDataDir
    return () => {
      fs.rmSync(tempDataDir, { recursive: true, force: true })
      if (previousDataDir === undefined) {
        delete process.env.DATA_DIR
      } else {
        process.env.DATA_DIR = previousDataDir
      }
    }
  })

  it('populates extractedText for text/plain upload', async () => {
    const content = 'This is a plain text document.'
    const descriptor = await saveUploadWithExtraction({
      buffer: Buffer.from(content, 'utf-8'),
      originalName: 'doc.txt',
      mimeType: 'text/plain',
      source: 'web',
    })

    expect(descriptor.extractedText).toBe(content)
    expect(descriptor.kind).toBe('file')
    expect(descriptor.originalName).toBe('doc.txt')
  })

  it('populates extractedText for application/json upload', async () => {
    const json = '{"hello":"world"}'
    const descriptor = await saveUploadWithExtraction({
      buffer: Buffer.from(json, 'utf-8'),
      originalName: 'data.json',
      mimeType: 'application/json',
      source: 'web',
    })

    expect(descriptor.extractedText).toBe(json)
  })

  it('does NOT set extractedText for image uploads', async () => {
    const descriptor = await saveUploadWithExtraction({
      buffer: Buffer.alloc(32, 0),
      originalName: 'photo.jpg',
      mimeType: 'image/jpeg',
      source: 'web',
    })

    expect(descriptor.extractedText).toBeUndefined()
    expect(descriptor.kind).toBe('image')
  })

  it('does NOT set extractedText for unsupported binary uploads', async () => {
    const descriptor = await saveUploadWithExtraction({
      buffer: Buffer.from('binary'),
      originalName: 'archive.zip',
      mimeType: 'application/zip',
      source: 'web',
    })

    expect(descriptor.extractedText).toBeUndefined()
    expect(descriptor.kind).toBe('file')
  })

  it('leaves extractedText undefined when text is empty', async () => {
    const descriptor = await saveUploadWithExtraction({
      buffer: Buffer.from('   ', 'utf-8'),
      originalName: 'empty.txt',
      mimeType: 'text/plain',
      source: 'web',
    })

    expect(descriptor.extractedText).toBeUndefined()
  })

  it('still writes the file to disk', async () => {
    const content = 'persist me'
    const descriptor = await saveUploadWithExtraction({
      buffer: Buffer.from(content, 'utf-8'),
      originalName: 'test.txt',
      mimeType: 'text/plain',
      source: 'web',
    })

    const absPath = path.join(tempDataDir, 'uploads', descriptor.relativePath)
    expect(fs.existsSync(absPath)).toBe(true)
    expect(fs.readFileSync(absPath, 'utf-8')).toBe(content)
  })
})
