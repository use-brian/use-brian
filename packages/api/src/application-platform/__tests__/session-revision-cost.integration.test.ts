/** [COMP:api/native-chat-read-cost] Count real current revision reads, independent of seeding. */
import { randomUUID } from 'node:crypto'
import { ContextScopeAccumulator } from '@use-brian/agent-runtime/security/context-scope.js'
import { boundScopeSources } from '@use-brian/agent-runtime/security/source-evidence.js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { getAppPool, getPool } from '../../db/client.js'
import { conversationReadersActive, initializeConversationVisibility } from '../../db/conversation-visibility.js'
import { createDbEpisodicStore } from '../../db/episodic-store.js'
import { readSessionContextRevisions } from '../../db/session-context-revisions.js'
import { readTurnSqlLedger, setTurnSqlRecording, takeTurnSqlLedger, withTurnFrame } from '../../db/turn-sql-accounting.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'
import { sourceModeFixture } from './fixtures/source-modes.js'
import { originalMemoryAuthority } from './fixtures/retained-memory.js'
import type { ScopeSource } from '@use-brian/agent-runtime/security/derived-scope.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
vi.hoisted(() => { process.env.PG_POOL_MAX = '1' })

describe.sequential('current episodic revision cost', () => {
  beforeAll(async () => {
    expect(getAppPool().options.max).toBe(1)
    await initializeConversationVisibility()
    expect(conversationReadersActive()).toBe(true)
  })
  afterAll(async () => { await getAppPool().end(); await getPool().end() })

  it('measures the store as the active revision cohort grows from 1 to 10 to 100', async () => {
    const f = await persistentContextFixture()
    const episodes = createDbEpisodicStore()
    const seeded = new Set<string>()
    const samples = []
    try {
      const sources = (await f.history()).flatMap(boundScopeSources)
      expect(sources.length).toBeGreaterThan(0)
      for (const size of [1, 10, 100]) {
        const seedStarted = performance.now()
        const writer = await f.modelContext()
        while (seeded.size < size) {
          const n = seeded.size + 1
          const episode = await episodes.create({ sessionId: f.session.id, userId: f.ownerId, assistantId: f.assistantId,
            topicLabel: `Fictional revision topic ${n}`, summary: `Fictional revision ${n}`,
            messageSpan: { fromSequence: 1, toSequence: 3, turnCount: 3 }, authority: writer,
            derivation: { producer: 'fixture:revision-cost', sources } })
          seeded.add(episode.id)
        }
        const seedMs = performance.now() - seedStarted
        const reader = await f.modelContext(f.firstId)
        const turnId = randomUUID()
        setTurnSqlRecording(true)
        const started = performance.now()
        try {
          const revisions = await withTurnFrame({ turnId, frameId: 'current-episodic-revisions' },
            () => readSessionContextRevisions(f.session.id, 'episodic_memory', reader))
          expect(new Set(revisions.map(row => row.parentId))).toEqual(seeded)
          expect(revisions.every(row => boundScopeSources(row).some(source => source.resourceId === row.id))).toBe(true)
          const ledger = readTurnSqlLedger(turnId)!
          expect(ledger.totals.failed).toBe(0)
          expect(ledger.overflow.fingerprints).toBe(0)
          const sum = (predicate: (shape: string) => boolean) => ledger.fingerprints.reduce(
            (count, row) => count + (predicate(row.shape) ? row.count : 0), 0)
          const readFrames = sum(shape => /^BEGIN\b/i.test(shape))
          const revisionPayloadReads = sum(shape => shape.includes('read_session_context_revision('))
          expect(readFrames).toBe(Math.ceil(size / 8))
          expect(revisionPayloadReads).toBe(readFrames)
          samples.push({ revisions: size, seedMs, wallMs: performance.now() - started,
            ...ledger.totals, overflow: ledger.overflow,
            readFrames, revisionPayloadReads,
          })
        } finally {
          setTurnSqlRecording(undefined)
          takeTurnSqlLedger(turnId)
        }
      }
      console.info('revision-cost', JSON.stringify(samples))
    } finally { await f.cleanup() }
  }, 180_000)

  it('returns independently governed and native revisions without mixing admission, association or order', async () => {
    const x = await sourceModeFixture('internal')
    const f = x.f
    const episodes = createDbEpisodicStore()
    try {
      const native = (await f.history()).flatMap(boundScopeSources)
      const couldBeHeld = await f.memory('Fictional retained Memory source')
      const heldSource = (await f.pool.query<{source: ScopeSource}>(
        "SELECT read_scope_source($1,'memory',$2) AS source", [f.workspaceId,couldBeHeld.id])).rows[0].source
      const current = await originalMemoryAuthority(x)
      await current.runtime.read!('readRecord', {id:'record-1', fields:['description']}, 'governed')
      expect(current.accumulator.evidence.sources?.map(root=>root.resourceKind)).toContain('external_source')
      const local = { execution: current.execution, accumulator: new ContextScopeAccumulator() }
      const add = (label: string, authority: typeof local, sources: ScopeSource[]) =>
        episodes.create({sessionId:current.session.id,userId:f.ownerId,assistantId:f.assistantId,
          topicLabel:label,summary:label,messageSpan:{fromSequence:1,toSequence:3,turnCount:3},
          authority,derivation:{producer:'fixture:mixed-revision-cost',sources}})
      const visible = await add('Fictional native episode', local, native)
      const held = await add('Fictional subsequently held episode', local, [heldSource])
      const external = await add('Fictional independently governed episode', current, [])
      const read = () => readSessionContextRevisions(current.session.id,'episodic_memory',local)
      const original = await read()
      expect(new Set(original.map(row=>row.parentId))).toEqual(new Set([visible.id,held.id,external.id]))
      expect(original.map(row=>row.id)).toEqual(original.map(row=>row.id).sort())
      expect(original.every(row=>boundScopeSources(row)[0]?.resourceId===row.id)).toBe(true)
      await f.pool.query('UPDATE memories SET scope_held=true WHERE id=$1',[couldBeHeld.id])
      expect(new Set((await read()).map(row=>row.parentId))).toEqual(new Set([visible.id,external.id]))
      await x.sourcePool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[f.ownerId])
      expect((await read()).map(row=>row.parentId)).toEqual([visible.id])
    } finally { await x.cleanup() }
  }, 120_000)
})
