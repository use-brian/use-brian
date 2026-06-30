import { describe, it, expect } from 'vitest'
import { createMemoryTools, type MemoryToolEvent } from '../tools.js'
import type { MemoryStore } from '../types.js'
import type {
  EntityKind,
  EntityLinkCreateParams,
  EntityLinkRecord,
  EntityLinksStore,
  EntityRecord,
  EntityStore,
} from '../../entities/types.js'

type FakeRow = {
  id: string
  assistantId: string
  userId: string
  scope: string
  summary: string
  detail: string | null
  tags: string[]
  confidence: number
  sensitivity: 'public' | 'internal' | 'confidential'
}

function makeFakeStore(): MemoryStore & { rows: FakeRow[] } {
  const rows: FakeRow[] = []
  let nextId = 100
  const store: MemoryStore & { rows: FakeRow[] } = {
    rows,
    async create(params) {
      const row: FakeRow = {
        id: `mem_${nextId++}`,
        assistantId: params.assistantId,
        userId: params.userId,

        scope: params.scope ?? 'shared',
        summary: params.summary,
        detail: params.detail ?? null,
        tags: params.tags ?? [],
        confidence: params.confidence ?? 1.0,
        sensitivity: params.sensitivity,
      }
      rows.push(row)
      return { ...row }
    },
    async update(id, updates) {
      const row = rows.find((r) => r.id === id)
      if (!row) return null
      if (updates.summary !== undefined) row.summary = updates.summary
      if (updates.detail !== undefined) row.detail = updates.detail
      if (updates.tags !== undefined) row.tags = updates.tags
      return { ...row }
    },
    async getById(ctx, id) {
      const row = rows.find((r) => r.id === id)
      if (!row) return null
      if (row.assistantId !== ctx.assistantId || row.userId !== ctx.userId) return null
      return { ...row }
    },
    async getByIdSystem(id) {
      const row = rows.find((r) => r.id === id)
      return row ? { ...row } : null
    },
    async search(ctx, params) {
      const filtered = rows.filter(
        (r) => r.assistantId === ctx.assistantId && r.userId === ctx.userId,
      )
      if (params.idPrefix) {
        return filtered.filter((r) => r.id.startsWith(params.idPrefix!)).slice(0, params.limit)
      }
      if (params.query) {
        return filtered
          .filter((r) => r.summary.toLowerCase().includes(params.query.toLowerCase()))
          .slice(0, params.limit)
      }
      return filtered.slice(0, params.limit)
    },
    async getIdentity(ctx) {
      // Post-Phase-4 (retire-memory-type): no `type` field. The fake
      // returns self-profile-tagged rows as the identity stand-in,
      // mirroring how getIdentityMemories now reads (legacy or
      // self-entity attribute synthesis).
      return rows.filter((r) => r.assistantId === ctx.assistantId && r.userId === ctx.userId && r.tags.includes('self-profile'))
    },
    async getIndex(ctx) {
      return rows
        .filter((r) => r.assistantId === ctx.assistantId && r.userId === ctx.userId)
        .map((r) => ({ id: r.id, summary: r.summary, tags: r.tags, sensitivity: r.sensitivity }))
    },
    async getIndexSystem(assistantId, userId) {
      return rows
        .filter((r) => r.assistantId === assistantId && r.userId === userId)
        .map((r) => ({ id: r.id, summary: r.summary, tags: r.tags, sensitivity: r.sensitivity }))
    },
    async getWorkspaceIndexSystem() { return [] },
    async getIndexRanked() { return { rows: [], totalCount: 0 } },
    async getSoul() { return null },
    async trackRecall() {},
    async trackRecallOutcome() {},
    async count(ctx) {
      return rows.filter((r) => r.assistantId === ctx.assistantId && r.userId === ctx.userId).length
    },
    // Deep-phase methods — not exercised by the memory-tools tests, stubbed.
    async listWithMetrics() { return [] },
    async writeConsolidationScore() {},
    async deleteMemory(id) {
      const idx = rows.findIndex((r) => r.id === id)
      if (idx >= 0) rows.splice(idx, 1)
    },
    async listCronContextCandidatesForPrune() { return [] },
    async listForSoulSynthesis() { return { selfEntityAttributes: null, preferences: [] } },
    async upsertSoul() {},
    async upsertDomainSummary() {},
    async pruneStaleDomainSummaries() { return 0 },
    async logConsolidation() {},
    async listMemoryUsers() { return [] },
    async getLastPhaseAt() { return null },
    async hasRecentActivity() { return true },
    // Team memory methods — not exercised by memory-tools tests
    async getWorkspaceIdentity() { return [] },
    async getWorkspaceIndex() { return [] },
    async getWorkspaceMemoriesByCategory() { return [] },
    async searchTeam() { return [] },
    async listWorkspaceMemoryGroups() { return [] },
    async listTeamWithMetrics() { return [] },
    async getLastWorkspacePhaseAt() { return null },
    async logWorkspaceConsolidation() {},
    async listForReflection() { return [] },
    async listOpenCommitments() { return [] },
  }
  return store
}

