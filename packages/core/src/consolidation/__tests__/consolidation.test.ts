import { describe, it, expect } from 'vitest'
import { computeConsolidationScore, runLightConsolidation, runREMConsolidation, runReflectionConsolidation } from '../phases.js'
import type { MemoryStore } from '../../memory/types.js'

describe('[COMP:consolidation/phases] computeConsolidationScore', () => {
  it('scores high for frequently recalled, recent memory', () => {
    const score = computeConsolidationScore({
      recallCount: 8,
      usefulRecallCount: 6,
      uniqueQueries: 4,
      recallDays: 5,
      ageDays: 2,
      tags: ['food', 'preference', 'vegetarian'],
    })
    expect(score).toBeGreaterThan(0.6)
  })

  it('scores low for old, never-recalled memory', () => {
    const score = computeConsolidationScore({
      recallCount: 0,
      usefulRecallCount: 0,
      uniqueQueries: 0,
      recallDays: 0,
      ageDays: 60,
      tags: [],
    })
    expect(score).toBeLessThan(0.15)
  })

  it('returns between 0 and 1', () => {
    const score = computeConsolidationScore({
      recallCount: 5,
      usefulRecallCount: 3,
      uniqueQueries: 3,
      recallDays: 3,
      ageDays: 7,
      tags: ['travel'],
    })
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThanOrEqual(1)
  })

  it('penalizes memories with many recalls but zero useful recalls', () => {
    const inflated = computeConsolidationScore({
      recallCount: 52,
      usefulRecallCount: 0,
      uniqueQueries: 0,
      recallDays: 2,
      ageDays: 5,
      tags: [],
    })
    const useful = computeConsolidationScore({
      recallCount: 5,
      usefulRecallCount: 4,
      uniqueQueries: 3,
      recallDays: 3,
      ageDays: 5,
      tags: [],
    })
    expect(inflated).toBeLessThan(useful)
  })
})

// ── REM phase tests ──────────────────────────────────────────────

type FakeIndexRow = {
  id: string
  summary: string
  tags: string[]
  sensitivity: 'public' | 'internal' | 'confidential'
}

function makeFakeIndex(count: number, types: string[] = ['identity', 'preference', 'context']): FakeIndexRow[] {
  // Post-Phase-4 (retire-memory-type): the `type` field is gone from
  // FakeIndexRow. Caller-supplied `types[]` rotates into tags as a
  // coarse diversity signal so the REM "distinct clusters" gate fires.
  return Array.from({ length: count }, (_, i) => ({
    id: `mem-${String(i).padStart(3, '0')}`,
    summary: `Memory ${i} about topic ${i}`,
    tags: [types[i % types.length], `tag-${i}`],
    sensitivity: 'internal',
  }))
}

function makeREMStore(index: FakeIndexRow[]): MemoryStore & {
  created: Array<{ summary: string; detail: string | null; sensitivity: 'public' | 'internal' | 'confidential' }>
  deleted: string[]
  updates: Array<{ id: string; summary?: string; detail?: string }>
  logs: Array<{ phase: string; memoriesAffected: string[] }>
} {
  const created: Array<{ summary: string; detail: string | null; sensitivity: 'public' | 'internal' | 'confidential' }> = []
  const deleted: string[] = []
  const updates: Array<{ id: string; summary?: string; detail?: string }> = []
  const logs: Array<{ phase: string; memoriesAffected: string[] }> = []
  // Track detail state so EXTENDS merges see current value.
  const detailById = new Map<string, string | null>()
  const notImpl = () => { throw new Error('not used') }
  return {
    created,
    deleted,
    updates,
    logs,
    async getIndex() { return index },
    async getIndexSystem() { return index },
    async getWorkspaceIndexSystem() { return [] },
    async getIndexRanked() { return { rows: [], totalCount: 0 } },
    async getById(_ctx, id) {
      const row = index.find((r) => r.id === id)
      if (!row) return null
      return {
        id: row.id,

        scope: 'shared',
        summary: row.summary,
        detail: detailById.get(id) ?? null,
        tags: row.tags,
        confidence: 0.8,
        sensitivity: row.sensitivity,
      }
    },
    async getByIdSystem(id) {
      const row = index.find((r) => r.id === id)
      if (!row) return null
      return {
        id: row.id,

        scope: 'shared',
        summary: row.summary,
        detail: detailById.get(id) ?? null,
        tags: row.tags,
        confidence: 0.8,
        sensitivity: row.sensitivity,
      }
    },
    async update(id, updatesIn) {
      updates.push({ id, summary: updatesIn.summary, detail: updatesIn.detail })
      if (updatesIn.detail !== undefined) detailById.set(id, updatesIn.detail)
      const row = index.find((r) => r.id === id)
      if (!row) return null
      return {
        id: row.id,

        scope: 'shared',
        summary: updatesIn.summary ?? row.summary,
        detail: detailById.get(id) ?? null,
        tags: row.tags,
        confidence: 0.8,
        sensitivity: row.sensitivity,
      }
    },
    async create(params) {
      const record = {
        id: `new-${created.length}`,
        summary: params.summary!,
        detail: params.detail ?? null,
        tags: [],
        confidence: 0.6,
        scope: 'shared',
        sensitivity: params.sensitivity,
      }
      created.push({ summary: params.summary!, detail: params.detail ?? null, sensitivity: params.sensitivity })
      return record
    },
    async deleteMemory(id) { deleted.push(id) },
    async logConsolidation(params) { logs.push({ phase: params.phase, memoriesAffected: params.memoriesAffected }) },
    async listCronContextCandidatesForPrune() { return [] },
    // Unused
    search: notImpl as never,
    getIdentity: notImpl as never,
    trackRecall: notImpl as never,
    trackRecallOutcome: notImpl as never,
    getWorkspaceIdentity: notImpl as never,
    getWorkspaceIndex: notImpl as never,
    getWorkspaceMemoriesByCategory: notImpl as never,
    searchTeam: notImpl as never,
    listWorkspaceMemoryGroups: notImpl as never,
    listTeamWithMetrics: notImpl as never,
    getLastWorkspacePhaseAt: notImpl as never,
    logWorkspaceConsolidation: notImpl as never,
    count: notImpl as never,
    getSoul: async () => null,
    listOpenCommitments: async () => [],
    listForReflection: async () => [],
    listWithMetrics: notImpl as never,
    writeConsolidationScore: notImpl as never,
    listForSoulSynthesis: notImpl as never,
    upsertSoul: notImpl as never,
    upsertDomainSummary: notImpl as never,
    pruneStaleDomainSummaries: notImpl as never,
    listMemoryUsers: notImpl as never,
    getLastPhaseAt: notImpl as never,
    hasRecentActivity: notImpl as never,
  }
}

