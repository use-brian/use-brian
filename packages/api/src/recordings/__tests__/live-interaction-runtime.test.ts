import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveInteractionDeps } from '../live-interaction-service.js'

const mocks = vi.hoisted(() => ({
  service: vi.fn(), create: vi.fn(), session: vi.fn(), assistant: vi.fn(), resolve: vi.fn(),
  query: vi.fn(), txQuery: vi.fn(), add: vi.fn(), sources: vi.fn(), answer: vi.fn(),
  ledger: vi.fn(), release: vi.fn(), rule: vi.fn(),
}))
vi.mock('../live-interaction-service.js', () => ({
  InteractionError: class extends Error { constructor(public status: number, message: string) { super(message) } },
  createLiveInteractionService: mocks.service,
}))
vi.mock('../../db/sessions.js', () => ({ findSessionById: mocks.session, addSessionMessage: mocks.add }))
vi.mock('../../db/users.js', () => ({ findAssistantById: mocks.assistant }))
vi.mock('../../context-scope/execution-context.js', () => ({ resolveExecutionContextSystem: mocks.resolve }))
vi.mock('../../db/derived-scope-store.js', () => ({ readCurrentScopeSources: mocks.sources }))
vi.mock('../../db/client.js', () => ({ getPool: () => ({ query: mocks.query,
  connect: async () => ({ query: mocks.txQuery, release: mocks.release }) }) }))
vi.mock('../../db/live-interaction-store.js', () => ({ createLiveInteractionStore: () => ({
  claimInbox: async () => ({ capture }), listUtterances: async () => [{ id: 'speech', text: 'latest', source: 'system', startMs: 1, endMs: 2 }],
}) }))
vi.mock('../../ledger/recorder.js', () => ({ createTurnLedger: mocks.ledger }))
vi.mock('../live-interaction-model.js', () => ({ createInteractionAnswerAdapter: () => mocks.answer,
  createInteractionRuleEvaluator: (_p: unknown, _m: unknown, opts: unknown) => (input: unknown) => mocks.rule(input, opts),
}))
import { createLiveInteractionRuntime, type LiveInteractionRuntimeDeps } from '../live-interaction-runtime.js'

const capture = { id: 'capture', ownerId: 'owner', workspaceId: 'workspace', assistantId: 'assistant',
  pageId: 'page', chatSessionId: 'chat', rule: 'rule', ruleVersion: 1, state: 'listening' as const }
const job = { id: 'job', captureId: 'capture', chatSessionId: 'chat', pageId: 'page', question: 'question',
  status: 'completed' as const, answer: 'answer', error: null, createdAt: '', token: 'lease', assistantMessageId: 'reserved' }
let callbacks: LiveInteractionDeps
let deps: LiveInteractionRuntimeDeps
let data: Record<string, unknown>
let fenced: boolean
beforeEach(() => {
  vi.clearAllMocks()
  fenced = true
  data = { publicationEvidence: { sensitivity: 'internal', compartments: ['team'], projectIds: ['project'] } }
  mocks.service.mockImplementation((input: LiveInteractionDeps) => { callbacks = input; return {
    create: mocks.create,
    preview: (rule: string, text: string) => input.evaluateRule!({ rule, text }, new AbortController().signal),
  } })
  mocks.session.mockResolvedValue({ id: 'chat', userId: 'owner', assistantId: 'assistant', visibility: 'owner',
    channelType: 'web', channelId: 'channel', mode: null, appId: 'app' })
  mocks.assistant.mockResolvedValue({ id: 'assistant', workspaceId: 'workspace' })
  mocks.resolve.mockResolvedValue({ turnScope: { access: { workspaceId: 'workspace', userId: 'owner',
    assistantId: 'assistant', clearance: 'confidential', compartments: null, projectIds: null },
    writeCompartments: [], writeProjectIds: [] },
    executionContext: { security: { authority: { assertCurrent: vi.fn() } } } })
  mocks.query.mockResolvedValue({ rows: [], rowCount: 1 })
  mocks.txQuery.mockImplementation(async (sql: string, args?: unknown[]) => {
    if (sql.startsWith('SELECT data')) return { rows: fenced ? [{ data }] : [] }
    if (sql.startsWith('UPDATE live_interaction_jobs')) data = { ...data, ...JSON.parse(args![1] as string) }
    return { rows: [] }
  })
  mocks.add.mockImplementation(async ({ role }: { role: string }) => ({ id: `actual-${role}` }))
  mocks.sources.mockResolvedValue([])
  mocks.ledger.mockImplementation(() => ({ ledger: {}, flush: async () => {} }))
  mocks.answer.mockImplementation(async input => {
    input.createContext(new AbortController().signal)
    await input.onText('a'); await input.onText('b')
    return { text: 'ab', evidence: [] }
  })
  deps = { provider: {} as never, model: 'model', tools: new Map(), knowledgeStore: {} as never,
    payloads: {} as never, savedViewStore: { getById: vi.fn().mockResolvedValue({ workspaceId: 'workspace', clearance: 'internal', projectId: 'project' }) },
    workspaceStore: { getRole: vi.fn().mockResolvedValue('member') } }
  createLiveInteractionRuntime(deps)
})
const publish = () => callbacks.publish({ capture, job, signal: new AbortController().signal })

