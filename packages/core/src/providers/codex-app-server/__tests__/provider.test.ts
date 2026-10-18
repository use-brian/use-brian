import { withDocumentFlowDebug } from '../../../engine/document-flow-debug.js'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  missingPdfPageCompletionMarkers,
  stripPdfPageCompletionMarkers,
} from '../../../files/pdf-distill.js'
import type { Message, StreamChunk, ToolDefinition } from '../../types.js'
import {
  CodexProviderProtocolError,
  CodexTurnError,
  createCodexAppServerProvider,
} from '../provider.js'
import { CodexRpcPeer } from '../rpc.js'

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

function captureDocumentFlow() {
  vi.stubEnv('BRIAN_DEBUG_DOCUMENT_FLOW', '1')
  const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
  return () => spy.mock.calls.filter(([prefix]) => prefix === '[document-flow-debug]').map(([, line]) => JSON.parse(line as string))
}

async function collectScoped(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  return collect(withDocumentFlowDebug('private-session-id', (async function* () { yield* stream })()))
}

type RpcFrame = {
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: unknown
}

type Harness = {
  peer: CodexRpcPeer
  inbound: PassThrough
  outbound: RpcFrame[]
}

const MODEL = 'gpt-codex-test'
const ECHO_TOOL: ToolDefinition = {
  name: 'brian_echo',
  description: 'Echo text through Brian.',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
}

function createHarness(writeGate?: (frame: RpcFrame, done: (error?: Error | null) => void) => void): Harness {
  const inbound = new PassThrough()
  const outbound: RpcFrame[] = []
  const output = new Writable({ write(chunk, _encoding, done) {
    const frame = JSON.parse(chunk.toString()) as RpcFrame
    outbound.push(frame)
    if (writeGate) writeGate(frame,done)
    else done()
  } })
  return {
    peer: new CodexRpcPeer({ input: inbound, output, maxFrameBytes: 8 * 1024 * 1024 }),
    inbound,
    outbound,
  }
}

async function waitForMethod(
  harness: Harness,
  method: string,
  occurrence = 0,
): Promise<RpcFrame> {
  await vi.waitFor(() => {
    expect(harness.outbound.filter((frame) => frame.method === method).length).toBeGreaterThan(
      occurrence,
    )
  })
  return harness.outbound.filter((frame) => frame.method === method)[occurrence]!
}

async function waitForResponse(harness: Harness, id: string): Promise<RpcFrame> {
  await vi.waitFor(() => {
    expect(harness.outbound.some((frame) => frame.id === id && frame.method === undefined)).toBe(
      true,
    )
  })
  return harness.outbound.find((frame) => frame.id === id && frame.method === undefined)!
}

function respond(harness: Harness, request: RpcFrame, result: unknown): void {
  harness.inbound.write(`${JSON.stringify({ id: request.id, result })}\n`)
}

function reject(harness: Harness, request: RpcFrame, code: number, message: string): void {
  harness.inbound.write(`${JSON.stringify({ id: request.id, error: { code, message } })}\n`)
}

function notify(harness: Harness, method: string, params: unknown): void {
  harness.inbound.write(`${JSON.stringify({ method, params })}\n`)
}

function request(harness: Harness, id: string, method: string, params: unknown): void {
  harness.inbound.write(`${JSON.stringify({ id, method, params })}\n`)
}

function respondToThreadStart(harness: Harness, frame: RpcFrame, threadId = 'thread-1'): void {
  respond(harness, frame, {
    thread: { id: threadId },
    model: MODEL,
    modelProvider: 'openai',
  })
}

function respondToTurnStart(harness: Harness, frame: RpcFrame, turnId = 'turn-1'): void {
  respond(harness, frame, { turn: { id: turnId, status: 'inProgress' } })
}

function usage(harness: Harness, threadId: string, turnId: string): void {
  notify(harness, 'thread/tokenUsage/updated', {
    threadId,
    turnId,
    tokenUsage: {
      last: {
        inputTokens: 11,
        cachedInputTokens: 3,
        outputTokens: 7,
        reasoningOutputTokens: 2,
        totalTokens: 18,
      },
      total: {
        inputTokens: 11,
        cachedInputTokens: 3,
        outputTokens: 7,
        reasoningOutputTokens: 2,
        totalTokens: 18,
      },
    },
  })
}

