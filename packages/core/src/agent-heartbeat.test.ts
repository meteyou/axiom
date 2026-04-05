import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHeartbeatService, DEFAULT_AGENT_HEARTBEAT_SETTINGS } from './agent-heartbeat.js'
import type { AgentHeartbeatSettings, AgentHeartbeatServiceOptions } from './agent-heartbeat.js'
import type { TaskStore } from './task-store.js'
import type { TaskRunner } from './task-runner.js'
import type { ProviderConfig } from './provider-config.js'

const mockProvider: ProviderConfig = {
  id: 'test-provider',
  name: 'Test Provider',
  type: 'openai-completions',
  providerType: 'openai',
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  defaultModel: 'gpt-4o',
  status: 'connected',
}

function createMocks() {
  const mockTaskStore = {
    create: vi.fn().mockImplementation((input) => ({
      id: 'task-123',
      ...input,
      status: 'running',
      promptTokens: 0,
      completionTokens: 0,
      estimatedCost: 0,
      toolCallCount: 0,
      resultSummary: null,
      resultStatus: null,
      errorMessage: null,
      createdAt: '2024-01-01 00:00:00',
      startedAt: null,
      completedAt: null,
    })),
  } as unknown as TaskStore

  const mockTaskRunner = {
    startTask: vi.fn().mockResolvedValue('task-123'),
  } as unknown as TaskRunner

  return { mockTaskStore, mockTaskRunner }
}