/**
 * Build a minimal REM LLM response in the new structured format.
 * `ids` are the CONNECTS ids, optional `extendsId` + `detail`.
 */
function remBlock(opts: { summary: string; ids: string[]; detail?: string; extendsId?: string }): string {
  const lines = [`SUMMARY: ${opts.summary}`]
  if (opts.detail !== undefined) lines.push(`DETAIL: ${opts.detail}`)
  lines.push(`CONNECTS: ${opts.ids.join(', ')}`)
  if (opts.extendsId !== undefined) lines.push(`EXTENDS: ${opts.extendsId}`)
  return lines.join('\n')
}

describe('[COMP:consolidation/phases] REM phase guards', () => {
  it('skips when fewer than 15 memories', async () => {
    const store = makeREMStore(makeFakeIndex(10))
    const result = await runREMConsolidation(store, 'a1', 'u1', async () => 'NO_PATTERNS')
    expect(result.summary).toContain('Too few memories')
    expect(store.created).toHaveLength(0)
  })

  it('skips when fewer than 3 distinct tag clusters', async () => {
    // Post-Phase-4 (retire-memory-type): the REM diversity gate keys
    // on distinct tag-clusters instead of distinct types. 15 memories
    // but only 2 tag-buckets.
    const store = makeREMStore(makeFakeIndex(15, ['identity', 'preference']))
    const result = await runREMConsolidation(store, 'a1', 'u1', async () => 'NO_PATTERNS')
    expect(result.summary).toContain('Too few memory clusters')
    expect(store.created).toHaveLength(0)
  })

  it('creates at most 3 connection memories', async () => {
    const store = makeREMStore(makeFakeIndex(30))
    const llmOutput = Array.from({ length: 10 }, (_, i) =>
      remBlock({ summary: `Unique pattern number ${i} about completely different topic ${i}`, ids: [`mem-${i * 2}`, `mem-${i * 2 + 1}`] }),
    ).join('\n\n')
    const result = await runREMConsolidation(store, 'a1', 'u1', async () => llmOutput)
    expect(store.created.length).toBeLessThanOrEqual(3)
    expect(result.summary).toMatch(/Found [1-3] cross-domain patterns/)
  })

  it('deduplicates similar patterns before writing', async () => {
    const store = makeREMStore(makeFakeIndex(30))
    const llmOutput = [
      remBlock({ summary: 'User loves cooking Italian food', ids: ['mem-000', 'mem-001'] }),
      remBlock({ summary: 'User loves cooking Italian food and pasta', ids: ['mem-002', 'mem-003'] }),
      remBlock({ summary: 'Something completely different about travel', ids: ['mem-004', 'mem-005'] }),
    ].join('\n\n')
    await runREMConsolidation(store, 'a1', 'u1', async () => llmOutput)
    // The two Italian cooking patterns are ≥ 70% similar — only one should survive
    expect(store.created.length).toBe(2)
  })

  it('excludes existing connection memories from LLM input but shows them in EXISTING block', async () => {
    const index = [
      // 15 non-connection memories to meet threshold
      ...makeFakeIndex(15),
      // Post-migration 162: REM outputs are `context` carrying the
      // `consolidation:rem` provenance tag (was ``).
      { id: 'conn-1', summary: 'A prior connection', tags: ['consolidation:rem'], sensitivity: 'internal' as const },
      { id: 'conn-2', summary: 'Another prior connection', tags: ['consolidation:rem'], sensitivity: 'internal' as const },
    ]
    const store = makeREMStore(index)
    let promptReceived = ''
    await runREMConsolidation(store, 'a1', 'u1', async (prompt) => {
      promptReceived = prompt
      return 'NO_PATTERNS'
    })
    // Connection summaries appear in the EXISTING block so the model can extend
    expect(promptReceived).toContain('EXISTING CONNECTIONS')
    expect(promptReceived).toContain('A prior connection')
    expect(promptReceived).toContain('Another prior connection')
    // But they do NOT appear in the USER-GENERATED MEMORIES section
    const userBlock = promptReceived.split('EXISTING CONNECTIONS')[0]
    expect(userBlock).not.toContain('A prior connection')
    expect(userBlock).not.toContain('Another prior connection')
    // Non-connection memories should still be present in the user-generated block
    expect(userBlock).toContain('mem-000')
  })

  it('shows "(none yet)" in EXISTING CONNECTIONS block when no prior connections', async () => {
    const store = makeREMStore(makeFakeIndex(15))
    let promptReceived = ''
    await runREMConsolidation(store, 'a1', 'u1', async (prompt) => {
      promptReceived = prompt
      return 'NO_PATTERNS'
    })
    expect(promptReceived).toContain('(none yet)')
  })
})

