/**
 * [COMP:inspection/tools] Read-only introspection toolkit exposed to the
 * workspace primary assistant during a Brain inbox "Ask about this"
 * deliberation. Five tools (`inspectMemoryProvenance` /
 * `inspectRecallHistory` / `inspectRowProvenance` / `inspectMyActivity` /
 * `inspectMyMistakes`) that read provenance, recall history, activity and
 * corrections and render them as model-readable text.
 *
 * Tests cover: the workspace-context guard every tool shares, the params
 * threaded into the store (assistant/workspace scope + the documented
 * defaults for limit / sinceMinutes / sinceDays), the `workspaceWide`
 * flag pass-through, empty-result friendly messages, the text rendering
 * (including `session_messages.content` shapes), and the read-only +
 * concurrency-safe safety flags. Store is a `vi.fn()` fake — no DB.
 *
 * Spec: docs/architecture/brain/corrections.md → "User verification
 * surface" (the read-only Ask-about-this tool registry).
 */

import { describe, expect, it, vi } from 'vitest'
import { createInspectionTools } from '../tools.js'
import type {
  ActivityEvent,
  InspectionStore,
  MistakeEvent,
  ProvenanceWalk,
  RecallEvent,
} from '../types.js'
import type { ToolContext } from '../../tools/types.js'

// ── Fixtures ─────────────────────────────────────────────────────────

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'
const ASSISTANT_ID = 'asst-1'
const MEMORY_ID = '11111111-1111-4111-8111-111111111111'
const ROW_ID = '22222222-2222-4222-8222-222222222222'

const ctx: ToolContext = {
  userId: 'user-1',
  assistantId: ASSISTANT_ID,
  sessionId: 'sess-1',
  appId: 'Use Brian',
  channelType: 'brain_inspection',
  channelId: 'inbox-1',
  workspaceId: WORKSPACE_ID,
  abortSignal: new AbortController().signal,
}

/** A ctx with no workspace — every tool must reject this. */
const ctxNoWorkspace: ToolContext = { ...ctx, workspaceId: null }

// ── Fake store (vi.fn recorders) ─────────────────────────────────────

type FakeStore = InspectionStore & {
  getMemoryProvenance: ReturnType<typeof vi.fn>
  getRecallHistory: ReturnType<typeof vi.fn>
  getRowProvenance: ReturnType<typeof vi.fn>
  getRecentActivity: ReturnType<typeof vi.fn>
  getRecentMistakes: ReturnType<typeof vi.fn>
}

function makeStore(overrides: Partial<Record<keyof InspectionStore, unknown>> = {}): FakeStore {
  return {
    getMemoryProvenance: vi.fn(async () => overrides.getMemoryProvenance ?? null),
    getRecallHistory: vi.fn(async () => overrides.getRecallHistory ?? ([] as RecallEvent[])),
    getRowProvenance: vi.fn(async () => overrides.getRowProvenance ?? null),
    getRecentActivity: vi.fn(async () => overrides.getRecentActivity ?? ([] as ActivityEvent[])),
    getRecentMistakes: vi.fn(async () => overrides.getRecentMistakes ?? ([] as MistakeEvent[])),
  } as FakeStore
}

// ── Shared: every tool guards on workspace context ───────────────────

describe('[COMP:inspection/tools] workspace-context guard', () => {
  it('every tool returns an error result without a workspace', async () => {
    const store = makeStore()
    const tools = createInspectionTools(store)
    const calls: Array<Promise<{ isError?: boolean }>> = [
      tools.inspectMemoryProvenance.execute({ memoryId: MEMORY_ID }, ctxNoWorkspace),
      tools.inspectRecallHistory.execute({ rowId: ROW_ID }, ctxNoWorkspace),
      tools.inspectRowProvenance.execute(
        { primitive: 'memory', rowId: ROW_ID },
        ctxNoWorkspace,
      ),
      tools.inspectMyActivity.execute({}, ctxNoWorkspace),
      tools.inspectMyMistakes.execute({}, ctxNoWorkspace),
    ]
    const results = await Promise.all(calls)
    for (const r of results) {
      expect(r.isError).toBe(true)
    }
    // No store method is reached when the guard trips.
    expect(store.getMemoryProvenance).not.toHaveBeenCalled()
    expect(store.getRecallHistory).not.toHaveBeenCalled()
    expect(store.getRowProvenance).not.toHaveBeenCalled()
    expect(store.getRecentActivity).not.toHaveBeenCalled()
    expect(store.getRecentMistakes).not.toHaveBeenCalled()
  })
})

