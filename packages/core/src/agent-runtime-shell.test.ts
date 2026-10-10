import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { createYoloTools } from './agent-runtime.js'

function getShellTool(): AgentTool {
  const tool = createYoloTools().find(t => t.name === 'shell')
  if (!tool) throw new Error('shell tool missing from createYoloTools')
  return tool
}

function textOf(result: AgentToolResult<unknown>): string {
  return (result.content ?? [])
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text)
    .join('\n')
}

describe('shell tool structured output', () => {
  let workspace: string
  let previousWorkspace: string | undefined

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-shell-'))
    previousWorkspace = process.env.WORKSPACE_DIR
    process.env.WORKSPACE_DIR = workspace
  })

  afterEach(() => {
    if (previousWorkspace === undefined) delete process.env.WORKSPACE_DIR
    else process.env.WORKSPACE_DIR = previousWorkspace
    fs.rmSync(workspace, { recursive: true, force: true })
  })

  function run(command: string, timeout?: number, signal?: AbortSignal) {
    return getShellTool().execute('call-1', { command, timeout }, signal) as Promise<AgentToolResult<unknown>>
  }

  it('declares an output schema for { output, exit_code }', () => {
    const tool = getShellTool()
    expect(tool.outputSchema).toBeTruthy()
    const schema = tool.outputSchema as { properties?: Record<string, unknown> }
    expect(Object.keys(schema.properties ?? {})).toEqual(['output', 'exit_code'])
  })

  it('sets structured content on success and keeps the model-facing text', async () => {
    const result = await run('echo hello')
    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toBe('hello\n')
    expect(result.structuredContent).toEqual({ output: 'hello\n', exit_code: 0 })
  })

  it('sets structured content when the command produces no output', async () => {
    const result = await run('true')
    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toBe('(no output)')
    expect(result.structuredContent).toEqual({ output: '(no output)', exit_code: 0 })
  })

  it('sets structured content on a non-zero exit without flagging the result as failed', async () => {
    const result = await run('echo out; echo err 1>&2; exit 7')
    expect(result.isError).toBeFalsy()
    expect(result.details).not.toHaveProperty('error')
    expect(textOf(result)).toBe('out\n\nerr\n')
    expect(result.structuredContent).toEqual({ output: 'out\n\nerr\n', exit_code: 7 })
  })

  it('sets structured content when a failing command prints nothing', async () => {
    const result = await run('exit 3')
    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toBe('Command failed')
    expect(result.structuredContent).toEqual({ output: 'Command failed', exit_code: 3 })
  })

  it('sets structured content on timeout', async () => {
    const result = await run('sleep 5', 100)
    expect(textOf(result)).toContain('timed out after 100ms')
    expect(result.structuredContent).toEqual({ output: textOf(result), exit_code: 1 })
  }, 15000)

  it('sets structured content on abort', async () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 50)
    const result = await run('sleep 5', 30000, ac.signal)
    expect(textOf(result)).toContain('Command aborted')
    expect(result.structuredContent).toEqual({ output: textOf(result), exit_code: 1 })
  }, 15000)

  it('sets structured content when the output limit is hit', async () => {
    const result = await run("head -c 11000000 /dev/zero | tr '\\0' a")
    const text = textOf(result)
    expect(text).toContain('Command output exceeded 10485760 bytes')
    expect(result.structuredContent).toEqual({ output: text, exit_code: 1 })
  }, 30000)
})