const ctx = {
  assistantId: 'assistant_1',
  userId: 'user_1',
  sessionId: 'session_1',
  appId: 'sidanclaw',
  channelType: 'web',
  channelId: 'c_1',
  abortSignal: new AbortController().signal,
}

describe('[COMP:memory/tools] saveMemory', () => {
  it('creates a new memory when no id is provided', async () => {
    const store = makeFakeStore()
    const { saveMemory } = createMemoryTools(store)
    const result = await saveMemory.execute(
      { summary: 'Likes ramen', },
      ctx,
    )
    expect(result.isError).toBeFalsy()
    expect(store.rows).toHaveLength(1)
    expect(store.rows[0].summary).toBe('Likes ramen')
  })

  it('routes people/companies/deals to their own primitive, not a bundled memory', () => {
    // Regression (2026-06-30): a 4-person team roster was saved as a single flat
    // saveMemory blob because only the self-entity had a routing nudge. The tool
    // must steer distinct people to per-person primitives so a normal
    // (non-research) chat turn does not collapse a roster into one memory. The
    // routing lives on the `tags` field note (kept tight for the per-turn token
    // budget), alongside the proven-effective updateSelfProfile self-routing.
    const { saveMemory } = createMemoryTools(makeFakeStore())
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tagsNote: string = (saveMemory.inputSchema as any).shape.tags.description ?? ''
    expect(tagsNote).toMatch(/updateSelfProfile/)
    expect(tagsNote).toMatch(/saveContact/)
    expect(tagsNote).toMatch(/saveCompany/)
    expect(tagsNote).toMatch(/saveDeal/)
    expect(tagsNote).toMatch(/never collapse a team roster/i)
  })

  it('unions injectedTags onto a created memory (workflow tagging)', async () => {
    // The workflow callee passes injectedTags: ['workflow:<id>'] so a written
    // memory is traceable to the workflow — the key behind prior-run visibility.
    const store = makeFakeStore()
    const { saveMemory } = createMemoryTools(store, { injectedTags: ['workflow:wf-123'] })
    await saveMemory.execute({ summary: 'HK SME fact', tags: ['research'] }, ctx)
    expect(store.rows).toHaveLength(1)
    expect(store.rows[0].tags).toEqual(expect.arrayContaining(['research', 'workflow:wf-123']))
  })

  it('does not duplicate an injectedTag the model already supplied', async () => {
    const store = makeFakeStore()
    const { saveMemory } = createMemoryTools(store, { injectedTags: ['workflow:wf-123'] })
    await saveMemory.execute({ summary: 'x', tags: ['workflow:wf-123'] }, ctx)
    expect(store.rows[0].tags.filter((t) => t === 'workflow:wf-123')).toHaveLength(1)
  })

  it('does not apply injectedTags on update (create-only)', async () => {
    const store = makeFakeStore()
    // Seed a row with a plain tool (no injected tag), then update via the
    // workflow-tagging tool: the update path must not stamp the workflow tag.
    await createMemoryTools(store).saveMemory.execute({ summary: 'Original', tags: ['research'] }, ctx)
    const id = store.rows[0].id
    const { saveMemory } = createMemoryTools(store, { injectedTags: ['workflow:wf-123'] })
    await saveMemory.execute({ id, detail: 'more detail' }, ctx)
    expect(store.rows[0].tags).toEqual(['research'])
  })

  it('stamps a research-mode finding public despite internal brain-first reads', async () => {
    // The reported bug: research mode reads internal brain rows (brain-first)
    // before web research, bumping the per-turn accumulator, so public web
    // findings landed `internal`. Research provenance is the public web.
    const { SensitivityAccumulator } = await import('../../security/sensitivity.js')
    const accumulator = new SensitivityAccumulator()
    accumulator.note('internal')

    const store = makeFakeStore()
    const { saveMemory } = createMemoryTools(store)
    await saveMemory.execute(
      { summary: 'Acme raised a $5M seed (TechCrunch)' },
      { ...ctx, sensitivity: accumulator, researchMode: true },
    )
    expect(store.rows[0].sensitivity).toBe('public')
  })

  it('keeps confidential a hard floor in research mode (no laundering)', async () => {
    const { SensitivityAccumulator } = await import('../../security/sensitivity.js')
    const accumulator = new SensitivityAccumulator()
    accumulator.note('confidential')

    const store = makeFakeStore()
    const { saveMemory } = createMemoryTools(store)
    await saveMemory.execute(
      { summary: 'Derived from a confidential source' },
      { ...ctx, sensitivity: accumulator, researchMode: true },
    )
    expect(store.rows[0].sensitivity).toBe('confidential')
  })

  it('inherits the accumulator max on a normal (non-research) turn', async () => {
    const { SensitivityAccumulator } = await import('../../security/sensitivity.js')
    const accumulator = new SensitivityAccumulator()
    accumulator.note('internal')

    const store = makeFakeStore()
    const { saveMemory } = createMemoryTools(store)
    await saveMemory.execute(
      { summary: 'Saved during a normal turn' },
      { ...ctx, sensitivity: accumulator },
    )
    expect(store.rows[0].sensitivity).toBe('internal')
  })

  it('updates an existing memory when id is provided', async () => {
    const store = makeFakeStore()
    const { saveMemory } = createMemoryTools(store)
    await saveMemory.execute({ summary: 'Original', }, ctx)
    const memId = store.rows[0].id
    await saveMemory.execute({ id: memId, summary: 'Updated', }, ctx)
    expect(store.rows).toHaveLength(1)
    expect(store.rows[0].summary).toBe('Updated')
  })

  it('returns an error when updating a non-existent id', async () => {
    const store = makeFakeStore()
    const { saveMemory } = createMemoryTools(store)
    const result = await saveMemory.execute(
      { id: 'mem_does_not_exist', summary: 'x', },
      ctx,
    )
    expect(result.isError).toBe(true)
  })

  it('updates an existing memory when summary is omitted (description says to)', async () => {
    // The tool description tells the model to omit `summary` on update so
    // the existing summary is preserved. The schema must allow it, and the
    // update must succeed without rewriting the summary field.
    const store = makeFakeStore()
    const { saveMemory } = createMemoryTools(store)
    await saveMemory.execute({ summary: 'Original summary', detail: 'old detail' }, ctx)
    const memId = store.rows[0].id
    const result = await saveMemory.execute(
      { id: memId, detail: 'new detail' },
      ctx,
    )
    expect(result.isError).toBeFalsy()
    expect(store.rows).toHaveLength(1)
    expect(store.rows[0].summary).toBe('Original summary')
    expect(store.rows[0].detail).toBe('new detail')
  })

  it('errors when creating without summary', async () => {
    const store = makeFakeStore()
    const { saveMemory } = createMemoryTools(store)
    const result = await saveMemory.execute({ detail: 'orphan detail' }, ctx)
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('requires `summary`')
    expect(store.rows).toHaveLength(0)
  })

  it('enforces 20-memory cap for free plan users', async () => {
    const store = makeFakeStore()
    // Seed 20 memories for this user
    for (let i = 0; i < 20; i++) {
      await store.create({
        assistantId: ctx.assistantId,
        userId: ctx.userId,
      createdByUserId: ctx.userId,
      createdByAssistantId: ctx.assistantId,
        summary: `Memory ${i}`,
        sensitivity: 'internal',
      })
    }
    const { saveMemory } = createMemoryTools(store, { userPlan: 'free' })
    const result = await saveMemory.execute(
      { summary: 'One too many', },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('Memory limit reached')
    // Should still be 20
    expect(store.rows).toHaveLength(20)
  })

  it('does not enforce the 20-memory cap for paid plans', async () => {
    const store = makeFakeStore()
    for (let i = 0; i < 20; i++) {
      await store.create({
        assistantId: ctx.assistantId,
        userId: ctx.userId,
      createdByUserId: ctx.userId,
      createdByAssistantId: ctx.assistantId,
        summary: `Memory ${i}`,
        sensitivity: 'internal',
      })
    }
    const { saveMemory } = createMemoryTools(store, { userPlan: 'pro' })
    const result = await saveMemory.execute(
      { summary: 'Memory 21', },
      ctx,
    )
    expect(result.isError).toBeFalsy()
    expect(store.rows).toHaveLength(21)
  })

  it('emits memory_created event on create', async () => {
    // Post-Phase-4 (retire-memory-type): `memoryType` in the analytics
    // event is now the first tag (or 'untyped'). No tags supplied =>
    // 'untyped'.
    const store = makeFakeStore()
    const events: MemoryToolEvent[] = []
    const { saveMemory } = createMemoryTools(store, { onEvent: (e) => events.push(e) })
    await saveMemory.execute({ summary: 'Likes ramen', }, ctx)
    expect(events).toEqual([{ type: 'memory_created', source: 'model', memoryType: 'untyped' }])
  })

  it('emits memory_updated event on update', async () => {
    const store = makeFakeStore()
    const events: MemoryToolEvent[] = []
    const { saveMemory } = createMemoryTools(store, { onEvent: (e) => events.push(e) })
    await saveMemory.execute({ summary: 'Original', }, ctx)
    const memId = store.rows[0].id
    events.length = 0  // clear
    await saveMemory.execute({ id: memId, summary: 'Updated', }, ctx)
    expect(events).toEqual([{ type: 'memory_updated', memoryId: memId }])
  })

  // ── Scope routing (post-053 model surface: 'user' | 'team') ────

  it('maps scope "user" to DB scope "shared" with no workspaceId', async () => {
    const store = makeFakeStore()
    const { saveMemory } = createMemoryTools(store)
    await saveMemory.execute(
      { summary: 'Likes window seats', scope: 'user' },
      ctx,
    )
    expect(store.rows).toHaveLength(1)
    expect(store.rows[0].scope).toBe('shared')
  })

  it('omitted scope defaults to DB scope "shared"', async () => {
    const store = makeFakeStore()
    const { saveMemory } = createMemoryTools(store)
    await saveMemory.execute({ summary: 'Likes ramen', }, ctx)
    expect(store.rows[0].scope).toBe('shared')
  })

  it('rejects scope "team" when context has no workspaceId', async () => {
    const store = makeFakeStore()
    const { saveMemory } = createMemoryTools(store)
    const result = await saveMemory.execute(
      { summary: 'Project ships May 1', scope: 'team' },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('not part of a team')
    expect(store.rows).toHaveLength(0)
  })

  it('writes DB scope "workspace" with workspace_id set when team context provided', async () => {
    // Migration 110 renamed the DB enum value 'team' → 'workspace' (the
    // valid_scope CHECK allows 'shared' | 'app' | 'workspace'). The
    // model-facing surface still uses 'team' for readability; this test
    // pins the model-side→DB-side translation in saveMemory.
    const store = makeFakeStore()
    const teamCtx = { ...ctx, workspaceId: 'team_42' }
    const { saveMemory } = createMemoryTools(store)
    const result = await saveMemory.execute(
      { summary: 'Project ships May 1', scope: 'team' },
      teamCtx,
    )
    expect(result.isError).toBeFalsy()
    expect(store.rows[0].scope).toBe('workspace')
  })

  // ── UUID round-trip — returning full id + accepting prefix on update.
  // Prod 2026-04-23: model saw `[02eca923]` prefix in response, later
  // passed hallucinated full UUID on update → "not found".
  it('returns the full id (not a prefix) in the save response', async () => {
    const store = makeFakeStore()
    const { saveMemory } = createMemoryTools(store)
    const result = await saveMemory.execute(
      { summary: 'Likes ramen', },
      ctx,
    )
    expect(result.isError).toBeFalsy()
    const fullId = store.rows[0].id
    expect(String(result.data)).toContain(fullId)
  })

  it('accepts an 8-char prefix on update and resolves to the full id', async () => {
    const store = makeFakeStore()
    const { saveMemory } = createMemoryTools(store)
    await saveMemory.execute({ summary: 'Original', }, ctx)
    const fullId = store.rows[0].id
    const prefix = fullId.slice(0, 4) // short prefix (fake store uses short ids)
    const result = await saveMemory.execute(
      { id: prefix, summary: 'Updated via prefix', },
      ctx,
    )
    expect(result.isError).toBeFalsy()
    expect(store.rows[0].summary).toBe('Updated via prefix')
  })

  it('translates Postgres UUID-syntax errors to "memory not found"', async () => {
    const store = makeFakeStore()
    // Mutate store.update to simulate the Postgres error that leaks today
    // when a short prefix is passed to a UUID column without fallback.
    const original = store.update.bind(store)
    store.update = async (id, updates) => {
      if (id.length < 36 && !store.rows.some((r) => r.id === id)) {
        const err = new Error(`invalid input syntax for type uuid: "${id}"`)
        throw err
      }
      return original(id, updates)
    }
    const { saveMemory } = createMemoryTools(store)
    const result = await saveMemory.execute(
      { id: 'notauuid', summary: 'x', },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('not found')
    expect(String(result.data)).not.toContain('invalid input syntax')
  })

  // ── Operational-state payload guard ─────────────────────────
  // See `docs/architecture/context-engine/memory-system.md` →
  // "Write-side operational filter". These assertions pin the behaviour
  // that stops the 2026-04-22 / 2026-04-23 Cynthia pill-loop from
  // re-priming yesterday's deltas onto today's clock.
  describe('rejects operational-state phrasing', () => {
    it('blocks "Nth follow-up sent" in the summary', async () => {
      const store = makeFakeStore()
      const { saveMemory } = createMemoryTools(store)
      const result = await saveMemory.execute(
        {
          summary: 'Pill reminder active (2:00 PM April 23) - 30m overdue, second follow-up sent.',
        },
        ctx,
      )
      expect(result.isError).toBe(true)
      expect(String(result.data)).toContain('operational-state phrasing')
      expect(store.rows).toHaveLength(0)
    })

    it('blocks "N hours overdue" hidden in the detail even when the summary is benign', async () => {
      // The 2026-04-23 failure mode: a "completed" row whose detail carried
      // "2.5 hours overdue" survived the summary-only scan and re-primed
      // the topic on every turn's memory index.
      const store = makeFakeStore()
      const { saveMemory } = createMemoryTools(store)
      const result = await saveMemory.execute(
        {
          summary: 'Pill reminder completed (April 22)',
          detail:
            'Pill reminder for April 22 completed at 4:35 PM HKT (8:35 AM UTC). 2.5 hours overdue.',
        },
        ctx,
      )
      expect(result.isError).toBe(true)
      expect(String(result.data)).toContain('operational-state phrasing')
      expect(store.rows).toHaveLength(0)
    })

    it('allows a benign event memory with no operational phrasing', async () => {
      const store = makeFakeStore()
      const { saveMemory } = createMemoryTools(store)
      const result = await saveMemory.execute(
        {
          summary: 'Pill reminder fired at 14:30 HKT on April 23',
        },
        ctx,
      )
      expect(result.isError).toBeFalsy()
      expect(store.rows).toHaveLength(1)
    })

    it('blocks operational-state phrasing on UPDATE (not just CREATE)', async () => {
      // Updates must be gated too — otherwise the model can create a
      // benign row, then update it with operational phrasing to bypass
      // the write-side filter.
      const store = makeFakeStore()
      const { saveMemory } = createMemoryTools(store)
      await saveMemory.execute({ summary: 'Daily pill', }, ctx)
      const memId = store.rows[0].id
      const result = await saveMemory.execute(
        { id: memId, summary: 'Daily pill — 3rd follow-up sent', },
        ctx,
      )
      expect(result.isError).toBe(true)
      expect(store.rows[0].summary).toBe('Daily pill')
    })
  })
})

describe('[COMP:memory/tools] getMemory', () => {
  it('fetches a memory by full id', async () => {
    const store = makeFakeStore()
    const created = await store.create({
      assistantId: ctx.assistantId,
      userId: ctx.userId,
      createdByUserId: ctx.userId,
      createdByAssistantId: ctx.assistantId,
      summary: 'User is a software engineer',
      sensitivity: 'internal',
    })
    const { getMemory } = createMemoryTools(store)
    const result = await getMemory.execute({ id: created.id }, ctx)
    expect(result.isError).toBeFalsy()
    expect(result.data).toMatchObject({ id: created.id, summary: 'User is a software engineer' })
  })

  it('fetches by id prefix (8-char from memory index)', async () => {
    const store = makeFakeStore()
    const created = await store.create({
      assistantId: ctx.assistantId,
      userId: ctx.userId,
      createdByUserId: ctx.userId,
      createdByAssistantId: ctx.assistantId,
      summary: 'Likes ramen',
      sensitivity: 'internal',
    })
    const prefix = created.id.slice(0, 4)  // short prefix
    const { getMemory } = createMemoryTools(store)
    const result = await getMemory.execute({ id: prefix }, ctx)
    expect(result.isError).toBeFalsy()
    expect(result.data).toMatchObject({ summary: 'Likes ramen' })
  })

  it('returns an error when id is not found', async () => {
    const store = makeFakeStore()
    const { getMemory } = createMemoryTools(store)
    const result = await getMemory.execute({ id: 'mem_missing' }, ctx)
    expect(result.isError).toBe(true)
  })

  it('searches by query keyword', async () => {
    const store = makeFakeStore()
    await store.create({
      assistantId: ctx.assistantId,
      userId: ctx.userId,
      createdByUserId: ctx.userId,
      createdByAssistantId: ctx.assistantId,
      summary: 'Loves Japanese ramen',
      sensitivity: 'internal',
    })
    await store.create({
      assistantId: ctx.assistantId,
      userId: ctx.userId,
      createdByUserId: ctx.userId,
      createdByAssistantId: ctx.assistantId,
      summary: 'Hates pineapple pizza',
      sensitivity: 'internal',
    })
    const { getMemory } = createMemoryTools(store)
    const result = await getMemory.execute({ query: 'ramen' }, ctx)
    expect(result.isError).toBeFalsy()
    expect(Array.isArray(result.data)).toBe(true)
    expect((result.data as Array<{ summary: string }>)).toHaveLength(1)
  })

  it('returns empty-result message when search has no hits', async () => {
    const store = makeFakeStore()
    const { getMemory } = createMemoryTools(store)
    const result = await getMemory.execute({ query: 'nothing-matches' }, ctx)
    expect(result.isError).toBeFalsy()
    expect(result.data).toBe('No matching memories found.')
  })

  it('errors when neither id nor query is provided', async () => {
    const store = makeFakeStore()
    const { getMemory } = createMemoryTools(store)
    const result = await getMemory.execute({}, ctx)
    expect(result.isError).toBe(true)
  })

  it('emits memory_retrieved events', async () => {
    const store = makeFakeStore()
    await store.create({
      assistantId: ctx.assistantId,
      userId: ctx.userId,
      createdByUserId: ctx.userId,
      createdByAssistantId: ctx.assistantId,
      summary: 'Likes ramen',
      sensitivity: 'internal',
    })
    const events: MemoryToolEvent[] = []
    const { getMemory } = createMemoryTools(store, { onEvent: (e) => events.push(e) })
    await getMemory.execute({ query: 'ramen' }, ctx)
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('memory_retrieved')
  })
})

describe('[COMP:memory/tools] deleteMemory', () => {
  it('is built with requiresConfirmation=true and no persistent-approval affordance', () => {
    const store = makeFakeStore()
    const { deleteMemory } = createMemoryTools(store)
    expect(deleteMemory.requiresConfirmation).toBe(true)
    expect(deleteMemory.isReadOnly).toBe(false)
    // Built-in tools don't get Always Allow / Always Deny — each call
    // targets a distinct memory, so a persistent decision is misleading.
    expect(deleteMemory.allowPersistentApproval).toBe(false)
  })

  it('removes a memory by full id', async () => {
    const store = makeFakeStore()
    const { saveMemory, deleteMemory } = createMemoryTools(store)
    await saveMemory.execute({ summary: 'Likes ramen', }, ctx)
    const fullId = store.rows[0].id
    const result = await deleteMemory.execute({ ids: [fullId] }, ctx)
    expect(result.isError).toBeFalsy()
    expect(store.rows).toHaveLength(0)
  })

  it('accepts an 8-char prefix and resolves to the matching row', async () => {
    const store = makeFakeStore()
    const { saveMemory, deleteMemory } = createMemoryTools(store)
    await saveMemory.execute({ summary: 'Likes ramen', }, ctx)
    const prefix = store.rows[0].id.slice(0, 4) // fake store uses short ids
    const result = await deleteMemory.execute({ ids: [prefix] }, ctx)
    expect(result.isError).toBeFalsy()
    expect(store.rows).toHaveLength(0)
  })

  it('batches multiple ids in a single call', async () => {
    const store = makeFakeStore()
    const { saveMemory, deleteMemory } = createMemoryTools(store)
    await saveMemory.execute({ summary: 'Pill reminder 1', }, ctx)
    await saveMemory.execute({ summary: 'Pill reminder 2', }, ctx)
    await saveMemory.execute({ summary: 'Pill reminder 3', }, ctx)
    const ids = store.rows.map((r) => r.id)
    const result = await deleteMemory.execute({ ids }, ctx)
    expect(result.isError).toBeFalsy()
    expect(store.rows).toHaveLength(0)
    expect(String(result.data)).toContain('3 memories')
  })

  it('returns an error when no ids match', async () => {
    const store = makeFakeStore()
    const { deleteMemory } = createMemoryTools(store)
    const result = await deleteMemory.execute({ ids: ['mem_missing'] }, ctx)
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('Not found')
  })

  it('deletes found ids and reports missing ones when the batch is mixed', async () => {
    const store = makeFakeStore()
    const { saveMemory, deleteMemory } = createMemoryTools(store)
    await saveMemory.execute({ summary: 'Real memory', }, ctx)
    const realId = store.rows[0].id
    const result = await deleteMemory.execute({ ids: [realId, 'mem_missing'] }, ctx)
    expect(result.isError).toBeFalsy()
    expect(store.rows).toHaveLength(0)
    expect(String(result.data)).toContain('1 memory')
    expect(String(result.data)).toContain('Not found')
  })

  it('describeConfirmation surfaces memory summaries instead of ids', async () => {
    const store = makeFakeStore()
    const { saveMemory, deleteMemory } = createMemoryTools(store)
    await saveMemory.execute({ summary: 'Likes ramen', }, ctx)
    await saveMemory.execute({ summary: 'Hates pineapple pizza', }, ctx)
    const ids = store.rows.map((r) => r.id)
    const lines = await deleteMemory.describeConfirmation!({ ids }, ctx)
    expect(lines).toEqual(['• Likes ramen', '• Hates pineapple pizza'])
  })

  it('describeConfirmation marks unknown ids explicitly', async () => {
    const store = makeFakeStore()
    const { deleteMemory } = createMemoryTools(store)
    const lines = await deleteMemory.describeConfirmation!({ ids: ['mem_ghost'] }, ctx)
    expect(lines).toEqual(['• (not found: mem_ghost)'])
  })

  it('emits a memory_deleted event per deleted row', async () => {
    const store = makeFakeStore()
    const events: MemoryToolEvent[] = []
    const { saveMemory, deleteMemory } = createMemoryTools(store, { onEvent: (e) => events.push(e) })
    await saveMemory.execute({ summary: 'A', }, ctx)
    await saveMemory.execute({ summary: 'B', }, ctx)
    const ids = store.rows.map((r) => r.id)
    events.length = 0 // clear the create events
    await deleteMemory.execute({ ids }, ctx)
    expect(events).toEqual([
      { type: 'memory_deleted', memoryId: ids[0] },
      { type: 'memory_deleted', memoryId: ids[1] },
    ])
  })
})

// ── CRM-note path (WU-6.12) ──────────────────────────────────────────
// Spec: docs/architecture/brain/corrections.md §"CRM notes via memory".
// saveMemory with `entityId` anchors the memory as a per-entity note via
// entity_links (source=memory, target=entity, edge=mentioned) plus the
// 'note' tag.

type FakeLinkRow = EntityLinkCreateParams & { id: string; createdAt: Date }

function makeFakeEntityStore(seed: Array<Pick<EntityRecord, 'id' | 'kind' | 'displayName'>>): EntityStore {
  const byId = new Map<string, EntityRecord>()
  for (const e of seed) {
    byId.set(e.id, {
      id: e.id,
      kind: e.kind as EntityKind,
      displayName: e.displayName,
      canonicalId: null,
      aliases: [],
      attributes: {},
      sensitivity: 'internal',
      workspaceId: 'team_42',
      userId: 'user_1',
      assistantId: null,
      createdByUserId: 'user_1',
      createdByAssistantId: null,
      sourceEpisodeId: null,
      source: 'user',
      verifiedByUserId: null,
      verifiedAt: null,
      validFrom: new Date(),
      validTo: null,
      supersededBy: null,
      retractedAt: null,
      retractedReason: null,
      retractedBy: null,
      centrality: 0,
      centralityComputedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  }
  // Only `getById` is exercised by saveMemory's note path; the rest are
  // stubs so the EntityStore type checks.
  return {
    async create() {
      throw new Error('not used in note tests')
    },
    async getById(_ctx, id) {
      return byId.get(id) ?? null
    },
    async findByName() { return null },
    async findByNameSystem() { return null },
    async findByCanonicalId() { return [] },
    async findByCanonicalIdSystem() { return [] },
    async listForWorkspace() { return [] },
    async update() { return null },
    async supersedeAttributes() { return null },
    async getEntity() { return null },
    async findDuplicateClustersSystem() { return [] },
    async findCrossKindDuplicateClustersSystem() { return [] },
    async listLiveEntitiesSystem() { return [] },
    async addAlias() { return { kind: 'not_found' as const } },
    async removeAlias() { return null },
    async getOrCreateSelf() {
      throw new Error('not used in note tests')
    },
    async updateSelfProfile() {
      throw new Error('not used in note tests')
    },
  }
}

function makeFakeEntityLinksStore(): EntityLinksStore & { links: FakeLinkRow[] } {
  const links: FakeLinkRow[] = []
  let nextLinkId = 1
  return {
    links,
    async create(params) {
      const row: FakeLinkRow = { id: `link_${nextLinkId++}`, createdAt: new Date(), ...params }
      links.push(row)
      // Return a fully-populated EntityLinkRecord shape; the tool only
      // reads the link as a side effect, so most fields are placeholder.
      const record: EntityLinkRecord = {
        id: row.id,
        sourceKind: params.sourceKind,
        sourceId: params.sourceId,
        targetKind: params.targetKind,
        targetId: params.targetId,
        edgeType: params.edgeType,
        attributes: params.attributes ?? {},
        source: params.source,
        verifiedByUserId: null,
        verifiedAt: null,
        validFrom: new Date(),
        validTo: null,
        retractedAt: null,
        retractedReason: null,
        sourceEpisodeId: params.sourceEpisodeId ?? null,
        sensitivity: params.sensitivity ?? 'internal',
        workspaceId: params.workspaceId,
        userId: params.userId ?? null,
        assistantId: params.assistantId ?? null,
        createdAt: row.createdAt,
      }
      return record
    },
    async getById() { return null },
    async walkOutbound() { return [] },
    async walkInbound() { return [] },
    async countForEntity() { return 0 },
    async listForWorkspace() { return [] },
    async closeAt() { return null },
    async retract() { return null },
  }
}

const teamCtx = { ...ctx, workspaceId: 'team_42' }
const PERSON_ID = '11111111-1111-1111-1111-111111111111'
const PROJECT_ID = '22222222-2222-2222-2222-222222222222'

describe('[COMP:crm/notes-via-memory] saveMemory CRM-note anchoring', () => {
  it('creates a memory tagged "note" and a memory→entity link when entityId is provided', async () => {
    const store = makeFakeStore()
    const entityStore = makeFakeEntityStore([
      { id: PERSON_ID, kind: 'person', displayName: 'Alex Chen' },
    ])
    const linksStore = makeFakeEntityLinksStore()
    const { saveMemory } = createMemoryTools(store, { entityStore, entityLinksStore: linksStore })

    const result = await saveMemory.execute(
      {
        summary: 'Prefers afternoon investor calls',
        entityId: PERSON_ID,
      },
      teamCtx,
    )

    expect(result.isError).toBeFalsy()
    expect(store.rows).toHaveLength(1)
    expect(store.rows[0].tags).toEqual(['note'])
    expect(linksStore.links).toHaveLength(1)
    expect(linksStore.links[0]).toMatchObject({
      sourceKind: 'memory',
      sourceId: store.rows[0].id,
      targetKind: 'entity',
      targetId: PERSON_ID,
      edgeType: 'mentioned',
      workspaceId: 'team_42',
    })
    expect(String(result.data)).toContain('Saved note')
    expect(String(result.data)).toContain('Alex Chen')
  })

  it('appends "note" to user-supplied tags without duplicating it', async () => {
    const store = makeFakeStore()
    const entityStore = makeFakeEntityStore([
      { id: PERSON_ID, kind: 'company', displayName: 'Acme Co' },
    ])
    const linksStore = makeFakeEntityLinksStore()
    const { saveMemory } = createMemoryTools(store, { entityStore, entityLinksStore: linksStore })

    // tags supplied, no 'note'
    await saveMemory.execute(
      {
        summary: 'Follow up after Q2 close',
        entityId: PERSON_ID,
        tags: ['follow-up'],
      },
      teamCtx,
    )
    expect(store.rows[0].tags).toEqual(['follow-up', 'note'])

    // tags already include 'note' — no duplication
    await saveMemory.execute(
      {
        summary: 'Second note',
        entityId: PERSON_ID,
        tags: ['note', 'urgent'],
      },
      teamCtx,
    )
    expect(store.rows[1].tags).toEqual(['note', 'urgent'])
  })

  it('returns isError when entityId does not resolve to an entity', async () => {
    const store = makeFakeStore()
    const entityStore = makeFakeEntityStore([])
    const linksStore = makeFakeEntityLinksStore()
    const { saveMemory } = createMemoryTools(store, { entityStore, entityLinksStore: linksStore })

    const result = await saveMemory.execute(
      { summary: 'A note', entityId: PERSON_ID },
      teamCtx,
    )

    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('not found')
    expect(store.rows).toHaveLength(0)
    expect(linksStore.links).toHaveLength(0)
  })

  it('returns isError when entity kind is not person/company/deal', async () => {
    const store = makeFakeStore()
    const entityStore = makeFakeEntityStore([
      { id: PROJECT_ID, kind: 'project', displayName: 'Phoenix' },
    ])
    const linksStore = makeFakeEntityLinksStore()
    const { saveMemory } = createMemoryTools(store, { entityStore, entityLinksStore: linksStore })

    const result = await saveMemory.execute(
      { summary: 'Phoenix needs review', entityId: PROJECT_ID },
      teamCtx,
    )

    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain("'project'")
    expect(store.rows).toHaveLength(0)
    expect(linksStore.links).toHaveLength(0)
  })

  it('returns isError when entityId is set but entity stores are not wired', async () => {
    const store = makeFakeStore()
    const { saveMemory } = createMemoryTools(store) // no entity deps

    const result = await saveMemory.execute(
      { summary: 'A note', entityId: PERSON_ID },
      teamCtx,
    )

    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('entity wiring missing')
    expect(store.rows).toHaveLength(0)
  })

  it('returns isError when both id and entityId are provided', async () => {
    const store = makeFakeStore()
    const entityStore = makeFakeEntityStore([
      { id: PERSON_ID, kind: 'person', displayName: 'Alex Chen' },
    ])
    const linksStore = makeFakeEntityLinksStore()
    const { saveMemory } = createMemoryTools(store, { entityStore, entityLinksStore: linksStore })

    const result = await saveMemory.execute(
      { id: 'mem_existing', summary: 'x', entityId: PERSON_ID },
      teamCtx,
    )

    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('Cannot combine `id` with `entityId`')
    expect(store.rows).toHaveLength(0)
    expect(linksStore.links).toHaveLength(0)
  })
})

describe('[COMP:memory/voice-tag] saveMemory voice tag', () => {
  // Post-Phase-4 (retire-memory-type Q3 lock): `category` column is
  // gone. Voice rules ride on `tags: ['voice', ...]`. The scope
  // constraint stays: voice tag is only valid on team-scoped memories.
  it('rejects the `voice` tag on a user-scoped memory', async () => {
    const store = makeFakeStore()
    const { saveMemory } = createMemoryTools(store)
    const result = await saveMemory.execute(
      { summary: 'Write punchy headlines', tags: ['voice'] },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain("'voice' tag")
    expect(store.rows).toHaveLength(0)
  })

  it('accepts the `voice` tag on a team-scoped memory and forwards it to the store', async () => {
    const store = makeFakeStore()
    let capturedTags: unknown
    const origCreate = store.create.bind(store)
    store.create = async (params) => {
      capturedTags = params.tags
      return origCreate(params)
    }
    const { saveMemory } = createMemoryTools(store)
    const result = await saveMemory.execute(
      { summary: 'Write punchy headlines', scope: 'team', tags: ['voice'] },
      teamCtx,
    )
    expect(result.isError).toBeFalsy()
    expect(store.rows).toHaveLength(1)
    expect(Array.isArray(capturedTags) && (capturedTags as string[]).includes('voice')).toBe(true)
  })
})
