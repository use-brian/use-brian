import { describe, it, expect, vi } from 'vitest'
import { runMemoryNudge, extractRecalledMemories, extractResponseText, parseVerdicts } from '../nudge.js'
import type { NudgeTurn } from '../nudge.js'
import type { ContentBlock } from '../../providers/types.js'
import type { MemoryStore } from '../types.js'

// ── Helpers ──────────────────────────────────────────────────────

function toolResult(name: string, content: string, isError = false): ContentBlock {
  return { type: 'tool_result', toolUseId: 'tu-1', name, content, isError }
}

function textBlock(text: string): ContentBlock {
  return { type: 'text', text }
}

function turn(content: ContentBlock[], toolResults: ContentBlock[]): NudgeTurn {
  return { content, toolResults }
}

function makeFakeStore(): MemoryStore & { outcomes: Array<{ id: string; useful: boolean }> } {
  const outcomes: Array<{ id: string; useful: boolean }> = []
  const notImpl = () => { throw new Error('not used') }
  return {
    outcomes,
    async trackRecallOutcome(memoryId, useful) {
      outcomes.push({ id: memoryId, useful })
    },
    // Unused in nudge
    create: notImpl as never,
    update: notImpl as never,
    getById: notImpl as never,
    getByIdSystem: notImpl as never,
    search: notImpl as never,
    getIdentity: notImpl as never,
    getIndex: notImpl as never,
    getIndexSystem: notImpl as never,
    getWorkspaceIndexSystem: notImpl as never,
    getIndexRanked: notImpl as never,
    trackRecall: notImpl as never,
    getWorkspaceIdentity: notImpl as never,
    getWorkspaceIndex: notImpl as never,
    getWorkspaceMemoriesByCategory: notImpl as never,
    searchTeam: notImpl as never,
    listWorkspaceMemoryGroups: notImpl as never,
    listTeamWithMetrics: notImpl as never,
    getLastWorkspacePhaseAt: notImpl as never,
    logWorkspaceConsolidation: notImpl as never,
    getSoul: notImpl as never,
    count: notImpl as never,
    listWithMetrics: notImpl as never,
    writeConsolidationScore: notImpl as never,
    deleteMemory: notImpl as never,
    listCronContextCandidatesForPrune: notImpl as never,
    listForSoulSynthesis: notImpl as never,
    upsertSoul: notImpl as never,
    upsertDomainSummary: notImpl as never,
    pruneStaleDomainSummaries: notImpl as never,
    logConsolidation: notImpl as never,
    listMemoryUsers: notImpl as never,
    getLastPhaseAt: notImpl as never,
    hasRecentActivity: notImpl as never,
    listForReflection: notImpl as never,
    listOpenCommitments: notImpl as never,
  }
}

// ── Unit tests ────────────────────────────────────────────────────

