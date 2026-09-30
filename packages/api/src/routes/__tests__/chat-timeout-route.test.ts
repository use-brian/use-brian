import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

const state = vi.hoisted(() => ({
  events: [] as any[], rows: [] as any[], bus: [] as any[], held: true, cancelled: false,
  txClients: [] as Array<{ query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }>,
  beforeLoop: null as null | ((options: any) => Promise<void>),
  afterFirstEvent: null as null | ((options: any) => Promise<void>),
  successor: null as null | string,
  onRelease: null as null | (() => Promise<void>),
  session: { id: 'session-test', userId: 'user-test', assistantId: 'assistant-test', channelType: 'web', channelId: 'user-test', status: 'idle', mode: 'default', visibility: 'owner', title: 'Existing title', contextGroupId: null, contextProjectId: null, contextLockedAt: null },
}))
vi.mock('../../db/notify-listener.js', () => ({ registerNotifyChannel: vi.fn(), startNotifyListener: vi.fn() }))
vi.mock('../_recovery-message.js', () => ({ composeRecoveryMessage: vi.fn() }))
vi.mock('../_empty-turn-synthesis.js', () => ({ composeEmptyTurnSynthesis: vi.fn() }))
vi.mock('../../db/client.js', () => ({
  query: vi.fn(async () => ({ rows: [] })),
  // The flush writes every buffered row inside one transaction on a pool
  // client; `addSessionMessage` is mocked, so the client only sees
  // BEGIN / COMMIT / ROLLBACK.
  getPool: () => ({ connect: async () => {
    const client = { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() }
    state.txClients.push(client)
    return client
  } }),
}))
vi.mock('../../db/users.js', () => ({
  getDefaultAssistant: async () => ({ id: 'assistant-test', kind: 'personal', name: 'Test', soul: 'Test', userId: 'user-test', workspaceId: 'workspace-test', clearance: 'internal' }),
  findAssistantById: async () => ({ id: 'assistant-test', kind: 'personal', name: 'Test', soul: 'Test', userId: 'user-test', workspaceId: 'workspace-test', clearance: 'internal' }),
}))
vi.mock('../../db/sessions.js', async (original) => ({
  ...await original<any>(),
  findOrCreateSession: async () => state.session,
  findSessionById: async () => state.session,
  findSessionAuthorityById: async () => state.session,
  findSessionByChannel: async () => state.session,
  getPreferredChannel: async () => null, getSessionMessages: async () => [...state.rows], getSessionTopicLabels: async () => [],
  addSessionMessage: vi.fn(async (row) => { const saved = { ...row, createdAt: new Date(), id: `row-${state.rows.length}`, sequenceNum: state.rows.length }; state.rows.push(saved); return saved }),
  updateSessionStatus: vi.fn(async (_id, status) => { state.session.status = status }),
  requestTurnCancel: async () => {}, reclaimStaleTurn: async () => false, updateSessionTitle: async () => true, countSessionTurns: async () => 2,
  startTurnLease: async () => 'lease-test',
  touchTurnLease: vi.fn(async () => ({ held: state.held, cancelRequested: state.cancelled })),
  isTurnLeaseSuperseded: vi.fn(async (_id: string, token: string) => state.successor !== null && state.successor !== token),
  releaseTurnLease: vi.fn(async () => { state.held = false; await state.onRelease?.() }),
}))
vi.mock('../route-helpers.js', async (original) => ({
  ...await original<any>(), resolveUser: async () => ({ id: 'user-test', name: 'Test', timezone: 'UTC' }),
  checkUsageBudget: async () => null,
}))
vi.mock('../../context-scope/resolve-turn-scope.js', async (original) => ({
  ...await original<any>(),
  resolveTurnScopeSystem: async () => ({ access: { workspaceId: 'workspace-test', userId: 'user-test', assistantId: 'assistant-test', assistantKind: 'primary', clearance: 'internal', compartments: [], mutationCompartments: [], projectIds: [], visibilityAssistantIds: null }, effectiveCompartments: [], effectiveProjectIds: [], writeCompartments: [], writeProjectIds: [], activeTeam: null, activeProject: null }),
  resolveLiveAccessCeilingSystem: async () => ({ workspaceId: 'workspace-test', userId: 'user-test', clearance: 'internal', compartments: [], mutationCompartments: [], projectIds: [], visibilityAssistantIds: null }),
}))
vi.mock('@use-brian/core', async (original) => ({
  ...await original<any>(),
  queryLoop: vi.fn(async function* (options) {
    await state.beforeLoop?.(options)
    for (const [index, event] of state.events.entries()) {
      yield event
      if (index === 0) await state.afterFirstEvent?.(options)
    }
  }),
  classifyTopic: async () => ({ isNewTopic: false, topic: 'test' }),
  buildMemoryContext: () => '',
  runMemoryNudge: async () => ({}),
}))
import { queryLoop } from '@use-brian/core'
import { addSessionMessage, touchTurnLease, releaseTurnLease, TURN_HEARTBEAT_INTERVAL_MS } from '../../db/sessions.js'
import { composeRecoveryMessage } from '../_recovery-message.js'
import { composeEmptyTurnSynthesis } from '../_empty-turn-synthesis.js'
import { chatRoutes } from '../chat.js'

