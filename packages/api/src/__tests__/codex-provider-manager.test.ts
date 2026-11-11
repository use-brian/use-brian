import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  CodexRpcClosedError,
  CodexRpcPeer,
  type CodexAppServerProcess,
  buildTool,
  createRoutingProvider,
  wrapProvider,
  queryLoop,
  NOOP_TURN_LEDGER,
  type QueryEvent,
} from '@use-brian/core'
import { MutableProviderAvailability } from '@use-brian/shared/model-registry'
import { startCodexProviderManager } from '../codex-provider-manager.js'
import { z } from 'zod'

type Frame = { id?: number | string; method?: string; params?: unknown; result?: unknown }

function processHarness(): {
  process: CodexAppServerProcess
  peer: CodexRpcPeer
  inbound: PassThrough
  outbound: Frame[]
  close: ReturnType<typeof vi.fn>
} {
  const inbound = new PassThrough()
  const output = new PassThrough()
  const outbound: Frame[] = []
  let buffered = ''
  output.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8')
    let newline = buffered.indexOf('\n')
    while (newline !== -1) {
      outbound.push(JSON.parse(buffered.slice(0, newline)))
      buffered = buffered.slice(newline + 1)
      newline = buffered.indexOf('\n')
    }
  })
  const peer = new CodexRpcPeer({ input: inbound, output })
  const close = vi.fn(async () => {})
  return {
    process: {
      rpc: peer,
      initialize: {
        codexHome: '/tmp/codex-home',
        platformFamily: 'unix',
        platformOs: 'test',
        userAgent: 'test',
      },
      codexHome: '/tmp/codex-home',
      cwd: '/tmp/codex-cwd',
      pid: 1,
      diagnostics: () => ({ stderrBytes: 0, stderrTruncated: false }),
      close,
    },
    peer,
    inbound,
    outbound,
    close,
  }
}

async function waitForMethod(
  harness: ReturnType<typeof processHarness>,
  method: string,
  occurrence = 0,
): Promise<Frame> {
  await vi.waitFor(() => {
    expect(harness.outbound.filter((frame) => frame.method === method).length).toBeGreaterThan(
      occurrence,
    )
  })
  return harness.outbound.filter((frame) => frame.method === method)[occurrence]!
}

function respond(
  harness: ReturnType<typeof processHarness>,
  request: Frame,
  result: unknown,
): void {
  harness.inbound.write(`${JSON.stringify({ id: request.id, result })}\n`)
}

function catalogModel(model: string, overrides: Record<string, unknown> = {}) {
  return {
    id: model,
    model,
    displayName: model,
    description: 'Test model',
    hidden: false,
    isDefault: model === 'gpt-5.6-sol',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Fast' },
      { reasoningEffort: 'medium', description: 'Balanced' },
    ],
    inputModalities: ['text', 'image'],
    ...overrides,
  }
}

