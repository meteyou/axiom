import fs from 'node:fs'
import path from 'node:path'

/**
 * Get the workspace directory for agent file operations.
 * Falls back to DATA_DIR/workspace, then /workspace (Docker default).
 */
export function getWorkspaceDir(): string {
  if (process.env.WORKSPACE_DIR) return process.env.WORKSPACE_DIR
  if (process.env.DATA_DIR) {
    const wsDir = path.join(process.env.DATA_DIR, 'workspace')
    if (!fs.existsSync(wsDir)) fs.mkdirSync(wsDir, { recursive: true })
    return wsDir
  }
  return '/workspace'
}

/** Resolve a tool path relative to the workspace directory. */
export function resolveWorkspacePath(filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath
  return path.resolve(getWorkspaceDir(), filePath)
}