describe('[COMP:memory/nudge] extractRecalledMemories', () => {
  it('extracts single getMemory result', () => {
    const turns = [turn([], [
      toolResult('getMemory', JSON.stringify({ id: 'abcd1234-5678-9012-3456-789012345678', summary: 'User is vegetarian', tags: [] })),
    ])]
    const result = extractRecalledMemories(turns)
    expect(result).toHaveLength(1)
    expect(result[0].fullId).toBe('abcd1234-5678-9012-3456-789012345678')
    expect(result[0].prefix).toBe('abcd1234')
    expect(result[0].summary).toBe('User is vegetarian')
  })

  it('extracts array results from search', () => {
    const turns = [turn([], [
      toolResult('getMemory', JSON.stringify([
        { id: '11111111-1111-1111-1111-111111111111', summary: 'Memory A', tags: [] },
        { id: '22222222-2222-2222-2222-222222222222', summary: 'Memory B', tags: [] },
      ])),
    ])]
    const result = extractRecalledMemories(turns)
    expect(result).toHaveLength(2)
  })

  it('skips error results', () => {
    const turns = [turn([], [
      toolResult('getMemory', 'Memory abc12345 not found', true),
    ])]
    const result = extractRecalledMemories(turns)
    expect(result).toHaveLength(0)
  })

  it('skips non-getMemory tool results', () => {
    const turns = [turn([], [
      toolResult('webSearch', JSON.stringify({ results: [] })),
    ])]
    const result = extractRecalledMemories(turns)
    expect(result).toHaveLength(0)
  })

  it('deduplicates same memory across turns', () => {
    const mem = JSON.stringify({ id: 'abcd1234-5678-9012-3456-789012345678', summary: 'Same memory', tags: [] })
    const turns = [
      turn([], [toolResult('getMemory', mem)]),
      turn([], [toolResult('getMemory', mem)]),
    ]
    const result = extractRecalledMemories(turns)
    expect(result).toHaveLength(1)
  })

  it('handles non-JSON content gracefully', () => {
    const turns = [turn([], [
      toolResult('getMemory', 'No matching memories found.'),
    ])]
    const result = extractRecalledMemories(turns)
    expect(result).toHaveLength(0)
  })
})

describe('[COMP:memory/nudge] extractResponseText', () => {
  it('concatenates text blocks across turns', () => {
    const turns = [
      turn([textBlock('Hello '), textBlock('world')], []),
      turn([textBlock('Second turn')], []),
    ]
    expect(extractResponseText(turns)).toBe('Hello \nworld\nSecond turn')
  })

  it('ignores tool_use blocks', () => {
    const turns = [turn([
      textBlock('Some text'),
      { type: 'tool_use', id: 't1', name: 'getMemory', input: {} },
    ], [])]
    expect(extractResponseText(turns)).toBe('Some text')
  })
})

describe('[COMP:memory/nudge] parseVerdicts', () => {
  it('parses USED and UNUSED verdicts', () => {
    const recalled = [
      { fullId: 'aaaaaaaa-1111-2222-3333-444444444444', prefix: 'aaaaaaaa', summary: 'A' },
      { fullId: 'bbbbbbbb-1111-2222-3333-444444444444', prefix: 'bbbbbbbb', summary: 'B' },
    ]
    const output = 'aaaaaaaa: USED\nbbbbbbbb: UNUSED'
    const verdicts = parseVerdicts(output, recalled)
    expect(verdicts.get('aaaaaaaa-1111-2222-3333-444444444444')).toBe(true)
    expect(verdicts.get('bbbbbbbb-1111-2222-3333-444444444444')).toBe(false)
  })

  it('ignores lines that do not match pattern', () => {
    const recalled = [
      { fullId: 'aaaaaaaa-1111-2222-3333-444444444444', prefix: 'aaaaaaaa', summary: 'A' },
    ]
    const output = 'Here are my judgments:\naaaaaaaa: USED\nSome extra commentary'
    const verdicts = parseVerdicts(output, recalled)
    expect(verdicts.size).toBe(1)
  })

  it('handles case-insensitive verdicts', () => {
    const recalled = [
      { fullId: 'aaaaaaaa-1111-2222-3333-444444444444', prefix: 'aaaaaaaa', summary: 'A' },
    ]
    const output = 'aaaaaaaa: used'
    const verdicts = parseVerdicts(output, recalled)
    expect(verdicts.get('aaaaaaaa-1111-2222-3333-444444444444')).toBe(true)
  })

  it('ignores unknown prefixes', () => {
    const recalled = [
      { fullId: 'aaaaaaaa-1111-2222-3333-444444444444', prefix: 'aaaaaaaa', summary: 'A' },
    ]
    const output = 'aaaaaaaa: USED\ncccccccc: USED'
    const verdicts = parseVerdicts(output, recalled)
    expect(verdicts.size).toBe(1)
  })
})

// ── Integration tests ─────────────────────────────────────────────

