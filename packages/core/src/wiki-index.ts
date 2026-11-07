import fs from 'node:fs'
import path from 'node:path'
import type { Database } from './database.js'
import { normalizeFtsQuery } from './fts-utils.js'
import { getMemoryDir, parseProjectAliases } from './memory.js'

export interface WikiSearchHit {
  /** Absolute path, ready for `file_read`. */
  path: string
  title: string
  aliases: string[]
  snippet: string
}

export interface WikiSyncResult {
  added: number
  updated: number
  removed: number
}

interface IndexedFileRow {
  id: number
  path: string
  mtime_ms: number
  size: number
}

interface WikiFileStat {
  relPath: string
  absPath: string
  mtimeMs: number
  size: number
}

const FRONTMATTER_RE = /^---\s*\n[\s\S]*?\n---[^\n]*(\n|$)/

function getWikiDir(memoryDir?: string): string {
  return path.join(memoryDir ?? getMemoryDir(), 'wiki')
}

function collectWikiFiles(wikiDir: string): WikiFileStat[] {
  const files: WikiFileStat[] = []
  const walk = (dir: string, relDir: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const absPath = path.join(dir, entry.name)
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(absPath, relPath)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        try {
          const stat = fs.statSync(absPath)
          files.push({ relPath, absPath, mtimeMs: stat.mtimeMs, size: stat.size })
        } catch {
          // File vanished between readdir and stat; the next sync picks up its state.
        }
      }
    }
  }
  if (fs.existsSync(wikiDir)) walk(wikiDir, '')
  return files
}

export function parseWikiPage(relPath: string, content: string): { title: string; aliases: string[]; body: string } {
  const aliases = parseProjectAliases(content)
  const body = content.replace(FRONTMATTER_RE, '')
  const heading = body.match(/^#\s+(.+?)\s*#*\s*$/m)
  const fmTitle = content.match(FRONTMATTER_RE)?.[0].match(/^title:\s*["']?(.+?)["']?\s*$/m)
  const title = heading?.[1] ?? fmTitle?.[1] ?? path.basename(relPath, path.extname(relPath))
  return { title, aliases, body }
}

/** Brings the wiki index in line with the files on disk, using mtime + size to detect changes. */
export function syncWikiIndex(db: Database, memoryDir?: string): WikiSyncResult {
  const files = collectWikiFiles(getWikiDir(memoryDir))
  const indexed = new Map(
    (db.prepare('SELECT id, path, mtime_ms, size FROM wiki_index_files').all() as IndexedFileRow[])
      .map(row => [row.path, row]),
  )

  const insertFile = db.prepare('INSERT INTO wiki_index_files (path, mtime_ms, size) VALUES (?, ?, ?)')
  const updateFile = db.prepare('UPDATE wiki_index_files SET mtime_ms = ?, size = ? WHERE id = ?')
  const deleteFile = db.prepare('DELETE FROM wiki_index_files WHERE id = ?')
  const insertFts = db.prepare('INSERT INTO wiki_index_fts (rowid, path, title, aliases, body) VALUES (?, ?, ?, ?, ?)')
  const deleteFts = db.prepare('DELETE FROM wiki_index_fts WHERE rowid = ?')

  const result: WikiSyncResult = { added: 0, updated: 0, removed: 0 }

  db.transaction(() => {
    for (const file of files) {
      const existing = indexed.get(file.relPath)
      indexed.delete(file.relPath)
      if (existing && existing.mtime_ms === file.mtimeMs && existing.size === file.size) continue

      let content: string
      try {
        content = fs.readFileSync(file.absPath, 'utf-8')
      } catch {
        continue
      }
      const page = parseWikiPage(file.relPath, content)

      let id: number
      if (existing) {
        id = existing.id
        updateFile.run(file.mtimeMs, file.size, id)
        deleteFts.run(id)
        result.updated++
      } else {
        id = Number(insertFile.run(file.relPath, file.mtimeMs, file.size).lastInsertRowid)
        result.added++
      }
      insertFts.run(id, file.relPath, page.title, page.aliases.join(', '), page.body)
    }

    for (const stale of indexed.values()) {
      deleteFts.run(stale.id)
      deleteFile.run(stale.id)
      result.removed++
    }
  })()

  return result
}

export function searchWiki(
  db: Database,
  query: string,
  options: { memoryDir?: string; limit?: number } = {},
): WikiSearchHit[] {
  const trimmed = query.trim()
  if (trimmed.length === 0) return []

  syncWikiIndex(db, options.memoryDir)

  const limit = Math.max(1, Math.floor(options.limit ?? 10))
  const rows = db.prepare(`
    SELECT path, title, aliases,
      snippet(wiki_index_fts, 3, '**', '**', '…', 24) AS snippet
    FROM wiki_index_fts
    WHERE wiki_index_fts MATCH ?
    ORDER BY bm25(wiki_index_fts, 5.0, 10.0, 10.0, 1.0) ASC, path ASC
    LIMIT ?
  `).all(normalizeFtsQuery(trimmed, 'OR'), limit) as Array<{ path: string; title: string; aliases: string; snippet: string }>

  const wikiDir = getWikiDir(options.memoryDir)
  return rows.map(row => ({
    path: path.join(wikiDir, row.path),
    title: row.title,
    aliases: row.aliases ? row.aliases.split(',').map(alias => alias.trim()).filter(Boolean) : [],
    snippet: row.snippet.replace(/\s+/g, ' ').trim(),
  }))
}