// ── Cross-cycle sensitivity dedup ───────────────────────────────────

describe('[COMP:consolidation/phases] REM cross-cycle dedup by sensitivity', () => {
  it('stamps a new pattern with the max sensitivity of its connected sources', async () => {
    const index: Array<{ id: string; summary: string; tags: string[]; sensitivity: 'public' | 'internal' | 'confidential' }> = [
      { id: 'mem-000-abcdef', summary: 'public fact', tags: [], sensitivity: 'public' },
      { id: 'mem-001-abcdef', summary: 'internal fact', tags: [], sensitivity: 'internal' },
      { id: 'mem-002-abcdef', summary: 'confidential fact', tags: [], sensitivity: 'confidential' },
      ...Array.from({ length: 13 }, (_, i) => ({
        id: `mem-${String(i + 3).padStart(3, '0')}-xxxx`,
        summary: `filler ${i}`,
        // Post-Phase-4 (retire-memory-type): REM diversity gate now
        // keys on tag clusters. Rotate three tags so the gate fires.
        tags: [['follow-up', 'project', 'note'][i % 3]],
        sensitivity: 'public' as const,
      })),
    ]
    const store = makeREMStore(index)
    await runREMConsolidation(store, 'a1', 'u1', async () =>
      remBlock({ summary: 'Some cross-domain insight', ids: ['mem-000-', 'mem-001-', 'mem-002-'] }),
    )
    expect(store.created).toHaveLength(1)
    expect(store.created[0].sensitivity).toBe('confidential')
  })

  it('skips a new candidate when an existing connection at equal-or-lower tier already covers it', async () => {
    const index: Array<{ id: string; summary: string; tags: string[]; sensitivity: 'public' | 'internal' | 'confidential' }> = [
      { id: 'conn-old', summary: 'The user prefers coffee over tea in the morning', tags: ['consolidation:rem'], sensitivity: 'public' },
      ...Array.from({ length: 16 }, (_, i) => ({
        id: `mem-${String(i).padStart(3, '0')}-xxxx`,
        summary: `filler ${i}`,
        // Post-Phase-4: tag-based diversity for the REM gate.
        tags: [['follow-up', 'project', 'note'][i % 3]],
        sensitivity: 'confidential' as const,
      })),
    ]
    const store = makeREMStore(index)
    await runREMConsolidation(store, 'a1', 'u1', async () =>
      remBlock({ summary: 'The user prefers coffee over tea in the morning', ids: ['mem-000-', 'mem-001-'] }),
    )
    // The new candidate duplicates the existing public connection. The new
    // would be stamped confidential (sources are confidential); the existing
    // public row is broader — keep it, drop the new, don't delete.
    expect(store.created).toHaveLength(0)
    expect(store.deleted).toHaveLength(0)
  })

  it('deletes a higher-tier existing connection when a new lower-tier duplicate arrives', async () => {
    const index: Array<{ id: string; summary: string; tags: string[]; sensitivity: 'public' | 'internal' | 'confidential' }> = [
      { id: 'conn-old', summary: 'The user prefers coffee over tea in the morning', tags: ['consolidation:rem'], sensitivity: 'confidential' },
      ...Array.from({ length: 16 }, (_, i) => ({
        id: `mem-${String(i).padStart(3, '0')}-xxxx`,
        summary: `filler ${i}`,
        // Post-Phase-4: tag-based diversity for the REM gate.
        tags: [['follow-up', 'project', 'note'][i % 3]],
        sensitivity: 'public' as const,
      })),
    ]
    const store = makeREMStore(index)
    await runREMConsolidation(store, 'a1', 'u1', async () =>
      remBlock({ summary: 'The user prefers coffee over tea in the morning', ids: ['mem-000-', 'mem-001-'] }),
    )
    // New pattern's sources are all public → stamped public. Existing is
    // confidential. Broaden visibility: delete the confidential, write the public.
    expect(store.deleted).toContain('conn-old')
    expect(store.created).toHaveLength(1)
    expect(store.created[0].sensitivity).toBe('public')
  })
})