// ── Shared: all five tools are read-only + concurrency-safe ──────────

describe('[COMP:inspection/tools] safety flags', () => {
  it('marks all five tools read-only and concurrency-safe', () => {
    const tools = createInspectionTools(makeStore())
    for (const tool of Object.values(tools)) {
      expect(tool.isReadOnly).toBe(true)
      expect(tool.isConcurrencySafe).toBe(true)
    }
  })

  it('exposes the five documented tool names', () => {
    const tools = createInspectionTools(makeStore())
    expect(tools.inspectMemoryProvenance.name).toBe('inspectMemoryProvenance')
    expect(tools.inspectRecallHistory.name).toBe('inspectRecallHistory')
    expect(tools.inspectRowProvenance.name).toBe('inspectRowProvenance')
    expect(tools.inspectMyActivity.name).toBe('inspectMyActivity')
    expect(tools.inspectMyMistakes.name).toBe('inspectMyMistakes')
  })
})

// ── inspectMemoryProvenance ──────────────────────────────────────────

describe('[COMP:inspection/tools] inspectMemoryProvenance', () => {
  it('scopes the read to the calling assistant + workspace + memory id', async () => {
    const store = makeStore()
    const { inspectMemoryProvenance } = createInspectionTools(store)
    await inspectMemoryProvenance.execute({ memoryId: MEMORY_ID }, ctx)
    expect(store.getMemoryProvenance).toHaveBeenCalledWith({
      assistantId: ASSISTANT_ID,
      workspaceId: WORKSPACE_ID,
      memoryId: MEMORY_ID,
    })
  })

  it('renders saved-at, saving assistant, source session and message window', async () => {
    const store = makeStore({
      getMemoryProvenance: {
        savedAt: new Date('2026-05-01T10:00:00.000Z'),
        sourceSessionId: 'sess-src',
        savingAssistantName: 'Ops',
        messages: [
          { id: 'm1', role: 'user', content: 'why did we pick vendor X?', createdAt: new Date('2026-05-01T09:59:00.000Z') },
          { id: 'm2', role: 'assistant', content: [{ text: 'because of price' }], createdAt: new Date('2026-05-01T09:59:30.000Z') },
        ],
      },
    })
    const { inspectMemoryProvenance } = createInspectionTools(store)
    const result = await inspectMemoryProvenance.execute({ memoryId: MEMORY_ID }, ctx)
    const text = String(result.data)
    expect(text).toContain('Saving assistant: Ops')
    expect(text).toContain('Source session: sess-src')
    // Both a plain-string and an array-of-{text} content render.
    expect(text).toContain('why did we pick vendor X?')
    expect(text).toContain('because of price')
  })

  it('reports a friendly message when there is no provenance', async () => {
    const store = makeStore() // returns null
    const { inspectMemoryProvenance } = createInspectionTools(store)
    const result = await inspectMemoryProvenance.execute({ memoryId: MEMORY_ID }, ctx)
    expect(result.isError).toBeFalsy()
    expect(String(result.data)).toMatch(/No provenance/i)
  })

  it('notes the fallbacks when the saving assistant and source session are unknown', async () => {
    const store = makeStore({
      getMemoryProvenance: {
        savedAt: new Date('2026-05-01T10:00:00.000Z'),
        sourceSessionId: null,
        savingAssistantName: null,
        messages: [],
      },
    })
    const { inspectMemoryProvenance } = createInspectionTools(store)
    const text = String((await inspectMemoryProvenance.execute({ memoryId: MEMORY_ID }, ctx)).data)
    expect(text).toContain('(unknown)')
    expect(text).toContain('(none captured)')
    expect(text).toMatch(/no source session messages/i)
  })
})

// ── inspectRecallHistory ─────────────────────────────────────────────

