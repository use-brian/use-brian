/**
 * [COMP:api/turn-kernel] T1 at the HTTP boundary (M3): an ordinary web chat
 * activates no connector family, even with Google Calendar connected.
 *
 * Drives one real `/chat` request through `chatRoutes` on the disposable
 * ordinary-owner PostgreSQL fixture with a connected workspace Google Calendar
 * instance (real encrypted `connector_instances` row, real catalog SQL) and
 * counts credential reads on the connector instance store: activation of a
 * Google family reads the stored grant, catalog preparation never does. The
 * surface module is a passthrough that records only the routine eligibility the
 * route passed, and the composition module a passthrough that records every
 * catalog activation selection.
 *
 * The routine read is late-activated (M3): with routine eligibility on, the
 * same stores still prepare with 0 credential reads, and the real routine read
 * port (owner-bound adapters, a fixture decision runtime) reads none either
 * when the plan is ordinary. With routine intent, exactly the Calendar read is
 * activated and the stored grant is read once: that is the positive control,
 * so a zero count is evidence, not an absent connector. The deployment has no
 * Google OAuth app configured, so the read's token refresh fails offline after
 * the credential read.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { LLMProvider, StreamChunk } from '@use-brian/agent-runtime/providers/types.js'
import type { Tool } from '@use-brian/agent-runtime/tools/types.js'

const surface = vi.hoisted(() => ({ calls: [] as Array<{ surface: string; routineCalendarRead: boolean | undefined }> }))
vi.mock('../../mcp/surface.js', async original => {
  const actual = await original<typeof import('../../mcp/surface.js')>()
  return { ...actual, composeSurfaceCapabilities: (async (name, options) => {
    surface.calls.push({ surface: name, routineCalendarRead: options.routineCalendarRead })
    return actual.composeSurfaceCapabilities(name, options)
  }) as typeof actual.composeSurfaceCapabilities }
})

const activations = vi.hoisted(() => ({ selections: [] as unknown[] }))
vi.mock('../../mcp/composition.js', async original => {
  const actual = await original<typeof import('../../mcp/composition.js')>()
  return { ...actual, prepareComposedCatalog: (async input => {
    const composed = await actual.prepareComposedCatalog(input)
    const activate = composed.catalog.activate
    return { ...composed, catalog: { ...composed.catalog, activate: selection => { activations.selections.push(structuredClone(selection)); return activate(selection) } } }
  }) as typeof actual.prepareComposedCatalog }
})

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

const { chatRoutes } = await import('../../routes/chat.js')
const { composeSurfaceCapabilities } = await import('../../mcp/surface.js')
const { getAppPool, getPool } = await import('../../db/client.js')
const { authSessionStore } = await import('../../db/auth-session-store.js')
const { createPersonalWebSession } = await import('../../db/sessions.js')
const { findAssistantById } = await import('../../db/users.js')
const { createDbMemoryStore } = await import('../../db/memory-store.js')
const { createDbCapabilityStore } = await import('../../db/capability-store.js')
const { createPendingApprovalsStore } = await import('../../db/pending-approvals-store.js')
const { createConnectorInstanceStore } = await import('../../db/connector-instance-store.js')
const { createDbConnectorStore } = await import('../../db/connector-store.js')
const { createConnectorGrantStore } = await import('../../db/connector-grant-store.js')
const { createDbMcpSettingsStore } = await import('../../db/mcp-settings-store.js')
const { resolveExecutionContextSystem } = await import('../../context-scope/execution-context.js')
const { persistentContextFixture } = await import('../../application-platform/__tests__/fixtures/persistent-context.js')
const { bindToolsToAgentAccess } = await import('../../context-scope/agent-access-tools.js')
const { executeRoutineCalendarRead } = await import('@use-brian/core/engine/routine-read.js')
const { inheritRoutineCalendarRead, ownsRoutineCalendarRead } = await import('@use-brian/core/engine/routine-read-ownership.js')
const { createLoopDetector } = await import('@use-brian/agent-runtime/engine/loop-detector.js')
const { NOOP_TURN_LEDGER } = await import('@use-brian/agent-runtime/engine/turn-ledger.js')
const { executionToolContext } = await import('@use-brian/agent-runtime/security/execution-context.js')
const { ContextScopeAccumulator } = await import('@use-brian/agent-runtime/security/context-scope.js')
const { executionFixture, fixtureDecisionProvider } = await import('../../../../core/src/decisions/__tests__/execution-fixture.js')

describe.sequential('[COMP:api/turn-kernel] T1: ordinary chat activates no connector', () => {
  afterAll(async () => { await getAppPool().end(); await getPool().end() })

  it('prepares Google Calendar as a catalogue entry only, and activates exactly its read only for a planned routine read', async () => {
    const f = await persistentContextFixture('confidential')
    try {
      await f.pool.query("UPDATE workspaces SET plan='pro' WHERE id=$1", [f.workspaceId])
      const key = randomBytes(32)
      const instances = createConnectorInstanceStore(key)
      await instances.createWorkspaceInstance({ workspaceId: f.workspaceId, provider: 'gcal', label: 'Google Calendar', createdBy: f.ownerId,
        connected: true, credentials: { client_id: 'fictional-client', client_secret: 'fictional-refresh-token' }, compartments: [], projectIds: [] })
      const credentialReads: string[] = []
      const counted = new Proxy(instances, { get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver)
        if (typeof value !== 'function') return value
        if (typeof property === 'string' && /credential/i.test(property)) {
          return (...args: unknown[]) => { credentialReads.push(property); return (value as (...a: unknown[]) => unknown).apply(target, args) }
        }
        return value.bind(target)
      } })
      const stores = { connectorStore: createDbConnectorStore(key), mcpSettingsStore: createDbMcpSettingsStore(),
        connectorInstanceStore: counted, connectorGrantStore: createConnectorGrantStore() }

      const offered: string[][] = []
      const reply: StreamChunk[] = [{ type: 'message_start', model: 'fixture' }, { type: 'text_delta', text: 'Fictional ordinary answer.' },
        { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 3 } }]
      const provider: LLMProvider = { name: 'fictional-t1', models: ['fixture'],
        async *stream() { yield* [{ type: 'message_start', model: 'fixture' }, { type: 'text_delta', text: '{"research":false}' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }] as StreamChunk[] },
        createSession(options) { offered.push((options.tools ?? []).map(tool => tool.name)); return { send() { return (async function* () { yield* reply })() } } } }
      const device = (await authSessionStore.create(f.ownerId, { deviceLabel: 'Fictional T1 browser', userAgent: null, ipAddress: null }))!
      const session = await createPersonalWebSession({
        assistantId: f.assistantId, userId: f.ownerId, workspaceId: f.workspaceId, channelType: 'web', channelId: randomUUID(), appOrigin: 'chat',
      }, { actorUserId: f.ownerId, authSessionId: device.id, authVersion: device.authVersion })
      const app = express(); app.use(express.json()); app.use((req, _res, next) => {
        req.userId = f.ownerId; req.authSessionId = device.id; req.authVersion = device.authVersion; next()
      })
      app.use('/chat', chatRoutes({ provider, systemPrompt: 'Continue the fictional conversation.', tools: new Map(),
        memoryStore: createDbMemoryStore(), capabilityStore: createDbCapabilityStore(), pendingApprovalsStore: createPendingApprovalsStore(), ...stores }))
      const response = await request(app).post('/chat').send({ sessionId: session.id, assistantId: f.assistantId, workspaceId: f.workspaceId,
        message: 'Which notebook did we choose earlier?', model: 'standard' }).buffer(true).parse((res, done) => {
        let text = ''; res.on('data', (chunk: Buffer) => { text += chunk.toString() }); res.on('end', () => done(null, text)); res.on('error', done)
      })
      expect(response.status).toBe(200)
      expect(String(response.body)).not.toContain('event: error')
      expect(String(response.body)).toContain('Fictional ordinary answer.')
      // The route asked for no routine Calendar read (no decision runtime on this deployment) …
      expect(surface.calls.filter(call => call.surface === 'web')).toEqual([{ surface: 'web', routineCalendarRead: false }])
      // … so no Google family was activated: no stored grant was read.
      expect(credentialReads).toEqual([])
      // Calendar is still catalogued: the search pair over it reaches the model.
      expect(offered.length).toBeGreaterThan(0)
      expect(offered[0]).toContain('mcp_search')
      expect(offered[0]).not.toContain('googleCalendarListEvents')

      expect(activations.selections).toEqual([])

      // Routine eligibility on, through the real routine read port: one fresh
      // preparation of the same stores per case, bound through the owner's
      // access scope like the route's adapters.
      const assistant = (await findAssistantById(f.assistantId))!
      const llm: LLMProvider = { name: 'fictional-routine', models: ['fixture'], stream() { throw new Error('Unexpected stateless request') },
        createSession() { throw new Error('The routine phase composes nothing') } }
      const routineTurn = async (choice: 'ordinary' | 'calendar') => {
        const resolved = await resolveExecutionContextSystem({ userId: f.ownerId, workspaceId: f.workspaceId, assistant, memberMode: 'member',
          identity: { kind: 'attended', principal: { kind: 'workspace_member', userId: f.ownerId } }, ownership: { kind: 'workspace', workspaceId: f.workspaceId },
          lifecycle: { sessionId: randomUUID(), sessionPersisted: false, channelType: 'test', channelId: 'fixture', abortSignal: new AbortController().signal } })
        const tools = new Map<string, Tool>()
        const prepared = await composeSurfaceCapabilities('web', { userId: f.ownerId, assistantId: f.assistantId, assistantTeamId: f.workspaceId, tools,
          connectorStore: stores.connectorStore, settingsStore: stores.mcpSettingsStore, connectorInstanceStore: counted,
          connectorGrantStore: stores.connectorGrantStore, contextScope: resolved.turnScope, executionContext: resolved.executionContext,
          exposeLocalReadTools: true, routineCalendarRead: true })
        const preparationReads = credentialReads.length, preparationActivations = activations.selections.length
        const adapters = prepared.routineCalendarTools ?? new Map<string, Tool>()
        const bound = bindToolsToAgentAccess(tools, resolved.executionContext.security.access)
        const calendarTools = new Map<string, Tool>()
        for (const [name, adapter] of adapters) {
          expect(tools.get(name)).toBe(adapter)
          calendarTools.set(name, inheritRoutineCalendarRead(adapter, bound.get(name)!))
        }
        const full = async () => {}
        const context: import('@use-brian/agent-runtime/tools/types.js').ToolContext = {
          ...executionToolContext(resolved.executionContext, { appId: 'fictional-routine-read' }),
          scopeAccumulator: new ContextScopeAccumulator(resolved.executionContext.security.provenance), admitModelInput: full }
        const runtime = executionFixture({ llm, totalTimeoutMs: 60_000, primaryTimeoutMs: 50_000, primary: fixtureDecisionProvider(async request => {
          const state = request.state as unknown as { targets: Array<{ id: string }>; ranges: Array<{ id: string }> }
          const answers = request.questions.map(question => question.kind === 'boolean'
            ? { kind: 'boolean' as const, questionId: question.id, value: question.id === state.targets[0].id, evidence: { source: 'unavailable' as const } }
            : { kind: 'choice' as const, questionId: question.id, value: question.id === 'routine' ? choice : state.ranges[0].id, evidence: { source: 'unavailable' as const } })
          return { providerId: 'fixture-decision', model: request.model, answers }
        }) })
        const activationOutcomes: unknown[] = []
        let readsAtActivation: number | null = null
        const options = { provider: llm, model: 'fixture', systemPrompt: 'Answer from the fictional calendar.', messages: [{ role: 'user' as const, content: 'What is on my calendar today?' }],
          tools: bound, context, ledger: NOOP_TURN_LEDGER, maxTurns: 1,
          routineCalendarRead: { runtime, llm: { provider: llm, modelId: 'fixture' }, calendarTools, onActivation: (outcome: unknown) => { activationOutcomes.push(outcome); readsAtActivation = credentialReads.length } } }
        const phase = executeRoutineCalendarRead({ options, tools: bound, loopDetector: createLoopDetector({ hardLimit: 10 }), deniedTools: new Set(),
          ledger: NOOP_TURN_LEDGER.startTrace({ actor: 'assistant_turn', model: 'fixture', systemPrompt: '', messages: [] }), assertInputAuthority: full })
        const started: string[] = []
        let step = await phase.next()
        while (!step.done) { if (step.value.type === 'tool_start') started.push(step.value.name); step = await phase.next() }
        return { adapters, preparationReads, preparationActivations, readsAtActivation, started, activationOutcomes, result: step.value }
      }

      // Eligible, no routine intent: nothing activates, no stored grant is read.
      const ordinary = await routineTurn('ordinary')
      expect(ordinary.adapters.size).toBeGreaterThan(0)
      for (const adapter of ordinary.adapters.values()) expect(ownsRoutineCalendarRead(adapter)).toBe(true)
      expect(ordinary.preparationReads).toBe(0)
      expect(ordinary.preparationActivations).toBe(0)
      expect(ordinary.started).toEqual([])
      expect(ordinary.result.calls).toBe(0)
      expect(ordinary.activationOutcomes).toEqual([])
      expect(credentialReads).toEqual([])
      expect(activations.selections).toEqual([])

      // Routine intent (positive control): exactly the Calendar read activates,
      // after planning, and the stored grant is read once.
      const planned = await routineTurn('calendar')
      expect(planned.preparationReads).toBe(0)
      expect(planned.preparationActivations).toBe(0)
      const [calendarRead] = [...planned.adapters.keys()]
      expect(activations.selections).toEqual([{ toolNames: [calendarRead] }])
      expect(planned.activationOutcomes).toEqual([{ status: 'ready', activated: 1 }])
      expect(planned.started).toEqual([calendarRead])
      expect(planned.result.calls).toBe(1)
      // The late activation read the stored grant exactly once …
      expect(planned.readsAtActivation).toBe(1)
      // … and the dispatched read, reaching the activated tool through the bound
      // adapter, is the only other reader: with no OAuth app configured its
      // token refresh re-reads the grant and fails offline, an honest error
      // observation rather than an empty calendar.
      expect(credentialReads).toEqual(['getCredentialsSystem', 'getCredentialsSystem'])
      expect(planned.result.records).toHaveLength(1)
      expect(planned.result.records[0]).toMatchObject({ name: calendarRead, isError: true })
      expect(planned.result.complete).toBe(false)
      expect(activations.selections).toHaveLength(1)
    } finally { await f.cleanup() }
  }, 120_000)
})