// ── REM EXTENDS + split summary/detail ──────────────────────────────

describe('[COMP:consolidation/phases] REM EXTENDS path', () => {
  it('updates an existing connection instead of creating a new one when EXTENDS points at it', async () => {
    const index: Array<{ id: string; summary: string; tags: string[]; sensitivity: 'public' | 'internal' | 'confidential' }> = [
      { id: 'conn-old', summary: 'Old summary', tags: ['consolidation:rem'], sensitivity: 'internal' },
      ...makeFakeIndex(15),
    ]
    const store = makeREMStore(index)
    await runREMConsolidation(store, 'a1', 'u1', async () =>
      remBlock({
        summary: 'Refined hook',
        detail: 'Refined full insight with specifics',
        ids: ['mem-000', 'mem-001'],
        extendsId: 'conn-old',
      }),
    )
    expect(store.created).toHaveLength(0)
    expect(store.updates).toHaveLength(1)
    expect(store.updates[0].id).toBe('conn-old')
    expect(store.updates[0].summary).toBe('Refined hook')
    expect(store.updates[0].detail).toContain('Refined full insight')
  })

  it('writes summary and detail into separate columns on new connection creation', async () => {
    const store = makeREMStore(makeFakeIndex(15))
    await runREMConsolidation(store, 'a1', 'u1', async () =>
      remBlock({
        summary: 'Short hook',
        detail: 'Longer paragraph explaining the pattern with specifics about the user.',
        ids: ['mem-000', 'mem-001'],
      }),
    )
    expect(store.created).toHaveLength(1)
    expect(store.created[0].summary).toBe('Short hook')
    expect(store.created[0].detail).toContain('Longer paragraph')
  })

  it('falls through to new-pattern creation when EXTENDS id does not resolve', async () => {
    const store = makeREMStore(makeFakeIndex(15))
    await runREMConsolidation(store, 'a1', 'u1', async () =>
      remBlock({
        summary: 'New pattern',
        ids: ['mem-000', 'mem-001'],
        extendsId: 'nonexistent',
      }),
    )
    expect(store.updates).toHaveLength(0)
    expect(store.created).toHaveLength(1)
  })

  it('truncates oversized summary and detail to the configured caps', async () => {
    const store = makeREMStore(makeFakeIndex(15))
    const longSummary = 'a'.repeat(300)
    const longDetail = 'b'.repeat(1200)
    await runREMConsolidation(store, 'a1', 'u1', async () =>
      remBlock({ summary: longSummary, detail: longDetail, ids: ['mem-000', 'mem-001'] }),
    )
    expect(store.created).toHaveLength(1)
    expect(store.created[0].summary.length).toBeLessThanOrEqual(100)
    expect(store.created[0].detail!.length).toBeLessThanOrEqual(500)
  })
})

// ── REM logConsolidation ID resolution ───────────────────────────
//
// Regression: the model is shown 8-char prefixes of memory UUIDs and emits
// those prefixes back in CONNECTS. They were being pushed into the
// `memoriesAffected` array unchanged and then handed to a `uuid[]` column,
// causing every REM tick to fail with "invalid input syntax for type uuid".