describe('[COMP:inspection/tools] inspectRecallHistory', () => {
  it('defaults the limit to 10 and threads primitive through', async () => {
    const store = makeStore()
    const { inspectRecallHistory } = createInspectionTools(store)
    await inspectRecallHistory.execute({ rowId: ROW_ID, primitive: 'memory' }, ctx)
    expect(store.getRecallHistory).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      rowId: ROW_ID,
      primitive: 'memory',
      limit: 10,
    })
  })

  it('honors an explicit limit', async () => {
    const store = makeStore()
    const { inspectRecallHistory } = createInspectionTools(store)
    await inspectRecallHistory.execute({ rowId: ROW_ID, limit: 3 }, ctx)
    expect(store.getRecallHistory.mock.calls[0][0].limit).toBe(3)
  })

  it('renders recall events with their outcome (unrated when null)', async () => {
    const events: RecallEvent[] = [
      { id: 'r1', recalledAt: new Date('2026-05-01T10:00:00.000Z'), sessionId: 's1', recallKind: 'index_inject', outcome: 'negative' },
      { id: 'r2', recalledAt: new Date('2026-05-01T11:00:00.000Z'), sessionId: 's2', recallKind: 'tool_call', outcome: null },
    ]
    const store = makeStore({ getRecallHistory: events })
    const { inspectRecallHistory } = createInspectionTools(store)
    const text = String((await inspectRecallHistory.execute({ rowId: ROW_ID }, ctx)).data)
    expect(text).toContain('index_inject')
    expect(text).toContain('negative')
    expect(text).toContain('unrated')
  })

  it('reports a friendly message when there are no recall events', async () => {
    const store = makeStore()
    const { inspectRecallHistory } = createInspectionTools(store)
    expect(String((await inspectRecallHistory.execute({ rowId: ROW_ID }, ctx)).data)).toMatch(
      /No recall events/i,
    )
  })
})

// ── inspectRowProvenance ─────────────────────────────────────────────

describe('[COMP:inspection/tools] inspectRowProvenance', () => {
  it('passes the primitive + row id through', async () => {
    const store = makeStore()
    const { inspectRowProvenance } = createInspectionTools(store)
    await inspectRowProvenance.execute({ primitive: 'entity', rowId: ROW_ID }, ctx)
    expect(store.getRowProvenance).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      primitive: 'entity',
      rowId: ROW_ID,
    })
  })

  it('renders the source episode and version history newest-first', async () => {
    const walk: ProvenanceWalk = {
      sourceEpisodeId: 'ep-9',
      origin: 'slack_thread @ 2026-05-01',
      history: [
        { id: 'v2', validFrom: new Date('2026-05-02T00:00:00.000Z'), validTo: null, reason: 'user edit' },
        { id: 'v1', validFrom: new Date('2026-05-01T00:00:00.000Z'), validTo: new Date('2026-05-02T00:00:00.000Z') },
      ],
    }
    const store = makeStore({ getRowProvenance: walk })
    const { inspectRowProvenance } = createInspectionTools(store)
    const text = String((await inspectRowProvenance.execute({ primitive: 'entity', rowId: ROW_ID }, ctx)).data)
    expect(text).toContain('Source episode: ep-9')
    expect(text).toContain('Origin: slack_thread @ 2026-05-01')
    expect(text).toContain('v2')
    expect(text).toContain('user edit')
    // v2 (newest) appears before v1.
    expect(text.indexOf('v2')).toBeLessThan(text.indexOf('v1'))
  })

  it('marks a manual save with no source episode and no prior versions', async () => {
    const walk: ProvenanceWalk = { sourceEpisodeId: null, origin: null, history: [] }
    const store = makeStore({ getRowProvenance: walk })
    const { inspectRowProvenance } = createInspectionTools(store)
    const text = String((await inspectRowProvenance.execute({ primitive: 'memory', rowId: ROW_ID }, ctx)).data)
    expect(text).toMatch(/none - manual save|none — manual save/)
    expect(text).toMatch(/first write/i)
  })

  it('reports a friendly message when no provenance is found', async () => {
    const store = makeStore()
    const { inspectRowProvenance } = createInspectionTools(store)
    const result = await inspectRowProvenance.execute({ primitive: 'task', rowId: ROW_ID }, ctx)
    expect(String(result.data)).toMatch(/No provenance found/i)
  })

  it('rejects an unknown primitive at the Zod layer', () => {
    const { inspectRowProvenance } = createInspectionTools(makeStore())
    const parsed = inspectRowProvenance.inputSchema.safeParse({ primitive: 'unknown', rowId: ROW_ID })
    expect(parsed.success).toBe(false)
  })
})

