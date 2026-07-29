import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { Message, StreamChunk, ToolDefinition } from '../../types.js'
import {
  CodexProviderProtocolError,
  CodexTurnError,
  createCodexAppServerProvider,
} from '../provider.js'
import { CodexRpcPeer } from '../rpc.js'

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

function createHarness(): Harness {
  const inbound = new PassThrough()
  const output = new PassThrough()
  const outbound: RpcFrame[] = []
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
  })
  const first = collect(session.send(messages))
  const threadStart = await waitForMethod(harness, 'thread/start')
  respondToThreadStart(harness, threadStart)
  const turnStart = await waitForMethod(harness, 'turn/start')
  respondToTurnStart(harness, turnStart)
  await new Promise<void>((resolve) => setImmediate(resolve))
  return { session, first }
}

describe('[COMP:providers/codex-app-server] Codex app-server provider bridge', () => {
  it('starts an isolated ephemeral thread, injects history, and normalizes streaming output', async () => {
    const harness = createHarness()
    const provider = createCodexAppServerProvider({
      transport: { rpc: harness.peer, cwd: '/tmp/brian-codex-test' },
      models: [MODEL],
    })
    const session = provider.createSession({
      model: MODEL,
      systemPrompt: 'You are Brian.',
      tools: [ECHO_TOOL],
      thinkingLevel: 'high',
    })
    const chunks = collect(
      session.send([
        { role: 'system', content: 'Prior policy.' },
        { role: 'assistant', content: 'Earlier answer.' },
        { role: 'user', content: 'Current question.' },
      ]),
    )

    const threadStart = await waitForMethod(harness, 'thread/start')
    expect(threadStart.params).toMatchObject({
      model: MODEL,
      baseInstructions: 'You are Brian.',
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

  it('parks a dynamic tool request and resumes the same Codex turn with its result', async () => {
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

    const second = collect(
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
    harness.peer.close()
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
    const harness = createHarness()
    const provider = createCodexAppServerProvider({
      transport: { rpc: harness.peer, cwd: '/tmp/brian-codex-test' },
      models: [MODEL],
    })
    const session = provider.createSession({ model: MODEL, systemPrompt: 'You are Brian.' })
    const chunks = collect(
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
    harness.peer.close()
  })
})
