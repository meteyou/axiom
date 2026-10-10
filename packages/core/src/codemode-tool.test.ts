import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Type } from '@earendil-works/pi-ai'
import type { Api, Model } from '@earendil-works/pi-ai'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import {
  CODEMODE_SPILL_DIR,
  createCodemodeTool,
  createNestedCallLogObserver,
  buildCodemodeDescription,
} from './codemode-tool.js'
import type {
  CodemodeToolOwner,
  CodemodeNestedCallStart,
  CodemodeNestedCallEnd,
} from './codemode-tool.js'
import { extractUploadsFromToolResult } from './send-file-tool.js'
import { initDatabase } from './database.js'

function makeModel(): Model<Api> {
  return { api: 'openai-completions', provider: 'test', id: 'test-model' } as unknown as Model<Api>
}

function makeTool(overrides: { name: string } & Partial<AgentTool>): AgentTool {
  return {
    label: overrides.name,
    description: `${overrides.name} tool`,
    parameters: Type.Object({}),
    execute: async (): Promise<AgentToolResult<Record<string, unknown>>> => ({
      content: [{ type: 'text', text: 'ok' }],
      details: {},
    }),
    ...overrides,
  } as AgentTool
}

function makeOwner(tools: AgentTool[], afterToolCall?: CodemodeToolOwner['afterToolCall']): CodemodeToolOwner {
  return {
    getTools: () => tools,
    getMessages: () => [],
    getModel: makeModel,
    afterToolCall,
  }
}

function textOf(result: AgentToolResult<unknown>): string {
  return (result.content ?? [])
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text)
    .join('\n')
}

