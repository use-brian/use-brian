import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { runPreflight } from '@use-brian/core/workers/preflight.js'
import { calculateCost } from '@use-brian/agent-runtime/billing/cost-tracker.js'
import type { LLMProvider, StreamChunk } from '@use-brian/agent-runtime/providers/types.js'
import { createExecutionContext } from '@use-brian/agent-runtime/security/execution-context.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  persist: vi.fn(), history: vi.fn(),
  current: vi.fn(),
  audience: vi.fn(),
  budget: vi.fn(),
  claim: vi.fn(), release: vi.fn(), wait: vi.fn(),
}))

vi.mock('../../db/sessions.js', async original => ({
  ...(await original<typeof import('../../db/sessions.js')>()),
  findOrCreateSession: vi.fn(async () => ({ id: 'session', visibility: 'personal', channelType: 'feishu' })),
  addSessionMessage: mocks.persist, getSessionMessages: mocks.history,
  claimTurnLeaseOutcome: mocks.claim,
  releaseTurnOutcome: mocks.release,
  touchTurnLease: vi.fn(async () => ({ held: true, cancelRequested: false })),
}))
vi.mock('../../db/workspace-store.js', async original => ({
  ...(await original<typeof import('../../db/workspace-store.js')>()),
  getWorkspaceRoleSystem: vi.fn(async () => 'member'),
  getWorkspacePlan: vi.fn(async () => 'pro'),
}))
vi.mock('../../billing-party.js', () => ({ billingPartyForAssistant: vi.fn(async () => 'owner') }))
vi.mock('../../channel-room/room.js', async original => ({
  ...(await original<typeof import('../../channel-room/room.js')>()),
  resolveRoomBinding: vi.fn(async () => null),
}))
vi.mock('../../context-scope/execution-context.js', async original => ({
  ...(await original<typeof import('../../context-scope/execution-context.js')>()),
  resolveExecutionContextSystem: vi.fn(async (input: { workspaceId?: string | null; sessionId?: string }) => ({
    turnScope: {
      access: { userId: 'user', workspaceId: input.workspaceId, clearance: 'internal', compartments: [], projectIds: [] },
      effectiveCompartments: [], writeCompartments: [], effectiveProjectIds: [], writeProjectIds: [],
    },
    executionContext: createExecutionContext({
      identity: { kind: 'attended', principal: { kind: 'workspace_member', userId: 'user', authenticationKind: 'native_session' } },
      ownership: input.workspaceId ? { kind: 'workspace', workspaceId: input.workspaceId } : { kind: 'personal', ownerUserId: 'user' },
      access: { userId: 'user', workspaceId: input.workspaceId ?? '', assistantId: 'assistant', assistantKind: 'standard',
        clearance: 'internal', compartments: [], mutationCompartments: [], projectIds: [], visibilityAssistantIds: ['assistant'] },
      writeDefaults: { compartments: [], projectIds: [] },
      authority: { assertCurrent: mocks.current, async execute(operation) { await mocks.current(); return operation() } },
      lifecycle: { sessionId: input.sessionId ?? 'session', channelType: 'feishu', channelId: 'conversation', abortSignal: new AbortController().signal },
    }),
  })),
}))
vi.mock('../../context-scope/delivery-authority.js', async original => ({
  ...(await original<typeof import('../../context-scope/delivery-authority.js')>()),
  createDeliveryAudienceAuthorizer: () => mocks.audience,
}))
vi.mock('../route-helpers.js', async original => ({
  ...(await original<typeof import('../route-helpers.js')>()), checkUsageBudget: mocks.budget,
}))

vi.mock('../../turn/lease.js', async original => ({ ...await original<typeof import('../../turn/lease.js')>(), waitForTurnSlot: mocks.wait }))

import { abortLocalTurn, TurnLeaseLostError, TurnStoppedError } from '../../turn/lease.js'
import { processChannelMessage, type ChannelPipelineParams } from '../channel-pipeline.js'
import { channelConfirmations } from '../channel-interactions.js'
import { AuthorityChangedError } from '../../context-scope/authority-lease.js'

