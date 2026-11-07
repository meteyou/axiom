import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { parseWikiPage, searchWiki, syncWikiIndex } from './wiki-index.js'

describe('wiki index', () => {
  let db: Database
  let memoryDir: string
  let wikiDir: string

  const writePage = (relPath: string, content: string, mtime?: Date) => {
    const file = path.join(wikiDir, relPath)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content, 'utf-8')
    if (mtime) fs.utimesSync(file, mtime, mtime)
  }

  beforeEach(() => {
    db = initDatabase(':memory:')
    memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-wiki-index-'))
    wikiDir = path.join(memoryDir, 'wiki')
    fs.mkdirSync(wikiDir, { recursive: true })
  })

  afterEach(() => {
    db.close()
    fs.rmSync(memoryDir, { recursive: true, force: true })
  })

  it('parses title, aliases and body from frontmatter pages', () => {
    const page = parseWikiPage('axiom.md', '---\naliases: [Axiom, the-axiom]\ntype: project\n---\n\n# Project: Axiom\n\nBody text.\n')
    expect(page.title).toBe('Project: Axiom')
    expect(page.aliases).toEqual(['Axiom', 'the-axiom'])
    expect(page.body).not.toContain('aliases:')
    expect(page.body).toContain('Body text.')
  })

  it('falls back to the filename when a page has no heading', () => {
    expect(parseWikiPage('topic/notes.md', 'just text').title).toBe('notes')
  })

  it('indexes all pages, including topic folders, on the first search', () => {
    writePage('axiom.md', '---\naliases: [ax]\n---\n# Axiom\n\nRuns behind a Caddy reverse proxy.\n')
    writePage('homelab/index.md', '# Homelab\n\nProxmox cluster with three nodes.\n')
    writePage('.hidden.md', '# Hidden\n\nproxmox\n')
    writePage('notes.txt', 'proxmox')

    const hits = searchWiki(db, 'proxmox', { memoryDir })

    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      path: path.join(wikiDir, 'homelab', 'index.md'),
      title: 'Homelab',
      aliases: [],
    })
    expect(hits[0].snippet).toContain('**Proxmox**')
    const count = db.prepare('SELECT COUNT(*) AS n FROM wiki_index_files').get() as { n: number }
    expect(count.n).toBe(2)
  })

  it('matches aliases, titles and paths, and returns aliases with the hit', () => {
    writePage('axiom-deployment.md', '---\naliases: [ax-deploy, rollout]\n---\n# Shipping\n\nDocker compose on the server.\n')

    expect(searchWiki(db, 'rollout', { memoryDir })[0]).toMatchObject({
      title: 'Shipping',
      aliases: ['ax-deploy', 'rollout'],
    })
    expect(searchWiki(db, 'shipping', { memoryDir })).toHaveLength(1)
    expect(searchWiki(db, 'deployment', { memoryDir })).toHaveLength(1)
  })

  it('ranks title and alias matches above body-only matches', () => {
    writePage('a-misc.md', '# Misc\n\nWe once mentioned kubernetes in passing.\n')
    writePage('b-k8s.md', '---\naliases: [kubernetes]\n---\n# Cluster\n\nNode pools.\n')

    const hits = searchWiki(db, 'kubernetes', { memoryDir })
    expect(hits.map(hit => path.basename(hit.path))).toEqual(['b-k8s.md', 'a-misc.md'])
  })

  it('re-indexes modified pages', () => {
    writePage('axiom.md', '# Axiom\n\nUses postgres.\n', new Date('2026-01-01T00:00:00Z'))
    expect(searchWiki(db, 'postgres', { memoryDir })).toHaveLength(1)

    writePage('axiom.md', '# Axiom\n\nUses sqlite.\n', new Date('2026-01-02T00:00:00Z'))

    expect(searchWiki(db, 'postgres', { memoryDir })).toHaveLength(0)
    expect(searchWiki(db, 'sqlite', { memoryDir })).toHaveLength(1)
  })

  it('removes deleted pages from results', () => {
    writePage('axiom.md', '# Axiom\n\nUses postgres.\n')
    expect(searchWiki(db, 'postgres', { memoryDir })).toHaveLength(1)

    fs.unlinkSync(path.join(wikiDir, 'axiom.md'))

    expect(searchWiki(db, 'postgres', { memoryDir })).toHaveLength(0)
    const count = db.prepare('SELECT COUNT(*) AS n FROM wiki_index_files').get() as { n: number }
    expect(count.n).toBe(0)
  })

  it('only re-reads pages whose modification time changed', () => {
    writePage('a.md', '# A\n', new Date('2026-01-01T00:00:00Z'))
    writePage('b.md', '# B\n', new Date('2026-01-01T00:00:00Z'))

    expect(syncWikiIndex(db, memoryDir)).toEqual({ added: 2, updated: 0, removed: 0 })
    expect(syncWikiIndex(db, memoryDir)).toEqual({ added: 0, updated: 0, removed: 0 })

    writePage('b.md', '# B\n', new Date('2026-01-03T00:00:00Z'))
    expect(syncWikiIndex(db, memoryDir)).toEqual({ added: 0, updated: 1, removed: 0 })
  })

  it('treats a missing wiki directory as empty without creating it', () => {
    fs.rmSync(wikiDir, { recursive: true })
    expect(searchWiki(db, 'anything', { memoryDir })).toEqual([])
    expect(fs.existsSync(wikiDir)).toBe(false)
  })
})
