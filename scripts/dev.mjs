import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import process from 'node:process'

const rootDir = process.cwd()

for (const file of ['.env', '.env.local']) {
  const filePath = path.join(rootDir, file)
  if (fs.existsSync(filePath)) {
    process.loadEnvFile(filePath)
  }
}

const resolvedDataDir = path.resolve(rootDir, process.env.DATA_DIR || '.data')
process.env.DATA_DIR = resolvedDataDir
process.env.PORT ||= '3000'
process.env.HOST ||= '0.0.0.0'
process.env.NUXT_PUBLIC_API_BASE ||= 'http://localhost:3000'
process.env.ADMIN_USERNAME ||= 'admin'
process.env.ADMIN_PASSWORD ||= 'admin'
process.env.JWT_SECRET ||= 'openagent-dev-secret-change-me'

fs.mkdirSync(resolvedDataDir, { recursive: true })

console.log('[openagent] Starting local dev environment...')
console.log(`[openagent] DATA_DIR=${process.env.DATA_DIR}`)
console.log(`[openagent] Backend:  http://localhost:${process.env.PORT}`)
console.log('[openagent] Frontend: http://localhost:3001')
console.log('[openagent] Core:     watching for changes (tsc --watch)')

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const spawnOpts = {
  cwd: rootDir,
  env: process.env,
  stdio: 'inherit',
  detached: true,
}

const backendSrc = path.join(rootDir, 'packages', 'web-backend', 'src')
const coreDist = path.join(rootDir, 'packages', 'core', 'dist')

const children = [
  // 1. Core: tsc --watch recompiles on source changes → outputs to dist/
  spawn(npmCmd, ['run', 'dev', '--workspace=packages/core'], spawnOpts),
  // 2. Backend: --watch restarts when backend src/ or core dist/ changes
  spawn('node', [
    '--watch',
    `--watch-path=${backendSrc}`,
    `--watch-path=${coreDist}`,
    '--import', 'tsx',
    path.join(backendSrc, 'server.ts'),
  ], spawnOpts),
  // 3. Frontend: Nuxt dev server with HMR
  spawn(npmCmd, ['run', 'dev:frontend'], spawnOpts),
]

let shuttingDown = false
let exitCode = 0

function shutdown(signal = 'SIGTERM') {
  if (shuttingDown) return
  shuttingDown = true

  for (const child of children) {
    try { process.kill(-child.pid, signal) } catch {}
  }

  setTimeout(() => {
    for (const child of children) {
      try { process.kill(-child.pid, 'SIGKILL') } catch {}
    }
  }, 3000).unref()
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(signal))
}

let exitedChildren = 0
for (const child of children) {
  child.on('exit', (code, signal) => {
    exitedChildren += 1

    if (signal || (code && code !== 0)) {
      exitCode = code ?? 1
    }

    if (!shuttingDown && exitedChildren < children.length) {
      shutdown('SIGTERM')
    }

    if (exitedChildren === children.length) {
      process.exit(exitCode)
    }
  })
}
