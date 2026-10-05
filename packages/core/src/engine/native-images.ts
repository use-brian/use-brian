import { z } from 'zod'
import { NativeModelIdSchema } from '../computer-use/trace.js'
import { randomUUID } from 'node:crypto'
import { registryRow } from '@use-brian/shared/model-registry'
import type { Message, ProviderRequest, StreamChunk, TokenUsage } from '../providers/types.js'
import type { ToolContext, ToolResultImage } from '../tools/types.js'

// An image's data field is an opaque capability, not base64. No screenshot
// bytes enter ordinary history, ledgers, compaction, resume or alternate engines.
// Only the normal query-loop upload boundary can resolve it. Restart/eviction
// fails closed. MIME + prefix survive existing image persistence projections.
const MIME = 'application/x-brian-native-image-reference'
const PREFIX = 'native-image-ref:'
const MAX_BYTES = 16 * 1024 * 1024
const entries = new Map<string, Entry>()
let bytes = 0
const owner = (c: ToolContext) => JSON.stringify([c.userId, c.workspaceId, c.assistantId, c.sessionId])
export type NativeImageSettlement = { actualModel: string | null; usage: TokenUsage | null; outcome: 'ok' | 'failed'; interrupted: boolean; durationMs: number }
export type NativeImageAttempt = { settle(result: NativeImageSettlement): Promise<void> }
type Entry = {
  image: ToolResultImage; bytes: number; owner: string; expiresAt: number
  route: NonNullable<ToolContext['engineRuntime']>
  assertCurrent(context: ToolContext): Promise<void>
  reserve(context: ToolContext, tokens: number): Promise<void>
  observed?(): void
  beginAttempt(context: ToolContext): Promise<NativeImageAttempt>
}
function remove(id: string) {
  const entry = entries.get(id)
  if (entry) bytes -= entry.bytes
  entries.delete(id)
}
export function protectNativeImage(image: ToolResultImage, context: ToolContext, policy: {
  expiresAt: number
  assertCurrent(context: ToolContext): Promise<void>
  /** Non-refundable budget reservation. Durable settlement owns this call
   * independently of publication; it is excluded from generic chat billing. */
  reserve(context: ToolContext, tokens: number): Promise<void>
  observed?(): void
  beginAttempt(context: ToolContext): Promise<NativeImageAttempt>
}): ToolResultImage {
  if (!context.engineRuntime?.imageUploads || image.mimeType !== 'image/png') throw new Error('Native image route unavailable')
  const size = Buffer.byteLength(image.data)
  if (!size || size > 3 * 1024 * 1024 || policy.expiresAt <= Date.now()) throw new Error('Native image unavailable')
  for (const [id, entry] of entries) if (entry.expiresAt <= Date.now()) remove(id)
  while (entries.size >= 32 || bytes + size > MAX_BYTES) remove(entries.keys().next().value!)
  const id = PREFIX + randomUUID()
  entries.set(id, { ...policy, image: { ...image }, bytes: size, owner: owner(context), route: context.engineRuntime })
  bytes += size
  return { mimeType: MIME, data: id }
}
function isReference(block: { type: string; data?: string; mimeType?: string }) {
  return block.type === 'image' && (block.mimeType === MIME || block.data?.startsWith(PREFIX))
}
export function hasNativeImages(messages: Message[]): boolean {
  return messages.some(m => Array.isArray(m.content) && m.content.some(isReference))
}

/** Every call, including later turns/retries, starts from opaque history. The
 * returned request is ephemeral and must never replace that history. */
export async function prepareNativeImageUpload(request: ProviderRequest, context: ToolContext): Promise<{
  request: ProviderRequest
  assertCurrent(): Promise<void>
  observed(): void
  attempt?: NativeImageAttempt
}> {
  if (!hasNativeImages(request.messages)) return { request, assertCurrent: async () => {}, observed: () => {} }
  context.abortSignal.throwIfAborted()
  await context.authority?.assertCurrent()
  const admitted = new Set<Entry>()
  const assertEntry = async (entry: Entry) => {
    const route = context.engineRuntime
    if (!route?.imageUploads || route.provider !== entry.route.provider || route.model !== entry.route.model
      || request.model !== route.model || owner(context) !== entry.owner || entry.expiresAt <= Date.now()) throw new Error('Native image unavailable')
    context.abortSignal.throwIfAborted()
    await context.authority?.assertCurrent()
    await entry.assertCurrent(context)
    if (entry.expiresAt <= Date.now()) throw new Error('Native image expired')
    context.abortSignal.throwIfAborted()
  }
  const messages: Message[] = []
  for (const message of request.messages) {
    if (!Array.isArray(message.content)) { messages.push(message); continue }
    const content = []
    for (const block of message.content) {
      if (!isReference(block) || block.type !== 'image') { content.push(block); continue }
      const entry = entries.get(block.data)
      try {
        if (!entry) throw new Error('Native image unavailable')
        await assertEntry(entry)
        admitted.add(entry)
        content.push({ type: 'image' as const, ...entry.image })
      } catch {
        content.push({ type: 'text' as const, text: '[Native screenshot withheld: image policy unavailable, revoked or expired. Obtain fresh evidence; never replay an uncertain action.]' })
      }
    }
    messages.push({ ...message, content })
  }
  context.abortSignal.throwIfAborted()
  await context.authority?.assertCurrent()
  if (!admitted.size) return { request: { ...request, messages }, assertCurrent: async () => {}, observed: () => {} }
  // Byte-based upper bound includes the whole chat, tools, system and images,
  // not just the tool result. Keep the existing native vision reservation floor.
  const imageCount = messages.reduce((count, m) => count + (Array.isArray(m.content) ? m.content.filter(b => b.type === 'image').length : 0), 0)
  const tokens = Math.max(imageCount * (4 * 1024 * 1024 + 32768),
    Buffer.byteLength(JSON.stringify({ ...request, messages })) + (request.maxTokens ?? registryRow(request.model)?.maxOutput ?? 65536))
  for (const entry of admitted) await entry.reserve(context, tokens)
  const assertCurrent = async () => { for (const entry of admitted) await assertEntry(entry) }
  await assertCurrent()
  const attempt = await admitted.values().next().value!.beginAttempt(context)
  return { attempt, request: { ...request, messages, nativeStrict: true, nativeImageChat: true, nativeImageUploadGuard: assertCurrent, allowProviderFallback: false,
    httpRetryWindow: { deadline: Date.now(), rateLimited: false } }, assertCurrent, observed: () => { for (const entry of admitted) entry.observed?.() } }
}

