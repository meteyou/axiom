import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_MEMORY_SNAPSHOT_RETENTION = 7

const SNAPSHOT_NAME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(-\d+)?$/
const PARTIAL_SUFFIX = '.partial'

export interface MemorySnapshotOptions {
  /** Number of snapshots to keep, including the new one. */
  retention: number
  /** Additional files to include, e.g. profiles of non-bootstrap users. Must live inside the data dir. */
  extraFiles?: string[]
  now?: Date
}

export interface MemorySnapshotResult {
  dir: string
  files: number
  pruned: string[]
  /** Set when the snapshot was written but old snapshots could not be pruned. */
  pruneError?: Error
}

function dataDir(): string {
  return process.env.DATA_DIR ?? '/data'
}

function getMemorySnapshotsDir(): string {
  return path.join(dataDir(), 'memory-snapshots')
}

function snapshotName(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-')
}

function reserveSnapshotDir(snapshotsDir: string, now: Date): string {
  const base = snapshotName(now)
  for (let attempt = 0; ; attempt++) {
    const name = attempt === 0 ? base : `${base}-${attempt}`
    const target = path.join(snapshotsDir, name)
    if (!fs.existsSync(target) && !fs.existsSync(target + PARTIAL_SUFFIX)) return target
  }
}

function relativeToDataDir(file: string): string {
  const relative = path.relative(path.resolve(dataDir()), path.resolve(file))
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to snapshot a path outside the data directory: ${file}`)
  }
  return relative
}

function countFiles(dir: string): number {
  let count = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    count += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1
  }
  return count
}

/** Snapshots sorted oldest first. Names are ISO timestamps, so lexical order is chronological. */
function listMemorySnapshots(): string[] {
  const snapshotsDir = getMemorySnapshotsDir()
  if (!fs.existsSync(snapshotsDir)) return []
  return fs.readdirSync(snapshotsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && SNAPSHOT_NAME_PATTERN.test(entry.name))
    .map(entry => entry.name)
    .sort()
}

function pruneMemorySnapshots(retention: number): string[] {
  const snapshotsDir = getMemorySnapshotsDir()
  for (const entry of fs.readdirSync(snapshotsDir)) {
    if (entry.endsWith(PARTIAL_SUFFIX)) {
      fs.rmSync(path.join(snapshotsDir, entry), { recursive: true, force: true })
    }
  }
  const snapshots = listMemorySnapshots()
  const expired = snapshots.slice(0, Math.max(0, snapshots.length - retention))
  for (const name of expired) {
    fs.rmSync(path.join(snapshotsDir, name), { recursive: true, force: true })
  }
  return expired
}

/**
 * Copies MEMORY.md, the profiles in memory/users/, the wiki and any extra files
 * into <DATA_DIR>/memory-snapshots/<timestamp>/, mirroring their paths relative
 * to the data dir so a snapshot can be restored by copying it back.
 *
 * Throws when the snapshot cannot be written; callers that are about to rewrite
 * memory must treat that as fatal.
 */
export function createMemorySnapshot(options: MemorySnapshotOptions): MemorySnapshotResult {
  if (!Number.isInteger(options.retention) || options.retention < 1) {
    throw new Error(`Memory snapshot retention must be a positive integer, got ${options.retention}`)
  }

  const memoryDir = path.join(dataDir(), 'memory')
  const sources = [
    path.join(memoryDir, 'MEMORY.md'),
    path.join(memoryDir, 'users'),
    path.join(memoryDir, 'wiki'),
    ...(options.extraFiles ?? []),
  ]

  const existingSources = sources
    .map(source => ({ source, relative: relativeToDataDir(source) }))
    .filter(({ source }) => fs.existsSync(source))

  const snapshotsDir = getMemorySnapshotsDir()
  fs.mkdirSync(snapshotsDir, { recursive: true })
  const finalDir = reserveSnapshotDir(snapshotsDir, options.now ?? new Date())
  // Written under a temporary name and renamed at the end, so a crash mid-copy
  // never leaves a half-written directory that looks like a valid snapshot.
  const partialDir = finalDir + PARTIAL_SUFFIX
  fs.mkdirSync(partialDir)

  try {
    for (const { source, relative } of existingSources) {
      const target = path.join(partialDir, relative)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.cpSync(source, target, { recursive: true, verbatimSymlinks: true, errorOnExist: true })
    }
    fs.renameSync(partialDir, finalDir)
  } catch (err) {
    fs.rmSync(partialDir, { recursive: true, force: true })
    throw err
  }

  const files = countFiles(finalDir)
  // The new snapshot is already complete, so a pruning failure must not abort
  // the consolidation; it is returned so the caller reports it instead.
  try {
    return { dir: finalDir, files, pruned: pruneMemorySnapshots(options.retention) }
  } catch (err) {
    return { dir: finalDir, files, pruned: [], pruneError: err as Error }
  }
}

