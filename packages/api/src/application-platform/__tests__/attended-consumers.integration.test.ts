import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { boundScopeSources, createCompactionCircuitBreaker, type LLMProvider, type StreamFn } from '@use-brian/core'
import { getAppPool, getPool } from '../../db/client.js'
import { createDbMemoryStore } from '../../db/memory-store.js'
import { runProactiveCompaction } from '../../routes/proactive-compaction.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

describe.sequential('[COMP:api/application-persistence] current attended compaction boundaries', () => {
  let fixture: Awaited<ReturnType<typeof persistentContextFixture>> | undefined
  afterEach(async () => { await fixture?.cleanup(); fixture = undefined })
  afterAll(async () => { await getAppPool().end(); await getPool().end() })
  function provider(stream: StreamFn): LLMProvider {
    return { name: 'deterministic-context-fixture', models: ['fixture'], stream,
      createSession() { throw new Error('Stateless fixture expected') } }
  }
  async function run(f: NonNullable<typeof fixture>, current: Awaited<ReturnType<typeof f.modelContext>>, stream: StreamFn, persist = false) {
    return runProactiveCompaction({
      sessionMessages: await f.history(), timezone: 'UTC', session: f.session,
      tier: 'standard', channelClass: 'web', profile: 'linear', unconditional: true,
      provider: provider(stream), model: 'fixture', systemPrompt: 'Synthetic compaction fixture.',
      assistantId: f.assistantId, userId: current.execution.security.access.userId, ownerId: f.ownerId,
      channelType: 'web', memoryStore: createDbMemoryStore(),
      persistLongTermContext: false, persistSessionSummary: persist,
      authority: current.execution.security.authority, modelContext: current,
      circuitBreaker: createCompactionCircuitBreaker(),
    })
  }

  it('retains nullable shared message evidence through actual replay and in-memory compaction', async () => {
    fixture = await persistentContextFixture()
    const current = await fixture.modelContext()
    const result = await run(fixture, current, async function* () { yield { type: 'text_delta', text: 'Fictional compacted answer' } })
    expect(result.compacted).toBe(true)
    expect(boundScopeSources(result.messages[0])).not.toHaveLength(0)
    expect(boundScopeSources(result.messages[0]).every(source => source.userId === null && source.assistantId === null)).toBe(true)
  })

  it('refuses a stale member before provider dispatch while another current member remains usable', async () => {
    fixture = await persistentContextFixture()
    const original = (await fixture.history()).flatMap(boundScopeSources)
    const first = await fixture.modelContext(fixture.firstId)
    const stream = vi.fn<StreamFn>(async function* () { yield { type: 'text_delta', text: 'Fictional answer' } })
    await fixture.pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2", [fixture.workspaceId, fixture.firstId])
    await expect(run(fixture, first, stream)).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(stream).not.toHaveBeenCalled()
    expect((await fixture.history()).flatMap(boundScopeSources)).toEqual(original)
    const second = await fixture.modelContext(fixture.secondId)
    expect((await run(fixture, second, stream)).compacted).toBe(true)
    expect(stream).toHaveBeenCalledOnce()
  })

  it('uses the current shared-audience memory index and persists complete extraction ancestry', async () => {
    fixture = await persistentContextFixture()
    const f = fixture, visible = await f.memory('Fictional shared index fact')
    await f.memory('Fictional private index fact', f.ownerId)
    const rows = await f.history(), current = await f.modelContext()
    const requests: string[] = []
    const result = await runProactiveCompaction({
      sessionMessages: rows, timezone: 'UTC', session: f.session,
      tier: 'standard', channelClass: 'web', unconditional: true, provider: provider(async function* (request) {
        requests.push(JSON.stringify(request.messages))
        yield { type: 'text_delta', text: request.systemPrompt.includes('fact extraction')
          ? '[{"type":"preference","summary":"Fictional extracted preference"}]' : 'Fictional summary' }
      }), model: 'fixture', systemPrompt: 'Synthetic compaction fixture.',
      assistantId: f.assistantId, userId: f.ownerId, ownerId: f.ownerId, channelType: 'web',
      memoryStore: createDbMemoryStore(), persistSessionSummary: false,
      authority: current.execution.security.authority, modelContext: current,
    })
    expect(result.compacted).toBe(true)
    expect(requests).toHaveLength(2)
    expect(requests[0]).toContain('Fictional shared index fact')
    expect(requests.join('')).not.toContain('Fictional private index fact')
    const facts = (await f.pool.query("SELECT id FROM memories WHERE workspace_id=$1 AND summary='Fictional extracted preference'", [f.workspaceId])).rows
    expect(facts).toHaveLength(1)
    const sources = (await f.pool.query(`SELECT s.source_id FROM scope_derivations d
      JOIN scope_derivation_sources s ON s.derivation_id=d.id AND s.workspace_id=d.workspace_id
      WHERE d.workspace_id=$1 AND d.resource_id=$2`, [f.workspaceId, facts[0].id])).rows.map(row => row.source_id)
    expect(sources.sort()).toEqual([...rows.map(row => row.id), visible.id].sort())
  })

  it('aborts after contraction during generation without writing a durable summary or trimming as fallback', async () => {
    fixture = await persistentContextFixture()
    const f = fixture, current = await f.modelContext(f.firstId)
    const result = run(f, current, async function* () {
      yield { type: 'text_delta', text: 'Fictional partial summary' }
      await f.pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.firstId])
    }, true)
    await expect(result).rejects.toMatchObject({ reason: 'authority_changed', retrySafe: false })
    expect((await f.pool.query('SELECT compact_summary FROM sessions WHERE id=$1', [f.session.id])).rows[0].compact_summary).toBeNull()
  })
})