describe('[COMP:memory/nudge] runMemoryNudge', () => {
  it('returns early without calling model when no getMemory results', async () => {
    const callModel = vi.fn()
    const store = makeFakeStore()
    const result = await runMemoryNudge({
      turns: [turn([textBlock('Hello')], [])],
      callModel,
      store,
    })
    expect(result).toEqual({ judged: 0, useful: 0, usage: null, model: null })
    expect(callModel).not.toHaveBeenCalled()
  })

  it('returns early when no response text', async () => {
    const callModel = vi.fn()
    const store = makeFakeStore()
    const result = await runMemoryNudge({
      turns: [turn([], [
        toolResult('getMemory', JSON.stringify({ id: 'aaaaaaaa-1111-2222-3333-444444444444', summary: 'Test', tags: [] })),
      ])],
      callModel,
      store,
    })
    expect(result).toEqual({ judged: 0, useful: 0, usage: null, model: null })
    expect(callModel).not.toHaveBeenCalled()
  })

  it('judges a single useful memory', async () => {
    const store = makeFakeStore()
    const result = await runMemoryNudge({
      turns: [turn(
        [textBlock('Since you are vegetarian, here are some options...')],
        [toolResult('getMemory', JSON.stringify({ id: 'aaaaaaaa-1111-2222-3333-444444444444', summary: 'User is vegetarian', tags: [] }))],
      )],
      callModel: async () => 'aaaaaaaa: USED',
      store,
    })
    expect(result).toEqual({ judged: 1, useful: 1, usage: null, model: null })
    expect(store.outcomes).toEqual([{ id: 'aaaaaaaa-1111-2222-3333-444444444444', useful: true }])
  })

  it('handles mixed USED/UNUSED verdicts', async () => {
    const store = makeFakeStore()
    const result = await runMemoryNudge({
      turns: [turn(
        [textBlock('Here is the flight info you asked about.')],
        [toolResult('getMemory', JSON.stringify([
          { id: 'aaaaaaaa-1111-2222-3333-444444444444', summary: 'HKG to NRT flights', tags: [] },
          { id: 'bbbbbbbb-1111-2222-3333-444444444444', summary: 'User likes sushi', tags: [] },
        ]))],
      )],
      callModel: async () => 'aaaaaaaa: USED\nbbbbbbbb: UNUSED',
      store,
    })
    expect(result).toEqual({ judged: 2, useful: 1, usage: null, model: null })
    expect(store.outcomes).toContainEqual({ id: 'aaaaaaaa-1111-2222-3333-444444444444', useful: true })
    expect(store.outcomes).toContainEqual({ id: 'bbbbbbbb-1111-2222-3333-444444444444', useful: false })
  })

  it('propagates usage and model when callModel returns NudgeModelResult', async () => {
    const store = makeFakeStore()
    const result = await runMemoryNudge({
      turns: [turn(
        [textBlock('Vegetarian options follow.')],
        [toolResult('getMemory', JSON.stringify({ id: 'aaaaaaaa-1111-2222-3333-444444444444', summary: 'User is vegetarian', tags: [] }))],
      )],
      callModel: async () => ({
        text: 'aaaaaaaa: USED',
        usage: { inputTokens: 42, outputTokens: 7 },
        model: 'gemini-flash',
      }),
      store,
    })
    expect(result.judged).toBe(1)
    expect(result.useful).toBe(1)
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 7 })
    expect(result.model).toBe('gemini-flash')
  })

  it('propagates callModel errors', async () => {
    const store = makeFakeStore()
    await expect(runMemoryNudge({
      turns: [turn(
        [textBlock('Response')],
        [toolResult('getMemory', JSON.stringify({ id: 'aaaaaaaa-1111-2222-3333-444444444444', summary: 'Test', tags: [] }))],
      )],
      callModel: async () => { throw new Error('Flash call failed') },
      store,
    })).rejects.toThrow('Flash call failed')
  })
})
