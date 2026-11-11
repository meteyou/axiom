import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkPathAccess } from './memory-path-guard.js'
import type { PathPolicy } from './memory-path-guard.js'

let root: string
let policy: PathPolicy

function file(relative: string, content = ''): string {
  const target = path.join(root, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content, 'utf-8')
  return target
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-path-guard-')))
  file('memory/MEMORY.md')
  file('memory/wiki/index.md')
  file('memory/sources/a.md')
  file('config/AGENTS.md')
  policy = {
    read: [path.join(root, 'memory')],
    write: [path.join(root, 'memory/MEMORY.md'), path.join(root, 'memory/wiki')],
    deny: [path.join(root, 'config')],
    denyWrite: [path.join(root, 'memory/sources')],
  }
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('checkPathAccess', () => {
  it('allows writes to allowlisted files and to new files below allowlisted directories', () => {
    expect(checkPathAccess(policy, path.join(root, 'memory/MEMORY.md'), 'write')).toEqual({ allowed: true, path: path.join(root, 'memory/MEMORY.md') })
    expect(checkPathAccess(policy, path.join(root, 'memory/wiki/new/topic.md'), 'write')).toEqual({ allowed: true, path: path.join(root, 'memory/wiki/new/topic.md') })
  })

  it('denies writes outside the allowlist even when the path is readable', () => {
    expect(checkPathAccess(policy, path.join(root, 'memory/SOUL.md'), 'write').allowed).toBe(false)
    expect(checkPathAccess(policy, path.join(root, 'memory/SOUL.md'), 'read').allowed).toBe(true)
    expect(checkPathAccess(policy, path.join(root, 'memory/MEMORY.md.bak'), 'write').allowed).toBe(false)
  })

  it('lets denyWrite block writes but not reads', () => {
    policy.write.push(path.join(root, 'memory'))

    expect(checkPathAccess(policy, path.join(root, 'memory/sources/a.md'), 'write').allowed).toBe(false)
    expect(checkPathAccess(policy, path.join(root, 'memory/sources/a.md'), 'read').allowed).toBe(true)
  })

  it('lets deny win over an allowlisted parent', () => {
    policy.read.push(root)

    expect(checkPathAccess(policy, path.join(root, 'config/AGENTS.md'), 'read').allowed).toBe(false)
  })

  it('normalizes .. before checking', () => {
    const traversal = `${path.join(root, 'memory/wiki')}/../../config/AGENTS.md`
    const result = checkPathAccess(policy, traversal, 'write')

    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toContain(path.join(root, 'config/AGENTS.md'))
    expect(checkPathAccess(policy, `${path.join(root, 'memory/wiki')}/../MEMORY.md`, 'write').allowed).toBe(true)
  })

  it('rejects relative paths', () => {
    expect(checkPathAccess(policy, 'memory/MEMORY.md', 'read')).toEqual({ allowed: false, reason: 'Path must be absolute: memory/MEMORY.md' })
  })

  it('rejects a symlinked directory inside an allowed root that points outside', () => {
    fs.symlinkSync(path.join(root, 'config'), path.join(root, 'memory/wiki/escape'))

    expect(checkPathAccess(policy, path.join(root, 'memory/wiki/escape/AGENTS.md'), 'write').allowed).toBe(false)
    expect(checkPathAccess(policy, path.join(root, 'memory/wiki/escape/new.md'), 'write').allowed).toBe(false)
    expect(checkPathAccess(policy, path.join(root, 'memory/wiki/escape/AGENTS.md'), 'read').allowed).toBe(false)
  })

  it('rejects a symlinked file that points outside', () => {
    const outside = file('elsewhere/secret.txt', 'secret')
    fs.symlinkSync(outside, path.join(root, 'memory/wiki/secret.md'))

    expect(checkPathAccess(policy, path.join(root, 'memory/wiki/secret.md'), 'read').allowed).toBe(false)
  })

  it('rejects a dangling symlink, whose target would be created on write', () => {
    fs.symlinkSync(path.join(root, 'elsewhere/not-yet.md'), path.join(root, 'memory/wiki/dangling.md'))

    const result = checkPathAccess(policy, path.join(root, 'memory/wiki/dangling.md'), 'write')

    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toContain('symlink to a missing target')
  })

  it('accepts a symlink that stays inside an allowed root and returns the real path', () => {
    fs.symlinkSync(path.join(root, 'memory/wiki/index.md'), path.join(root, 'memory/wiki/alias.md'))

    expect(checkPathAccess(policy, path.join(root, 'memory/wiki/alias.md'), 'write')).toEqual({ allowed: true, path: path.join(root, 'memory/wiki/index.md') })
  })

  it('does not treat a sibling with a common prefix as inside the root', () => {
    file('memory/wiki-private/notes.md')

    expect(checkPathAccess(policy, path.join(root, 'memory/wiki-private/notes.md'), 'write').allowed).toBe(false)
  })
})