describe('codemode tool', () => {
  let workspace: string
  let previousWorkspace: string | undefined

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-codemode-'))
    previousWorkspace = process.env.WORKSPACE_DIR
    process.env.WORKSPACE_DIR = workspace
  })

  afterEach(() => {
    if (previousWorkspace === undefined) delete process.env.WORKSPACE_DIR
    else process.env.WORKSPACE_DIR = previousWorkspace
    fs.rmSync(workspace, { recursive: true, force: true })
  })

  function run(tool: AgentTool, code: string, signal?: AbortSignal): Promise<AgentToolResult<Record<string, unknown>>> {
    return tool.execute('parent-1', { code }, signal) as Promise<AgentToolResult<Record<string, unknown>>>
  }

  it('runs nested calls in parallel', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const tool = makeTool({
      name: 'slow',
      execute: async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(r => setTimeout(r, 60))
        inFlight--
        return { content: [{ type: 'text' as const, text: 'done' }], details: {} }
      },
    })
    const codemode = createCodemodeTool({ owner: makeOwner([tool]) })
    const result = await run(codemode, `
      const results = await Promise.all([tools.slow({}), tools.slow({}), tools.slow({})]);
      return results.length;
    `)
    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toContain('3')
    expect(maxInFlight).toBeGreaterThanOrEqual(2)
  })

  it('rejects nested calls that report details.error with the tool text', async () => {
    const tool = makeTool({
      name: 'bad',
      execute: async () => ({ content: [{ type: 'text' as const, text: 'custom failure' }], details: { error: true } }),
    })
    const codemode = createCodemodeTool({ owner: makeOwner([tool]) })
    const result = await run(codemode, `
      try { await tools.bad({}); return 'no-error' } catch (e) { return 'rejected:' + e.message }
    `)
    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toContain('rejected:custom failure')
  })

  it('rejects nested calls that fail with an error outcome', async () => {
    const tool = makeTool({
      name: 'boom',
      execute: async () => { throw new Error('exploded') },
    })
    const codemode = createCodemodeTool({ owner: makeOwner([tool]) })
    const result = await run(codemode, `
      try { await tools.boom({}); return 'no-error' } catch (e) { return 'rejected:' + e.message }
    `)
    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toContain('rejected:exploded')
  })

  it('resolves tools with an output schema to their structured content', async () => {
    const tool = makeTool({
      name: 'calc',
      outputSchema: Type.Object({ value: Type.Number() }),
      execute: async () => ({
        content: [{ type: 'text' as const, text: 'ignored text' }],
        details: {},
        structuredContent: { value: 42 },
      }),
    })
    const codemode = createCodemodeTool({ owner: makeOwner([tool]) })
    const result = await run(codemode, `const r = await tools.calc({}); return r.value;`)
    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toContain('42')
    expect(textOf(result)).not.toContain('ignored text')
  })

  it('resolves a shell tool to { output, exit_code } without rejecting on non-zero exit', async () => {
    const tool = makeTool({
      name: 'shell',
      description: 'Execute a shell command and return stdout/stderr.',
      outputSchema: Type.Object({ output: Type.String(), exit_code: Type.Number() }),
      execute: async () => ({
        content: [{ type: 'text' as const, text: 'boom\nCommand failed' }],
        details: { exitCode: 1 },
        structuredContent: { output: 'boom\nCommand failed', exit_code: 1 },
      }),
    })
    const codemode = createCodemodeTool({ owner: makeOwner([tool]) })
    const result = await run(codemode,
      'const r = await tools.shell({ command: "false" });\n'
      + 'return "exit=" + r.exit_code + "|out=" + r.output;')
    expect(result.isError).toBeFalsy()
    const text = textOf(result)
    expect(text).toContain('exit=1|out=boom')
    expect(text).toContain('Command failed')
    expect(text).not.toContain('Script error')
    expect(text).not.toContain('rejected')
  })

  it('resolves a shell tool to { output, exit_code } on success', async () => {
    const tool = makeTool({
      name: 'shell',
      description: 'Execute a shell command and return stdout/stderr.',
      outputSchema: Type.Object({ output: Type.String(), exit_code: Type.Number() }),
      execute: async () => ({
        content: [{ type: 'text' as const, text: 'ok' }],
        details: { exitCode: 0 },
        structuredContent: { output: 'ok', exit_code: 0 },
      }),
    })
    const codemode = createCodemodeTool({ owner: makeOwner([tool]) })
    const result = await run(codemode, `const r = await tools.shell({ command: 'echo ok' }); return r.exit_code;`)
    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toContain('0')
  })

  it('resolves the real shell tool to { output, exit_code } in a script, including non-zero exit', async () => {
    const { createYoloTools } = await import('./agent-runtime.js')
    const shell = createYoloTools().find(t => t.name === 'shell')
    if (!shell) throw new Error('shell tool missing')
    const codemode = createCodemodeTool({ owner: makeOwner([shell]) })
    const result = await run(codemode,
      'const r = await tools.shell({ command: "echo o; exit 2" });\n'
      + 'return "exit=" + r.exit_code + "|out=" + r.output;')
    expect(result.isError).toBeFalsy()
    const text = textOf(result)
    expect(text).toContain('exit=2|out=o')
    expect(text).not.toContain('Script error')
  })

  it('resolves tools without an output schema to their text output', async () => {
    const tool = makeTool({
      name: 'plain',
      execute: async () => ({ content: [{ type: 'text' as const, text: 'the text' }], details: {} }),
    })
    const codemode = createCodemodeTool({ owner: makeOwner([tool]) })
    const result = await run(codemode, `const r = await tools.plain({}); return r;`)
    expect(textOf(result)).toContain('the text')
  })

  it('applies the after-tool hook to nested results', async () => {
    const tool = makeTool({
      name: 't',
      execute: async () => ({ content: [{ type: 'text' as const, text: 'raw' }], details: {} }),
    })
    const hook = async () => ({ content: [{ type: 'text' as const, text: 'HOOKED' }] })
    const codemode = createCodemodeTool({ owner: makeOwner([tool], hook) })
    const result = await run(codemode, `const r = await tools.t({}); return r;`)
    expect(textOf(result)).toContain('HOOKED')
    expect(textOf(result)).not.toContain('raw')
  })

  it('validates nested call arguments against the tool schema', async () => {
    const tool: AgentTool = {
      name: 'needs',
      label: 'needs',
      description: 'needs a required arg',
      parameters: Type.Object({ req: Type.String() }),
      execute: async () => ({ content: [{ type: 'text' as const, text: 'ran' }], details: {} }),
    }
    const codemode = createCodemodeTool({ owner: makeOwner([tool]) })
    const result = await run(codemode, `
      try { await tools.needs({}); return 'no-error' } catch (e) { return 'rejected:' + e.message }
    `)
    expect(textOf(result)).toContain('rejected:')
    expect(textOf(result)).not.toContain('no-error')
  })

  it('does not expose tools outside the agent tool set', async () => {
    const codemode = createCodemodeTool({ owner: makeOwner([makeTool({ name: 'only' })]) })
    const result = await run(codemode, `await tools.nope({});`)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('does not exist')
  })

  it('numbers multiple text items, collects console lines, and appends the return value', async () => {
    const codemode = createCodemodeTool({ owner: makeOwner([]) })
    const result = await run(codemode, `
      text('first');
      console.log('log line');
      return 'returned';
    `)
    const text = textOf(result)
    expect(text).toContain('==> text 1/2 <==')
    expect(text).toContain('first')
    expect(text).toContain('==> text 2/2 <==')
    expect(text).toContain('returned')
    expect(text).toContain('<console_output>')
    expect(text).toContain('log line')
    expect(text).toContain('</console_output>')
  })

  it('does not number a single text item', async () => {
    const codemode = createCodemodeTool({ owner: makeOwner([]) })
    const result = await run(codemode, `text('only');`)
    const text = textOf(result)
    expect(text).toContain('only')
    expect(text).not.toContain('==> text')
  })

  it('truncates oversized output, keeps head and tail, and spills the full text', async () => {
    const codemode = createCodemodeTool({ owner: makeOwner([]) })
    const result = await run(codemode, `// @options: {"max_output_tokens": 100}
text('A'.repeat(5000));
text('B'.repeat(5000));`)
    const text = textOf(result)
    expect(text).toContain('truncated')
    expect(result.details.outputTruncated).toBe(true)
    const spillPath = result.details.fullOutputPath as string
    expect(spillPath).toBeTruthy()
    expect(spillPath).toContain(CODEMODE_SPILL_DIR)
    expect(spillPath.startsWith(workspace)).toBe(true)
    const spilled = fs.readFileSync(spillPath, 'utf-8')
    expect(spilled.length).toBeGreaterThan(10000)
    // head and tail survive
    expect(text).toContain('A')
    expect(text).toContain('B')
  })

  it('keeps output under the budget un-truncated', async () => {
    const codemode = createCodemodeTool({ owner: makeOwner([]) })
    const result = await run(codemode, `text('short');`)
    expect(result.details.outputTruncated).toBeFalsy()
    expect(result.details.fullOutputPath).toBeUndefined()
    expect(textOf(result)).toContain('short')
  })

  it('enforces the timeout_ms deadline', async () => {
    const tool = makeTool({ name: 'hang', execute: () => new Promise(() => {}) })
    const codemode = createCodemodeTool({ owner: makeOwner([tool]) })
    const result = await run(codemode, `// @options: {"timeout_ms": 300}
await tools.hang({});`)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('timed out')
  }, 10000)

  it('aborts the script and its nested calls when the signal fires', async () => {
    const tool = makeTool({ name: 'hang', execute: () => new Promise(() => {}) })
    const codemode = createCodemodeTool({ owner: makeOwner([tool]) })
    const ac = new AbortController()
    const p = run(codemode, `await tools.hang({});`, ac.signal)
    setTimeout(() => ac.abort('user abort'), 200)
    const result = await p
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('aborted')
  })

  it('cancels unawaited nested calls when the script ends', async () => {
    let aborted = false
    const tool = makeTool({
      name: 'bg',
      execute: (_id, _params, signal) => new Promise(resolve => {
        signal?.addEventListener('abort', () => { aborted = true; resolve({ content: [{ type: 'text' as const, text: 'x' }], details: {} }) })
      }),
    })
    const codemode = createCodemodeTool({ owner: makeOwner([tool]) })
    const result = await run(codemode, `tools.bg({}); return 1;`)
    expect(result.isError).toBeFalsy()
    expect(aborted).toBe(true)
  })

  it('keeps partial output and lists executed calls on failure', async () => {
    const ok = makeTool({ name: 'ok', execute: async () => ({ content: [{ type: 'text' as const, text: 'did work' }], details: {} }) })
    const fail = makeTool({ name: 'fail', execute: async () => { throw new Error('boom') } })
    const codemode = createCodemodeTool({ owner: makeOwner([ok, fail]) })
    const result = await run(codemode, `
      text('before failure');
      await tools.ok({});
      await tools.fail({});
    `)
    expect(result.isError).toBe(true)
    const text = textOf(result)
    expect(text).toContain('before failure')
    expect(text).toContain('Script error')
    expect(text).toContain('boom')
    expect(text).toContain('ok (ok)')
    expect(text).toContain('fail (error)')
  })

  it('collects uploads from nested results into details.uploadedFiles, de-duplicated', async () => {
    const uploadA = {
      kind: 'file' as const,
      originalName: 'a.txt',
      storedName: 'a-a.txt',
      relativePath: '2026/05/01/a-a.txt',
      urlPath: '/api/uploads/2026/05/01/a-a.txt',
      mimeType: 'text/plain',
      size: 1,
    }
    const uploadB = {
      kind: 'file' as const,
      originalName: 'b.png',
      storedName: 'b-b.png',
      relativePath: '2026/05/01/b-b.png',
      urlPath: '/api/uploads/2026/05/01/b-b.png',
      mimeType: 'image/png',
      size: 2,
    }
    const send = makeTool({
      name: 'send_file_to_user',
      execute: async (_id, params) => {
        const p = (params as { file: string }).file
        return { content: [{ type: 'text' as const, text: 'sent' }], details: { uploadedFile: p === 'a' ? uploadA : uploadB } }
      },
    })
    const batch = makeTool({
      name: 'export',
      execute: async () => ({ content: [{ type: 'text' as const, text: 'exported' }], details: { uploadedFiles: [uploadB, uploadA] } }),
    })
    const codemode = createCodemodeTool({ owner: makeOwner([send, batch]) })
    const result = await run(codemode, `
      await tools.send_file_to_user({ file: 'a' });
      await tools.send_file_to_user({ file: 'b' });
      await tools.export({});
      return 'done';
    `)
    expect(result.isError).toBeFalsy()

    const collected = result.details.uploadedFiles as Array<{ relativePath: string }>
    expect(collected.map(u => u.relativePath)).toEqual(['2026/05/01/a-a.txt', '2026/05/01/b-b.png'])
    // The existing channel-layer extraction picks the uploads off the codemode result.
    expect(extractUploadsFromToolResult(result).map(u => u.relativePath)).toEqual([
      '2026/05/01/a-a.txt',
      '2026/05/01/b-b.png',
    ])
  })

  it('delivers uploads from nested calls that ran before a script failure', async () => {
    const upload = {
      kind: 'file' as const,
      originalName: 'c.txt',
      storedName: 'c-c.txt',
      relativePath: '2026/05/01/c-c.txt',
      urlPath: '/api/uploads/2026/05/01/c-c.txt',
      mimeType: 'text/plain',
      size: 3,
    }
    const send = makeTool({
      name: 'send_file_to_user',
      execute: async () => ({ content: [{ type: 'text' as const, text: 'sent' }], details: { uploadedFile: upload } }),
    })
    const boom = makeTool({ name: 'boom', execute: async () => { throw new Error('exploded') } })
    const codemode = createCodemodeTool({ owner: makeOwner([send, boom]) })
    const result = await run(codemode, `
      await tools.send_file_to_user({});
      await tools.boom({});
    `)
    expect(result.isError).toBe(true)
    const collected = result.details.uploadedFiles as Array<{ relativePath: string }>
    expect(collected.map(u => u.relativePath)).toEqual(['2026/05/01/c-c.txt'])
    expect(extractUploadsFromToolResult(result)).toHaveLength(1)
  })

  it('omits uploadedFiles when no nested call produced an upload', async () => {
    const codemode = createCodemodeTool({ owner: makeOwner([makeTool({ name: 'plain' })]) })
    const result = await run(codemode, `const r = await tools.plain({}); return r;`)
    expect(result.details.uploadedFiles).toBeUndefined()
  })

  it('reports invalid source as an error result', async () => {
    const codemode = createCodemodeTool({ owner: makeOwner([]) })
    const result = await run(codemode, `   `)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('Invalid source')
  })

  it('prunes spill files older than the retention window', async () => {
    const { pruneCodemodeSpillFolder } = await import('./codemode-tool.js')
    const dir = path.join(workspace, CODEMODE_SPILL_DIR)
    fs.mkdirSync(dir, { recursive: true })
    const fresh = path.join(dir, 'fresh.txt')
    const stale = path.join(dir, 'stale.txt')
    fs.writeFileSync(fresh, 'x')
    fs.writeFileSync(stale, 'x')
    const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    fs.utimesSync(stale, oldTime, oldTime)
    const removed = pruneCodemodeSpillFolder()
    expect(removed).toBe(1)
    expect(fs.existsSync(fresh)).toBe(true)
    expect(fs.existsSync(stale)).toBe(false)
  })
})

