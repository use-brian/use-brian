import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest'
import { boundScopeSources, type SessionContextAuthority, type DerivedWriteEvidence } from '@use-brian/core'
import { getPool, getAppPool } from '../client.js'
import { createDbSessionStateStore } from '../session-state-store.js'
import { persistentContextFixture } from '../../application-platform/__tests__/fixtures/persistent-context.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
let fixture: Awaited<ReturnType<typeof persistentContextFixture>> | undefined
let authority: SessionContextAuthority,derivation: DerivedWriteEvidence
let userId: string,assistantId: string,sessionId: string
const store=createDbSessionStateStore()
afterEach(async()=>{await fixture?.cleanup();fixture=undefined})
afterAll(async()=>{await getAppPool().end();await getPool().end()})
beforeEach(async()=>{
  fixture=await persistentContextFixture()
  userId=fixture.ownerId;assistantId=fixture.assistantId;sessionId=fixture.session.id
  authority=await fixture.modelContext()
  derivation={producer:'fixture:state-regression',sources:(await fixture.history()).flatMap(boundScopeSources)}
})
describe('[COMP:api/session-state-store] actual guarded persistent store',()=>{
  it('upsert → listOpenBySession round trip', async () => {
    await store.upsert({ authority, derivation,
      sessionId, userId, assistantId,
      key: 'pill:2026-04-23',
      summary: 'Confirm 2 PM pill',
      source: 'tool',
    })
    const open = await store.listOpenBySession(sessionId,authority)
    expect(open).toHaveLength(1)
    expect(open[0].key).toBe('pill:2026-04-23')
    expect(open[0].status).toBe('open')
    expect(open[0].source).toBe('tool')
  })

  it('upsert twice on same key updates in place (no duplicate row)', async () => {
    await store.upsert({ authority, derivation,
      sessionId, userId, assistantId,
      key: 'pill:today', summary: 'first', source: 'tool',
    })
    await store.upsert({ authority, derivation,
      sessionId, userId, assistantId,
      key: 'pill:today', summary: 'second', source: 'tool',
    })
    const all = await store.listRecentBySession(sessionId,50,authority)
    expect(all).toHaveLength(1)
    expect(all[0].summary).toBe('second')
    expect(all[0].source).toBe('tool')
  })

  // ── Provenance rule ───────────────────────────────────────
  // See docs/architecture/context-engine/session-state.md →
  // "Provenance rule on conflicting writes". The tool path is
  // authoritative over diff-pass for summary + detail.
  it('diff-pass upsert preserves tool-written detail', async () => {
    await store.upsert({ authority, derivation,
      sessionId, userId, assistantId,
      key: 'itinerary:seoul',
      summary: 'Seoul trip',
      detail: 'Fictional day one. Fictional day two. Fictional day three. Fictional day four. Fictional day five.',
      source: 'tool',
    })
    await store.upsert({ authority, derivation,
      sessionId, userId, assistantId,
      key: 'itinerary:seoul',
      summary: 'Seoul trip (5 days)',
      detail: null, // diff-pass commonly emits no detail
      source: 'diff-pass',
    })
    const rows = await store.listRecentBySession(sessionId,50,authority)
    expect(rows).toHaveLength(1)
    // Detail preserved from the tool write:
    expect(rows[0].detail).toBe(
      'Fictional day one. Fictional day two. Fictional day three. Fictional day four. Fictional day five.',
    )
    // Summary also preserved (tool is authoritative):
    expect(rows[0].summary).toBe('Seoul trip')
    // Source reflects the most recent writer:
    expect(rows[0].source).toBe('diff-pass')
  })

  it('tool upsert overwrites diff-pass-written detail (tool is authoritative)', async () => {
    await store.upsert({ authority, derivation,
      sessionId, userId, assistantId,
      key: 'trip:day2',
      summary: 'Day 2 dinner',
      detail: 'Auto-derived by diff-pass',
      source: 'diff-pass',
    })
    await store.upsert({ authority, derivation,
      sessionId, userId, assistantId,
      key: 'trip:day2',
      summary: 'Day 2 dinner decided',
      detail: 'Fictional dinner, 19:00',
      source: 'tool',
    })
    const rows = await store.listRecentBySession(sessionId,50,authority)
    expect(rows).toHaveLength(1)
    expect(rows[0].summary).toBe('Day 2 dinner decided')
    expect(rows[0].detail).toBe('Fictional dinner, 19:00')
    expect(rows[0].source).toBe('tool')
  })

  it('diff-pass over diff-pass writes normally (no provenance protection between peers)', async () => {
    await store.upsert({ authority, derivation,
      sessionId, userId, assistantId,
      key: 'auto:key',
      summary: 'v1',
      detail: 'detail-v1',
      source: 'diff-pass',
    })
    await store.upsert({ authority, derivation,
      sessionId, userId, assistantId,
      key: 'auto:key',
      summary: 'v2',
      detail: null,
      source: 'diff-pass',
    })
    const rows = await store.listRecentBySession(sessionId,50,authority)
    expect(rows).toHaveLength(1)
    expect(rows[0].summary).toBe('v2')
    expect(rows[0].detail).toBeNull()
  })

  it('resolve flips the row and sets resolved_at', async () => {
    await store.upsert({ authority, derivation,
      sessionId, userId, assistantId,
      key: 'trip:day2', summary: 'Pick dinner', source: 'tool',
    })
    const resolved = await store.resolve({ authority, derivation, sessionId, key: 'trip:day2', source: 'tool' })
    expect(resolved).not.toBeNull()
    expect(resolved!.status).toBe('resolved')
    expect(resolved!.resolvedAt).toBeInstanceOf(Date)
    expect(await store.listOpenBySession(sessionId,authority)).toHaveLength(0)
  })

  it('resolve returns null when the key does not exist', async () => {
    const res = await store.resolve({ authority, derivation, sessionId, key: 'phantom', source: 'tool' })
    expect(res).toBeNull()
  })

  it('re-upsert after resolve reopens the row', async () => {
    await store.upsert({ authority, derivation,
      sessionId, userId, assistantId,
      key: 'pill:today', summary: 'today', source: 'tool',
    })
    await store.resolve({ authority, derivation, sessionId, key: 'pill:today', source: 'tool' })
    await store.upsert({ authority, derivation,
      sessionId, userId, assistantId,
      key: 'pill:today', summary: 'tomorrow', source: 'tool',
    })
    const open = await store.listOpenBySession(sessionId,authority)
    expect(open).toHaveLength(1)
    expect(open[0].summary).toBe('tomorrow')
    expect(open[0].resolvedAt).toBeNull()
  })

  it('purgeResolvedOlderThan removes old resolved rows only', async () => {
    await store.upsert({ authority, derivation,
      sessionId, userId, assistantId,
      key: 'old', summary: 'old', source: 'tool',
    })
    const clock=vi.spyOn(Date,'now').mockReturnValue(Date.now()-48*60*60*1000)
    try { await store.resolve({ authority, derivation, sessionId, key: 'old', source: 'tool' }) } finally { clock.mockRestore() }
    authority=await fixture!.modelContext()
    await store.upsert({ authority, derivation,
      sessionId, userId, assistantId,
      key: 'current', summary: 'current', source: 'tool',
    })

    const deletedCount = await store.purgeResolvedOlderThan(
      sessionId,
      new Date(Date.now() - 24 * 60 * 60 * 1000),
      authority,
    )
    expect(deletedCount).toBe(1)

    const remaining = await store.listRecentBySession(sessionId,50,authority)
    expect(remaining).toHaveLength(1)
    expect(remaining[0].key).toBe('current')
  })

  it('cascades on session delete', async () => {
    await store.upsert({ authority, derivation,
      sessionId, userId, assistantId,
      key: 'cascade:test', summary: 'x', source: 'tool',
    })
    const client = await fixture!.pool.connect()
    try {
      await client.query(`DELETE FROM sessions WHERE id = $1`, [sessionId])
      const r = await client.query(
        `SELECT id FROM session_state WHERE session_id = $1`,
        [sessionId],
      )
      expect(r.rows).toHaveLength(0)
    } finally {
      client.release()
    }
  })
})
