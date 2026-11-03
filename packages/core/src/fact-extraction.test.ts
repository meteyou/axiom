import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./pi-models.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return {
    ...original,
    completeSimple: vi.fn(),
  }
})

import { completeSimple } from './pi-models.js'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import {
  extractAndStoreFacts,
  findRelatedFacts,
  parseFactDecisions,
  parseFactLines,
} from './fact-extraction.js'
import { createMemory, getMemoryById, listMemories, searchMemories, supersedeMemories } from './memories-store.js'

const mockCompleteSimple = vi.mocked(completeSimple)

function insertUser(db: Database, id: number, username: string): void {
  db.prepare(
    'INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)',
  ).run(id, username, 'hash', 'user')
}

function makeModel() {
  return {
    id: 'gpt-4o-mini',
    name: 'GPT-4o mini',
    api: 'openai-completions' as const,
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    reasoning: false,
    input: ['text' as const, 'image' as const],
    cost: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  }
}

function makeResponse(text: string) {
  return {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text }],
    usage: {
      input: 100,
      output: 40,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 140,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    model: 'gpt-4o-mini',
    api: 'openai-completions' as const,
    provider: 'openai',
    stopReason: 'stop' as const,
    timestamp: Date.now(),
  }
}

describe('fact-extraction', () => {
  let db: Database

  beforeEach(() => {
    db = initDatabase(':memory:')
    insertUser(db, 1, 'alice')
    insertUser(db, 2, 'bob')
    mockCompleteSimple.mockReset()
  })

  afterEach(() => {
    db.close()
  })

  it('parseFactLines handles bullet lists, numbered lists, empty lines, and NO_FACTS', () => {
    expect(parseFactLines('- User prefers dark mode\n- Project uses PostgreSQL')).toEqual([
      'User prefers dark mode',
      'Project uses PostgreSQL',
    ])

    expect(parseFactLines('1. User works in Berlin\n\n2) Deployment uses Docker Compose')).toEqual([
      'User works in Berlin',
      'Deployment uses Docker Compose',
    ])

    expect(parseFactLines('  NO_FACTS  ')).toEqual([])
    expect(parseFactLines('\n\n')).toEqual([])
  })

  it('findRelatedFacts ranks active facts of the same user by word overlap', () => {
    const portId = createMemory(db, 1, 'session-a', 'The project uses PostgreSQL on port 5433', 'extracted_fact')
    createMemory(db, 1, 'session-a', 'PostgreSQL backups run nightly', 'extracted_fact')
    createMemory(db, 2, 'session-b', 'The project uses PostgreSQL on port 5433', 'extracted_fact')

    const related = findRelatedFacts(db, 1, 'Project uses PostgreSQL at port 5433')

    expect(related.map(fact => fact.id)[0]).toBe(portId)
    expect(related).toHaveLength(2)
    expect(related[0].overlap).toBeGreaterThan(0.7)
    expect(related[0].overlap).toBeGreaterThan(related[1].overlap)
  })

  it('findRelatedFacts ignores superseded facts', () => {
    const oldId = createMemory(db, 1, 'session-a', 'User prefers dark mode', 'extracted_fact')
    const newId = createMemory(db, 1, 'session-b', 'User prefers light mode', 'extracted_fact')
    supersedeMemories(db, 1, [oldId], newId)

    expect(findRelatedFacts(db, 1, 'User prefers dark mode').map(fact => fact.id)).toEqual([newId])
  })

  it('parseFactDecisions maps answers by index, defaults to add, and drops ids that were not offered', () => {
    const decisions = parseFactDecisions([
      'N1: SKIP',
      'N2: SUPERSEDES #12, #99',
      '- N3: supersede #13',
      'N4: SUPERSEDES #77',
      'N9: SKIP',
      'some chatter',
    ].join('\n'), 5, new Set([12, 13]))

    expect(decisions).toEqual([
      { action: 'skip' },
      { action: 'supersede', ids: [12] },
      { action: 'supersede', ids: [13] },
      { action: 'add' },
      { action: 'add' },
    ])
  })

  it('parseFactDecisions ignores numbers in explanation text after SUPERSEDES', () => {
    const decisions = parseFactDecisions(
      'N1: SUPERSEDES #42 (user moved in 2024, has 3 cats)',
      1,
      new Set([3, 42, 2024]),
    )

    expect(decisions).toEqual([{ action: 'supersede', ids: [42] }])
  })

  it('stores unrelated facts without a reconciliation call', async () => {
    mockCompleteSimple.mockResolvedValueOnce(makeResponse([
      '- The project uses PostgreSQL on port 5433',
      '- User prefers dark mode in all applications',
    ].join('\n')))

    const result = await extractAndStoreFacts(
      db,
      1,
      'session-new',
      'User: Please remember that I prefer dark mode.\nAssistant: Got it.',
      makeModel(),
      'test-key',
    )

    expect(result).toEqual({ extracted: 2, stored: 2, duplicates: 0, superseded: 0 })
    expect(mockCompleteSimple).toHaveBeenCalledOnce()

    const [, prompt, options] = mockCompleteSimple.mock.calls[0]
    expect(prompt.systemPrompt).toContain('extract atomic, reusable facts')
    expect(prompt.messages[0].content).toContain('<transcript>\nUser: Please remember that I prefer dark mode.')
    expect(prompt.messages[0].content).toContain('\n</transcript>')
    expect(options).toMatchObject({ apiKey: 'test-key' })
    // claude-sonnet-5 and friends reject `temperature` with a 400.
    expect(options).not.toHaveProperty('temperature')

    const storedFacts = listMemories(db, { userId: 1, limit: 10, offset: 0 }).facts.map(fact => fact.content)
    expect(storedFacts).toEqual(expect.arrayContaining([
      'The project uses PostgreSQL on port 5433',
      'User prefers dark mode in all applications',
    ]))
  })

  it('skips exact duplicates of existing facts and within the same batch without asking the LLM', async () => {
    createMemory(db, 1, 'session-old', 'Deployment is done via Docker Compose with 3 services', 'extracted_fact')
    mockCompleteSimple.mockResolvedValueOnce(makeResponse([
      '- Deployment is done via docker compose with 3 services.',
      '- User works in Berlin',
      '- User works in Berlin',
    ].join('\n')))

    const result = await extractAndStoreFacts(db, 1, 'session-new', 'User: hi', makeModel(), 'test-key')

    expect(result).toEqual({ extracted: 3, stored: 1, duplicates: 2, superseded: 0 })
    expect(mockCompleteSimple).toHaveBeenCalledOnce()
    expect(listMemories(db, { userId: 1 }).total).toBe(2)
  })

  it('lets the LLM supersede a contradicted fact and skip a reworded duplicate', async () => {
    const darkModeId = createMemory(db, 1, 'session-old', 'User prefers dark mode in all applications', 'extracted_fact')
    const portId = createMemory(db, 1, 'session-old', 'The project uses PostgreSQL on port 5433', 'extracted_fact')
    const otherUserFactId = createMemory(db, 2, 'session-bob', 'User prefers dark mode in all applications', 'extracted_fact')

    mockCompleteSimple
      .mockResolvedValueOnce(makeResponse([
        '- User prefers light mode in all applications',
        '- Project uses PostgreSQL at port 5433',
      ].join('\n')))
      .mockResolvedValueOnce(makeResponse(`N1: SUPERSEDES #${darkModeId}, #${otherUserFactId}\nN2: SKIP`))

    const result = await extractAndStoreFacts(db, 1, 'session-new', 'User: I switched to light mode.', makeModel(), 'test-key')

    expect(result).toEqual({ extracted: 2, stored: 1, duplicates: 1, superseded: 1 })
    expect(mockCompleteSimple).toHaveBeenCalledTimes(2)

    const [, reconciliationPrompt] = mockCompleteSimple.mock.calls[1]
    expect(reconciliationPrompt.systemPrompt).toContain('SUPERSEDES')
    expect(reconciliationPrompt.messages[0].content).toContain(`[#${darkModeId}] User prefers dark mode in all applications`)
    expect(reconciliationPrompt.messages[0].content).toContain(`[#${portId}] The project uses PostgreSQL on port 5433`)
    expect(reconciliationPrompt.messages[0].content).not.toContain(`[#${otherUserFactId}]`)
    expect(reconciliationPrompt.messages[0].content).toContain('N1: User prefers light mode in all applications')

    const activeFacts = listMemories(db, { userId: 1 }).facts
    const lightModeFact = activeFacts.find(fact => fact.content === 'User prefers light mode in all applications')
    expect(lightModeFact).toBeDefined()
    expect(activeFacts.map(fact => fact.id)).not.toContain(darkModeId)

    const retired = getMemoryById(db, darkModeId)
    expect(retired?.supersededBy).toBe(lightModeFact?.id)
    expect(retired?.deletedAt).not.toBeNull()
    expect(searchMemories(db, '"dark mode"', { userId: 1 })).toEqual([])

    expect(getMemoryById(db, otherUserFactId)?.deletedAt).toBeNull()
  })

  it('does not store anything when the reconciliation request fails', async () => {
    createMemory(db, 1, 'session-old', 'User prefers dark mode in all applications', 'extracted_fact')
    mockCompleteSimple
      .mockResolvedValueOnce(makeResponse('- User prefers light mode in all applications'))
      .mockRejectedValueOnce(new Error('LLM unavailable'))

    await expect(extractAndStoreFacts(db, 1, 'session-new', 'User: light mode', makeModel(), 'test-key'))
      .rejects.toThrow('LLM unavailable')
    expect(listMemories(db, { userId: 1 }).total).toBe(1)
  })

  it('books the extraction call in the token usage of the session', async () => {
    mockCompleteSimple.mockResolvedValueOnce(makeResponse('NO_FACTS'))

    await extractAndStoreFacts(db, 1, 'session-usage', 'User: hi', makeModel(), 'test-key')

    const row = db.prepare('SELECT provider, model, prompt_tokens, completion_tokens, estimated_cost, session_id, user_id FROM token_usage').get()
    expect(row).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini',
      prompt_tokens: 100,
      completion_tokens: 40,
      estimated_cost: (100 * 0.15 + 40 * 0.6) / 1_000_000,
      session_id: 'session-usage',
      user_id: 1,
    })
  })

  it('returns zero counts when the LLM says NO_FACTS', async () => {
    mockCompleteSimple.mockResolvedValueOnce(makeResponse('NO_FACTS'))

    const result = await extractAndStoreFacts(
      db,
      1,
      'session-empty',
      'User: Hello\nAssistant: Hi there',
      makeModel(),
      'test-key',
    )

    expect(result).toEqual({ extracted: 0, stored: 0, duplicates: 0, superseded: 0 })
    expect(listMemories(db, { userId: 1, limit: 10, offset: 0 }).facts).toHaveLength(0)
  })

  it('throws when the provider rejects the request instead of storing zero facts', async () => {
    mockCompleteSimple.mockResolvedValueOnce({
      ...makeResponse(''),
      content: [],
      stopReason: 'error' as const,
      errorMessage: '400 `temperature` is deprecated for this model.',
    })

    await expect(extractAndStoreFacts(
      db,
      1,
      'session-error',
      'User: remember X\nAssistant: ok',
      makeModel(),
      'test-key',
    )).rejects.toThrow('temperature')
  })

  it('propagates LLM errors so callers can handle them', async () => {
    mockCompleteSimple.mockRejectedValueOnce(new Error('LLM unavailable'))

    await expect(extractAndStoreFacts(
      db,
      1,
      'session-error',
      'User: remember this',
      makeModel(),
      'test-key',
    )).rejects.toThrow('LLM unavailable')
  })
})