const count = z.number().int().nonnegative().safe()
const usageSchema = z.object({ inputTokens: count, outputTokens: count, cacheReadTokens: count.optional(), cacheWriteTokens: count.optional() })

/** Publication authority cannot cancel accounting. Admission precedes dispatch;
 * this consumer awaits durable settlement BEFORE yielding even a refusal. Only
 * independently validated upstream counters/identity can be billed. Unknowns
 * remain durable NULLs, never zero/free or priced as the requested model. */
export async function* verifiedNativeImageStream(stream: AsyncIterable<StreamChunk>, model: string,
  assertCurrent: () => Promise<void>, observed: () => void, attempt: NativeImageAttempt): AsyncGenerator<StreamChunk> {
  const started = performance.now()
  const chunks: StreamChunk[] = []
  let size = 0
  let end: Extract<StreamChunk, { type: 'message_end' }> | undefined
  let actualModel: string | null = null, usage: TokenUsage | null = null
  let invalid = false, streamFailed = false, publicationError: unknown
  let modelConflict = false, usageConflict = false
  try {
    for await (const chunk of stream) {
      if (end) invalid = true
      if (chunk.type === 'message_end') {
        const nextModel = NativeModelIdSchema.safeParse(chunk.nativeMetadata?.actualModel)
        const nextUsage = usageSchema.safeParse(chunk.nativeMetadata?.usage)
        const observedModel = nextModel.success ? nextModel.data : null
        const observedUsage = nextUsage.success ? nextUsage.data : null
        // Duplicate/conflicting terminal evidence cannot rewrite attribution.
        modelConflict ||= !!end && actualModel !== observedModel
        usageConflict ||= !!end && JSON.stringify(usage) !== JSON.stringify(observedUsage)
        actualModel = modelConflict ? null : observedModel
        usage = usageConflict ? null : observedUsage
        end = chunk
      }
      size += Buffer.byteLength(JSON.stringify(chunk))
      if (size > 1024 * 1024) { invalid = true; continue }
      chunks.push(chunk)
    }
  } catch { streamFailed = true; invalid = true }
  const expected = registryRow(model)?.apiModelId ?? model
  if (!end || actualModel !== expected || !usage || !['end_turn', 'tool_use'].includes(end.stopReason)
    || (chunks.some(c => c.type.startsWith('tool_use')) && end.stopReason !== 'tool_use')) invalid = true
  try { await assertCurrent() } catch (error) { publicationError = error; invalid = true }
  await attempt.settle({ actualModel, usage, outcome: invalid ? 'failed' : 'ok', interrupted: !!publicationError,
    durationMs: Math.max(0, Math.round(performance.now() - started)) })
  // Do not expose ANY content after revocation, including a refusal/usage event.
  if (publicationError) throw publicationError
  // Settlement itself may await storage across Stop/consent expiry. Accounting
  // is already durable; recheck publication without replaying or refunding it.
  await assertCurrent()
  if (streamFailed || !end || !actualModel || !usage) throw new Error('Native image response unavailable; accounting evidence retained')
  yield { type: 'message_start', model: actualModel }
  const validatedEnd = { ...end, usage, nativeMetadata: { actualModel, usage } }
  if (invalid) {
    yield { type: 'text_delta', text: 'Computer image response withheld: model provenance, freshness or permission could not be verified. No visual action was executed.' }
    yield { ...validatedEnd, stopReason: 'end_turn' }
    return
  }
  observed()
  for (const chunk of chunks) if (chunk.type !== 'message_start') yield chunk.type === 'message_end' ? validatedEnd : chunk
}