// ── inspectMyActivity ────────────────────────────────────────────────

describe('[COMP:inspection/tools] inspectMyActivity', () => {
  it('defaults to self-scope with 60-minute lookback and a 20-row cap', async () => {
    const store = makeStore()
    const { inspectMyActivity } = createInspectionTools(store)
    await inspectMyActivity.execute({}, ctx)
    expect(store.getRecentActivity).toHaveBeenCalledWith({
      assistantId: ASSISTANT_ID,
      workspaceId: WORKSPACE_ID,
      sinceMinutes: 60,
      limit: 20,
      workspaceWide: undefined,
    })
  })

  it('threads workspaceWide + overrides through', async () => {
    const store = makeStore()
    const { inspectMyActivity } = createInspectionTools(store)
    await inspectMyActivity.execute({ sinceMinutes: 120, limit: 5, workspaceWide: true }, ctx)
    expect(store.getRecentActivity).toHaveBeenCalledWith({
      assistantId: ASSISTANT_ID,
      workspaceId: WORKSPACE_ID,
      sinceMinutes: 120,
      limit: 5,
      workspaceWide: true,
    })
  })

  it('renders activity events and reports empty windows', async () => {
    const withEvents = makeStore({
      getRecentActivity: [
        { id: 'a1', eventName: 'tool_executed', occurredAt: new Date('2026-05-01T10:00:00.000Z'), summary: 'searchBrain ok' },
      ] as ActivityEvent[],
    })
    const { inspectMyActivity } = createInspectionTools(withEvents)
    expect(String((await inspectMyActivity.execute({}, ctx)).data)).toContain('tool_executed')

    const empty = makeStore()
    const emptyTools = createInspectionTools(empty)
    expect(String((await emptyTools.inspectMyActivity.execute({}, ctx)).data)).toMatch(
      /No recorded activity/i,
    )
  })
})

// ── inspectMyMistakes ────────────────────────────────────────────────

describe('[COMP:inspection/tools] inspectMyMistakes', () => {
  it('defaults to self-scope with a 14-day lookback and a 20-row cap', async () => {
    const store = makeStore()
    const { inspectMyMistakes } = createInspectionTools(store)
    await inspectMyMistakes.execute({}, ctx)
    expect(store.getRecentMistakes).toHaveBeenCalledWith({
      assistantId: ASSISTANT_ID,
      workspaceId: WORKSPACE_ID,
      sinceDays: 14,
      limit: 20,
      workspaceWide: undefined,
    })
  })

  it('threads workspaceWide + overrides through', async () => {
    const store = makeStore()
    const { inspectMyMistakes } = createInspectionTools(store)
    await inspectMyMistakes.execute({ sinceDays: 30, limit: 7, workspaceWide: true }, ctx)
    expect(store.getRecentMistakes).toHaveBeenCalledWith({
      assistantId: ASSISTANT_ID,
      workspaceId: WORKSPACE_ID,
      sinceDays: 30,
      limit: 7,
      workspaceWide: true,
    })
  })

  it('renders correction events with action, primitive, short row id and reason', async () => {
    const events: MistakeEvent[] = [
      {
        id: 'x1',
        action: 'retract',
        primitive: 'memory',
        rowId: '99999999-9999-4999-8999-999999999999',
        reason: 'wrong company attributed',
        at: new Date('2026-05-01T10:00:00.000Z'),
      },
    ]
    const store = makeStore({ getRecentMistakes: events })
    const { inspectMyMistakes } = createInspectionTools(store)
    const text = String((await inspectMyMistakes.execute({}, ctx)).data)
    expect(text).toContain('retract')
    expect(text).toContain('memory:99999999') // 8-char prefix
    expect(text).toContain('wrong company attributed')
    // The full UUID is NOT echoed — only the 8-char prefix.
    expect(text).not.toContain('99999999-9999-4999-8999-999999999999')
  })

  it('reports a friendly message when there are no corrections', async () => {
    const store = makeStore()
    const { inspectMyMistakes } = createInspectionTools(store)
    expect(String((await inspectMyMistakes.execute({}, ctx)).data)).toMatch(
      /No recorded mistakes/i,
    )
  })
})