describe('AgentHeartbeatService', () => {
  let service: AgentHeartbeatService
  let mocks: ReturnType<typeof createMocks>

  beforeEach(() => {
    vi.useFakeTimers()
    mocks = createMocks()
  })

  afterEach(() => {
    service?.stop()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function createService(overrides: Partial<AgentHeartbeatServiceOptions> = {}) {
    return new AgentHeartbeatService({
      taskStore: mocks.mockTaskStore,
      taskRunner: mocks.mockTaskRunner,
      getDefaultProvider: () => mockProvider,
      now: () => new Date('2024-06-15T12:00:00Z'),
      getTimezone: () => 'UTC',
      ...overrides,
    })
  }

  describe('isNightMode', () => {
    it('returns false when night mode is disabled', () => {
      service = createService()
      const settings: AgentHeartbeatSettings = {
        ...DEFAULT_AGENT_HEARTBEAT_SETTINGS,
        nightMode: { enabled: false, startHour: 23, endHour: 8 },
      }
      expect(service.isNightMode(new Date('2024-06-15T02:00:00Z'), 'UTC', settings)).toBe(false)
    })

    it('detects night mode with midnight-crossing (23→8)', () => {
      service = createService()
      const settings: AgentHeartbeatSettings = {
        ...DEFAULT_AGENT_HEARTBEAT_SETTINGS,
        nightMode: { enabled: true, startHour: 23, endHour: 8 },
      }

      // 23:00 — night
      expect(service.isNightMode(new Date('2024-06-15T23:00:00Z'), 'UTC', settings)).toBe(true)
      // 23:30 — night
      expect(service.isNightMode(new Date('2024-06-15T23:30:00Z'), 'UTC', settings)).toBe(true)
      // 00:00 — night
      expect(service.isNightMode(new Date('2024-06-16T00:00:00Z'), 'UTC', settings)).toBe(true)
      // 03:00 — night
      expect(service.isNightMode(new Date('2024-06-15T03:00:00Z'), 'UTC', settings)).toBe(true)
      // 07:59 — night
      expect(service.isNightMode(new Date('2024-06-15T07:59:00Z'), 'UTC', settings)).toBe(true)
      // 08:00 — NOT night (endHour is exclusive)
      expect(service.isNightMode(new Date('2024-06-15T08:00:00Z'), 'UTC', settings)).toBe(false)
      // 12:00 — NOT night
      expect(service.isNightMode(new Date('2024-06-15T12:00:00Z'), 'UTC', settings)).toBe(false)
      // 22:00 — NOT night
      expect(service.isNightMode(new Date('2024-06-15T22:00:00Z'), 'UTC', settings)).toBe(false)
    })

    it('detects night mode without midnight-crossing (8→17)', () => {
      service = createService()
      const settings: AgentHeartbeatSettings = {
        ...DEFAULT_AGENT_HEARTBEAT_SETTINGS,
        nightMode: { enabled: true, startHour: 8, endHour: 17 },
      }

      // 08:00 — night
      expect(service.isNightMode(new Date('2024-06-15T08:00:00Z'), 'UTC', settings)).toBe(true)
      // 12:00 — night
      expect(service.isNightMode(new Date('2024-06-15T12:00:00Z'), 'UTC', settings)).toBe(true)
      // 16:59 — night
      expect(service.isNightMode(new Date('2024-06-15T16:59:00Z'), 'UTC', settings)).toBe(true)
      // 17:00 — NOT night (endHour is exclusive)
      expect(service.isNightMode(new Date('2024-06-15T17:00:00Z'), 'UTC', settings)).toBe(false)
      // 07:00 — NOT night
      expect(service.isNightMode(new Date('2024-06-15T07:00:00Z'), 'UTC', settings)).toBe(false)
      // 23:00 — NOT night
      expect(service.isNightMode(new Date('2024-06-15T23:00:00Z'), 'UTC', settings)).toBe(false)
    })

    it('handles boundary exact hours', () => {
      service = createService()
      const settings: AgentHeartbeatSettings = {
        ...DEFAULT_AGENT_HEARTBEAT_SETTINGS,
        nightMode: { enabled: true, startHour: 22, endHour: 6 },
      }

      // Exact start hour — is night
      expect(service.isNightMode(new Date('2024-06-15T22:00:00Z'), 'UTC', settings)).toBe(true)
      // Exact end hour — NOT night
      expect(service.isNightMode(new Date('2024-06-15T06:00:00Z'), 'UTC', settings)).toBe(false)
    })

    it('is timezone-aware', () => {
      service = createService()
      const settings: AgentHeartbeatSettings = {
        ...DEFAULT_AGENT_HEARTBEAT_SETTINGS,
        nightMode: { enabled: true, startHour: 23, endHour: 8 },
      }

      // UTC time 15:00 = Berlin time 17:00 in summer (CEST = UTC+2) — NOT night
      expect(service.isNightMode(new Date('2024-06-15T15:00:00Z'), 'Europe/Berlin', settings)).toBe(false)

      // UTC time 22:00 = Berlin time 00:00 in summer (CEST = UTC+2) — night
      expect(service.isNightMode(new Date('2024-06-15T22:00:00Z'), 'Europe/Berlin', settings)).toBe(true)

      // UTC time 05:00 = Berlin time 07:00 in summer (CEST = UTC+2) — night (before 8)
      expect(service.isNightMode(new Date('2024-06-15T05:00:00Z'), 'Europe/Berlin', settings)).toBe(true)

      // UTC time 06:00 = Berlin time 08:00 in summer (CEST = UTC+2) — NOT night (endHour exclusive)
      expect(service.isNightMode(new Date('2024-06-15T06:00:00Z'), 'Europe/Berlin', settings)).toBe(false)
    })
  })

  describe('executeHeartbeat', () => {
    it('creates a background task with the correct prompt', async () => {
      service = createService()

      const taskId = await service.executeHeartbeat()

      expect(taskId).toBe('task-123')
      expect(mocks.mockTaskStore.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Agent Heartbeat',
          prompt: expect.stringContaining('HEARTBEAT.md'),
          triggerType: 'agent',
          triggerSourceId: 'agent-heartbeat',
          provider: 'Test Provider',
          model: 'gpt-4o',
        }),
      )
      expect(mocks.mockTaskRunner.startTask).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'task-123' }),
        mockProvider,
      )
    })

    it('prompt instructs to use task injection', async () => {
      service = createService()

      await service.executeHeartbeat()

      const createCall = (mocks.mockTaskStore.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(createCall.prompt).toContain('task injection')
      expect(createCall.prompt).toContain('read_file')
      expect(createCall.prompt).toContain('write_file')
    })

    it('skips heartbeat during night mode', async () => {
      service = createService({
        now: () => new Date('2024-06-15T02:00:00Z'), // 2 AM UTC — within default night mode 23→8
      })
      // Manually set settings to enabled with night mode
      const settings: AgentHeartbeatSettings = {
        enabled: true,
        intervalMinutes: 60,
        nightMode: { enabled: true, startHour: 23, endHour: 8 },
      }
      // Use isNightMode directly — the service will check internally
      expect(service.isNightMode(new Date('2024-06-15T02:00:00Z'), 'UTC', settings)).toBe(true)

      // Actually test executeHeartbeat skips — need to mock loadConfig
      vi.spyOn(await import('./config.js'), 'loadConfig').mockReturnValue({
        agentHeartbeat: { enabled: true, intervalMinutes: 60, nightMode: { enabled: true, startHour: 23, endHour: 8 } },
        timezone: 'UTC',
      })
      vi.spyOn(await import('./config.js'), 'ensureConfigTemplates').mockImplementation(() => {})

      // Re-create service so it loads the mocked settings
      service.stop()
      service = createService({
        now: () => new Date('2024-06-15T02:00:00Z'),
      })
      service.restart()

      const taskId = await service.executeHeartbeat()
      expect(taskId).toBeNull()
      expect(mocks.mockTaskStore.create).not.toHaveBeenCalled()
    })

    it('does not skip heartbeat when night mode is disabled', async () => {
      vi.spyOn(await import('./config.js'), 'loadConfig').mockReturnValue({
        agentHeartbeat: { enabled: true, intervalMinutes: 60, nightMode: { enabled: false, startHour: 23, endHour: 8 } },
        timezone: 'UTC',
      })
      vi.spyOn(await import('./config.js'), 'ensureConfigTemplates').mockImplementation(() => {})

      service = createService({
        now: () => new Date('2024-06-15T02:00:00Z'), // 2 AM — would be night, but disabled
      })
      service.restart()

      const taskId = await service.executeHeartbeat()
      expect(taskId).toBe('task-123')
      expect(mocks.mockTaskStore.create).toHaveBeenCalled()
    })
  })

  describe('scheduling', () => {
    it('fires at configured interval', async () => {
      vi.spyOn(await import('./config.js'), 'loadConfig').mockReturnValue({
        agentHeartbeat: { enabled: true, intervalMinutes: 30, nightMode: { enabled: false, startHour: 23, endHour: 8 } },
        timezone: 'UTC',
      })
      vi.spyOn(await import('./config.js'), 'ensureConfigTemplates').mockImplementation(() => {})

      service = createService({
        now: () => new Date('2024-06-15T12:00:00Z'),
      })
      service.start()

      // Initially no task created
      expect(mocks.mockTaskStore.create).not.toHaveBeenCalled()

      // Advance 30 minutes
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000)

      expect(mocks.mockTaskStore.create).toHaveBeenCalledTimes(1)
    })

    it('does not start when disabled', async () => {
      vi.spyOn(await import('./config.js'), 'loadConfig').mockReturnValue({
        agentHeartbeat: { enabled: false, intervalMinutes: 30, nightMode: { enabled: false, startHour: 23, endHour: 8 } },
        timezone: 'UTC',
      })
      vi.spyOn(await import('./config.js'), 'ensureConfigTemplates').mockImplementation(() => {})

      service = createService()
      service.start()

      // Advance far past the interval
      await vi.advanceTimersByTimeAsync(120 * 60 * 1000)

      expect(mocks.mockTaskStore.create).not.toHaveBeenCalled()
    })
  })

  describe('settings', () => {
    it('has correct defaults', () => {
      expect(DEFAULT_AGENT_HEARTBEAT_SETTINGS).toEqual({
        enabled: false,
        intervalMinutes: 60,
        nightMode: {
          enabled: true,
          startHour: 23,
          endHour: 8,
        },
      })
    })

    it('reloads settings on restart', async () => {
      const loadConfigSpy = vi.spyOn(await import('./config.js'), 'loadConfig')
      vi.spyOn(await import('./config.js'), 'ensureConfigTemplates').mockImplementation(() => {})

      // First call: disabled
      loadConfigSpy.mockReturnValueOnce({
        agentHeartbeat: { enabled: false, intervalMinutes: 60, nightMode: { enabled: true, startHour: 23, endHour: 8 } },
        timezone: 'UTC',
      })

      service = createService()
      service.start()

      expect(service.getSettings().enabled).toBe(false)

      // Second call: enabled with different interval
      loadConfigSpy.mockReturnValueOnce({
        agentHeartbeat: { enabled: true, intervalMinutes: 15, nightMode: { enabled: false, startHour: 22, endHour: 7 } },
        timezone: 'UTC',
      })

      service.restart()

      const newSettings = service.getSettings()
      expect(newSettings.enabled).toBe(true)
      expect(newSettings.intervalMinutes).toBe(15)
      expect(newSettings.nightMode.enabled).toBe(false)
      expect(newSettings.nightMode.startHour).toBe(22)
      expect(newSettings.nightMode.endHour).toBe(7)
    })
  })
})