async function run(extra: Record<string, unknown> = {}) {
  const app = express()
  app.use(express.json())
  app.use('/chat', chatRoutes({
    provider: { stream: async function* () {} }, systemPrompt: 'Test', tools: new Map(),
    capabilityStore: { listActive: async () => [] },
    memoryStore: {
      getSoul: async () => 'Test',
      getIndexRanked: async () => ({ rows: [], totalCount: 0 }),
      search: async () => [],
      getAll: async () => [],
      getIdentity: async () => [],
      getWorkspaceIdentity: async () => [],
      getWorkspaceIndex: async () => [],
      getWorkspaceMemoriesByCategory: async () => [],
    },
    publishSessionEvent: (event: any) => state.bus.push(event),
    ...extra,
  } as any))
  return request(app).post('/chat').send({ message: 'test', mode: 'default' })
}

beforeEach(() => {
  state.events = [{ type: 'error', error: new Error('Stream idle 30000ms') }]
  state.rows = []; state.bus = []; state.txClients = []; state.held = true; state.cancelled = false
  state.beforeLoop = null; state.afterFirstEvent = null; state.successor = null; state.onRelease = null; state.session.status = 'idle'; state.session.title = 'Existing title'
  vi.clearAllMocks()
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

function toolTurns(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    type: 'assistant_turn',
    response: { stopReason: 'tool_use', content: [{ type: 'tool_use', id: `call-${i}`, name: 'extractDocument', input: {} }] },
    toolResults: [{ type: 'tool_result', toolUseId: `call-${i}`, name: 'extractDocument', content: `evidence-${i}` }],
  }))
}
function frames(text: string) {
  return text.split('\n\n').filter((frame) => frame.startsWith('event:')).map((frame) => {
    const [event, data] = frame.split('\n')
    return { event: event.slice(7), data: JSON.parse(data.slice(6)) }
  })
}
function expectClosed(text: string) {
  expect(queryLoop).toHaveBeenCalledTimes(1)
  const events = frames(text)
  expect(events.at(-1)?.event).toBe('done')
  expect(events.some((e) => e.event === 'error')).toBe(false)
  const closures = state.rows.filter((row) => row.role === 'assistant' && row.content.some((b: any) => b.type === 'text' && b.text.includes('timed out')))
  expect(closures).toHaveLength(1)
  expect(closures[0].senderAssistantId).toBe('assistant-test')
  expect(events.filter((e) => e.event === 'text_delta' && e.data.text.includes('timed out'))).toHaveLength(1)
  expect(state.bus).toContainEqual(expect.objectContaining({ kind: 'assistant_message_saved', payload: expect.objectContaining({ id: closures[0].id, content: closures[0].content }) }))
  expect(composeRecoveryMessage).not.toHaveBeenCalled()
  expect(composeEmptyTurnSynthesis).not.toHaveBeenCalled()
  expect(releaseTurnLease).toHaveBeenCalledTimes(1)
  expect(console.info).toHaveBeenCalledWith('[chat] provider-error closing outcome', expect.objectContaining({ outcome: 'closed', persisted: true, mirrored: true, delivered: true }))
}

