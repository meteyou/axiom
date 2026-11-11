import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemorySnapshot } from './memory-snapshot.js'

let dataDir: string
let previousDataDir: string | undefined

function writeFile(relative: string, content: string): string {
  const file = path.join(dataDir, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf-8')
  return file
}

function snapshotsDir(): string {
  return path.join(dataDir, 'memory-snapshots')
}

function listSnapshotDirs(): string[] {
  return fs.readdirSync(snapshotsDir()).sort()
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-memory-snapshot-'))
  previousDataDir = process.env.DATA_DIR
  process.env.DATA_DIR = dataDir
})

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('createMemorySnapshot', () => {
  it('copies MEMORY.md, profiles, wiki and extra files, mirroring the data dir layout', () => {
    writeFile('memory/MEMORY.md', '# Memory\n')
    writeFile('memory/users/admin.md', 'admin profile')
    writeFile('memory/wiki/index.md', 'wiki index')
    writeFile('memory/wiki/topic/page.md', 'nested page')
    const aliceProfile = writeFile('users/alice/PROFILE.md', 'alice profile')
    writeFile('memory/daily/2026-11-07.md', 'daily note')
    writeFile('memory/SOUL.md', 'soul')

    const result = createMemorySnapshot({
      retention: 7,
      extraFiles: [aliceProfile],
      now: new Date('2026-11-07T03:00:00.000Z'),
    })

    expect(result.dir).toBe(path.join(snapshotsDir(), '2026-11-07T03-00-00-000Z'))
    expect(result.files).toBe(5)
    expect(fs.readFileSync(path.join(result.dir, 'memory/MEMORY.md'), 'utf-8')).toBe('# Memory\n')
    expect(fs.readFileSync(path.join(result.dir, 'memory/users/admin.md'), 'utf-8')).toBe('admin profile')
    expect(fs.readFileSync(path.join(result.dir, 'memory/wiki/topic/page.md'), 'utf-8')).toBe('nested page')
    expect(fs.readFileSync(path.join(result.dir, 'users/alice/PROFILE.md'), 'utf-8')).toBe('alice profile')
    expect(fs.existsSync(path.join(result.dir, 'memory/daily'))).toBe(false)
    expect(fs.existsSync(path.join(result.dir, 'memory/SOUL.md'))).toBe(false)
  })

  it('succeeds with an empty snapshot when no memory files exist yet', () => {
    const result = createMemorySnapshot({ retention: 3 })

    expect(fs.existsSync(result.dir)).toBe(true)
    expect(result.files).toBe(0)
  })

  it('keeps only the newest snapshots up to the retention limit', () => {
    writeFile('memory/MEMORY.md', 'v1')
    const times = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04']
    const results = times.map(day => createMemorySnapshot({ retention: 2, now: new Date(`${day}T03:00:00.000Z`) }))

    expect(listSnapshotDirs()).toEqual(['2026-11-03T03-00-00-000Z', '2026-11-04T03-00-00-000Z'])
    expect(results[3].pruned).toEqual(['2026-11-02T03-00-00-000Z'])
  })

  it('does not overwrite a snapshot taken at the same instant', () => {
    writeFile('memory/MEMORY.md', 'first')
    const now = new Date('2026-11-07T03:00:00.000Z')
    const first = createMemorySnapshot({ retention: 5, now })
    writeFile('memory/MEMORY.md', 'second')
    const second = createMemorySnapshot({ retention: 5, now })

    expect(second.dir).not.toBe(first.dir)
    expect(fs.readFileSync(path.join(first.dir, 'memory/MEMORY.md'), 'utf-8')).toBe('first')
    expect(fs.readFileSync(path.join(second.dir, 'memory/MEMORY.md'), 'utf-8')).toBe('second')
  })

  it('ignores unrelated directories when pruning and removes leftover partial snapshots', () => {
    fs.mkdirSync(path.join(snapshotsDir(), 'keep-me'), { recursive: true })
    fs.mkdirSync(path.join(snapshotsDir(), '2026-10-01T03-00-00-000Z.partial'), { recursive: true })

    createMemorySnapshot({ retention: 1, now: new Date('2026-11-07T03:00:00.000Z') })

    expect(listSnapshotDirs()).toEqual(['2026-11-07T03-00-00-000Z', 'keep-me'])
  })

  it('rejects paths outside the data dir whether or not they exist, without creating a snapshot', () => {
    writeFile('memory/MEMORY.md', 'content')
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-outside-'))
    const outsideFile = path.join(outsideDir, 'PROFILE.md')
    fs.writeFileSync(outsideFile, 'outside')

    try {
      for (const extra of [outsideFile, path.join(outsideDir, 'missing.md')]) {
        expect(() => createMemorySnapshot({ retention: 7, extraFiles: [extra] }))
          .toThrow(/outside the data directory/)
      }
      expect(fs.existsSync(snapshotsDir()) ? listSnapshotDirs() : []).toEqual([])
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it.skipIf(process.getuid?.() === 0)('returns the pruning error instead of throwing once the snapshot is written', () => {
    const stuck = path.join(snapshotsDir(), '2026-10-01T03-00-00-000Z', 'locked')
    fs.mkdirSync(stuck, { recursive: true })
    fs.writeFileSync(path.join(stuck, 'file'), 'x')
    fs.chmodSync(stuck, 0o555)

    try {
      const result = createMemorySnapshot({ retention: 1, now: new Date('2026-11-07T03:00:00.000Z') })

      expect(result.pruneError).toBeInstanceOf(Error)
      expect(result.pruned).toEqual([])
      expect(fs.existsSync(result.dir)).toBe(true)
    } finally {
      fs.chmodSync(stuck, 0o755)
    }
  })

  it('throws when the snapshot directory cannot be created', () => {
    fs.writeFileSync(snapshotsDir(), 'not a directory')

    expect(() => createMemorySnapshot({ retention: 7 })).toThrow()
  })

  it('rejects a retention below one', () => {
    expect(() => createMemorySnapshot({ retention: 0 })).toThrow(/retention/)
  })
})