describe('[COMP:consolidation/phases] REM logConsolidation ID resolution', () => {
  function uuidIndex(count: number): FakeIndexRow[] {
    // Shape that mirrors production: full UUIDs with distinct 8-char
    // prefixes (mirroring real random UUIDs) — that's what the model
    // sees in the prompt and echoes back in CONNECTS.
    return Array.from({ length: count }, (_, i) => {
      const prefix = `${String(i).padStart(2, '0')}45c1dd`
      return {
        id: `${prefix}-${String(i).padStart(4, '0')}-4f7a-9c3e-${String(i).padStart(12, '0')}`,
        type: ['identity', 'preference', 'context'][i % 3],
        summary: `Memory ${i} about topic ${i}`,
        tags: [`tag-${i}`],
        sensitivity: 'internal' as const,
      }
    })
  }

  it('resolves 8-char prefixes back to full UUIDs before logging', async () => {
    const index = uuidIndex(15)
    const store = makeREMStore(index)
    // Model emits the prefixes it was shown.
    const prefix0 = index[0].id.slice(0, 8)
    const prefix1 = index[1].id.slice(0, 8)
    await runREMConsolidation(store, 'a1', 'u1', async () =>
      remBlock({ summary: 'Some cross-domain pattern', ids: [prefix0, prefix1] }),
    )
    expect(store.logs).toHaveLength(1)
    // Every entry must be a full UUID — Postgres uuid[] would reject prefixes.
    for (const id of store.logs[0].memoriesAffected) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    }
    expect(store.logs[0].memoriesAffected).toEqual(
      expect.arrayContaining([index[0].id, index[1].id]),
    )
  })

  it('drops prefixes that do not resolve to any memory', async () => {
    const index = uuidIndex(15)
    const store = makeREMStore(index)
    const realPrefix = index[0].id.slice(0, 8)
    await runREMConsolidation(store, 'a1', 'u1', async () =>
      remBlock({ summary: 'Pattern with one bogus id', ids: [realPrefix, 'deadbeef'] }),
    )
    expect(store.logs).toHaveLength(1)
    expect(store.logs[0].memoriesAffected).toEqual([index[0].id])
  })

  it('on EXTENDS, logs full UUIDs for both target and connected sources', async () => {
    const connectionId = '11111111-2222-4333-8444-555555555555'
    const index: FakeIndexRow[] = [
      { id: connectionId, summary: 'Existing pattern', tags: ['consolidation:rem'], sensitivity: 'internal' },
      ...uuidIndex(15),
    ]
    const store = makeREMStore(index)
    const sourcePrefix = index[1].id.slice(0, 8)
    const sourcePrefix2 = index[2].id.slice(0, 8)
    await runREMConsolidation(store, 'a1', 'u1', async () =>
      remBlock({
        summary: 'Refined hook',
        detail: 'Refined detail',
        ids: [sourcePrefix, sourcePrefix2],
        extendsId: connectionId.slice(0, 8),
      }),
    )
    expect(store.logs).toHaveLength(1)
    for (const id of store.logs[0].memoriesAffected) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    }
    expect(store.logs[0].memoriesAffected).toEqual(
      expect.arrayContaining([connectionId, index[1].id, index[2].id]),
    )
  })
})

// ── REM LLM output parsing edge cases ────────────────────────────