describe('nested call observer and progress', () => {
  let workspace: string
  let previousWorkspace: string | undefined

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-codemode-obs-'))
    previousWorkspace = process.env.WORKSPACE_DIR
    process.env.WORKSPACE_DIR = workspace
  })

  afterEach(() => {
    if (previousWorkspace === undefined) delete process.env.WORKSPACE_DIR
    else process.env.WORKSPACE_DIR = previousWorkspace
    fs.rmSync(workspace, { recursive: true, force: true })
  })

  function runWith(tool: AgentTool, code: string, onUpdate?: (partial: AgentToolResult<Record<string, unknown>>) => void): Promise<AgentToolResult<Record<string, unknown>>> {
    return tool.execute('parent-1', { code }, undefined, onUpdate) as Promise<AgentToolResult<Record<string, unknown>>>
  }

  it('emits observer start and end events with parent and nested ids', async () => {
    const starts: CodemodeNestedCallStart[] = []
    const ends: CodemodeNestedCallEnd[] = []
    const tool = makeTool({
      name: 'read_file',
      execute: async () => ({ content: [{ type: 'text' as const, text: 'file contents' }], details: {} }),
    })
    const codemode = createCodemodeTool({
      owner: makeOwner([tool]),
      observer: {
        onCallStart: info => starts.push(info),
        onCallEnd: info => ends.push(info),
      },
    })
    const result = await runWith(codemode, `const r = await tools.read_file({ path: 'a.md' }); return r;`)
    expect(result.isError).toBeFalsy()

    expect(starts).toHaveLength(1)
    expect(starts[0]).toMatchObject({
      parentToolCallId: 'parent-1',
      toolCallId: 'parent-1/read_file/1',
      toolName: 'read_file',
    })
    expect(starts[0]!.args).toMatchObject({ path: 'a.md' })

    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({
      parentToolCallId: 'parent-1',
      toolCallId: 'parent-1/read_file/1',
      toolName: 'read_file',
      isError: false,
    })
    expect(ends[0]!.result).toEqual({ content: [{ type: 'text', text: 'file contents' }], details: {} })
    expect(typeof ends[0]!.durationMs).toBe('number')
  })

  it('flags failed nested calls in the observer end event', async () => {
    const ends: CodemodeNestedCallEnd[] = []
    const tool = makeTool({
      name: 'bad',
      execute: async () => ({ content: [{ type: 'text' as const, text: 'it broke' }], details: { error: true } }),
    })
    const codemode = createCodemodeTool({
      owner: makeOwner([tool]),
      observer: { onCallEnd: info => ends.push(info) },
    })
    const result = await runWith(codemode, `try { await tools.bad({}) } catch (e) { return 'caught' }`)
    expect(result.isError).toBeFalsy()

    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ toolName: 'bad', isError: true, toolCallId: 'parent-1/bad/1', parentToolCallId: 'parent-1' })
    expect(ends[0]!.result).toEqual({ content: [{ type: 'text', text: 'it broke' }], details: { error: true } })
  })

  it('streams a nested-call snapshot to onUpdate after every nested start and end', async () => {
    const updates: AgentToolResult<Record<string, unknown>>[] = []
    const tool = makeTool({
      name: 'slow',
      execute: async () => {
        await new Promise(r => setTimeout(r, 50))
        return { content: [{ type: 'text' as const, text: 'done' }], details: {} }
      },
    })
    const codemode = createCodemodeTool({ owner: makeOwner([tool]) })
    await runWith(codemode, `await tools.slow({});`, partial => updates.push(partial))

    expect(updates).toHaveLength(2)
    expect(updates[0]!.details.calls).toEqual([
      { id: 'parent-1/slow/1', name: 'slow', status: 'running', args: {}, durationMs: undefined, errorPreview: undefined },
    ])
    const finalCalls = updates[1]!.details.calls as Array<Record<string, unknown>>
    expect(finalCalls).toHaveLength(1)
    expect(finalCalls[0]).toMatchObject({ id: 'parent-1/slow/1', name: 'slow', status: 'ok', args: {} })
    expect(finalCalls[0]!.durationMs).toBeGreaterThanOrEqual(50)
  })

  it('includes the nested call args in the final result details', async () => {
    const tool = makeTool({
      name: 'read_file',
      execute: async () => ({ content: [{ type: 'text' as const, text: 'file contents' }], details: {} }),
    })
    const codemode = createCodemodeTool({ owner: makeOwner([tool]) })
    const result = await runWith(codemode, `await tools.read_file({ path: 'a.md' });`)
    const calls = result.details.calls as Array<Record<string, unknown>>
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ id: 'parent-1/read_file/1', name: 'read_file', status: 'ok', args: { path: 'a.md' } })
  })

  it('persists the nested call error preview in the final result details', async () => {
    const tool = makeTool({
      name: 'read_file',
      execute: async () => ({ content: [{ type: 'text' as const, text: 'ENOENT: no such file or directory' }], details: { error: true } }),
    })
    const codemode = createCodemodeTool({ owner: makeOwner([tool]) })
    const result = await runWith(codemode, `try { await tools.read_file({ path: 'missing.md' }); } catch (err) { return 'handled' }`)
    const calls = result.details.calls as Array<Record<string, unknown>>
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      id: 'parent-1/read_file/1',
      name: 'read_file',
      status: 'error',
      args: { path: 'missing.md' },
      errorPreview: 'ENOENT: no such file or directory',
    })
  })

  it('compacts nested call args in snapshots and result details but keeps them full for the observer', async () => {
    const content = 'first line of the file\n' + 'x'.repeat(5000)
    const updates: AgentToolResult<Record<string, unknown>>[] = []
    const starts: CodemodeNestedCallStart[] = []
    const tool = makeTool({
      name: 'write_file',
      execute: async () => ({ content: [{ type: 'text' as const, text: 'written' }], details: {} }),
    })
    const codemode = createCodemodeTool({
      owner: makeOwner([tool]),
      observer: { onCallStart: info => starts.push(info) },
    })
    const result = await runWith(
      codemode,
      `await tools.write_file({ path: 'a.md', content: ${JSON.stringify(content)} });`,
      partial => updates.push(partial),
    )

    const compactArgs = { path: 'a.md', content: 'first line of the file' }
    for (const update of updates) {
      expect((update.details.calls as Array<Record<string, unknown>>)[0]).toMatchObject({ args: compactArgs })
    }
    const calls = result.details.calls as Array<Record<string, unknown>>
    expect(calls[0]).toMatchObject({ status: 'ok', args: compactArgs })
    // The observer (tool-call log, task journal, loop detection) still gets the full args.
    expect(starts[0]!.args).toMatchObject({ path: 'a.md', content })
  })

  it('caps long single-line string args in the result details', async () => {
    const tool = makeTool({
      name: 'shell',
      execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }], details: {} }),
    })
    const command = `echo ${'a'.repeat(300)}`
    const codemode = createCodemodeTool({ owner: makeOwner([tool]) })
    const result = await runWith(codemode, `await tools.shell({ command: ${JSON.stringify(command)} });`)
    const calls = result.details.calls as Array<Record<string, unknown>>
    const args = calls[0]!.args as { command: string }
    expect(args.command).toBe(`echo ${'a'.repeat(194)}…`)
    expect(args.command).toHaveLength(200)
  })

  it('createNestedCallLogObserver writes nested calls to the tool-call log with the parent link', () => {
    const dbPath = path.join(workspace, 'log-test.db')
    const db = initDatabase(dbPath)
    const observer = createNestedCallLogObserver(db, () => 'session-log-1')

    observer.onCallEnd?.({
      parentToolCallId: 'parent-1',
      toolCallId: 'parent-1/shell/1',
      toolName: 'shell',
      args: { command: 'ls' },
      result: { content: [{ type: 'text', text: 'out' }], details: {} },
      isError: false,
      durationMs: 42,
    })

    const rows = db.prepare('SELECT * FROM tool_calls').all() as Record<string, unknown>[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      session_id: 'session-log-1',
      tool_name: 'shell',
      input: JSON.stringify({ command: 'ls' }),
      duration_ms: 42,
      status: 'success',
      tool_call_id: 'parent-1/shell/1',
      parent_tool_call_id: 'parent-1',
    })
    db.close()
  })
})

