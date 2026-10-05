import type { ProviderRequest, StreamChunk, TokenUsage } from './types.js'

/**
 * Strict support is scoped to stateless text/image inference in Anthropic,
 * Gemini (AI Studio / Vertex), and OpenAI-compatible adapters. SessionOptions
 * intentionally has no nativeStrict flag. Legacy tool/document transformations
 * and Codex fail before dispatch. nativeImageChat is a separate guarded opt-in
 * for normal tool chat, retaining the same no-retry/no-fallback transport.
 * The caller owns cancellation/deadlines; recovery/idle wrappers are bypassed.
 * Native evidence is independent of legacy zero-filled usage/message_start.
 */
export class NativeEvidence {
  private model: string | null = null
  private conflict = false
  usage: TokenUsage | null = null
  observeModel(value: unknown): void {
    if (value === undefined) return // usage-only frames need not repeat identity
    if (typeof value !== 'string' || !value.trim()) { this.conflict = true; return }
    if (this.model !== null && this.model !== value) this.conflict = true
    this.model = value
  }
  metadata() { return { actualModel: this.conflict ? null : this.model, usage: this.usage } }
}
export function counter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
export function nativeUsage(input: unknown, output: unknown, cached: unknown = 0, thoughts: unknown = 0, written: unknown = 0, inclusive = true): TokenUsage | null {
  if (!counter(input) || !counter(output) || !counter(cached) || !counter(thoughts) || !counter(written) || (inclusive && cached > input) || !counter(output + thoughts)) return null
  return { inputTokens: inclusive ? input - cached : input, outputTokens: output + thoughts,
    ...(cached ? { cacheReadTokens: cached } : {}), ...(written ? { cacheWriteTokens: written } : {}) }
}
export function assertNativeInput(request: ProviderRequest): void {
  // Legacy nativeStrict remains text/image only. The separate guarded chat
  // opt-in permits tool history, never document adaptation or hidden inference.
  const chat = request.nativeStrict === true && request.nativeImageChat === true
  if (chat && typeof request.nativeImageUploadGuard !== 'function') throw new Error('native_unsupported_input')
  if ((!chat && request.tools?.length) || request.messages.some(m => typeof m.content !== 'string' && m.content.some(b =>
    !['text', 'image', ...(chat ? ['tool_use', 'tool_result'] : [])].includes(b.type)
    || (b.type === 'image' && !/^image\/(png|jpeg|webp|gif)$/.test(b.mimeType))))) throw new Error('native_unsupported_input')
  const first = request.messages.find(m => m.role !== 'system')
  if (!first || first.role !== 'user') throw new Error('native_unsupported_input')
}
/** No upstream exception (including SDK causes / fetch URLs) escapes this lane. */
export async function* nativeGuard(stream: AsyncIterable<StreamChunk>): AsyncGenerator<StreamChunk> {
  try { yield* stream } catch { throw new Error('native_provider_failure') }
}
