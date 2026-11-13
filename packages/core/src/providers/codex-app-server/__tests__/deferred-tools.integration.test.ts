import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { providerModelIds, registryRow } from '@use-brian/shared/model-registry'
import {
  buildCodexEnvironment,
  buildCodexToolSurfaceArgs,
  resolvePinnedCodexCommand,
} from '../process.js'
import { InitializeResponseSchema, ThreadTokenUsageUpdatedNotificationSchema } from '../protocol.js'
import { CodexRpcPeer } from '../rpc.js'
import { createCodexAppServerProvider, codexToolSchemaMode } from '../provider.js'
import { queryLoop, type QueryEvent } from '../../../engine/query-loop.js'
import { NOOP_TURN_LEDGER } from '../../../engine/turn-ledger.js'
import { buildTool } from '../../../tools/types.js'

const models = providerModelIds('openai-codex')
const nativeModels = models.filter(model => codexToolSchemaMode(model) === 'native-deferred')
const basicSchema = { type: 'object', properties: {}, additionalProperties: false }
const basic = {
  type: 'function', name: 'basic', description: 'Basic synthetic tool.', inputSchema: basicSchema,
}
// Use actual schema structure, not descriptions (the runtime strips parameter descriptions).
const echoSchema = {
  type: 'object',
  properties: {
    value: { type: 'string' },
    ...Object.fromEntries(Array.from({ length: 48 }, (_, index) => [
      `synthetic_optional_field_${index}`,
      { type: 'string', enum: [`synthetic_choice_${index}_alpha`, `synthetic_choice_${index}_beta`] },
    ])),
  },
  required: ['value'],
  additionalProperties: false,
}
const deferredNamespace = {
  type: 'namespace', name: 'brian', description: 'Admitted Brian tools',
  tools: [{
    type: 'function', name: 'echo', description: 'Return a synthetic string.',
    inputSchema: echoSchema, deferLoading: true,
  }],
}
const wireBasic = {
  type: 'namespace', name: 'functions', description: '',
  tools: [{ type: 'function', name: 'basic', description: basic.description, strict: false, parameters: basicSchema }],
}
const wireDeferred = {
  type: 'namespace', name: 'brian', description: deferredNamespace.description,
  tools: [{
    type: 'function', name: 'echo', description: deferredNamespace.tools[0]!.description,
    strict: false, defer_loading: true, parameters: echoSchema,
  }],
}
const RequestSchema = z.object({
  model: z.string(),
  tools: z.array(z.unknown()).optional(),
  input: z.array(z.object({ type: z.string() }).passthrough()),
}).passthrough()
type ModelRequest = z.infer<typeof RequestSchema>