const scope = { channelType: 'feishu', integrationId: 'integration', conversationId: 'conversation', senderId: 'sender' }

function turn() {
  const hooks = {
    onProcessingStart: vi.fn(async () => {}),
    onCleanup: vi.fn(async () => {}),
    sendResponse: vi.fn(async () => {}),
    sendError: vi.fn(async (_error: Error) => {}),
  }
  const params = {
    admittedAnswerContext: { kind: 'continue' },
    interactionScope: scope,
    abortController: new AbortController(),
    assistant: { id: 'assistant', workspaceId: null, clearance: 'internal' },
    userId: 'user', ownerId: 'owner', isIdentified: true,
    channelType: 'feishu', channelId: 'conversation', isGroupChat: false,
    messageText: 'What is in progress?', userContentBlocks: [{ type: 'text', text: 'What is in progress?' }],
    hooks, publishSessionEvent: vi.fn(),
  } as unknown as ChannelPipelineParams
  return { params, hooks }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.wait.mockReset().mockResolvedValue(false)
  mocks.claim.mockReset().mockResolvedValue({ token: "processing-token", turnId: "a".repeat(64) })
  mocks.release.mockReset().mockImplementation(async (_id, reason) => ({ turnId: "a".repeat(64), reason }))
  mocks.current.mockResolvedValue(undefined)
  mocks.audience.mockResolvedValue({ allowed: true, evidence: { sensitivity: 'public', compartments: [], projectIds: [] } })
  mocks.budget.mockResolvedValue({ status: 'ok' })
})