describe('[COMP:consolidation/phases] REM LLM output parsing', () => {
  it('handles NO_PATTERNS response', async () => {
    const store = makeREMStore(makeFakeIndex(15))
    const result = await runREMConsolidation(store, 'a1', 'u1', async () => 'NO_PATTERNS')
    expect(store.created).toHaveLength(0)
    expect(result.summary).toBe('Found 0 cross-domain patterns')
  })

  it('handles empty response', async () => {
    const store = makeREMStore(makeFakeIndex(15))
    const result = await runREMConsolidation(store, 'a1', 'u1', async () => '')
    expect(store.created).toHaveLength(0)
    expect(result.summary).toBe('Found 0 cross-domain patterns')
  })

  it('ignores SUMMARY without a following CONNECTS line', async () => {
    const store = makeREMStore(makeFakeIndex(15))
    const llmOutput = [
      'SUMMARY: User likes coffee',
      'DETAIL: Just detail, no connects',
      '',
      'SUMMARY: User likes tea',
      'CONNECTS: mem-000, mem-001',
    ].join('\n')
    await runREMConsolidation(store, 'a1', 'u1', async () => llmOutput)
    // Only the second block has a valid CONNECTS line
    expect(store.created).toHaveLength(1)
    expect(store.created[0].summary).toBe('User likes tea')
  })

  it('ignores CONNECTS with fewer than 2 IDs', async () => {
    const store = makeREMStore(makeFakeIndex(15))
    const llmOutput = [
      remBlock({ summary: 'Only one ID', ids: ['mem-000'] }),
      remBlock({ summary: 'Valid pattern', ids: ['mem-001', 'mem-002'] }),
    ].join('\n\n')
    await runREMConsolidation(store, 'a1', 'u1', async () => llmOutput)
    expect(store.created).toHaveLength(1)
    expect(store.created[0].summary).toBe('Valid pattern')
  })

  it('ignores lowercase "summary:" (strict prefix matching)', async () => {
    const store = makeREMStore(makeFakeIndex(15))
    const llmOutput = [
      'summary: This uses lowercase',
      'CONNECTS: mem-000, mem-001',
      '',
      'SUMMARY: This is correct',
      'CONNECTS: mem-004, mem-005',
    ].join('\n')
    await runREMConsolidation(store, 'a1', 'u1', async () => llmOutput)
    // Only exact "SUMMARY:" prefix is matched
    expect(store.created).toHaveLength(1)
    expect(store.created[0].summary).toBe('This is correct')
  })

  it('handles extra whitespace in CONNECTS IDs', async () => {
    const store = makeREMStore(makeFakeIndex(15))
    const llmOutput = [
      'SUMMARY: Whitespace test',
      'CONNECTS:  mem-000 ,  mem-001 ,  mem-002  ',
    ].join('\n')
    await runREMConsolidation(store, 'a1', 'u1', async () => llmOutput)
    expect(store.created).toHaveLength(1)
  })

  it('handles LLM preamble before SUMMARY lines', async () => {
    const store = makeREMStore(makeFakeIndex(15))
    const llmOutput = [
      'Here are the patterns I found across the memories:',
      '',
      'SUMMARY: The actual pattern',
      'CONNECTS: mem-000, mem-001',
    ].join('\n')
    await runREMConsolidation(store, 'a1', 'u1', async () => llmOutput)
    expect(store.created).toHaveLength(1)
    expect(store.created[0].summary).toBe('The actual pattern')
  })

  it('records connected IDs in memoriesAffected', async () => {
    const store = makeREMStore(makeFakeIndex(15))
    const llmOutput = remBlock({ summary: 'A connection', ids: ['mem-000', 'mem-001', 'mem-002'] })
    const result = await runREMConsolidation(store, 'a1', 'u1', async () => llmOutput)
    expect(result.memoriesAffected).toEqual(['mem-000', 'mem-001', 'mem-002'])
  })

  it('treats EXTENDS: none as a fresh pattern', async () => {
    const store = makeREMStore(makeFakeIndex(15))
    const llmOutput = [
      'SUMMARY: Fresh pattern',
      'CONNECTS: mem-000, mem-001',
      'EXTENDS: none',
    ].join('\n')
    await runREMConsolidation(store, 'a1', 'u1', async () => llmOutput)
    expect(store.created).toHaveLength(1)
    expect(store.updates).toHaveLength(0)
  })
})

// ── Light merge — dedup + length cap ─────────────────────────────────
//
// Regression tests for the 2026-04-29 OOM. Two compounding bugs caused
// it: (1) merge concatenated unboundedly, (2) prune-marked memories
// kept reappearing in the index for re-merge over 30 days.
//
// Fixes verified here:
//   - mergeDetails dedups at line level so repeated merges don't add
//     duplicate content
//   - mergeDetails caps total at MERGED_DETAIL_MAX_CHARS = 16384
// The SQL-level `confidence > 0` filter that prevents re-merge is
// verified by integration tests against the real store.