describe('[COMP:providers/codex-deferred-tools] offline pinned runtime', () => {
  it('does not introduce native search when no dynamic tool is deferred', async () => {
    const result = await runFixture(models[0]!, false)
    expect(result.requests).toHaveLength(1)
    expect(result.callbacks).toEqual([])
    expectSurface(result.requests[0]!, false)
  })

  it.each(['invalid-input', 'deny'] as const)('keeps original validation and approval gates after native discovery: %s', async gate => {
    const result = await runFixture(models[0]!, true, true, gate)
    expect(result.requests).toHaveLength(3)
    expect(result.callbacks).toEqual([])
    expect(result.events.filter(event => event.type === 'tool_confirmation_required')).toHaveLength(gate === 'deny' ? 1 : 0)
    expect(result.events.find(event => event.type === 'turn_complete')).toMatchObject({ totalUsage: { inputTokens: 15, outputTokens: 15 } })
  })

  it.each(models.filter(model => codexToolSchemaMode(model) === 'eager'))('uses the complete eager surface for unsupported model %s', async model => {
    const result = await runFixture(model, true, true)
    expect(result.requests).toHaveLength(2)
    expect(JSON.stringify(result.requests[0])).toContain('synthetic_optional_field_')
    for (const request of result.requests) {
      expect(request.input.filter(item => item.type === 'additional_tools')).toEqual([])
      expect(request.tools).toEqual([
        { ...wireBasic.tools[0], parameters: { type: 'object', properties: {} } },
        { type: 'function', name: 'echo', description: deferredNamespace.tools[0]!.description, strict: false,
          parameters: { type: 'object', properties: echoSchema.properties, required: ['value'] } },
      ])
    }
    expect(result.callbacks).toEqual([{ name: 'echo', input: { value: 'synthetic-value' } }])
    expect(result.events.find(event => event.type === 'turn_complete')).toMatchObject({
      response: { content: [{ type: 'text', text: 'OK' }] }, totalUsage: { inputTokens: 10, outputTokens: 10 },
    })
  })

  it.each(nativeModels)('runs deferred discovery through the common engine and canonical executor for %s', async model => {
    const result = await runFixture(model, true, true)
    expect(result.requests).toHaveLength(3)
    for (const request of result.requests) expectSurface(request, true, true)
    expect(JSON.stringify(result.requests[0])).not.toContain('synthetic_optional_field_')
    expect(result.callbacks).toEqual([{ name: 'echo', input: { value: 'synthetic-value' } }])
    const events = result.events
    expect(events.filter(event => event.type === 'tool_start')).toHaveLength(1)
    expect(events.find(event => event.type === 'tool_start')).toMatchObject({ name: 'echo' })
    expect(events.filter(event => event.type === 'text_delta').map(event => event.text).join('')).toBe('OK')
    expect(events.filter(event => event.type === 'turn_complete')).toHaveLength(1)
    expect(events.find(event => event.type === 'turn_complete')).toMatchObject({
      response: { content: [{ type: 'text', text: 'OK' }], stopReason: 'end_turn' },
      totalUsage: { inputTokens: 15, outputTokens: 15 },
    })
  })

  it.each(nativeModels)('discovers only the admitted deferred namespace and routes its callback for %s', async model => {
    const { requests, callbacks, threadId, turnId, usageTotals } = await runFixture(model, true)
    expect(requests).toHaveLength(3)
    expect(usageTotals.at(-1)).toMatchObject({ inputTokens: 15, outputTokens: 15 })
    expect(JSON.stringify(echoSchema).length).toBeGreaterThan(5_000)
    for (const request of requests) {
      expect(request.model).toBe(registryRow(model)!.apiModelId)
      expectSurface(request, true)
    }
    // Registration is accepted, but neither the name nor the large schema is sent upfront.
    expect(JSON.stringify(requests[0])).not.toContain('synthetic_optional_field_')
    expect(JSON.stringify(requests[0])).not.toContain('"defer_loading"')
    expect(requests[0]!.input.filter(item => item.type === 'tool_search_output')).toEqual([])

    const discovery = requests[1]!.input.filter(item => item.type === 'tool_search_output')
    expect(discovery).toHaveLength(1)
    expect(discovery[0]).toMatchObject({
      call_id: 'search-call', status: 'completed', execution: 'client', tools: [wireDeferred],
    })
    // Exact equality catches any native tool or unrelated namespace in search results.
    expect(discovery[0]!.tools).toEqual([wireDeferred])
    expect(callbacks).toEqual([{
      threadId, turnId, callId: 'echo-call', namespace: 'brian', tool: 'echo',
      arguments: { value: 'synthetic-value' },
    }])
    expect(requests[2]!.input.filter(item => item.type === 'function_call')).toEqual([{
      type: 'function_call', name: 'echo', namespace: 'brian',
      arguments: JSON.stringify({ value: 'synthetic-value' }), call_id: 'echo-call',
    }])
    expect(requests[2]!.input.filter(item => item.type === 'function_call_output')).toEqual([
      expect.objectContaining({ call_id: 'echo-call', output: 'echo:synthetic-value' }),
    ])
  })
})

function expectSurface(request: ModelRequest, deferred: boolean, adapter = false): void {
  // The pin chooses top-level tools for GPT-5.5, additional_tools for newer
  // models. Both exact surfaces exclude shell/exec, web, MCP, agents, etc.
  const legacyWire = request.model === 'gpt-5.5'
  const additional = request.input.filter(item => item.type === 'additional_tools')
  expect(additional).toHaveLength(legacyWire ? 0 : 1)
  if (!legacyWire) expect(request.tools ?? []).toEqual([])
  const tools = z.array(z.unknown()).parse(legacyWire ? request.tools : additional[0]!.tools)
  expect(tools).toHaveLength(deferred ? 2 : 1)
  expect(tools[0]).toEqual(adapter ? {
    ...wireBasic, name: 'brian', description: 'Admitted Brian tools',
    tools: [{ ...wireBasic.tools[0], parameters: { type: 'object', properties: {} } }],
  } : legacyWire ? wireBasic.tools[0] : wireBasic)
  if (deferred) {
    expect(tools[1]).toMatchObject({
      type: 'tool_search', execution: 'client',
      parameters: {
        type: 'object', required: ['query'], additionalProperties: false,
        properties: { query: { type: 'string' }, limit: { type: 'number' } },
      },
    })
  }
}

