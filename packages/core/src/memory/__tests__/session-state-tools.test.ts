import { describe, it, expect, vi } from 'vitest'
import { createSessionStateTools } from '../session-state-tools.js'
import type {
  SessionStateRecord,
  SessionStateStore,
} from '../session-state-types.js'
import type { ToolContext } from '../../tools/types.js'

function makeRecord(overrides: Partial<SessionStateRecord> = {}): SessionStateRecord {
  return {
    id: 'row-1',
    sessionId: 's1',
    userId: 'u1',
    assistantId: 'a1',
    key: 'pill:today',
    status: 'open',
    summary: 'Take today\'s pill',
    detail: null,
    source: 'tool',
    createdAt: new Date(),
    updatedAt: new Date(),
    resolvedAt: null,
    ...overrides,
  }
}

function makeCtx(): ToolContext {
  return {
    userId: 'u1',
    assistantId: 'a1',
    sessionId: 's1',
    appId: 'Use Brian',
    channelType: 'web',
    channelId: 'web:u1',
    abortSignal: new AbortController().signal,
  }
}

function makeStore(initial: SessionStateRecord[] = []): SessionStateStore {
  let rows = [...initial]
  return {
    upsert: vi.fn(async (params) => {
      const existing = rows.find((r) => r.key === params.key)
      const record = makeRecord({
        id: existing?.id ?? `row-${rows.length + 1}`,
        key: params.key,
        summary: params.summary,
        detail: params.detail ?? null,
        source: params.source,
        status: 'open',
        resolvedAt: null,
      })
      rows = rows.filter((r) => r.key !== params.key).concat(record)
      return record
    }),
    resolve: vi.fn(async (params) => {
      const existing = rows.find((r) => r.key === params.key)
      if (!existing) return null
      const updated = { ...existing, status: 'resolved' as const, resolvedAt: new Date() }
      rows = rows.map((r) => (r.key === params.key ? updated : r))
      return updated
    }),
    listOpenBySession: vi.fn(async () => rows.filter((r) => r.status === 'open')),
    listRecentBySession: vi.fn(async () => rows),
    purgeResolvedOlderThan: vi.fn(async () => 0),
  }
}

describe('[COMP:memory/session-state-tools] trackCommitment', () => {
  it('inserts a new commitment and reports was-insert', async () => {
    const events: Array<{ type: string; wasInsert?: boolean }> = []
    const store = makeStore()
    const { trackCommitment } = createSessionStateTools(store, {
      onEvent: (e) => events.push(e as never),
    })
    const res = await trackCommitment.execute(
      { key: 'pill:2026-04-23', summary: 'Confirm daily 2 PM pill' },
      makeCtx(),
    )
    expect(res.isError).toBeFalsy()
    expect(res.data).toContain('Tracked commitment')
    expect(events[0]).toMatchObject({ type: 'session_state_upsert', wasInsert: true })
  })

  it('updates an existing commitment and reports was-insert=false', async () => {
    const store = makeStore([
      makeRecord({ key: 'pill:today', summary: 'old' }),
    ])
    const events: Array<{ type: string; wasInsert?: boolean }> = []
    const { trackCommitment } = createSessionStateTools(store, {
      onEvent: (e) => events.push(e as never),
    })
    const res = await trackCommitment.execute(
      { key: 'pill:today', summary: 'new summary' },
      makeCtx(),
    )
    expect(res.data).toContain('Updated commitment')
    expect(events[0]).toMatchObject({ type: 'session_state_upsert', wasInsert: false })
  })
})

describe('[COMP:memory/session-state-tools] resolveCommitment', () => {
  it('resolves an existing commitment', async () => {
    const store = makeStore([
      makeRecord({ key: 'pill:today', summary: 'Confirm pill' }),
    ])
    const events: Array<{ type: string; hit?: boolean }> = []
    const { resolveCommitment } = createSessionStateTools(store, {
      onEvent: (e) => events.push(e as never),
    })
    const res = await resolveCommitment.execute({ key: 'pill:today' }, makeCtx())
    expect(res.data).toContain('Resolved commitment')
    expect(events[0]).toMatchObject({ type: 'session_state_resolve', hit: true })
  })

  it('returns informational no-op when the key is unknown (not an error)', async () => {
    const store = makeStore()
    const events: Array<{ type: string; hit?: boolean }> = []
    const { resolveCommitment } = createSessionStateTools(store, {
      onEvent: (e) => events.push(e as never),
    })
    const res = await resolveCommitment.execute({ key: 'never-existed' }, makeCtx())
    expect(res.isError).toBeFalsy()
    expect(res.data).toContain('No open commitment')
    expect(events[0]).toMatchObject({ type: 'session_state_resolve', hit: false })
  })
})
