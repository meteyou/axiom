import { describe, it, expect } from 'vitest'
import { Type } from 'typebox'
import { AGENT_RUN_PARAMETERS, defineActionTool } from './action-tool.js'
import { createScheduleReadTool, createScheduleWriteTool } from './schedule-tools.js'
import type { TaskRuntimeScheduleBoundary } from './task-runtime.js'

interface DemoParams extends Record<string, unknown> {
  id?: string
  name?: string
}

function demoTool() {
  const calls: Array<[string, DemoParams]> = []
  const tool = defineActionTool<DemoParams, 'list' | 'create'>({
    name: 'demo_write',
    label: 'Demo',
    description: 'Demo tool.',
    parameters: {
      id: Type.String({ description: 'Identifier.' }),
      name: Type.String({ description: 'Name.' }),
    },
    actions: {
      list: {
        description: 'list things.',
        replay: 'safe',
        execute: async params => {
          calls.push(['list', params])
          return { content: [{ type: 'text', text: 'listed' }], details: {} }
        },
      },
      create: {
        description: 'create a thing.',
        required: ['id', 'name'],
        replay: 'unsafe',
        execute: async params => {
          calls.push(['create', params])
          return { content: [{ type: 'text', text: 'created' }], details: {} }
        },
      },
    },
  })
  return { tool, calls }
}

function text(result: { content: unknown[] }): string {
  return (result.content[0] as { text: string }).text
}

function containsCombinator(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return false
  return Object.entries(schema).some(([key, value]) =>
    key === 'oneOf' || key === 'anyOf' || key === 'allOf' || containsCombinator(value))
}

describe('defineActionTool', () => {
  it('produces a flat schema with a required action enum and optional fields', () => {
    const { tool } = demoTool()
    const schema = JSON.parse(JSON.stringify(tool.parameters)) as {
      type: string
      properties: Record<string, { type: string; enum?: string[]; description?: string }>
      required?: string[]
    }
    expect(schema.type).toBe('object')
    expect(schema.properties.action).toMatchObject({ type: 'string', enum: ['list', 'create'] })
    expect(schema.properties.action!.description).toContain('"create": create a thing. Requires: id, name.')
    expect(schema.required).toEqual(['action'])
    expect(Object.keys(schema.properties)).toEqual(['action', 'id', 'name'])
    expect(containsCombinator(schema)).toBe(false)
  })

  it('runs the action with all parameters when its required fields are present', async () => {
    const { tool, calls } = demoTool()
    expect(text(await tool.execute('c1', { action: 'create', id: '1', name: 'x' }))).toBe('created')
    expect(text(await tool.execute('c2', { action: 'list' }))).toBe('listed')
    expect(calls).toEqual([['create', { action: 'create', id: '1', name: 'x' }], ['list', { action: 'list' }]])
  })

  it('names every missing field of the action', async () => {
    const { tool, calls } = demoTool()
    const one = await tool.execute('c1', { action: 'create', id: '1' })
    expect(text(one)).toBe('Error: name is required for action=create.')
    expect(one.details).toEqual({ error: true })
    expect(text(await tool.execute('c2', { action: 'create', name: '  ' }))).toBe('Error: id, name are required for action=create.')
    expect(calls).toEqual([])
  })

  it('rejects unknown and missing actions', async () => {
    const { tool, calls } = demoTool()
    expect(text(await tool.execute('c1', { action: 'delete' }))).toBe('Error: Unknown action "delete" for demo_write. Valid actions: list, create.')
    expect(text(await tool.execute('c2', {}))).toBe('Error: action is required for demo_write. Valid actions: list, create.')
    expect(text(await tool.execute('c3', { action: 'constructor' }))).toContain('Unknown action "constructor"')
    expect(calls).toEqual([])
  })

  it('exposes the replay policy per action', () => {
    const { tool } = demoTool()
    expect(tool.actions).toEqual(['list', 'create'])
    expect(tool.actionReplayPolicies).toEqual({ list: 'safe', create: 'unsafe' })
  })
})

describe('grouped schedule tools', () => {
  const boundary = {} as TaskRuntimeScheduleBoundary

  it('have flat schemas without combinators', () => {
    for (const tool of [createScheduleReadTool({ taskRuntime: boundary }), createScheduleWriteTool({ taskRuntime: boundary })]) {
      expect(containsCombinator(JSON.parse(JSON.stringify(tool.parameters))), tool.name).toBe(false)
    }
  })

  it('reuse the shared agent-run parameter definitions', () => {
    const properties = (createScheduleWriteTool({ taskRuntime: boundary }).parameters as { properties: Record<string, unknown> }).properties
    for (const [key, schema] of Object.entries(AGENT_RUN_PARAMETERS)) {
      expect(properties[key]).toEqual(schema)
    }
  })
})