/** No account client, credential fixture, inherited config, or real upstream. */
async function runFixture(model: string, deferred: boolean, adapter = false, gate: 'none' | 'invalid-input' | 'deny' = 'none') {
  const needsSearch = deferred && (!adapter || codexToolSchemaMode(model) === 'native-deferred')
  const codexHome = await mkdtemp(join(tmpdir(), 'brian-codex-deferred-home-'))
  const cwd = await mkdtemp(join(tmpdir(), 'brian-codex-deferred-cwd-'))
  const requests: ModelRequest[] = []
  const callbacks: unknown[] = []
  const usageTotals: unknown[] = []
  const events: QueryEvent[] = []
  const failures: unknown[] = []
  const completed = promiseWithResolvers<unknown>()
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      try {
        expect(request.method).toBe('POST')
        expect(request.url).toBe('/v1/responses')
        requests.push(RequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
        const n = requests.length
        if (n > (deferred ? needsSearch ? 3 : 2 : 1)) throw new Error('Unexpected extra model request')
        const id = `response-fixture-${n}`
        const item = needsSearch && n === 1
          ? {
              type: 'tool_search_call', id: 'search-item', call_id: 'search-call',
              execution: 'client', arguments: { query: 'echo synthetic string', limit: 1 },
            }
          : deferred && n === (needsSearch ? 2 : 1)
            ? {
                type: 'function_call', id: 'echo-item', call_id: 'echo-call',
                ...(needsSearch ? { namespace: 'brian' } : {}), name: 'echo',
                arguments: JSON.stringify({ value: gate === 'invalid-input' ? 17 : 'synthetic-value' }),
              }
            : {
                type: 'message', id: 'final-item', role: 'assistant',
                content: [{ type: 'output_text', text: 'OK', annotations: [] }],
              }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end([
          { type: 'response.created', response: { id } },
          { type: 'response.output_item.done', item },
          { type: 'response.completed', response: {
            id, output: [item], usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
          } },
        ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
      } catch (error) {
        failures.push(error)
        completed.resolve(undefined)
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'Synthetic fixture rejected request' } }))
      }
    })
  })
  let child: ChildProcessWithoutNullStreams | undefined
  let rpc: CodexRpcPeer | undefined
  let stderr = ''
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Fixture has no TCP port')
    const command = await resolvePinnedCodexCommand()
    child = spawn(command.command, [
      ...(command.argsPrefix ?? []), 'app-server',
      // The exact production hardening profile: no capability overrides or relaxations.
      ...await buildCodexToolSurfaceArgs(command, cwd, 'inference'),
      '-c', 'analytics.enabled=false',
      '-c', 'model_provider="brian_mock"',
      '-c', 'model_providers.brian_mock.name="Brian mock"',
      '-c', `model_providers.brian_mock.base_url="http://127.0.0.1:${address.port}/v1"`,
      '-c', 'model_providers.brian_mock.wire_api="responses"',
      '-c', 'model_providers.brian_mock.requires_openai_auth=false',
      '--listen', 'stdio://',
    ], {
      cwd,
      // Deliberately do not inherit credentials or proxy settings, even from the test runner.
      env: buildCodexEnvironment(codexHome, { PATH: process.env.PATH, RUST_LOG: 'error' }),
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-16_384) })
    rpc = new CodexRpcPeer({ input: child.stdout, output: child.stdin, requestTimeoutMs: 10_000 })
    rpc.onNotification('turn/completed', completed.resolve)
    rpc.onNotification('thread/tokenUsage/updated', params => {
      usageTotals.push(ThreadTokenUsageUpdatedNotificationSchema.parse(params).tokenUsage.total)
    })
    if (!adapter) rpc.onRequest('item/tool/call', params => {
      callbacks.push(params)
      return { contentItems: [{ type: 'inputText', text: 'echo:synthetic-value' }], success: true }
    })
    await rpc.request('initialize', {
      clientInfo: { name: 'brian_deferred_fixture', version: '0.0.1' },
      capabilities: { experimentalApi: true },
    }, InitializeResponseSchema)
    await rpc.notify('initialized', {})
    if (adapter) {
      const provider = createCodexAppServerProvider({ transport: { rpc, cwd }, models: [model], toolBatchQuietMs: 1 })
      const tools = new Map([
        ['basic', buildTool({ name: 'basic', description: basic.description, inputSchema: z.object({}).strict(),
          isReadOnly: true, isConcurrencySafe: true, execute: async () => ({ data: 'basic' }) })],
        ['echo', buildTool({ name: 'echo', description: deferredNamespace.tools[0]!.description,
          inputSchema: z.object({ value: z.string(), ...Object.fromEntries(Array.from({ length: 48 }, (_, index) => [
            `synthetic_optional_field_${index}`, z.enum([`synthetic_choice_${index}_alpha`, `synthetic_choice_${index}_beta`]).optional(),
          ])) }).strict(), isReadOnly: gate !== 'deny', requiresConfirmation: gate === 'deny', isConcurrencySafe: true,
          execute: async input => {
            callbacks.push({ name: 'echo', input })
            return { data: 'echo:synthetic-value' }
          } })],
      ])
      await withTimeout((async () => {
        for await (const event of queryLoop({
          provider, model, systemPrompt: 'Synthetic isolated contract.',
          messages: [{ role: 'user', content: 'Discover the synthetic echo tool, call it, then reply OK.' }],
          tools, deferToolSchemas: true, toolSelection: { preselected: ['basic'], llm: { provider, modelId: model },
            runtime: { run: async () => { throw new Error('Native discovery must not call a classifier') },
              observe: async () => { throw new Error('Native discovery must not call a classifier') } } },
          confirmationResolver: gate === 'deny' ? { resolve: () => {}, waitForDecision: async () => ({ decision: 'deny' }) } : undefined,
          ledger: NOOP_TURN_LEDGER, maxTurns: 4,
          context: { userId: 'fixture-user', assistantId: 'fixture-assistant', sessionId: 'fixture-session',
            appId: 'fixture', channelType: 'web', channelId: 'fixture', abortSignal: new AbortController().signal },
        })) events.push(event)
      })(), 10_000)
      expect(failures).toEqual([])
      return { requests, callbacks, threadId: '', turnId: '', usageTotals, events }
    }
    const started = await rpc.request('thread/start', {
      model: registryRow(model)!.apiModelId, modelProvider: 'brian_mock', cwd, ephemeral: true,
      approvalPolicy: { granular: {
        mcp_elicitations: false, request_permissions: false, rules: false,
        sandbox_approval: false, skill_approval: false,
      } },
      sandbox: 'read-only', environments: [],
      dynamicTools: deferred ? [basic, deferredNamespace] : [basic],
    }, z.object({ thread: z.object({ id: z.string().min(1) }).passthrough() }).passthrough())
    const turn = await rpc.request('turn/start', {
      threadId: started.thread.id,
      input: [{ type: 'text', text: deferred
        ? 'Discover the synthetic echo tool, call it, then reply OK.' : 'Reply OK.' }],
    }, z.object({ turn: z.object({ id: z.string().min(1) }).passthrough() }).passthrough())
    const outcome = await withTimeout(completed.promise, 10_000)
    expect(failures).toEqual([])
    expect(outcome).toMatchObject({ turn: { id: turn.turn.id, status: 'completed' } })
    return { requests, callbacks, threadId: started.thread.id, turnId: turn.turn.id, usageTotals, events }
  } catch (error) {
    throw new Error(`Offline Codex deferred-tools contract failed (stderr=${JSON.stringify(stderr)}): ${
      error instanceof Error ? error.message : String(error)
    }`, { cause: error })
  } finally {
    rpc?.close()
    if (child) {
      const exited = once(child, 'exit')
      child.stdin.end()
      child.kill('SIGTERM')
      try { await withTimeout(exited, 1_000) } catch { child.kill('SIGKILL') }
    }
    server.closeAllConnections()
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await Promise.all([
      rm(codexHome, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true }),
    ])
  }
}

function promiseWithResolvers<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out waiting for offline Codex fixture')), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}