const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('[COMP:api/turn-kernel] channel preparation under the original owner', () => {
  it('holds the existing owner before progress and input persistence and releases only after preparation cleanup', async () => {
    const append = deferred<never>()
    const { params, hooks } = turn()
    mocks.persist.mockReturnValue(append.promise)
    const running = processChannelMessage(params).catch(error => error)
    await vi.waitFor(() => expect(mocks.persist).toHaveBeenCalledOnce())
    expect(mocks.claim).toHaveBeenCalledExactlyOnceWith('session', 'assistant', expect.any(Date))
    expect(hooks.onProcessingStart).toHaveBeenCalledOnce()
    expect(mocks.claim.mock.invocationCallOrder[0]).toBeLessThan(hooks.onProcessingStart.mock.invocationCallOrder[0])
    expect(hooks.onProcessingStart.mock.invocationCallOrder[0]).toBeLessThan(mocks.persist.mock.invocationCallOrder[0])
    expect(mocks.release).not.toHaveBeenCalled()
    append.reject(new Error('Synthetic preparation failure'))
    expect(await running).toMatchObject({ message: 'Synthetic preparation failure' })
    expect(hooks.onCleanup).toHaveBeenCalledOnce()
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith('session', 'failed', 'processing-token')
    expect(hooks.onCleanup.mock.invocationCallOrder[0]).toBeLessThan(mocks.release.mock.invocationCallOrder[0])
  })

  it('does no progress/context/model work when canonical claim refuses', async () => {
    mocks.claim.mockResolvedValue(null)
    const { params, hooks } = turn()
    await processChannelMessage(params)
    expect(mocks.wait).toHaveBeenCalledOnce()
    expect(hooks.sendResponse).toHaveBeenCalledOnce()
    expect(hooks.onProcessingStart).not.toHaveBeenCalled()
    expect(mocks.history).not.toHaveBeenCalled()
    expect(mocks.release).not.toHaveBeenCalled()
  })

  it('rechecks the original authority after a slot wait before preparing a turn', async () => {
    const refused = new AuthorityChangedError(false)
    mocks.claim.mockResolvedValueOnce(null)
    mocks.wait.mockImplementationOnce(async () => { mocks.current.mockRejectedValue(refused); return true })
    const { params, hooks } = turn()
    await processChannelMessage(params)
    expect(mocks.claim).toHaveBeenCalledTimes(2)
    expect(hooks.sendError).toHaveBeenCalledExactlyOnceWith(refused)
    expect(hooks.onProcessingStart).not.toHaveBeenCalled()
    expect(mocks.history).not.toHaveBeenCalled()
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith('session', 'failed', 'processing-token')
  })

  it('forwards the original abort signal through a slot wait and never begins preparation after Stop', async () => {
    const { params, hooks } = turn()
    mocks.claim.mockResolvedValue(null)
    mocks.wait.mockImplementationOnce(async (_id, options) => {
      expect(options.signal).toBe(params.abortController.signal)
      params.abortController.abort(new TurnStoppedError())
      return true
    })
    await processChannelMessage(params)
    expect(mocks.claim).toHaveBeenCalledOnce()
    expect(hooks.onProcessingStart).not.toHaveBeenCalled()
    expect(mocks.history).not.toHaveBeenCalled()
    expect(hooks.sendResponse).not.toHaveBeenCalled()
    expect(hooks.onCleanup).toHaveBeenCalledOnce()
    expect(mocks.release).not.toHaveBeenCalled()
  })

  it('registers exact-owner Stop before progress delivery and settles its original public ID', async () => {
    const { params, hooks } = turn()
    hooks.onProcessingStart.mockImplementation(async () => { expect(abortLocalTurn('session', 'processing-token')).toBe(true) })
    await processChannelMessage(params)
    expect(params.abortController.signal.reason).toBeInstanceOf(TurnStoppedError)
    expect(mocks.history).not.toHaveBeenCalled()
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith('session', 'stopped_by_user', 'processing-token')
    expect(params.publishSessionEvent).toHaveBeenCalledExactlyOnceWith({ kind: 'turn_completed', sessionId: 'session', payload: { senderUserId: 'user', turnId: 'a'.repeat(64), reason: 'stopped_by_user' } })
  })

  it('keeps provider-native explicit Stop distinct from a failed or lost turn', async () => {
    const { params, hooks } = turn()
    hooks.onProcessingStart.mockImplementation(async () => { expect(channelConfirmations.handle(scope, { kind: 'text', text: 'stop' }).handled).toBe(true) })
    await processChannelMessage(params)
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith('session', 'stopped_by_user', 'processing-token')
    expect(hooks.sendResponse).toHaveBeenCalledExactlyOnceWith('Stopped.')
    expect(mocks.history).not.toHaveBeenCalled()
    expect(hooks.sendError).not.toHaveBeenCalled()
  })

  it('does not announce completion or run recovery after loss to a successor during preparation', async () => {
    const { params, hooks } = turn()
    mocks.persist.mockImplementation(async () => { params.abortController.abort(new TurnLeaseLostError()); throw params.abortController.signal.reason })
    mocks.release.mockResolvedValue(null)
    await expect(processChannelMessage(params)).rejects.toBeInstanceOf(TurnLeaseLostError)
    expect(hooks.onCleanup).toHaveBeenCalledOnce()
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith('session', 'failed', 'processing-token')
    expect(params.publishSessionEvent).not.toHaveBeenCalled()
    expect(hooks.sendResponse).not.toHaveBeenCalled()
    expect(hooks.sendError).not.toHaveBeenCalled()
  })

  it('releases even when progress and transport cleanup both fail', async () => {
    const { params, hooks } = turn()
    hooks.onProcessingStart.mockRejectedValue(new Error('Synthetic start failure'))
    hooks.onCleanup.mockRejectedValue(new Error('Synthetic cleanup failure'))
    await expect(processChannelMessage(params)).rejects.toThrow('Synthetic cleanup failure')
    expect(hooks.onCleanup).toHaveBeenCalledOnce()
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith('session', 'failed', 'processing-token')
  })

  it('publishes only the source-owned predecessor outcome on stale takeover', async () => {
    const { params, hooks } = turn()
    mocks.claim.mockResolvedValue({ token: 'processing-token', turnId: 'a'.repeat(64), recovered: { turnId: 'b'.repeat(64), reason: 'publication_recovered' } })
    hooks.onProcessingStart.mockRejectedValue(new Error('Synthetic start failure'))
    await expect(processChannelMessage(params)).rejects.toThrow('Synthetic start failure')
    expect(params.publishSessionEvent).toHaveBeenNthCalledWith(1, { kind: 'turn_completed', sessionId: 'session', payload: { senderUserId: null, turnId: 'b'.repeat(64), reason: 'publication_recovered' } })
    expect(JSON.stringify(vi.mocked(params.publishSessionEvent!).mock.calls)).not.toContain('processing-token')
    expect(mocks.release).toHaveBeenCalledOnce()
  })
})