describe('codemode description', () => {
  it('lists the globals and each callable tool with its resolve hint', () => {
    const tools = [
      makeTool({ name: 'read_file', description: 'Read a file from the workspace. It returns the content.' }),
      makeTool({ name: 'calc', description: 'Compute.', outputSchema: Type.Object({ value: Type.Number() }) }),
    ]
    const description = buildCodemodeDescription(tools)
    expect(description).toContain('text(value)')
    expect(description).toContain('console.log')
    expect(description).toContain('return value')
    expect(description).toContain('await tools.read_file(')
    expect(description).toContain('a string')
    expect(description).toContain('await tools.calc(')
    expect(description).toContain('an object')
    // v1 does not advertise store/load or the models API
    expect(description).not.toContain('store(')
    expect(description).not.toContain('models.')
  })

  it('shows that shell resolves to { output, exit_code } without rejecting on non-zero exit', () => {
    const tools = [
      makeTool({
        name: 'shell',
        description: 'Execute a shell command and return stdout/stderr.',
        outputSchema: Type.Object({ output: Type.String(), exit_code: Type.Number() }),
      }),
    ]
    const description = buildCodemodeDescription(tools)
    expect(description).toContain('an object { output, exit_code }')
    expect(description).toContain('non-zero exit code does NOT reject')
  })

  it('maps non-identifier tool names to identifiers in the description', () => {
    const tools = [makeTool({ name: 'my tool' })]
    const description = buildCodemodeDescription(tools)
    expect(description).toContain('tools.my_tool')
  })
})