function complete(harness: Harness, threadId: string, turnId: string): void {
  notify(harness, 'turn/completed', {
    threadId,
    turn: { id: turnId, status: 'completed', error: null },
  })
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

async function startToolTurn(
  harness: Harness,
  messages: Message[] = [{ role: 'user', content: 'Use the echo tool.' }],
  assertInputAuthority?: () => Promise<void>,
): Promise<{
  session: ReturnType<ReturnType<typeof createCodexAppServerProvider>['createSession']>
  first: Promise<StreamChunk[]>
}> {
  const provider = createCodexAppServerProvider({
    transport: { rpc: harness.peer, cwd: '/tmp/brian-codex-test' },
    models: [MODEL],
    toolBatchQuietMs: 1,
  })
  const session = provider.createSession({
    model: MODEL,
    systemPrompt: 'You are Brian.',
    tools: [ECHO_TOOL],
    assertInputAuthority,
  })
  const first = collectScoped(session.send(messages))
  const threadStart = await waitForMethod(harness, 'thread/start')
  respondToThreadStart(harness, threadStart)
  const turnStart = await waitForMethod(harness, 'turn/start')
  respondToTurnStart(harness, turnStart)
  await new Promise<void>((resolve) => setImmediate(resolve))
  return { session, first }
}

describe('[COMP:providers/codex-app-server] Codex app-server provider bridge', () => {
  it.each([false,true])('refuses before a thread payload and keeps the refusal terminal (stateless=%s)', async stateless => {
    const harness = createHarness(); let revoked = true
    const provider = createCodexAppServerProvider({ transport: { rpc: harness.peer,cwd: '/tmp/brian-codex-test' },models: [MODEL] })
    const options = { model: MODEL,systemPrompt: 'Withheld fictional context',assertInputAuthority: async () => { if (revoked) throw new Error('Grant withdrawn') } }
    const session = provider.createSession(options)
    const send = () => collect(stateless ? provider.stream({ ...options,messages: [{ role: 'user',content: 'Fictional input' }] }) : session.send([{ role: 'user',content: 'Fictional input' }]))
    try {
      await expect(send()).rejects.toMatchObject({ reason: 'authority_changed',retrySafe: false })
      if (!stateless) {
        revoked = false
        await expect(send()).rejects.toMatchObject({ reason: 'authority_changed' })
      }
      expect(harness.outbound).toEqual([])
      expect(harness.peer.closed).toBe(false)
    } finally { harness.peer.close() }
  })

  it('withholds history after a grant is withdrawn during thread creation', async () => {
    const harness = createHarness(); let revoked = false
    const provider = createCodexAppServerProvider({ transport: { rpc: harness.peer,cwd: '/tmp/brian-codex-test' },models: [MODEL] })
    const session = provider.createSession({ model: MODEL,systemPrompt: 'Fictional checked context',assertInputAuthority: async () => { if (revoked) throw new Error('Grant withdrawn') } })
    try {
      const failed = expect(collect(session.send([{ role: 'assistant',content: 'Withheld fictional history' },{ role: 'user',content: 'Current input' }])))
        .rejects.toMatchObject({ reason: 'authority_changed' })
      const start = await waitForMethod(harness,'thread/start')
      revoked = true; respondToThreadStart(harness,start)
      await failed
      expect(harness.outbound.filter(frame => frame.method === 'thread/inject_items' || frame.method === 'turn/start')).toEqual([])
      expect(JSON.stringify(harness.outbound)).not.toContain('Withheld fictional history')
    } finally { harness.peer.close() }
  })

  it('rechecks each history batch and withholds later batches after withdrawal', async () => {
    const harness = createHarness(); let revoked = false
    const provider = createCodexAppServerProvider({ transport: { rpc: harness.peer,cwd: '/tmp/brian-codex-test' },models: [MODEL] })
    const session = provider.createSession({ model: MODEL,systemPrompt: 'Fictional checked context',assertInputAuthority: async () => { if (revoked) throw new Error('Grant withdrawn') } })
    try {
      const history: Message[] = Array.from({ length: 32 },(_,n) => ({ role: 'user',content: `${n}: ${'x'.repeat(210_000)}` }))
      const failed = expect(collect(session.send([...history,{ role: 'user',content: 'Current input' }]))).rejects.toMatchObject({ reason: 'authority_changed' })
      respondToThreadStart(harness,await waitForMethod(harness,'thread/start'))
      const first = await waitForMethod(harness,'thread/inject_items')
      revoked = true; respond(harness,first,{})
      await failed
      expect(harness.outbound.filter(frame => frame.method === 'thread/inject_items')).toHaveLength(1)
      expect(harness.outbound.filter(frame => frame.method === 'turn/start')).toHaveLength(0)
    } finally { harness.peer.close() }
  })

  it('withholds structured-output retry after withdrawal instead of sending a second turn', async () => {
    const harness = createHarness(); let revoked = false
    const provider = createCodexAppServerProvider({ transport: { rpc: harness.peer,cwd: '/tmp/brian-codex-test' },models: [MODEL] })
    try {
      const failed = expect(collect(provider.stream({ model: MODEL,systemPrompt: 'Fictional checked context',messages: [{ role: 'user',content: 'Fictional input' }],responseFormat: 'json',responseSchema: { type: 'object' },
        assertInputAuthority: async () => { if (revoked) throw new Error('Grant withdrawn') } }))).rejects.toMatchObject({ reason: 'authority_changed' })
      respondToThreadStart(harness,await waitForMethod(harness,'thread/start'))
      const turn = await waitForMethod(harness,'turn/start')
      revoked = true; reject(harness,turn,-32602,'Fictional schema rejection')
      await failed
      expect(harness.outbound.filter(frame => frame.method === 'turn/start')).toHaveLength(1)
      expect(JSON.stringify(harness.outbound)).not.toContain('assertInputAuthority')
    } finally { harness.peer.close() }
  })

  it('withholds a queued parked tool result and invalidates only its own session', async () => {
    let release!: () => void, revoked = false, resumedCheck = false
    const harness = createHarness((frame,done) => { if (frame.method === 'fixture/barrier') release = () => done(); else done() })
    const check = async () => {
      if (revoked) throw new Error('Grant withdrawn')
      if (harness.outbound.some(frame => frame.method === 'fixture/barrier')) resumedCheck = true
    }
    try {
      const { session,first } = await startToolTurn(harness,undefined,check)
      request(harness,'guarded-tool','item/tool/call',{ threadId: 'thread-1',turnId: 'turn-1',callId: 'guarded-call',tool: ECHO_TOOL.name,arguments: { text: 'Lookup' } })
      await first
      const barrier = harness.peer.notify('fixture/barrier',{})
      await waitForMethod(harness,'fixture/barrier')
      const failed = expect(collect(session.send([{ role: 'user',content: [{ type: 'tool_result',toolUseId: 'guarded-call',name: ECHO_TOOL.name,content: 'Withheld fictional cost' }] }])))
        .rejects.toMatchObject({ reason: 'authority_changed' })
      await vi.waitFor(() => expect(resumedCheck).toBe(true))
      revoked = true; release(); await barrier
      await failed
      expect((await waitForResponse(harness,'guarded-tool')).error).toEqual({ code: -32603,message: 'Request handler failed' })
      expect(JSON.stringify(harness.outbound)).not.toContain('Withheld fictional cost')
      expect(harness.peer.closed).toBe(false)
      revoked = false
      await expect(collect(session.send([{ role: 'user',content: 'Cannot revive' }]))).rejects.toMatchObject({ reason: 'authority_changed' })
    } finally { harness.peer.close() }
  })

  it.each([false, true])('starts an isolated thread with both system sections (stateless=%s)', async (stateless) => {
    const harness = createHarness()
    const provider = createCodexAppServerProvider({
      transport: { rpc: harness.peer, cwd: '/tmp/brian-codex-test' },
      models: [MODEL],
    })
    const options = {
      assertInputAuthority: async () => {},
      model: MODEL,
      systemPrompt: 'You are Brian.',
      tools: [ECHO_TOOL],
      thinkingLevel: 'high' as const,
      runtimeSystemContext: 'Current time: 12:00',
    }
    const messages: Message[] = [
      { role: 'system', content: 'Prior policy.' },
      { role: 'assistant', content: 'Earlier answer.' },
      { role: 'user', content: 'Current question.' },
    ]
    const chunks = collect(stateless
      ? provider.stream({ ...options, messages })
      : provider.createSession(options).send(messages))

    const threadStart = await waitForMethod(harness, 'thread/start')
    expect(threadStart.params).toMatchObject({
      model: MODEL,
      baseInstructions: 'You are Brian.\n\n<runtime_context>\nCurrent time: 12:00\n</runtime_context>',
      developerInstructions: null,
      cwd: '/tmp/brian-codex-test',
      ephemeral: true,
      allowProviderModelFallback: false,
      sandbox: 'read-only',
      environments: [],
      runtimeWorkspaceRoots: [],
      selectedCapabilityRoots: [],
      dynamicTools: [
        {
          type: 'function',
          name: 'brian_echo',
          inputSchema: ECHO_TOOL.parameters,
        },
      ],
    })
    respondToThreadStart(harness, threadStart)

    const inject = await waitForMethod(harness, 'thread/inject_items')
    expect(inject.params).toMatchObject({
      threadId: 'thread-1',
      items: [
        {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'Prior policy.' }],
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Earlier answer.', annotations: [] }],
        },
      ],
    })
    respond(harness, inject, {})

    const turnStart = await waitForMethod(harness, 'turn/start')
    expect(turnStart.params).toMatchObject({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'Current question.' }],
      environments: [],
      effort: 'high',
    })
    respondToTurnStart(harness, turnStart)
    await new Promise<void>((resolve) => setImmediate(resolve))

    notify(harness, 'item/reasoning/summaryTextDelta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'reasoning-1',
      delta: 'thinking',
    })
    notify(harness, 'item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'message-1',
      delta: 'hello',
    })
    usage(harness, 'thread-1', 'turn-1')
    complete(harness, 'thread-1', 'turn-1')

    if (stateless) {
      const unsubscribe = await waitForMethod(harness, 'thread/unsubscribe')
      respond(harness, unsubscribe, {})
    }

    await expect(chunks).resolves.toEqual([
      { type: 'message_start', model: MODEL },
      { type: 'thinking_delta', text: 'thinking' },
      { type: 'text_delta', text: 'hello' },
      {
        type: 'message_end',
        stopReason: 'end_turn',
        usage: {
          inputTokens: 11,
          outputTokens: 7,
          cacheReadTokens: 3,
          cacheWriteTokens: 0,
        },
      },
    ])
    harness.peer.close()
  })

  it('preserves a PDF completion sentinel split across agent-message delta frames', async () => {
    const harness = createHarness()
    const provider = createCodexAppServerProvider({
      transport: { rpc: harness.peer, cwd: '/tmp/brian-codex-test' },
      models: [MODEL],
    })
    const session = provider.createSession({ model: MODEL, systemPrompt: 'Read the scan.' })
    const streamed = collect(session.send([{
      role: 'user',
      content: [
        { type: 'text', text: 'Transcribe page 1.' },
        { type: 'image', mimeType: 'image/jpeg', data: 'c2Nhbm5lZC1wYWdl' },
      ],
    }]))

    const threadStart = await waitForMethod(harness, 'thread/start')
    respondToThreadStart(harness, threadStart)
    const turnStart = await waitForMethod(harness, 'turn/start')
    respondToTurnStart(harness, turnStart)
    await new Promise<void>((resolve) => setImmediate(resolve))

    notify(harness, 'item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'message-1',
      delta: '## Page 1\n\nScanned total: 42\n\n[[PDF_PAGE_1_',
    })
    notify(harness, 'item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'message-1',
      delta: 'COMPLETE]]',
    })
    usage(harness, 'thread-1', 'turn-1')
    complete(harness, 'thread-1', 'turn-1')

    const text = (await streamed)
      .filter((chunk): chunk is Extract<StreamChunk, { type: 'text_delta' }> => (
        chunk.type === 'text_delta'
      ))
      .map((chunk) => chunk.text)
      .join('')
    expect(missingPdfPageCompletionMarkers(text, [1])).toEqual([])
    expect(stripPdfPageCompletionMarkers(text)).toBe('## Page 1\n\nScanned total: 42')
    harness.peer.close()
  })

  it('replays a historical inline image above the former 512 KiB item boundary', async () => {
    const harness = createHarness()
    const provider = createCodexAppServerProvider({
      transport: { rpc: harness.peer, cwd: '/tmp/brian-codex-test' },
      models: [MODEL],
    })
    const session = provider.createSession({ model: MODEL, systemPrompt: 'You are Brian.' })
    const imageData = 'A'.repeat(700 * 1024)
    const chunks = collect(
      session.send([
        {
          role: 'user',
          content: [{ type: 'image', mimeType: 'image/png', data: imageData }],
        },
        { role: 'user', content: 'What did the earlier image show?' },
      ]),
    )

    const threadStart = await waitForMethod(harness, 'thread/start')
    respondToThreadStart(harness, threadStart)
    const inject = await waitForMethod(harness, 'thread/inject_items')
    const injected = (inject.params as {
      items: Array<{ content: Array<{ type: string; image_url?: string }> }>
    }).items
    expect(injected[0]!.content).toEqual([
      { type: 'input_image', image_url: `data:image/png;base64,${imageData}` },
    ])
    expect(Buffer.byteLength(JSON.stringify(inject.params))).toBeGreaterThan(512 * 1024)
    expect(Buffer.byteLength(JSON.stringify(inject.params))).toBeLessThan(8 * 1024 * 1024)
    respond(harness, inject, {})

    const turnStart = await waitForMethod(harness, 'turn/start')
    respondToTurnStart(harness, turnStart)
    await new Promise<void>((resolve) => setImmediate(resolve))
    usage(harness, 'thread-1', 'turn-1')
    complete(harness, 'thread-1', 'turn-1')

    await expect(chunks).resolves.toEqual(expect.arrayContaining([{ type: 'message_start', model: MODEL }]))
    harness.peer.close()
  })

  it('replaces an over-budget historical image with an explicit reattachment note', async () => {
    const harness = createHarness()
    const provider = createCodexAppServerProvider({
      transport: { rpc: harness.peer, cwd: '/tmp/brian-codex-test' },
      models: [MODEL],
    })
    const session = provider.createSession({ model: MODEL, systemPrompt: 'You are Brian.' })
    const chunks = collect(
      session.send([
        {
          role: 'user',
          content: [
            { type: 'image', mimeType: 'image/png', data: 'A'.repeat(6 * 1024 * 1024) },
            { type: 'text', text: 'Earlier image context.' },
          ],
        },
        { role: 'user', content: 'Continue.' },
      ]),
    )

    const threadStart = await waitForMethod(harness, 'thread/start')
    respondToThreadStart(harness, threadStart)
    const inject = await waitForMethod(harness, 'thread/inject_items')
    const injected = (inject.params as {
      items: Array<{ content: Array<{ type: string; text?: string; image_url?: string }> }>
    }).items
    expect(injected[0]!.content).toEqual([
      {
        type: 'input_text',
        text: expect.stringContaining('visual contents are not available'),
      },
      { type: 'input_text', text: 'Earlier image context.' },
    ])
    expect(injected[0]!.content.some((part) => part.type === 'input_image')).toBe(false)
    respond(harness, inject, {})

    const turnStart = await waitForMethod(harness, 'turn/start')
    respondToTurnStart(harness, turnStart)
    await new Promise<void>((resolve) => setImmediate(resolve))
    usage(harness, 'thread-1', 'turn-1')
    complete(harness, 'thread-1', 'turn-1')

    await expect(chunks).resolves.toEqual(expect.arrayContaining([{ type: 'message_start', model: MODEL }]))
    harness.peer.close()
  })

  it('parks a dynamic tool request and resumes the same Codex turn with its result', async () => {
    const logs = captureDocumentFlow()
    const harness = createHarness()
    const { session, first } = await startToolTurn(harness,undefined,async () => {})

    request(harness, 'tool-request-1', 'item/tool/call', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      callId: 'call-1',
      tool: 'brian_echo',
      namespace: null,
      arguments: { text: 'hello' },
    })

    await expect(first).resolves.toEqual([
      { type: 'message_start', model: MODEL },
      { type: 'tool_use_start', id: 'call-1', name: 'brian_echo' },
      { type: 'tool_use_delta', id: 'call-1', input: '{"text":"hello"}' },
      { type: 'tool_use_end', id: 'call-1' },
      {
        type: 'message_end',
        stopReason: 'tool_use',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
    ])

    const second = collectScoped(
      session.send([
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              toolUseId: 'call-1',
              name: 'brian_echo',
              content: 'echoed hello',
            },
          ],
        },
      ]),
    )
    const toolResponse = await waitForResponse(harness, 'tool-request-1')
    expect(toolResponse.result).toEqual({
      success: true,
      contentItems: [{ type: 'inputText', text: 'echoed hello' }],
    })

    notify(harness, 'item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'message-2',
      delta: 'done',
    })
    usage(harness, 'thread-1', 'turn-1')
    complete(harness, 'thread-1', 'turn-1')

    await expect(second).resolves.toEqual([
      { type: 'message_start', model: MODEL },
      { type: 'text_delta', text: 'done' },
      {
        type: 'message_end',
        stopReason: 'end_turn',
        usage: {
          inputTokens: 11,
          outputTokens: 7,
          cacheReadTokens: 3,
          cacheWriteTokens: 0,
        },
      },
    ])
    expect(harness.outbound.filter((frame) => frame.method === 'turn/start')).toHaveLength(1)
    const wire = logs().filter(row => row.event === 'codex_turn_wire' || row.event === 'codex_tool_wire')
    expect(wire).toHaveLength(2)
    expect(wire[1]).toMatchObject({ event: 'codex_tool_wire', summary: { toolResult: 1 }, codex: { textParts: 1, pdfDataUrls: 0 } })
    expect(wire[1].session).toBe(wire[0].session)
    expect(wire[0].session).toMatch(/^[a-f0-9]{16}$/)
    expect(JSON.stringify(logs())).not.toContain('echoed hello')
    expect(JSON.stringify(logs())).not.toContain('private-session-id')
    harness.peer.close()
  })

  // Codex's exec envelope yields to the model after yield_time_ms while a Brian
  // tool is still held, so the turn keeps going with no send open. Everything
  // it does in that gap must reach the next send - an approval wait made the
  // resumed send stall silently until the stream-idle retry failed.
  describe('a turn that runs on while a Brian tool is held', () => {
    const toolCall = (harness: Harness, id: string, callId: string) =>
      request(harness, id, 'item/tool/call', { threadId: 'thread-1', turnId: 'turn-1', callId, tool: 'brian_echo', namespace: null, arguments: { text: callId } })
    const resultFor = (callId: string): Message[] => [{ role: 'user', content: [{ type: 'tool_result', toolUseId: callId, name: 'brian_echo', content: `echoed ${callId}` }] }]
    const held = async () => {
      const harness = createHarness()
      const { session, first } = await startToolTurn(harness)
      toolCall(harness, 'tool-request-1', 'call-1')
      await first
      return { harness, session }
    }

    it('delivers gap text and a gap tool call to the next send, then resumes the same turn', async () => {
      const { harness, session } = await held()
      notify(harness, 'item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'm', delta: 'still working' })
      toolCall(harness, 'tool-request-2', 'call-2')
      await new Promise<void>((resolve) => setImmediate(resolve))

      const second = await collect(session.send(resultFor('call-1')))
      expect((await waitForResponse(harness, 'tool-request-1')).result).toMatchObject({ success: true })
      // Notification vs request dispatch order is the RPC peer's, as on a live send.
      expect(second).toContainEqual({ type: 'text_delta', text: 'still working' })
      expect(second).toContainEqual({ type: 'tool_use_start', id: 'call-2', name: 'brian_echo' })
      expect(second.at(-1)).toMatchObject({ type: 'message_end', stopReason: 'tool_use' })

      // The gap call is now an ordinary surfaced call: its result resumes the same turn.
      const third = collect(session.send(resultFor('call-2')))
      expect((await waitForResponse(harness, 'tool-request-2')).result).toMatchObject({ success: true })
      notify(harness, 'item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'm2', delta: 'done' })
      complete(harness, 'thread-1', 'turn-1')
      expect((await third).map(c => c.type)).toEqual(['message_start', 'text_delta', 'message_end'])
      expect(harness.outbound.filter((frame) => frame.method === 'turn/start')).toHaveLength(1)
      harness.peer.close()
    })

    it('starts a fresh turn with the results when the held turn completed in the gap', async () => {
      const { harness, session } = await held()
      notify(harness, 'item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'm', delta: 'answered without the result' })
      complete(harness, 'thread-1', 'turn-1')
      // Codex cancelled the pending call when its turn ended.
      expect((await waitForResponse(harness, 'tool-request-1')).result).toMatchObject({ success: false })

      const second = collect(session.send(resultFor('call-1')))
      const turnStart = await waitForMethod(harness, 'turn/start', 1)
      expect(JSON.stringify(turnStart.params)).toContain('echoed call-1')
      respondToTurnStart(harness, turnStart, 'turn-2')
      await new Promise<void>((resolve) => setImmediate(resolve))
      notify(harness, 'item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-2', itemId: 'm2', delta: 'with the result' })
      complete(harness, 'thread-1', 'turn-2')
      const chunks = await second
      expect(chunks.filter(c => c.type === 'text_delta')).toEqual([{ type: 'text_delta', text: 'with the result' }])
      expect(chunks.at(-1)).toMatchObject({ type: 'message_end', stopReason: 'end_turn' })
      harness.peer.close()
    })

    it('fails the next send honestly when the held turn failed in the gap', async () => {
      const { harness, session } = await held()
      notify(harness, 'turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'failed', error: { message: 'upstream' } } })
      await waitForResponse(harness, 'tool-request-1')
      await expect(collect(session.send(resultFor('call-1')))).rejects.toBeInstanceOf(CodexTurnError)
      expect(harness.outbound.filter((frame) => frame.method === 'turn/start')).toHaveLength(1)
      harness.peer.close()
    })

    it('drops a gap call the result timeout answered before Brian ever saw it', async () => {
      const harness = createHarness()
      const provider = createCodexAppServerProvider({ transport: { rpc: harness.peer, cwd: '/tmp/brian-codex-test' }, models: [MODEL], toolBatchQuietMs: 1, toolResultTimeoutMs: 40 })
      const session = provider.createSession({ model: MODEL, systemPrompt: 'You are Brian.', tools: [ECHO_TOOL] })
      const first = collect(session.send([{ role: 'user', content: 'Use the echo tool.' }]))
      respondToThreadStart(harness, await waitForMethod(harness, 'thread/start'))
      respondToTurnStart(harness, await waitForMethod(harness, 'turn/start'))
      await new Promise<void>((resolve) => setImmediate(resolve))
      toolCall(harness, 'tool-request-1', 'call-1')
      await first
      // call-2 arrives in the gap; both expire while Brian is still on call-1.
      toolCall(harness, 'tool-request-2', 'call-2')
      expect((await waitForResponse(harness, 'tool-request-2')).result).toMatchObject({ success: false })
      await waitForResponse(harness, 'tool-request-1')
      const second = collect(session.send(resultFor('call-1')))
      await new Promise((resolve) => setTimeout(resolve, 20))
      complete(harness, 'thread-1', 'turn-1')
      // Codex already failed call-2, so Brian must never be handed it to run.
      const chunks = await second
      expect(chunks.some(c => c.type === 'tool_use_start')).toBe(false)
      harness.peer.close()
    })

    it('discards gap output when the resuming send fails', async () => {
      const { harness, session } = await held()
      toolCall(harness, 'tool-request-2', 'call-2')
      await new Promise<void>((resolve) => setImmediate(resolve))
      // A result for a call Codex never made fails the batch closed.
      await expect(collect(session.send(resultFor('call-9')))).rejects.toBeInstanceOf(CodexProviderProtocolError)
      complete(harness, 'thread-1', 'turn-1')
      await new Promise<void>((resolve) => setImmediate(resolve))
      // The next send is a fresh turn; the dead gap call is not replayed into it.
      const next = collect(session.send([{ role: 'user', content: 'hello again' }]))
      respondToTurnStart(harness, await waitForMethod(harness, 'turn/start', 1), 'turn-2')
      await new Promise<void>((resolve) => setImmediate(resolve))
      complete(harness, 'thread-1', 'turn-2')
      expect((await next).some(c => c.type === 'tool_use_start')).toBe(false)
      harness.peer.close()
    })

    it('bills the model calls Codex made in the gap on the next message_end', async () => {
      const { harness, session } = await held()
      usage(harness, 'thread-1', 'turn-1')
      await new Promise<void>((resolve) => setImmediate(resolve))
      const second = collect(session.send(resultFor('call-1')))
      await waitForResponse(harness, 'tool-request-1')
      usage(harness, 'thread-1', 'turn-1')
      complete(harness, 'thread-1', 'turn-1')
      expect((await second).at(-1)).toMatchObject({ type: 'message_end', usage: { inputTokens: 22, outputTokens: 14, cacheReadTokens: 6 } })
      harness.peer.close()
    })

    it('ignores a late result for a call the result timeout already answered', async () => {
      const harness = createHarness()
      const provider = createCodexAppServerProvider({ transport: { rpc: harness.peer, cwd: '/tmp/brian-codex-test' }, models: [MODEL], toolBatchQuietMs: 1, toolResultTimeoutMs: 20 })
      const session = provider.createSession({ model: MODEL, systemPrompt: 'You are Brian.', tools: [ECHO_TOOL] })
      const first = collect(session.send([{ role: 'user', content: 'Use the echo tool.' }]))
      respondToThreadStart(harness, await waitForMethod(harness, 'thread/start'))
      respondToTurnStart(harness, await waitForMethod(harness, 'turn/start'))
      await new Promise<void>((resolve) => setImmediate(resolve))
      toolCall(harness, 'tool-request-1', 'call-1')
      await first
      expect((await waitForResponse(harness, 'tool-request-1')).result).toMatchObject({ success: false })
      toolCall(harness, 'tool-request-2', 'call-2')
      await new Promise<void>((resolve) => setImmediate(resolve))
      // call-1's late result must not read as a batch mismatch.
      const second = await collect(session.send(resultFor('call-1')))
      expect(second.map(c => c.type)).toEqual(['message_start', 'tool_use_start', 'tool_use_delta', 'tool_use_end', 'message_end'])
      harness.peer.close()
    })
  })

  it('returns Brian tool failures to Codex as unsuccessful dynamic-tool results', async () => {
    const harness = createHarness()
    const { session, first } = await startToolTurn(harness)
    request(harness, 'tool-request-error', 'item/tool/call', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      callId: 'call-error',
      tool: 'brian_echo',
      namespace: null,
      arguments: { text: 'fail' },
    })
    await first

    const resumed = collect(
      session.send([
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              toolUseId: 'call-error',
              name: 'brian_echo',
              content: 'tool execution failed',
              isError: true,
            },
          ],
        },
      ]),
    )
    await expect(waitForResponse(harness, 'tool-request-error')).resolves.toMatchObject({
      result: {
        success: false,
        contentItems: [{ type: 'inputText', text: 'tool execution failed' }],
      },
    })
    complete(harness, 'thread-1', 'turn-1')
    await resumed
    harness.peer.close()
  })

  it('accepts a tool request delivered in the same input chunk as turn/start', async () => {
    const harness = createHarness()
    const provider = createCodexAppServerProvider({
      transport: { rpc: harness.peer, cwd: '/tmp/brian-codex-test' },
      models: [MODEL],
      toolBatchQuietMs: 1,
    })
    const session = provider.createSession({
      model: MODEL,
      systemPrompt: 'You are Brian.',
      tools: [ECHO_TOOL],
    })
    const first = collect(session.send([{ role: 'user', content: 'Echo.' }]))
    const threadStart = await waitForMethod(harness, 'thread/start')
    respondToThreadStart(harness, threadStart)
    const turnStart = await waitForMethod(harness, 'turn/start')
    harness.inbound.write(
      `${JSON.stringify({
        id: turnStart.id,
        result: { turn: { id: 'turn-1', status: 'inProgress' } },
      })}\n${JSON.stringify({
        id: 'tool-request-same-frame',
        method: 'item/tool/call',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          callId: 'call-same-frame',
          tool: 'brian_echo',
          namespace: null,
          arguments: { text: 'same frame' },
        },
      })}\n`,
    )

    await expect(first).resolves.toEqual(
      expect.arrayContaining([
        { type: 'tool_use_start', id: 'call-same-frame', name: 'brian_echo' },
        { type: 'tool_use_end', id: 'call-same-frame' },
      ]),
    )
    const second = collect(
      session.send([
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              toolUseId: 'call-same-frame',
              name: 'brian_echo',
              content: 'ok',
            },
          ],
        },
      ]),
    )
    await waitForResponse(harness, 'tool-request-same-frame')
    complete(harness, 'thread-1', 'turn-1')
    await second
    harness.peer.close()
  })

  it('retries an invalid structured-output schema once without the schema', async () => {
    const harness = createHarness()
    const provider = createCodexAppServerProvider({
      transport: { rpc: harness.peer, cwd: '/tmp/brian-codex-test' },
      models: [MODEL],
    })
    const result = collect(
      provider.stream({
        model: MODEL,
        systemPrompt: 'Return JSON.',
        messages: [{ role: 'user', content: 'Answer.' }],
        responseFormat: 'json',
        responseSchema: {
          type: 'object',
          properties: { answer: { type: 'string' } },
          required: ['answer'],
        },
      }),
    )
    const threadStart = await waitForMethod(harness, 'thread/start')
    respondToThreadStart(harness, threadStart)
    const firstTurnStart = await waitForMethod(harness, 'turn/start')
    expect(firstTurnStart.params).toMatchObject({
      outputSchema: { type: 'object', required: ['answer'] },
    })
    reject(harness, firstTurnStart, -32602, 'invalid output schema')

    const retry = await waitForMethod(harness, 'turn/start', 1)
    expect(retry.params).not.toHaveProperty('outputSchema')
    respondToTurnStart(harness, retry)
    await new Promise<void>((resolve) => setImmediate(resolve))
    notify(harness, 'item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'message-json',
      delta: '{"answer":"ok"}',
    })
    complete(harness, 'thread-1', 'turn-1')
    const unsubscribe = await waitForMethod(harness, 'thread/unsubscribe')
    respond(harness, unsubscribe, {})
    await expect(result).resolves.toEqual(
      expect.arrayContaining([{ type: 'text_delta', text: '{"answer":"ok"}' }]),
    )
    harness.peer.close()
  })

  it('batches parallel dynamic calls and requires one exact result for each call id', async () => {
    const harness = createHarness()
    const { session, first } = await startToolTurn(harness)
    request(harness, 'tool-request-a', 'item/tool/call', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      callId: 'call-a',
      tool: 'brian_echo',
      namespace: null,
      arguments: { text: 'a' },
    })
    request(harness, 'tool-request-b', 'item/tool/call', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      callId: 'call-b',
      tool: 'brian_echo',
      namespace: null,
      arguments: { text: 'b' },
    })
    await first

    const second = collect(
      session.send([
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              toolUseId: 'call-b',
              name: 'brian_echo',
              content: 'B',
            },
            {
              type: 'tool_result',
              toolUseId: 'call-a',
              name: 'brian_echo',
              content: 'A',
            },
          ],
        },
      ]),
    )
    await expect(waitForResponse(harness, 'tool-request-a')).resolves.toMatchObject({
      result: { success: true, contentItems: [{ type: 'inputText', text: 'A' }] },
    })
    await expect(waitForResponse(harness, 'tool-request-b')).resolves.toMatchObject({
      result: { success: true, contentItems: [{ type: 'inputText', text: 'B' }] },
    })
    complete(harness, 'thread-1', 'turn-1')
    await second
    harness.peer.close()
  })

  it('fails closed when a parked tool-result batch is missing a call id', async () => {
    const harness = createHarness()
    const { session, first } = await startToolTurn(harness)
    request(harness, 'tool-request-1', 'item/tool/call', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      callId: 'call-1',
      tool: 'brian_echo',
      namespace: null,
      arguments: { text: 'hello' },
    })
    await first

    const resumed = collect(session.send([{ role: 'user', content: 'no tool result' }]))
    await expect(resumed).rejects.toBeInstanceOf(CodexProviderProtocolError)
    await expect(waitForResponse(harness, 'tool-request-1')).resolves.toMatchObject({
      result: { success: false },
    })
    harness.peer.close()
  })

  it('interrupts an active Codex turn and fails the stream when Brian aborts', async () => {
    const harness = createHarness()
    const controller = new AbortController()
    const provider = createCodexAppServerProvider({
      transport: { rpc: harness.peer, cwd: '/tmp/brian-codex-test' },
      models: [MODEL],
    })
    const session = provider.createSession({
      model: MODEL,
      systemPrompt: 'You are Brian.',
      signal: controller.signal,
    })
    const streamed = collect(session.send([{ role: 'user', content: 'Wait.' }]))
    const threadStart = await waitForMethod(harness, 'thread/start')
    respondToThreadStart(harness, threadStart)
    const turnStart = await waitForMethod(harness, 'turn/start')
    respondToTurnStart(harness, turnStart)
    await new Promise<void>((resolve) => setImmediate(resolve))

    controller.abort()

    await expect(streamed).rejects.toMatchObject({ name: 'AbortError' })
    const interrupt = await waitForMethod(harness, 'turn/interrupt')
    expect(interrupt.params).toEqual({ threadId: 'thread-1', turnId: 'turn-1' })
    respond(harness, interrupt, {})
    harness.peer.close()
  })

  it('maps failed turns to a redacted provider error', async () => {
    const harness = createHarness()
    const provider = createCodexAppServerProvider({
      transport: { rpc: harness.peer, cwd: '/tmp/brian-codex-test' },
      models: [MODEL],
    })
    const streamed = collect(
      provider
        .createSession({ model: MODEL, systemPrompt: 'You are Brian.' })
        .send([{ role: 'user', content: 'Answer.' }]),
    )
    const threadStart = await waitForMethod(harness, 'thread/start')
    respondToThreadStart(harness, threadStart)
    const turnStart = await waitForMethod(harness, 'turn/start')
    respondToTurnStart(harness, turnStart)
    await new Promise<void>((resolve) => setImmediate(resolve))
    notify(harness, 'turn/completed', {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1',
        status: 'failed',
        error: { message: 'upstream secret detail' },
      },
    })

    await expect(streamed).rejects.toEqual(new CodexTurnError())
    harness.peer.close()
  })

  it('rejects models outside the authenticated catalog before opening a thread', () => {
    const harness = createHarness()
    const provider = createCodexAppServerProvider({
      transport: { rpc: harness.peer, cwd: '/tmp/brian-codex-test' },
      models: [MODEL],
    })
    expect(() =>
      provider.createSession({ model: 'not-in-catalog', systemPrompt: 'Brian' }),
    ).toThrow("model 'not-in-catalog' is not in the authenticated Codex catalog")
    expect(harness.outbound).toEqual([])
    harness.peer.close()
  })

  it('degrades an undeliverable inline mime to a typed note instead of a fake image part', async () => {
    // A PDF rides an `image` ContentBlock (the engine's carrier for any inline
    // media — shaped for Gemini's native inlineData reader). Forwarding it as
    // `data:application/pdf;base64,…` under an image part is accepted by the
    // app-server and undecodable by GPT, so the turn proceeds as if the
    // document had been read. See docs/architecture/engine/file-handling.md.
    const logs = captureDocumentFlow()
    const harness = createHarness()
    const provider = createCodexAppServerProvider({
      transport: { rpc: harness.peer, cwd: '/tmp/brian-codex-test' },
      models: [MODEL],
    })
    const session = provider.createSession({ model: MODEL, systemPrompt: 'You are Brian.' })
    const chunks = collectScoped(
      session.send([
        // History replay path (`thread/inject_items`).
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Earlier attachment.' },
            { type: 'image', mimeType: 'application/pdf', data: 'JVBERi0xLjQK' },
          ],
        },
        // Current-turn path (`turn/start` input).
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Read this.' },
            { type: 'image', mimeType: 'application/pdf', data: 'JVBERi0xLjQK' },
            { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
          ],
        },
      ]),
    )

    const threadStart = await waitForMethod(harness, 'thread/start')
    respondToThreadStart(harness, threadStart)

    const inject = await waitForMethod(harness, 'thread/inject_items')
    const injected = (inject.params as { items: Array<{ content: Array<{ type: string; text?: string }> }> }).items
    expect(injected[0]!.content[1]).toMatchObject({ type: 'input_text' })
    expect(injected[0]!.content[1]!.text).toContain('application/pdf')
    expect(injected[0]!.content[1]!.text).toContain('was not read')
    expect(JSON.stringify(injected)).not.toContain('data:application/pdf')
    respond(harness, inject, {})

    const turnStart = await waitForMethod(harness, 'turn/start')
    const input = (turnStart.params as { input: Array<{ type: string; text?: string; url?: string }> }).input
    expect(input).toEqual([
      { type: 'text', text: 'Read this.' },
      { type: 'text', text: expect.stringContaining('application/pdf') },
      { type: 'image', url: 'data:image/png;base64,iVBORw0KGgo=' },
    ])
    // A real image still rides through untouched; only the undecodable mime degrades.
    expect(JSON.stringify(input)).not.toContain('data:application/pdf')
    respondToTurnStart(harness, turnStart)
    await new Promise<void>((resolve) => setImmediate(resolve))
    usage(harness, 'thread-1', 'turn-1')
    complete(harness, 'thread-1', 'turn-1')

    await chunks
    const wire = logs().filter(row => row.event === 'codex_history_wire' || row.event === 'codex_turn_wire')
    expect(wire).toHaveLength(2)
    expect(wire[0]).toMatchObject({ event: 'codex_history_wire', summary: { pdf: 1 }, codex: { pdfDataUrls: 0, imageParts: 0 } })
    expect(wire[1]).toMatchObject({ event: 'codex_turn_wire', summary: { pdf: 1, png: 1 }, codex: { pdfDataUrls: 0, imageParts: 1 } })
    expect(wire[1].session).toBe(wire[0].session)
    for (const secret of ['JVBERi0xLjQK', 'iVBORw0KGgo=', 'Earlier attachment.', 'Read this.', 'private-session-id']) expect(JSON.stringify(logs())).not.toContain(secret)
    harness.peer.close()
  })
})