describe('actual chat route provider timeout (HTTP + real SSE/persistence wiring)', () => {
  it('closes zero-turn failures', async () => {
    expectClosed((await run()).text)
  })

  it.each([0, 17])('closes after %i tool turns plus partial unbuffered streamed text', async (count) => {
    const turns = toolTurns(count)
    state.events.unshift(...turns, { type: 'text_delta', text: 'private partial answer' })
    const response = await run()
    expectClosed(response.text)
    const text = frames(response.text).filter((e) => e.event === 'text_delta').map((e) => e.data.text).join('')
    expect(text).toContain('private partial answer\n\nThe model timed out')
    expect(state.rows.filter((r) => r.role === 'assistant')).toHaveLength(count + 1)
    const diagnostics = JSON.stringify(vi.mocked(console.info).mock.calls)
    expect(diagnostics).not.toContain('private partial answer')
    expect(diagnostics).toContain('"hadStreamedText":true')
  })

  it('preserves all 17 paired tool rows and adds one closure despite repeated errors', async () => {
    const turns = toolTurns(17)
    const original = structuredClone(turns)
    state.events = [...turns, ...state.events, ...state.events]
    expectClosed((await run()).text)
    expect(turns).toEqual(original)
    expect(state.rows.slice(1, -1)).toEqual(turns.flatMap((turn) => [
      expect.objectContaining({ role: 'assistant', content: turn.response.content }),
      expect.objectContaining({ role: 'user', content: turn.toolResults }),
    ]))
  })

  it.each(['empty', 'partial'] as const)('does not suppress closure or invoke synthesis for a buffered %s turn', async (kind) => {
    state.events.unshift({ type: 'assistant_turn', response: { stopReason: 'end_turn', content: kind === 'empty' ? [] : [{ type: 'text', text: 'Partial' }] }, toolResults: [] })
    expectClosed((await run()).text)
  })

  it('reports persistence failure without running another fallback or streaming an unsaved closure', async () => {
    state.beforeLoop = async () => { vi.mocked(addSessionMessage).mockRejectedValueOnce(new Error('write unavailable')) }
    const response = await run()
    expect(queryLoop).toHaveBeenCalledTimes(1)
    expect(state.rows.filter((r) => r.role === 'assistant')).toHaveLength(0)
    expect(response.text).not.toContain('timed out')
    expect(frames(response.text).filter((e) => e.event === 'error')).toHaveLength(1)
    expect(composeRecoveryMessage).not.toHaveBeenCalled()
    expect(composeEmptyTurnSynthesis).not.toHaveBeenCalled()
    expect(console.info).toHaveBeenCalledWith('[chat] provider-error closing outcome', expect.objectContaining({ outcome: 'failed', persisted: false, mirrored: false, delivered: false }))
  })

  it('saves every buffered row in one transaction and announces nothing when a later row fails', async () => {
    state.events = [...toolTurns(3), ...state.events]
    state.beforeLoop = async () => {
      vi.mocked(addSessionMessage).mockImplementation(async (row, client) => {
        // The first turn's tool-result row fails mid-flush, after its
        // assistant row was already written on the transaction client.
        if (client && row.role === 'user') throw new Error('write unavailable')
        const saved = { ...row, createdAt: new Date(), id: `row-${state.rows.length}`, sequenceNum: state.rows.length }
        state.rows.push(saved)
        return saved as any
      })
    }
    const response = await run()
    expect(state.txClients).toHaveLength(1)
    const [tx] = state.txClients
    expect(tx.query.mock.calls.map((call) => call[0])).toEqual(['BEGIN', 'ROLLBACK'])
    expect(tx.release).toHaveBeenCalledTimes(1)
    // Every flushed row went through the transaction client, none through the pool.
    const flushed = vi.mocked(addSessionMessage).mock.calls.filter(([, client]) => client !== undefined)
    expect(flushed.map(([row]) => row.role)).toEqual(['assistant', 'user'])
    for (const [, client] of flushed) expect(client).toBe(tx)
    // Rolled-back rows are never announced as saved, to the stream or the bus.
    expect(frames(response.text).some((e) => e.event === 'assistant_message_saved')).toBe(false)
    expect(state.bus.some((e) => e.kind === 'assistant_message_saved')).toBe(false)
    expect(frames(response.text).filter((e) => e.event === 'error')).toHaveLength(1)
  })

  it('commits the buffered rows in one transaction before announcing them', async () => {
    state.events = [...toolTurns(2), ...state.events]
    expectClosed((await run()).text)
    // The provider-error closure is a second, separate flush after the rows.
    const statements = state.txClients.map((tx) => tx.query.mock.calls.map((call) => call[0]))
    expect(statements[0]).toEqual(['BEGIN', 'COMMIT'])
    for (const tx of state.txClients) expect(tx.release).toHaveBeenCalledTimes(1)
  })

  it.each(['remote-stop', 'lease-lost', 'local-stop'] as const)('does not close or synthesize after %s', async (kind) => {
    if (kind === 'remote-stop') state.cancelled = true
    if (kind === 'lease-lost') state.held = false
    if (kind === 'local-stop') state.beforeLoop = async ({ context: { abortSignal } }) => {
      // Explicit stop route uses the same active-turn abort registry.
      const app = express(); app.use(express.json()); app.use((req, _res, next) => { (req as any).userId = 'user-test'; next() }); app.use('/chat', chatRoutes({} as any))
      await request(app).post('/chat/stop').send({ sessionId: state.session.id })
      expect(abortSignal.aborted).toBe(true)
    }
    const response = await run()
    expect(queryLoop).toHaveBeenCalledTimes(1)
    expect(state.rows.filter((r) => r.role === 'assistant')).toHaveLength(0)
    expect(response.text).not.toContain('timed out')
    expect(composeRecoveryMessage).not.toHaveBeenCalled()
    expect(composeEmptyTurnSynthesis).not.toHaveBeenCalled()
  })

  it('stops future heartbeats and ignores an in-flight stale tick before auto-title', async () => {
    const interval = vi.spyOn(globalThis, 'setInterval')
    const clear = vi.spyOn(globalThis, 'clearInterval')
    let resolveTick!: (value: { held: boolean; cancelRequested: boolean }) => void
    let signal!: AbortSignal
    let heartbeat: ReturnType<typeof setInterval>
    state.beforeLoop = async ({ context: { abortSignal } }) => {
      signal = abortSignal
      const index = interval.mock.calls.findIndex(([, ms]) => ms === TURN_HEARTBEAT_INTERVAL_MS)
      expect(index).toBeGreaterThanOrEqual(0)
      heartbeat = interval.mock.results[index].value
      vi.mocked(touchTurnLease).mockImplementationOnce(() => new Promise((resolve) => { resolveTick = resolve }))
      ;(interval.mock.calls[index][0] as () => void)()
    }
    state.onRelease = async () => {
      expect(clear).toHaveBeenCalledWith(heartbeat)
      resolveTick({ held: false, cancelRequested: false })
      await Promise.resolve()
      expect(signal.aborted).toBe(false)
    }
    state.session.title = ''
    const titleStream = vi.fn(async function* () {
      expect(releaseTurnLease).toHaveBeenCalledTimes(1)
      expect(signal.aborted).toBe(false)
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(signal.aborted).toBe(false)
      yield { type: 'text_delta', text: 'A useful test title' }
    })
    expectClosed((await run({ provider: { stream: titleStream } })).text)
    expect(titleStream).toHaveBeenCalledTimes(1)
    expect(touchTurnLease).toHaveBeenCalledTimes(2) // tick + final ownership check, no post-release tick
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('lease lost')
  })
})

