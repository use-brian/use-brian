import { afterEach, describe, expect, it, vi } from 'vitest'
import { protectNativeImage, prepareNativeImageUpload, hasNativeImages, verifiedNativeImageStream } from '../native-images.js'
import type { LLMProvider, Message, ProviderRequest, StreamChunk } from '../../providers/types.js'
import type { ToolContext } from '../../tools/types.js'
import { queryLoop } from '../query-loop.js'
import { NOOP_TURN_LEDGER } from '../turn-ledger.js'

const bytes = Buffer.from('synthetic public fixture').toString('base64')
function fixture() {
  const provider: LLMProvider = { name: 'approved', models: ['exact'], stream: vi.fn(async function* () {
    yield { type: 'text_delta', text: 'Screenshot withheld.' } as const
    yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } } as const
  }), createSession: vi.fn(() => { throw new Error('must not create a stateful session') }) }
  const context: ToolContext = { userId: 'owner', workspaceId: 'workspace', assistantId: 'assistant', sessionId: 'chat', appId: 'chat', channelType: 'web', channelId: 'chat',
    abortSignal: new AbortController().signal, engineRuntime: { provider, model: 'exact', imageUploads: true } }
  const attempt = { settle: vi.fn(async () => {}) }
  const policy = { beginAttempt: vi.fn(async () => attempt), expiresAt: Date.now() + 5000, assertCurrent: vi.fn(async () => {}), reserve: vi.fn(async (_c: ToolContext, _tokens: number) => {}), observed: vi.fn() }
  const ref = protectNativeImage({ mimeType: 'image/png', data: bytes }, context, policy)
  const messages: Message[] = [{ role: 'user', content: [{ type: 'image', ...ref }] }]
  const request: ProviderRequest = { model: 'exact', systemPrompt: 'system', messages }
  return { provider, context, policy, ref, messages, request, attempt }
}
afterEach(() => vi.useRealTimers())

describe('native opaque image upload boundary', () => {
  it('retains per-image provenance without mutating history and rechecks each upload', async () => {
    const f = fixture()
    const before = JSON.stringify(f.messages)
    const upload = await prepareNativeImageUpload(f.request, f.context)
    expect(hasNativeImages(f.messages)).toBe(true)
    expect(JSON.stringify(upload.request.messages)).toContain(bytes)
    expect(JSON.stringify(f.messages)).toBe(before)
    expect(before).not.toContain(bytes)
    expect(f.policy.reserve).toHaveBeenCalledTimes(1)
    expect(upload.request).toMatchObject({ nativeStrict: true, nativeImageChat: true, allowProviderFallback: false })
    f.policy.assertCurrent.mockRejectedValue(new Error('revoked'))
    await expect(upload.request.nativeImageUploadGuard!()).rejects.toThrow('revoked')
    const replay = await prepareNativeImageUpload(f.request, f.context)
    expect(JSON.stringify(replay.request)).not.toContain(bytes)
    expect(replay.request.nativeImageChat).toBeUndefined()
  })

  it.each(['missing', 'provider', 'model', 'owner', 'assistant', 'expired', 'stateful'] as const)('withholds %s reference before inference', async scenario => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const f = fixture()
    if (scenario === 'missing') f.messages[0].content = [{ type: 'image', ...f.ref, data: 'native-image-ref:unknown-after-restart' }]
    if (scenario === 'provider') f.context.engineRuntime = { ...f.context.engineRuntime!, provider: { ...f.provider } }
    if (scenario === 'model') f.context.engineRuntime = { ...f.context.engineRuntime!, model: 'other' }
    if (scenario === 'owner') f.context.userId = 'other'
    if (scenario === 'assistant') f.context.assistantId = 'other'
    if (scenario === 'expired') vi.setSystemTime(Date.now() + 5001)
    if (scenario === 'stateful') f.context.engineRuntime = { ...f.context.engineRuntime!, imageUploads: false }
    const upload = await prepareNativeImageUpload(f.request, f.context)
    expect(JSON.stringify(upload.request)).not.toContain(bytes)
    expect(JSON.stringify(upload.request)).toContain('screenshot withheld')
    expect(f.policy.reserve).not.toHaveBeenCalled()
  })

  it('enforces budgets over full payloads and repeated image occurrences, not just a reference', async () => {
    const f = fixture()
    f.messages.push(...f.messages)
    await prepareNativeImageUpload(f.request, f.context)
    expect(f.policy.reserve).toHaveBeenCalledTimes(1)
    expect(f.policy.reserve.mock.calls[0][1]).toBeGreaterThanOrEqual(2 * (4 * 1024 * 1024 + 32768))
    f.policy.reserve.mockRejectedValue(new Error('budget exhausted'))
    await expect(prepareNativeImageUpload(f.request, f.context)).rejects.toThrow('budget exhausted')
  })

  it('does not suppress abort or authority changes while replacing a denied reference', async () => {
    const f = fixture()
    f.policy.assertCurrent.mockImplementation(async () => { f.context.abortSignal = AbortSignal.abort(); throw new Error('revoked') })
    await expect(prepareNativeImageUpload(f.request, f.context)).rejects.toThrow()
    expect(f.provider.stream).not.toHaveBeenCalled()
  })

  it('orphaned durable history forces stateless mode even without computer tools, never creates/warmups a session', async () => {
    const f = fixture()
    f.messages[0].content = [{ type: 'image', ...f.ref, data: 'native-image-ref:unknown-after-restart' }]
    for await (const _event of queryLoop({ ledger: NOOP_TURN_LEDGER, provider: f.provider, model: 'exact', systemPrompt: '',
      messages: f.messages, tools: new Map(), context: f.context, maxTurns: 1 })) { /* drain */ }
    expect(f.provider.createSession).not.toHaveBeenCalled()
    expect(f.provider.stream).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(vi.mocked(f.provider.stream).mock.calls)).not.toContain(bytes)
    expect(JSON.stringify(vi.mocked(f.provider.stream).mock.calls)).toContain('screenshot withheld')
  })

  it('holds tool output until end-of-stream evidence; never marks an unverified frame observed', async () => {
    const f = fixture(), upload = await prepareNativeImageUpload(f.request, f.context)
    const chunks: StreamChunk[] = [
      { type: 'tool_use_start', name: 'computerAct', id: 'call' }, { type: 'tool_use_delta', id: 'call', input: '{}' }, { type: 'tool_use_end', id: 'call' },
      { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 9, outputTokens: 2 }, nativeMetadata: { actualModel: 'other', usage: { inputTokens: 9, outputTokens: 2 } } },
    ]
    const output: StreamChunk[] = []
    for await (const chunk of verifiedNativeImageStream((async function* () { yield* chunks })(), 'exact', upload.assertCurrent, upload.observed, upload.attempt!)) output.push(chunk)
    expect(output.some(c => c.type === 'tool_use_start')).toBe(false)
    expect(f.policy.observed).not.toHaveBeenCalled()
    expect(output.at(-1)).toMatchObject({ type: 'message_end', usage: { inputTokens: 9, outputTokens: 2 }, stopReason: 'end_turn' })
  })
})
