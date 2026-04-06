import type { Express } from 'express'

export interface OpenAgentPlugin {
  name: string
  version: string
  register(app: Express): void | Promise<void>
}