describe('[COMP:recordings/live-interaction] runtime', () => {
  it('binds a main-chat capture to its own assistant rather than the dock assistant', async () => {
    const runtime = createLiveInteractionRuntime(deps)
    await runtime.create('owner', { ...capture, assistantId: 'dock-assistant' })
    expect(mocks.create).toHaveBeenCalledWith('owner', capture)
    mocks.create.mockClear()
    await expect(runtime.create('stranger', capture)).rejects.toThrow('access denied')
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it.each([
    { userId: 'stranger' }, { visibility: 'workspace' }, { channelType: 'slack' },
    { assistantId: 'other' }, { mode: 'draft' },
  ])('rejects non-personal or mismatched destinations %j', async patch => {
    mocks.session.mockResolvedValue({ ...await mocks.session(), ...patch })
    expect(await callbacks.authorize('owner', capture)).toBe(false)
  })
  it('requires current membership and a readable page in the same workspace', async () => {
    expect(await callbacks.authorize('owner', capture)).toBe(true)
    vi.mocked(deps.workspaceStore.getRole).mockResolvedValue(null)
    expect(await callbacks.authorize('owner', capture)).toBe(false)
    vi.mocked(deps.workspaceStore.getRole).mockResolvedValue('member')
    vi.mocked(deps.savedViewStore.getById).mockResolvedValue(null)
    expect(await callbacks.authorize('owner', capture)).toBe(false)
  })
  it('publishes once and transactionally replaces reserved IDs with canonical IDs', async () => {
    await publish(); await publish()
    expect(mocks.add).toHaveBeenCalledTimes(2)
    expect(data).toMatchObject({ userMessageId: 'actual-user', assistantMessageId: 'actual-assistant', canonicalPublished: true })
    expect(mocks.add.mock.calls[1]![0].scope).toMatchObject({ userId: 'owner', assistantId: null,
      workspaceId: 'workspace', compartments: ['team'], projectIds: ['project'] })
    expect(mocks.txQuery.mock.calls.map(call => call[0])).toContain('COMMIT')
    const rebind = mocks.txQuery.mock.calls.filter(call => call[0].startsWith('UPDATE turn_events'))
    expect(rebind).toHaveLength(1)
    expect(rebind[0]![1]).toEqual(['actual-assistant', 'reserved', 'chat', 'workspace'])
  })
  it('fences stale workers and refuses changed or held evidence', async () => {
    fenced = false
    await expect(publish()).rejects.toThrow('lease lost')
    expect(mocks.add).not.toHaveBeenCalled()
    fenced = true
    mocks.sources.mockResolvedValue([{ state: 'held' }])
    await expect(publish()).rejects.toThrow('evidence changed')
    expect(mocks.add).not.toHaveBeenCalled()
    expect(mocks.txQuery).toHaveBeenCalledWith('ROLLBACK')
  })
  it('does not publish after permission loss', async () => {
    vi.mocked(deps.workspaceStore.getRole).mockResolvedValue(null)
    await expect(publish()).rejects.toThrow('access denied')
    expect(mocks.add).not.toHaveBeenCalled()
  })
  it('creates fresh contexts and ledgers, records page labels, and streams cumulative text', async () => {
    const onText = vi.fn()
    for (let i = 0; i < 2; i++) await callbacks.answer({ capture, job, signal: new AbortController().signal, onText })
    const inputs = mocks.answer.mock.calls.map(call => call[0])
    const contexts = inputs.map(input => input.createContext(new AbortController().signal))
    expect(contexts[0].scopeAccumulator).not.toBe(contexts[1].scopeAccumulator)
    expect(contexts[0].scopeAccumulator.evidence).toMatchObject({ sensitivity: 'internal', projectIds: ['project'] })
    expect(inputs[0].ledger).not.toBe(inputs[1].ledger)
    expect([...inputs[0].tools.keys()]).toContain('searchKnowledge')
    expect([...inputs[0].tools.keys()]).not.toContain('addKnowledgeEntry')
    expect(onText.mock.calls.slice(0, 2)).toEqual([['a'], ['ab']])
  })
  it.each(['running', 'completed'] as const)('gates %s polling on evidence even when the page remains readable', async status => {
    const polled = { ...job, status, ...data }
    expect(await callbacks.authorizeJob!(capture, polled)).toBe(true)
    mocks.sources.mockResolvedValue([{ state: 'held' }])
    expect(await callbacks.authorize('owner', capture)).toBe(true)
    expect(await callbacks.authorizeJob!(capture, polled)).toBe(false)
    mocks.sources.mockResolvedValue([])
    const resolved = await mocks.resolve()
    resolved.turnScope.access.compartments = []
    expect(await callbacks.authorizeJob!(capture, polled)).toBe(false)
  })
  it('hides missing-evidence answers but keeps queued jobs visible', async () => {
    expect(await callbacks.authorizeJob!(capture, job)).toBe(false)
    expect(await callbacks.authorizeJob!(capture, { ...job, status: 'queued', answer: '' })).toBe(true)
    const evidenceOnly = { ...job, answer: '', answerEvidence: ['retrieved content'] }
    expect(await callbacks.authorizeJob!(capture, evidenceOnly)).toBe(false)
  })
  it('persists exact evidence and labels before every partial callback', async () => {
    const evidence = [{ type: 'tool_result', toolUseId: 'kb', name: 'searchBrain', content: 'exact citation' }]
    mocks.answer.mockImplementationOnce(async input => {
      await input.onEvidence(evidence)
      await input.onText('partial')
      return { text: 'partial', evidence }
    })
    const onText = vi.fn(async () => {
      const saved = mocks.query.mock.calls.filter(call => call[0].startsWith('UPDATE live_interaction_jobs')).at(-1)!
      expect(JSON.parse(saved[1][2])).toMatchObject({ sensitivity: 'internal', projectIds: ['project'] })
      expect(JSON.parse(saved[1][3])).toEqual(evidence)
    })
    await callbacks.answer({ capture, job, signal: new AbortController().signal, onText })
    expect(onText).toHaveBeenCalledWith('partial')
    expect(JSON.parse(mocks.query.mock.calls.at(-1)![1][3])).toEqual(evidence)
  })
  it('never exposes a partial when evidence persistence loses its lease', async () => {
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 })
    const onText = vi.fn()
    await expect(callbacks.answer({ capture, job, signal: new AbortController().signal, onText })).rejects.toThrow('lease lost')
    expect(onText).not.toHaveBeenCalled()
  })
  it('includes registered workspace retrieval alongside the company KB', async () => {
    deps.tools = new Map(['searchBrain', 'browseBrain'].map(name => [name, { name, isReadOnly: true } as never]))
    createLiveInteractionRuntime(deps)
    await callbacks.answer({ capture, job, signal: new AbortController().signal, onText: vi.fn() })
    expect([...mocks.answer.mock.calls[0]![0].tools.keys()]).toEqual(expect.arrayContaining([
      'searchBrain', 'browseBrain', 'searchKnowledge', 'browseKnowledge',
    ]))
  })
  it('filters rejected canonical output from the real service jobs endpoint', async () => {
    const { createLiveInteractionService } = await vi.importActual<typeof import('../live-interaction-service.js')>('../live-interaction-service.js')
    mocks.sources.mockResolvedValue([{ state: 'held' }])
    await expect(publish()).rejects.toThrow('evidence changed')
    const queued = { ...job, id: 'queued', status: 'queued' as const, answer: '' }
    const runtime = createLiveInteractionService({ ...callbacks, store: {
      ...callbacks.store!, capture: async () => capture,
      job: async () => ({ ...job, ...data }),
      listJobs: async () => [{ ...job, ...data }, queued],
    } })
    expect(await runtime.jobs('owner', 'workspace', 'chat')).toEqual([queued])
  })
  it('meters detector rules but never attributes preview to an active capture', async () => {
    const runtime = createLiveInteractionRuntime(deps)
    await callbacks.store!.claimInbox()
    await callbacks.evaluateRule!({ rule: 'rule', text: 'speech' }, new AbortController().signal)
    expect(mocks.rule.mock.calls[0]![1].onUsage).toBeTypeOf('function')
    await runtime.preview('rule', 'preview')
    expect(mocks.rule.mock.calls[1]![1].onUsage).toBeUndefined()
  })
})
