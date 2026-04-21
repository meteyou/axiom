import http from 'node:http'
import { createApp } from '../app.js'
import { setupWebSocketChat } from '../ws-chat.js'
import { setupWebSocketLogs } from '../ws-logs.js'
import { setupWebSocketTask } from '../ws-task.js'
import type { RuntimeComposition } from './runtime-composition.js'

export interface HttpBoundaryOptions {
  host: string
  port: number
  logger?: Pick<typeof console, 'log'>
}

export interface StartedHttpBoundary {
  server: http.Server
  host: string
  port: number
  stopHttp: () => Promise<void>
}

export async function startHttpBoundary(
  runtimeComposition: RuntimeComposition,
  options: HttpBoundaryOptions,
): Promise<StartedHttpBoundary> {
  const logger = options.logger ?? console

  const app = createApp({
    db: runtimeComposition.db,
    getAgentCore: runtimeComposition.getAgentCore,
    healthMonitorService: runtimeComposition.healthMonitorService,
    runtimeMetrics: runtimeComposition.runtimeMetrics,
    consolidationScheduler: runtimeComposition.consolidationScheduler,
    agentHeartbeatService: runtimeComposition.agentHeartbeatService,
    onAgentHeartbeatSettingsChanged: () => {},
    getTaskRuntime: runtimeComposition.getTaskRuntime,
    getTelegramBot: runtimeComposition.getTelegramBot,
    onTelegramSettingsChanged: runtimeComposition.onTelegramSettingsChanged,
    onActiveProviderChanged: runtimeComposition.onActiveProviderChanged,
    taskEventBus: runtimeComposition.taskEventBus,
  })

  const server = http.createServer(app)

  const wsChat = setupWebSocketChat(
    server,
    runtimeComposition.db,
    runtimeComposition.getAgentCore,
    runtimeComposition.runtimeMetrics,
    runtimeComposition.chatEventBus,
  )
  runtimeComposition.setWebSocketChatPresenceChecker(wsChat)

  setupWebSocketTask({
    server,
    db: runtimeComposition.db,
    taskEventBus: runtimeComposition.taskEventBus,
  })

  const { wss: _logsWss, broadcast: broadcastLog } = setupWebSocketLogs(server)
  void broadcastLog

  await new Promise<void>((resolve) => {
    server.listen(options.port, options.host, resolve)
  })

  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : options.port

  logger.log(`[openagent] Server running at http://${options.host}:${actualPort}`)
  logger.log(`[openagent] Health check: http://${options.host}:${actualPort}/health`)
  logger.log(`[openagent] WebSocket chat: ws://${options.host}:${actualPort}/ws/chat`)
  logger.log(`[openagent] WebSocket logs: ws://${options.host}:${actualPort}/ws/logs`)
  logger.log(`[openagent] WebSocket task viewer: ws://${options.host}:${actualPort}/ws/task/:id`)

  return {
    server,
    host: options.host,
    port: actualPort,
    stopHttp: async () => {
      runtimeComposition.setWebSocketChatPresenceChecker(null)
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err)
            return
          }
          resolve()
        })
      })
    },
  }
}