describe('[COMP:consolidation/phases] Light merge detail cap', () => {
  it('dedups identical lines instead of appending duplicates', async () => {
    const a = {
      id: 'mem-a', summary: 'likes Threads',
      detail: 'Hinson likes Threads\nHe posts daily',
      tags: [], confidence: 0.7, scope: 'shared', sensitivity: 'internal' as const,
    }
    // b's first line duplicates a's first line; only the second line is new.
    const b = {
      id: 'mem-b', summary: 'likes Threads',
      detail: 'Hinson likes Threads\nHe avoids ads',
      tags: [], confidence: 0.6, scope: 'shared', sensitivity: 'internal' as const,
    }
    const updates: Array<{ id: string; patch: { detail?: string | undefined; confidence?: number } }> = []
    const notImpl = (..._args: unknown[]) => { throw new Error('not implemented') }
    const store: MemoryStore = {
      async getIndex() {
        return [a, b].map((m) => ({ id: m.id, summary: m.summary, tags: m.tags, sensitivity: m.sensitivity }))
      },
      async getById(_ctx, id) { return id === 'mem-a' ? a : id === 'mem-b' ? b : null },
      async getByIdSystem(id) { return id === 'mem-a' ? a : id === 'mem-b' ? b : null },
      async getIndexSystem() { return [a, b].map((m) => ({ id: m.id, summary: m.summary, tags: m.tags, sensitivity: m.sensitivity })) },
      async getWorkspaceIndexSystem() { return [] },
      async update(id, patch) { updates.push({ id, patch }); return null },
      async logConsolidation() {},
      async listCronContextCandidatesForPrune() { return [] },
      getIndexRanked: notImpl as never, search: notImpl as never, getIdentity: notImpl as never,
      create: notImpl as never, deleteMemory: notImpl as never,
      trackRecall: notImpl as never, trackRecallOutcome: notImpl as never,
      getWorkspaceIdentity: notImpl as never, getWorkspaceIndex: notImpl as never,
      getWorkspaceMemoriesByCategory: notImpl as never, searchTeam: notImpl as never,
      listWorkspaceMemoryGroups: notImpl as never, listTeamWithMetrics: notImpl as never,
      getLastWorkspacePhaseAt: notImpl as never, logWorkspaceConsolidation: notImpl as never,
      count: notImpl as never, getSoul: async () => null,
      listWithMetrics: notImpl as never, writeConsolidationScore: notImpl as never,
      listForSoulSynthesis: notImpl as never, upsertSoul: notImpl as never,
      upsertDomainSummary: notImpl as never, pruneStaleDomainSummaries: notImpl as never,
      listMemoryUsers: notImpl as never, getLastPhaseAt: notImpl as never,
      hasRecentActivity: notImpl as never,
      listForReflection: notImpl as never,
    listOpenCommitments: notImpl as never,
    }

    await runLightConsolidation(store, 'a1', 'u1')

    const detailUpdate = updates.find((u) => u.id === 'mem-a' && u.patch.detail !== undefined)
    expect(detailUpdate).toBeDefined()
    const merged = detailUpdate!.patch.detail!
    // Only 3 unique lines total (Hinson likes Threads, He posts daily, He avoids ads)
    expect(merged.split('\n')).toEqual([
      'Hinson likes Threads',
      'He posts daily',
      'He avoids ads',
    ])
    // The duplicate line appears exactly once
    expect((merged.match(/Hinson likes Threads/g) ?? []).length).toBe(1)
  })

  it('truncates merged detail above ~16 KB', async () => {
    // Two memories with identical summaries (similarity = 1.0, well above
    // the 0.9 threshold), so Light will merge them.
    const a = {
      id: 'mem-a', summary: 'Hinson likes Threads',
      detail: 'A'.repeat(20_000), // 20 KB — already past the cap on its own
      tags: [], confidence: 0.7, scope: 'shared', sensitivity: 'internal' as const,
    }
    const b = {
      id: 'mem-b', summary: 'Hinson likes Threads',
      detail: 'B'.repeat(20_000),
      tags: [], confidence: 0.6, scope: 'shared', sensitivity: 'internal' as const,
    }
    const updates: Array<{ id: string; patch: { detail?: string | undefined; confidence?: number } }> = []
    const notImpl = (..._args: unknown[]) => { throw new Error('not implemented') }
    const store: MemoryStore = {
      async getIndex() {
        return [a, b].map((m) => ({ id: m.id, summary: m.summary, tags: m.tags, sensitivity: m.sensitivity }))
      },
      async getById(_ctx, id) { return id === 'mem-a' ? a : id === 'mem-b' ? b : null },
      async getByIdSystem(id) { return id === 'mem-a' ? a : id === 'mem-b' ? b : null },
      async getIndexSystem() { return [a, b].map((m) => ({ id: m.id, summary: m.summary, tags: m.tags, sensitivity: m.sensitivity })) },
      async getWorkspaceIndexSystem() { return [] },
      async update(id, patch) { updates.push({ id, patch }); return null },
      async logConsolidation() {},
      async listCronContextCandidatesForPrune() { return [] },
      // Unused on the Light path
      getIndexRanked: notImpl as never,
      search: notImpl as never,
      getIdentity: notImpl as never,
      create: notImpl as never,
      deleteMemory: notImpl as never,
      trackRecall: notImpl as never,
      trackRecallOutcome: notImpl as never,
      getWorkspaceIdentity: notImpl as never,
      getWorkspaceIndex: notImpl as never,
      getWorkspaceMemoriesByCategory: notImpl as never,
      searchTeam: notImpl as never,
      listWorkspaceMemoryGroups: notImpl as never,
      listTeamWithMetrics: notImpl as never,
      getLastWorkspacePhaseAt: notImpl as never,
      logWorkspaceConsolidation: notImpl as never,
      count: notImpl as never,
      getSoul: async () => null,
      listWithMetrics: notImpl as never,
      writeConsolidationScore: notImpl as never,
      listForSoulSynthesis: notImpl as never,
      upsertSoul: notImpl as never,
      upsertDomainSummary: notImpl as never,
      pruneStaleDomainSummaries: notImpl as never,
      listMemoryUsers: notImpl as never,
      getLastPhaseAt: notImpl as never,
      hasRecentActivity: notImpl as never,
      listForReflection: notImpl as never,
    listOpenCommitments: notImpl as never,
    }

    await runLightConsolidation(store, 'a1', 'u1')

    const detailUpdate = updates.find((u) => u.id === 'mem-a' && u.patch.detail !== undefined)
    expect(detailUpdate, 'mem-a should have received a detail update').toBeDefined()
    const merged = detailUpdate!.patch.detail!
    // Cap is 16384 chars + "\n... [truncated]" suffix; leave a small buffer.
    expect(merged.length).toBeLessThanOrEqual(16_500)
    expect(merged).toMatch(/\[truncated\]$/)
  })
})