/** Execute the production channel callback with real local preflight workers. */
describe('[COMP:workers/preflight] channel COGS receiving', () => {
  const source = readFileSync(new URL('../channel-pipeline.ts', import.meta.url), 'utf8')
  const tree = ts.createSourceFile('channel-pipeline.ts', source, ts.ScriptTarget.Latest, true)
  let callback: ts.Expression | undefined
  const find = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(tree) === 'onUsage') callback ??= node.initializer
    ts.forEachChild(node, find)
  }
  find(tree)

  it.each(['platform', 'user'] as const)('awaits one original-payer worker row before preflight finishes (%s key)', async providerKeySource => {
    const billing = deferred<void>()
    const rows: Array<Record<string, unknown>> = []
    const usageStore = { recordUsage: vi.fn(async (row: Record<string, unknown>) => { rows.push(row); await billing.promise }) }
    if (!callback) throw new Error('Channel worker callback missing')
    const scope = { usageStore, billingUserId: 'original-payer', userId: 'original-actor',
      assistant: { id: 'original-assistant' }, session: { id: 'original-session' }, channelType: 'feishu', calculateCost,
      backgroundUsageAttribution: { modelTier: 'standard', providerKeySource },
    }
    const code = ts.transpileModule(`return (${callback.getText(tree)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
    const onUsage = new Function(...Object.keys(scope), code)(...Object.values(scope)) as NonNullable<Parameters<typeof runPreflight>[0]['onUsage']>
    const provider: LLMProvider = {
      name: 'fixture', models: ['gemini-flash'], createSession() { throw new Error('Expected stateless worker') },
      async *stream(): AsyncIterable<StreamChunk> {
        yield { type: 'message_start', model: 'gemini-flash' }
        yield { type: 'text_delta', text: 'Authorized finding' }
        yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2 } }
      },
    }
    let finished = false
    const running = runPreflight({ provider, model: 'gemini-flash', message: 'Look up one source', tools: new Map(),
      classify: async () => ({ tasks: ['one source'], model: 'splitter-fixture', usage: { inputTokens: 1, outputTokens: 1 } }),
      context: { userId: 'original-actor', assistantId: 'original-assistant', sessionId: 'original-session', workspaceId: 'original-workspace',
        appId: 'fixture', channelType: 'feishu', channelId: 'channel-fixture', abortSignal: new AbortController().signal,
        workerRuntime: { provider, model: 'gemini-flash', modelTier: 'standard', providerKeySource },
      }, onUsage,
    }).then(value => { finished = true; return value })
    await vi.waitFor(() => expect(rows).toHaveLength(1))
    expect(finished).toBe(false)
    expect(rows[0]).toMatchObject({ userId: 'original-payer', actorUserId: 'original-actor', assistantId: 'original-assistant', sessionId: 'original-session',
      model: 'gemini-flash', inputTokens: 5, outputTokens: 2, source: 'included', triggerKey: 'worker_run', providerKeySource,
    })
    expect(rows[0]).not.toHaveProperty('userMessageId')
    expect(rows[0].actualCostUsd).toBe(providerKeySource === 'user' ? 0 : calculateCost('gemini-flash', { inputTokens: 5, outputTokens: 2 }))
    billing.resolve()
    expect((await running).type).toBe('researched')
    expect(usageStore.recordUsage).toHaveBeenCalledOnce()
  })
})

it('[COMP:api/turn-kernel] awaits reported preparation spend on Stop before cleanup/release', async () => {
  const billing = deferred<void>()
  const { params, hooks } = turn()
  const recordUsage = vi.fn(async () => { await billing.promise })
  params.usageStore = { recordUsage } as unknown as ChannelPipelineParams['usageStore']
  params.voiceTranscriptionUsage = { model: 'gemini-flash', usage: { inputTokens: 3, outputTokens: 1 }, audioSeconds: 4 }
  hooks.onProcessingStart.mockImplementation(async () => { expect(abortLocalTurn('session', 'processing-token')).toBe(true) })
  const running = processChannelMessage(params)
  await vi.waitFor(() => expect(recordUsage).toHaveBeenCalledOnce())
  expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ userId: 'owner', actorUserId: 'user', assistantId: 'assistant', sessionId: 'session', model: 'gemini-flash', inputTokens: 3, outputTokens: 1, source: 'overhead:transcription', triggerKey: 'voice_message_transcription', audioSeconds: 4 }))
  expect(hooks.onCleanup).not.toHaveBeenCalled()
  expect(mocks.release).not.toHaveBeenCalled()
  billing.resolve()
  await running
  expect(recordUsage).toHaveBeenCalledOnce()
  expect(mocks.release).toHaveBeenCalledExactlyOnceWith('session', 'stopped_by_user', 'processing-token')
})

it('[COMP:workers/manager] actual boot COGS callback remains awaited by local preflight workers', async () => {
  const source = readFileSync(new URL('../../boot/tools.register.ts', import.meta.url), 'utf8')
  const tree = ts.createSourceFile('tools.register.ts', source, ts.ScriptTarget.Latest, true)
  let callback: ts.Expression | undefined
  const find = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'createWorkerManager') {
      const options = node.arguments[0]
      if (options && ts.isObjectLiteralExpression(options)) {
        const property = options.properties.find(value => ts.isPropertyAssignment(value) && value.name.getText(tree) === 'onUsage')
        if (property && ts.isPropertyAssignment(property)) callback ??= property.initializer
      }
    }
    ts.forEachChild(node, find)
  }
  find(tree)
  if (!callback) throw new Error('Boot worker callback missing')
  const billing = deferred<void>()
  const recordUsage = vi.fn(async (_row: Record<string, unknown>) => { await billing.promise })
  const scope = { usageStore: { recordUsage }, calculateCost }
  const code = ts.transpileModule(`return (${callback.getText(tree)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const onUsage = new Function(...Object.keys(scope), code)(...Object.values(scope)) as NonNullable<Parameters<typeof runPreflight>[0]['onUsage']>
  const provider: LLMProvider = {
    name: 'fixture', models: ['gemini-flash'], createSession() { throw new Error('Expected stateless worker') },
    async *stream(): AsyncIterable<StreamChunk> {
      yield { type: 'message_start', model: 'gemini-flash' }
      yield { type: 'text_delta', text: 'Original finding' }
      yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2 } }
    },
  }
  let finished = false
  const running = runPreflight({ provider, model: 'gemini-flash', message: 'Look up one source', tools: new Map(),
    classify: async () => ({ tasks: ['one source'], model: null, usage: null }),
    context: { userId: 'worker-payer', assistantId: 'worker-assistant', sessionId: 'worker-session', workspaceId: 'worker-workspace',
      appId: 'fixture', channelType: 'web', channelId: 'worker-channel', abortSignal: new AbortController().signal,
      workerRuntime: { provider, model: 'gemini-flash', modelTier: 'standard', providerKeySource: 'user' },
    }, onUsage,
  }).then(value => { finished = true; return value })
  await vi.waitFor(() => expect(recordUsage).toHaveBeenCalledOnce())
  expect(finished).toBe(false)
  expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ userId: 'worker-payer', assistantId: 'worker-assistant', sessionId: 'worker-session',
    model: 'gemini-flash', inputTokens: 5, outputTokens: 2, providerKeySource: 'user', actualCostUsd: 0, source: 'included', triggerKey: 'worker_run',
  }))
  billing.resolve()
  expect((await running).type).toBe('researched')
  expect(recordUsage).toHaveBeenCalledOnce()
})
