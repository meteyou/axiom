import { describe, it, expect } from 'vitest'
import { createApp } from './app.js'
import http from 'node:http'

describe('health endpoint', () => {
  it('GET /health returns status ok with uptime', async () => {
    const app = createApp()

    // Create a temporary server
    const server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, resolve))

    const address = server.address() as { port: number }
    const response = await fetch(`http://localhost:${address.port}/health`)
    const body = await response.json() as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(body.status).toBe('ok')
    expect(typeof body.uptime).toBe('number')
    expect(typeof body.version).toBe('string')
    expect(typeof body.timestamp).toBe('string')

    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
  })
})