describe('[COMP:api/turn-lease] a stopped turn and its successor', () => {
  const partial = [{
    type: 'assistant_turn',
    response: { stopReason: 'end_turn', content: [{ type: 'text', text: 'partial answer' }] },
    toolResults: [],
  }]
  const stopThen = (successorTookLease: boolean) => async ({ context: { abortSignal } }: any) => {
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { (req as any).userId = 'user-test'; next() }); app.use('/chat', chatRoutes({} as any))
    await request(app).post('/chat/stop').send({ sessionId: state.session.id })
    expect(abortSignal.aborted).toBe(true)
    // A plain stop releases the lease to NULL, exactly as the route does.
    // Stop, then retry: the retry's startTurnLease installs ANOTHER token.
    state.held = false
    if (successorTookLease) state.successor = 'lease-retry'
  }

  it('does not save a superseded turn\'s partial reply, and does not report it as an error', async () => {
    state.events = partial
    state.afterFirstEvent = stopThen(true)
    const response = await run()
    expect(state.rows.filter((r) => r.role === 'assistant')).toHaveLength(0)
    expect(frames(response.text).some((e) => e.event === 'error')).toBe(false)
  })

  it('still saves the partial reply of a stopped turn nobody replaced', async () => {
    state.events = partial
    state.afterFirstEvent = stopThen(false)
    await run()
    expect(state.rows.filter((r) => r.role === 'assistant')).toHaveLength(1)
  })
})