describe('[COMP:api/codex-provider] OSS Codex provider manager', () => {
  it.each(['gpt-6-luna', 'gpt-5.2'].flatMap(model => [false, true].map(stateless => ({ model, stateless }))))('preserves registration through the production manager/wrapper/router ($model, stateless: $stateless)', async ({ model, stateless }) => {
    const inference = processHarness(), account = processHarness()
    const startProcess = vi.fn(async options => options?.surface === 'account' ? account.process : inference.process)
    const starting = startCodexProviderManager({ availability: new MutableProviderAvailability(), startProcess })
    respond(account, await waitForMethod(account, 'account/read'), {
      account: { type: 'chatgpt', email: 'fixture@example.test', planType: 'plus' }, requiresOpenaiAuth: true,
    })
    respond(account, await waitForMethod(account, 'model/list'), { data: [catalogModel(model)], nextCursor: null })
    const manager = await starting
    try {
      const provider = createRoutingProvider({ 'openai-codex': wrapProvider(manager.provider) })
      const native = model === 'gpt-6-luna'
      expect(provider.toolSchemaMode?.(model)).toBe(native ? 'native-deferred' : 'eager')
      expect(manager.provider.toolSchemaMode?.('future-unverified-model')).toBe('eager')
      expect(inference.outbound).toEqual([])
      expect(account.outbound.map(frame => frame.method)).toEqual(['account/read', 'model/list'])
      expect(startProcess).toHaveBeenCalledTimes(2)
      const execute = vi.fn(async () => ({ data: 'not invoked' }))
      const tool = buildTool({ name: 'echoFixture', description: 'Synthetic schema', inputSchema: z.object({ value: z.string() }),
        isReadOnly: true, isConcurrencySafe: true, execute })
      const tools = new Map([
        [tool.name, tool],
        ['optionalFixture', { ...tool, name: 'optionalFixture', deferredSchemaOnly: true }],
        ['hiddenFixture', { ...tool, name: 'hiddenFixture', hiddenFromModel: true }],
        ['deniedFixture', { ...tool, name: 'deniedFixture', requiresCapability: 'not-granted' }],
      ])
      const events: QueryEvent[] = []
      const assertInputAuthority = vi.fn(async () => {})
      const run = (async () => {
        for await (const event of queryLoop({ provider, model, systemPrompt: 'Synthetic only.',
          messages: [{ role: 'user', content: 'Reply Fixture done.' }], tools, deferToolSchemas: true, stateless,
          ledger: NOOP_TURN_LEDGER, context: { userId: 'fixture', assistantId: 'fixture', sessionId: 'fixture',
            appId: 'fixture', channelType: 'web', channelId: 'fixture', abortSignal: new AbortController().signal,
            assertModelInputAuthority: assertInputAuthority },
        })) events.push(event)
      })()
      const start = await waitForMethod(inference, 'thread/start')
      const definitions = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }
      const wireTool = { type: 'function', name: 'echoFixture', description: tool.description, inputSchema: definitions }
      expect(start.params).toMatchObject({ dynamicTools: native ? [{ type: 'namespace', name: 'brian', tools: [
        { ...wireTool, deferLoading: true }, { ...wireTool, name: 'optionalFixture', deferLoading: true },
      ] }] : [wireTool] })
      expect(JSON.stringify(start.params)).not.toMatch(/hiddenFixture|deniedFixture|discoverTools/)
      respond(inference, start, { thread: { id: 'fixture-thread' }, model, modelProvider: 'openai' })
      respond(inference, await waitForMethod(inference, 'turn/start'), { turn: { id: 'fixture-turn', status: 'inProgress' } })
      const item = { type: 'agentMessage', id: 'fixture-message', text: 'Fixture done.', phase: 'final_answer' }
      inference.inbound.write([
        { method: 'item/completed', params: { threadId: 'fixture-thread', turnId: 'fixture-turn', item } },
        { method: 'turn/completed', params: { threadId: 'fixture-thread', turn: { id: 'fixture-turn', status: 'completed', items: [item] } } },
      ].map(frame => JSON.stringify(frame)).join('\n') + '\n')
      if (stateless) respond(inference, await waitForMethod(inference, 'thread/unsubscribe'), {})
      await run
      expect(events.filter(event => event.type === 'text_delta').map(event => event.text).join('')).toBe('Fixture done.')
      expect(events.filter(event => event.type === 'turn_complete')).toHaveLength(1)
      expect(inference.outbound.filter(frame => frame.method === 'turn/start')).toHaveLength(1)
      expect(execute).not.toHaveBeenCalled()
      expect(assertInputAuthority).toHaveBeenCalled()
    } finally {
      await manager.close()
      inference.peer.close(); account.peer.close()
    }
  })

  it('executes a deferred callback through the production manager and canonical engine registry', async () => {
    const model = 'gpt-6-luna'
    const inference = processHarness(), account = processHarness()
    const starting = startCodexProviderManager({ availability: new MutableProviderAvailability(),
      startProcess: vi.fn(async options => options?.surface === 'account' ? account.process : inference.process) })
    respond(account, await waitForMethod(account, 'account/read'), {
      account: { type: 'chatgpt', email: 'fixture@example.test', planType: 'plus' }, requiresOpenaiAuth: true,
    })
    respond(account, await waitForMethod(account, 'model/list'), { data: [catalogModel(model)], nextCursor: null })
    const manager = await starting
    try {
      const provider = createRoutingProvider({ 'openai-codex': wrapProvider(manager.provider) })
      const execute = vi.fn(async (input: { value: string }) => ({ data: `echo:${input.value}` }))
      const tool = buildTool({ name: 'echoFixture', description: 'Synthetic deferred tool', inputSchema: z.object({ value: z.string() }).strict(),
        isReadOnly: true, isConcurrencySafe: true, execute })
      const events: QueryEvent[] = []
      const run = (async () => {
        for await (const event of queryLoop({ provider, model, systemPrompt: 'Synthetic only.',
          messages: [{ role: 'user', content: 'Use the fixture tool.' }], tools: new Map([[tool.name, tool]]),
          deferToolSchemas: true, ledger: NOOP_TURN_LEDGER,
          context: { userId: 'fixture', assistantId: 'fixture', sessionId: 'fixture', appId: 'fixture',
            channelType: 'web', channelId: 'fixture', abortSignal: new AbortController().signal },
        })) events.push(event)
      })()
      const start = await waitForMethod(inference, 'thread/start')
      expect(start.params).toMatchObject({ dynamicTools: [{ type: 'namespace', name: 'brian',
        tools: [{ type: 'function', name: tool.name, deferLoading: true }] }] })
      respond(inference, start, { thread: { id: 'fixture-thread' }, model, modelProvider: 'openai' })
      respond(inference, await waitForMethod(inference, 'turn/start'), { turn: { id: 'fixture-turn', status: 'inProgress' } })
      inference.inbound.write(`${JSON.stringify({ id: 'fixture-tool-request', method: 'item/tool/call', params: {
        threadId: 'fixture-thread', turnId: 'fixture-turn', callId: 'fixture-call', namespace: 'brian',
        tool: tool.name, arguments: { value: 'fixture' },
      } })}\n`)
      await vi.waitFor(() => expect(inference.outbound.find(frame => frame.id === 'fixture-tool-request')?.result).toMatchObject({
        success: true, contentItems: [{ type: 'inputText', text: 'echo:fixture' }],
      }))
      inference.inbound.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'fixture-thread',
        turn: { id: 'fixture-turn', status: 'completed', items: [{ type: 'agentMessage', id: 'fixture-message', text: 'Fixture done.' }] },
      } })}\n`)
      await run
      expect(execute).toHaveBeenCalledOnce()
      expect(execute.mock.calls[0]?.[0]).toEqual({ value: 'fixture' })
      expect(events.filter(event => event.type === 'tool_start')).toMatchObject([{ name: tool.name }])
      expect(events.filter(event => event.type === 'text_delta').map(event => event.text).join('')).toBe('Fixture done.')
      expect(inference.outbound.filter(frame => frame.method === 'turn/start')).toHaveLength(1)
    } finally {
      await manager.close()
      inference.peer.close(); account.peer.close()
    }
  })

  it('uses a dedicated image process for cheap discovery and invalidates its estimate on logout', async () => {
    const chat = processHarness(); const image = processHarness()
    const startProcess = vi.fn().mockResolvedValueOnce(chat.process).mockResolvedValueOnce(chat.process).mockResolvedValueOnce(image.process)
    const starting = startCodexProviderManager({ availability: new MutableProviderAvailability(), startProcess })
    respond(chat, await waitForMethod(chat, 'account/read'), { account: null, requiresOpenaiAuth: true })
    const manager = await starting
    const inspecting = manager.images.inspect()
    respond(image, await waitForMethod(image, 'account/read'), { account: { type: 'chatgpt', email: 'fixture@example.com', planType: 'pro' }, requiresOpenaiAuth: true })
    respond(image, await waitForMethod(image, 'modelProvider/capabilities/read'), { imageGeneration: true, namespaceTools: true, webSearch: false })
    respond(image, await waitForMethod(image, 'model/list'), { data: [catalogModel('gpt-5.6-sol')], nextCursor: null })
    const snapshot = await inspecting
    expect(snapshot).toMatchObject({ model: 'gpt-image-2', orchestratorModel: 'gpt-5.6-sol' })
    expect(startProcess.mock.calls.map(call => call[0].surface)).toEqual(['inference', 'account', 'image'])
    expect(image.close).toHaveBeenCalledOnce()
    expect(image.outbound.some(frame => frame.method === 'turn/start')).toBe(false)
    const logout = manager.logout(); respond(chat, await waitForMethod(chat, 'account/logout'), {}); await logout
    await expect(manager.images.generate({ snapshot, prompt: 'A diagram', signal: new AbortController().signal })).rejects.toThrow('generation_configuration_changed')
    expect(startProcess).toHaveBeenCalledTimes(3)
    await manager.close()
  })

  it('publishes only the reviewed intersection of registry and live account catalog', async () => {
    const harness = processHarness()
    const inference = processHarness()
    const availability = new MutableProviderAvailability()
    const starting = startCodexProviderManager({
      availability,
      startProcess: vi.fn(async options => options?.surface === 'account' ? harness.process : inference.process),
    })

    const accountRead = await waitForMethod(harness, 'account/read')
    respond(harness, accountRead, {
      account: { type: 'chatgpt', email: 'owner@example.com', planType: 'plus' },
      requiresOpenaiAuth: true,
    })
    const modelList = await waitForMethod(harness, 'model/list')
    respond(harness, modelList, {
      data: [
        catalogModel('gpt-5.6-sol'),
        catalogModel('gpt-5.6-terra'),
        catalogModel('gpt-6-luna'),
        catalogModel('gpt-6-sol'),
        catalogModel('gpt-6.1-sol'),
        catalogModel('gpt-6-astra'),
        { ...catalogModel('gpt-5.5'), hidden: true },
        catalogModel('future-unreviewed-model'),
      ],
      nextCursor: null,
    })
    const manager = await starting

    expect(availability.has('openai-codex')).toBe(true)
    expect(availability.isModelAvailable('openai-codex', 'gpt-5.6-sol')).toBe(true)
    expect(availability.isModelAvailable('openai-codex', 'future-unreviewed-model')).toBe(false)
    expect(manager.provider.models).toContain('gpt-5.6-sol')
    expect(inference.outbound).toEqual([])
    for (const model of ['gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-astra']) {
      expect(availability.isModelAvailable('openai-codex', model)).toBe(true)
    }
    expect(availability.isModelAvailable('openai-codex', 'gpt-5.5')).toBe(false)

    const statusPromise = manager.status()
    const statusAccount = await waitForMethod(harness, 'account/read', 1)
    respond(harness, statusAccount, {
      account: { type: 'chatgpt', email: 'owner@example.com', planType: 'plus' },
      requiresOpenaiAuth: true,
    })
    const statusModels = await waitForMethod(harness, 'model/list', 1)
    respond(harness, statusModels, {
      data: [catalogModel('gpt-5.6-terra')],
      nextCursor: null,
    })
    await expect(statusPromise).resolves.toMatchObject({
      runtimeAvailable: true,
      account: { connected: true, emailHint: 'o***@example.com', planType: 'plus' },
      models: [{ model: 'gpt-5.6-terra' }],
    })
    expect(availability.isModelAvailable('openai-codex', 'gpt-5.6-sol')).toBe(false)
    expect(availability.isModelAvailable('openai-codex', 'gpt-6.1-sol')).toBe(false)

    const revokedStatus = manager.status()
    const revokedAccount = await waitForMethod(harness, 'account/read', 2)
    respond(harness, revokedAccount, { malformed: true })
    await expect(revokedStatus).resolves.toMatchObject({
      runtimeAvailable: true,
      account: { connected: false },
      models: [],
    })
    expect(availability.has('openai-codex')).toBe(false)
    await manager.close()
    expect(inference.close).toHaveBeenCalledOnce()
    expect(harness.close).toHaveBeenCalledOnce()
  })

  it('keeps the runtime available for login while the account is disconnected', async () => {
    const harness = processHarness()
    const availability = new MutableProviderAvailability()
    const starting = startCodexProviderManager({
      availability,
      startProcess: vi.fn(async () => harness.process),
    })
    const accountRead = await waitForMethod(harness, 'account/read')
    respond(harness, accountRead, { account: null, requiresOpenaiAuth: true })
    const manager = await starting

    expect(availability.has('openai-codex')).toBe(false)
    const loginPromise = manager.startDeviceCodeLogin()
    const loginRequest = await waitForMethod(harness, 'account/login/start')
    respond(harness, loginRequest, {
      type: 'chatgptDeviceCode',
      loginId: 'device-1',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
    })
    await expect(loginPromise).resolves.toMatchObject({
      loginId: 'device-1',
      userCode: 'ABCD-1234',
    })
    await manager.close()
  })

  it.each(['account', 'inference'] as const)('clears entitlement and restarts both processes after %s closes', async (surface) => {
    const first = processHarness()
    const second = processHarness()
    const firstInference = processHarness()
    const secondInference = processHarness()
    const availability = new MutableProviderAvailability()
    const startProcess = vi
      .fn()
      .mockResolvedValueOnce(firstInference.process)
      .mockResolvedValueOnce(first.process)
      .mockResolvedValueOnce(secondInference.process)
      .mockResolvedValueOnce(second.process)
    const starting = startCodexProviderManager({
      availability,
      startProcess,
      restartBackoffMs: 1,
    })
    const firstAccount = await waitForMethod(first, 'account/read')
    respond(first, firstAccount, { account: null, requiresOpenaiAuth: true })
    const manager = await starting
    const proxy = manager.provider
    const mode = proxy.toolSchemaMode!
    expect(mode('gpt-6-luna')).toBe('native-deferred')

    ;(surface === 'account' ? first : firstInference).peer.close(new CodexRpcClosedError('crash'))
    expect(mode('gpt-6-luna')).toBe('eager')
    const secondAccount = await waitForMethod(second, 'account/read')
    respond(second, secondAccount, { account: null, requiresOpenaiAuth: true })
    await vi.waitFor(() => expect(startProcess).toHaveBeenCalledTimes(4))
    expect(first.close).toHaveBeenCalledOnce()
    expect(firstInference.close).toHaveBeenCalledOnce()
    expect(availability.has('openai-codex')).toBe(false)
    expect(manager.provider).toBe(proxy)
    expect(mode('gpt-6-luna')).toBe('native-deferred')
    await manager.close()
    expect(mode('gpt-6-luna')).toBe('eager')
    expect(startProcess).toHaveBeenCalledTimes(4)
  })

  it('recycles cached inference credentials after successful login completion', async () => {
    const inference = processHarness(); const account = processHarness()
    const nextInference = processHarness(); const nextAccount = processHarness()
    const availability = new MutableProviderAvailability()
    const startProcess = vi.fn().mockResolvedValueOnce(inference.process).mockResolvedValueOnce(account.process)
      .mockResolvedValueOnce(nextInference.process).mockResolvedValueOnce(nextAccount.process)
    const starting = startCodexProviderManager({ availability, startProcess, restartBackoffMs: 1 })
    respond(account, await waitForMethod(account, 'account/read'), { account: null, requiresOpenaiAuth: true })
    const manager = await starting
    account.inbound.write(`${JSON.stringify({ method: 'account/login/completed', params: { loginId: 'fixture-login', success: true, error: null } })}\n`)
    respond(nextAccount, await waitForMethod(nextAccount, 'account/read'), {
      account: { type: 'chatgpt', email: 'next-fixture@example.com', planType: 'plus' }, requiresOpenaiAuth: true,
    })
    respond(nextAccount, await waitForMethod(nextAccount, 'model/list'), { data: [catalogModel('gpt-6.1-sol')], nextCursor: null })
    await vi.waitFor(() => expect(availability.isModelAvailable('openai-codex', 'gpt-6.1-sol')).toBe(true))
    expect(inference.close).toHaveBeenCalledOnce()
    expect(account.close).toHaveBeenCalledOnce()
    expect(startProcess.mock.calls.map(call => call[0].surface)).toEqual(['inference', 'account', 'inference', 'account'])
    await manager.close()
  })

  it('closes inference when the account process cannot start', async () => {
    const inference = processHarness()
    const startProcess = vi.fn().mockResolvedValueOnce(inference.process).mockRejectedValueOnce(new Error('catalog binary unavailable'))
    const manager = await startCodexProviderManager({ availability: new MutableProviderAvailability(), startProcess })
    expect(startProcess.mock.calls.map(call => call[0].surface)).toEqual(['inference', 'account'])
    expect(inference.close).toHaveBeenCalledOnce()
    await manager.close()
  })

  it('persists and publishes the preferred OSS provider without exposing config data', async () => {
    const harness = processHarness()
    const availability = new MutableProviderAvailability()
    const savePreferredProvider = vi.fn(async () => {})
    const starting = startCodexProviderManager({
      availability,
      savePreferredProvider,
      startProcess: vi.fn(async () => harness.process),
    })
    const accountRead = await waitForMethod(harness, 'account/read')
    respond(harness, accountRead, { account: null, requiresOpenaiAuth: true })
    const manager = await starting

    await manager.setPreferredProvider('openai-codex')

    expect(savePreferredProvider).toHaveBeenCalledWith('openai-codex')
    expect(availability.preferredProvider).toBe('openai-codex')
    const status = manager.status()
    const statusAccount = await waitForMethod(harness, 'account/read', 1)
    respond(harness, statusAccount, { account: null, requiresOpenaiAuth: true })
    await expect(status).resolves.toMatchObject({
      preferredProvider: 'openai-codex',
      account: { connected: false },
    })
    await manager.close()
  })

  it('keeps recovery and preference controls alive when the runtime cannot start', async () => {
    const availability = new MutableProviderAvailability()
    const savePreferredProvider = vi.fn(async () => {})
    const startProcess = vi.fn(async () => {
      throw new Error('binary unavailable')
    })
    const manager = await startCodexProviderManager({
      availability,
      savePreferredProvider,
      startProcess,
    })

    expect(manager.provider.toolSchemaMode?.('gpt-6-luna')).toBe('eager')
    expect(startProcess).toHaveBeenCalledTimes(1)
    await expect(manager.status()).resolves.toMatchObject({
      runtimeAvailable: false,
      account: { connected: false },
      models: [],
    })
    await manager.setPreferredProvider('gemini')

    expect(savePreferredProvider).toHaveBeenCalledWith('gemini')
    expect(availability.preferredProvider).toBe('gemini')
    expect(startProcess).toHaveBeenCalledTimes(2)
    await manager.close()
  })
})
