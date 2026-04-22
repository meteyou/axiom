import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
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
process.env.JWT_SECRET ||= 'axiom-dev-secret-change-me'

fs.mkdirSync(resolvedDataDir, { recursive: true })

console.log('[axiom] Starting local dev environment...')
console.log(`[axiom] DATA_DIR=${process.env.DATA_DIR}`)
console.log(`[axiom] Backend:  http://localhost:${process.env.PORT}`)
console.log('[axiom] Frontend: http://localhost:3001')

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const baseOpts = {
  cwd: rootDir,
  env: process.env,
  stdio: 'inherit',
}

const backendSrc = path.join(rootDir, 'packages', 'web-backend', 'src')
const coreDist = path.join(rootDir, 'packages', 'core', 'dist')
const telegramDist = path.join(rootDir, 'packages', 'telegram', 'dist')

// Ensure dist directories exist before anything tries to watch them.
// node --watch --watch-path=<dir> crashes with ENOENT if the directory is missing
// (e.g. after `npm run clean` or a fresh checkout).
fs.mkdirSync(coreDist, { recursive: true })
fs.mkdirSync(telegramDist, { recursive: true })

// Initial build of core + telegram so the backend has something to import on first start.
// Subsequent changes are handled by tsc --watch below.
const distHasJs = (dir) => {
  try {
    return fs.readdirSync(dir).some((f) => f.endsWith('.js'))
  } catch {
    return false
  }
}

for (const pkg of ['packages/core', 'packages/telegram']) {
  const pkgDist = path.join(rootDir, pkg, 'dist')
  if (distHasJs(pkgDist)) continue
  console.log(`[axiom] Initial build: ${pkg}`)
  const res = spawnSync(npmCmd, ['run', 'build', `--workspace=${pkg}`], {
    cwd: rootDir,
    env: process.env,
    stdio: 'inherit',
  })
  if (res.status !== 0) {
    console.error(`[axiom] Initial build failed for ${pkg}`)
    process.exit(res.status ?? 1)
  }
}

console.log('[axiom] Core:     watching for changes (tsc --watch)')

const children = [
  // 1. Core: tsc --watch recompiles on source changes → outputs to dist/
  spawn(npmCmd, ['run', 'dev', '--workspace=packages/core'], { ...baseOpts, detached: true }),
  // 1b. Telegram: tsc --watch recompiles on source changes → outputs to dist/
  spawn(npmCmd, ['run', 'dev', '--workspace=packages/telegram'], { ...baseOpts, detached: true }),
  // 2. Backend: --watch restarts when backend src/ or core/telegram dist/ changes
  //    Not detached — node --watch manages its own child; we just need to kill this tree.
  spawn('node', [
    '--watch',
    `--watch-path=${backendSrc}`,
    `--watch-path=${coreDist}`,
    `--watch-path=${telegramDist}`,
    '--import', 'tsx',
    path.join(backendSrc, 'server.ts'),
  ], { ...baseOpts, detached: true }),
  // 3. Frontend: Nuxt dev server with HMR
  spawn(npmCmd, ['run', 'dev:frontend'], { ...baseOpts, detached: true }),
]

let shuttingDown = false
let exitCode = 0

function shutdown(signal = 'SIGTERM') {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n[axiom] Shutting down dev environment...`)

  // Send signal to each process group
  for (const child of children) {
    try { process.kill(-child.pid, signal) } catch {}
  }

  // Force kill after timeout
  const forceTimer = setTimeout(() => {
    for (const child of children) {
      try { process.kill(-child.pid, 'SIGKILL') } catch {}
    }
    // Final fallback: exit ourselves
    setTimeout(() => process.exit(exitCode), 500).unref()
  }, 4000)
  forceTimer.unref()
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
