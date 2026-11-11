import fs from 'node:fs'
import path from 'node:path'

export type PathAccess = 'read' | 'write'

/**
 * Each entry covers the path itself and everything below it. Deny lists win
 * over allow lists; `write` implies `read`.
 */
export interface PathPolicy {
  read: string[]
  write: string[]
  /** Neither readable nor writable. */
  deny: string[]
  /** Readable when covered by `read`, never writable. */
  denyWrite: string[]
}

export type PathCheckResult =
  | { allowed: true; path: string }
  | { allowed: false; reason: string }

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function pathEntryExists(target: string): boolean {
  try {
    fs.lstatSync(target)
    return true
  } catch (err) {
    if (isMissing(err)) return false
    throw err
  }
}

function realPathOfExisting(target: string): string {
  try {
    return fs.realpathSync(target)
  } catch (err) {
    if (isMissing(err)) throw new Error(`${target} is a symlink to a missing target`)
    throw err
  }
}

/**
 * Resolves `..` and every symlink on the way, including for paths that do not
 * exist yet: the deepest existing ancestor is resolved and the missing tail is
 * appended. A dangling symlink is rejected, because writing through it would
 * create its target wherever it points.
 */
function resolveRealPath(target: string): string {
  const missingTail: string[] = []
  let current = path.resolve(target)
  while (!pathEntryExists(current)) {
    const parent = path.dirname(current)
    if (parent === current) return path.join(current, ...missingTail)
    missingTail.unshift(path.basename(current))
    current = parent
  }
  return path.join(realPathOfExisting(current), ...missingTail)
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function matchesAny(candidate: string, resolvedRoots: string[]): boolean {
  return resolvedRoots.some(root => isWithin(candidate, root))
}

export function checkPathAccess(policy: PathPolicy, requestedPath: string, access: PathAccess): PathCheckResult {
  if (typeof requestedPath !== 'string' || !path.isAbsolute(requestedPath)) {
    return { allowed: false, reason: `Path must be absolute: ${String(requestedPath)}` }
  }

  let realPath: string
  try {
    realPath = resolveRealPath(requestedPath)
  } catch (err) {
    return { allowed: false, reason: `Cannot resolve ${requestedPath}: ${(err as Error).message}` }
  }

  const allowedRoots = access === 'write' ? policy.write : [...policy.read, ...policy.write]
  const deniedRoots = access === 'write' ? [...policy.deny, ...policy.denyWrite] : policy.deny
  let denied: boolean
  try {
    const resolvedDenied = deniedRoots.map(resolveRealPath)
    const resolvedAllowed = allowedRoots.map(resolveRealPath)
    denied = matchesAny(realPath, resolvedDenied) || !matchesAny(realPath, resolvedAllowed)
  } catch (err) {
    // Fail closed: an unresolvable root compared lexically could let a path slip past a deny root.
    return { allowed: false, reason: `Access denied: cannot resolve the access policy for ${requestedPath}: ${(err as Error).message}` }
  }
  if (denied) {
    const resolvedNote = realPath === requestedPath ? '' : ` (resolves to ${realPath})`
    return {
      allowed: false,
      reason: `Access denied: ${requestedPath}${resolvedNote} is not ${access === 'write' ? 'writable' : 'readable'} in this run. Allowed: ${allowedRoots.join(', ')}`,
    }
  }
  return { allowed: true, path: realPath }
}