describe('[COMP:consolidation/phases] Reflection phase authorship', () => {
  // Regression (2026-07-10 source audit): the reflection create used a
  // type-erasing cast that dropped the required `createdByUserId`, so a
  // WU-4.5-style authorship guard threw on EVERY pattern write and the
  // per-pattern catch swallowed it — reflection memories never persisted.
  // The mock's create mirrors the real store's guard.
  function makeReflectionStore() {
    const created: Array<{
      summary: string
      scope?: string
      source?: string
      createdByUserId?: string
      createdByAssistantId?: string | null
    }> = []
    const workspaceLogs: Array<{ phase: string; memoriesAffected: string[] }> = []
    const notImpl = async () => {
      throw new Error('not implemented')
    }
    const store = {
      async create(params: Parameters<MemoryStore['create']>[0]) {
        if (!params.createdByUserId) {
          throw new Error('createMemory: createdByUserId is required (authorship guard)')
        }
        created.push({
          summary: params.summary,
          scope: params.scope,
          source: params.source,
          createdByUserId: params.createdByUserId,
          createdByAssistantId: params.createdByAssistantId,
        })
        return {
          id: `refl-${created.length}`,
          summary: params.summary,
          detail: params.detail ?? null,
          tags: params.tags ?? [],
          confidence: 0.6,
          scope: params.scope ?? 'shared',
          sensitivity: params.sensitivity,
        } as never
      },
      async listForReflection() {
        return [
          { id: 'v1', action: 'adjust_scope', primitive: 'memory', rowId: 'm1', rowSummary: 'A', reason: null, modelValue: 'workspace', userValue: 'personal', at: new Date() },
          { id: 'v2', action: 'adjust_scope', primitive: 'memory', rowId: 'm2', rowSummary: 'B', reason: null, modelValue: 'workspace', userValue: 'personal', at: new Date() },
          { id: 'v3', action: 'delete', primitive: 'memory', rowId: 'm3', rowSummary: 'C', reason: 'noise', modelValue: null, userValue: null, at: new Date() },
        ]
      },
      async logWorkspaceConsolidation(params: Parameters<MemoryStore['logWorkspaceConsolidation']>[0]) {
        workspaceLogs.push({ phase: params.phase, memoriesAffected: params.memoriesAffected })
      },
      getIndexSystem: notImpl as never,
      getByIdSystem: notImpl as never,
      update: notImpl as never,
      deleteMemory: notImpl as never,
      logConsolidation: notImpl as never,
      listCronContextCandidatesForPrune: notImpl as never,
      search: notImpl as never,
      getIdentity: notImpl as never,
      trackRecall: notImpl as never,
      trackRecallOutcome: notImpl as never,
      getWorkspaceIdentity: notImpl as never,
      getWorkspaceIndex: notImpl as never,
      getWorkspaceMemoriesByCategory: notImpl as never,
      searchTeam: notImpl as never,
      listWorkspaceMemoryGroups: notImpl as never,
      listTeamWithMetrics: notImpl as never,
      getLastWorkspacePhaseAt: notImpl as never,
      count: notImpl as never,
      getSoul: async () => null,
      listOpenCommitments: async () => [],
      listWithMetrics: notImpl as never,
      writeConsolidationScore: notImpl as never,
      listForSoulSynthesis: notImpl as never,
      upsertSoul: notImpl as never,
      upsertDomainSummary: notImpl as never,
      pruneStaleDomainSummaries: notImpl as never,
      listMemoryUsers: notImpl as never,
      getLastPhaseAt: notImpl as never,
      hasRecentActivity: notImpl as never,
    } as unknown as MemoryStore
    return { store, created, workspaceLogs }
  }

  it('persists synthesized patterns with authorship + DB-vocabulary scope', async () => {
    const { store, created, workspaceLogs } = makeReflectionStore()
    const llmOutput = JSON.stringify([
      { summary: 'The user prefers personal scope for behavioural inferences.' },
    ])

    const result = await runReflectionConsolidation(store, async () => llmOutput, {
      workspaceId: 'ws-1',
      assistantId: 'a1',
      userId: 'u1',
    })

    expect(created).toHaveLength(1)
    expect(created[0].createdByUserId).toBe('u1')
    expect(created[0].createdByAssistantId).toBe('a1')
    expect(created[0].source).toBe('reflection')
    // 'team' is the tool-surface alias and violates the memories
    // valid_scope CHECK — the store vocabulary is 'workspace'.
    expect(created[0].scope).toBe('workspace')
    expect(result.memoriesAffected).toHaveLength(1)
    expect(workspaceLogs).toHaveLength(1)
  })
})
