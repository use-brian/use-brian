/** Temporary, opt-in metadata diagnostics. Never serialize caller objects. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { registryRow } from '@use-brian/shared/model-registry'
import { summarizeProviderError } from '../providers/provider-error-summary.js'
import type { Message, TokenUsage } from '../providers/types.js'

const scope = new AsyncLocalStorage<{ sessionId?: string }>()
export const documentFlowDebugEnabled = () => process.env.BRIAN_DEBUG_DOCUMENT_FLOW === '1'
const size = (value: unknown) => typeof value === 'string' ? value.length : 0
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0
const known = (value: unknown, values: readonly string[]) => typeof value === 'string' && values.includes(value) ? value : 'other'

// Only literal host tool names; external/MCP names can contain private data.
const toolNames = ['listDocumentExtractionConnectors', 'prepareDocumentExtraction', 'startDocumentExtraction', 'readDocumentExtraction', 'proposeOfficeEvidenceFill', 'readFile', 'getCurrentPage', 'patchPage', 'searchBrain'] as const

/** Fixed-size aggregate: no content copies, JSON.stringify(input), or per-block arrays. */
export function summarizeDocumentMessages(messages: readonly Message[]) {
  const counts = { messages: messages.length, user: 0, assistant: 0, system: 0, text: 0, textChars: 0, image: 0, dataChars: 0, pdf: 0, jpeg: 0, png: 0, otherMime: 0, toolUse: 0, toolResult: 0, resultChars: 0, resultErrors: 0, otherBlocks: 0 }
  const tools: Record<string, number> = { other: 0 }
  for (const message of messages) {
    if (message.role === 'user' || message.role === 'assistant' || message.role === 'system') counts[message.role]++
    if (typeof message.content === 'string') { counts.text++; counts.textChars += message.content.length; continue }
    for (const block of message.content) {
      switch (block.type) {
        case 'text': counts.text++; counts.textChars += size(block.text); break
        case 'image':
          counts.image++; counts.dataChars += size(block.data)
          if (block.mimeType === 'application/pdf') counts.pdf++
          else if (block.mimeType === 'image/jpeg') counts.jpeg++
          else if (block.mimeType === 'image/png') counts.png++
          else counts.otherMime++
          break
        case 'tool_use': { counts.toolUse++; const name = known(block.name, toolNames); tools[name] = (tools[name] ?? 0) + 1; break }
        case 'tool_result': counts.toolResult++; counts.resultChars += size(block.content); if (block.isError) counts.resultErrors++; break
        default: counts.otherBlocks++
      }
    }
  }
  return { ...counts, tools }
}

type Event = 'tool_availability' | 'gemini_wire' | 'chat_input' | 'request' | 'response' | 'stream_error' | 'compaction' | 'tool_result' | 'tool_completion' | 'openai_wire' | 'document_adaptation' | 'context_fit' | 'codex_turn_wire' | 'codex_history_wire' | 'codex_tool_wire'
type Details = {
  declarations?: Iterable<{ name: string }>; phase?: 'before_filter' | 'after_filter';
  gemini?: GeminiToolWire;
  sessionId?: string; model?: string; turn?: number; mode?: 'stateful_delta' | 'stateless_full';
  messages?: readonly Message[]; before?: readonly Message[]; stopReason?: string; usage?: TokenUsage;
  providerError?: unknown; providerReason?: 'incomplete_stream' | 'idle_timeout';
  toolName?: string; error?: boolean; timeout?: boolean; aborted?: boolean; truncated?: boolean;
  codex?: readonly unknown[]; inputChars?: number; outputChars?: number; wire?: readonly { role: string; content: unknown; tool_calls?: readonly unknown[] }[];
}
export function debugDocumentFlow(event: Event, detail: Details): void {
  if (!documentFlowDebugEnabled()) return
  try {
    const sessionId = detail.sessionId ?? scope.getStore()?.sessionId
    const wire = detail.wire && { messages: detail.wire.length, textChars: 0, imageUrlParts: 0, imageUrlChars: 0, pdfDataUrls: 0, toolMessages: 0, toolCalls: 0 }
    if (wire) for (const message of detail.wire!) {
      if (message.role === 'tool') wire.toolMessages++
      wire.toolCalls += message.tool_calls?.length ?? 0
      if (typeof message.content === 'string') wire.textChars += message.content.length
      else if (Array.isArray(message.content)) for (const part of message.content) {
        if (part.type === 'text') wire.textChars += size(part.text)
        if (part.type === 'image_url') { wire.imageUrlParts++; wire.imageUrlChars += size(part.image_url?.url); if (typeof part.image_url?.url === 'string' && part.image_url.url.startsWith('data:application/pdf;')) wire.pdfDataUrls++ }
      }
    }
    console.info('[document-flow-debug]', JSON.stringify({
      event,
      ...(detail.error || detail.providerError !== undefined || detail.providerReason !== undefined ? {
        ...summarizeProviderError(detail.providerError),
        ...(detail.providerReason === 'incomplete_stream' || detail.providerReason === 'idle_timeout' ? { category: detail.providerReason } : {}),
      } : {}),
      // Hash arbitrary session selectors; never let a caller-controlled identifier leak.
      session: sessionId ? createHash('sha256').update(sessionId).digest('hex').slice(0, 16) : undefined,
      model: detail.model === undefined ? undefined : registryRow(detail.model) !== undefined ? detail.model : 'other',
      turn: detail.turn === undefined ? undefined : number(detail.turn), mode: detail.mode === undefined ? undefined : known(detail.mode, ['stateful_delta', 'stateless_full']),
      phase: detail.phase === undefined ? undefined : known(detail.phase, ['before_filter', 'after_filter']),
      declarations: detail.declarations && summarizeDocumentTools(detail.declarations),
      gemini: detail.gemini && summarizeGeminiTools(detail.gemini),
      summary: detail.messages && summarizeDocumentMessages(detail.messages),
      before: detail.before && summarizeDocumentMessages(detail.before), wire,
      codex: detail.codex && summarizeCodexWire(detail.codex),
      stopReason: detail.stopReason === undefined ? undefined : known(detail.stopReason, ['end_turn', 'tool_use', 'max_tokens', 'safety', 'incomplete']),
      usage: detail.usage && { inputTokens: number(detail.usage.inputTokens), outputTokens: number(detail.usage.outputTokens), cacheReadTokens: number(detail.usage.cacheReadTokens), cacheWriteTokens: number(detail.usage.cacheWriteTokens) },
      toolName: detail.toolName === undefined ? undefined : known(detail.toolName, toolNames),
      error: detail.error === true, timeout: detail.timeout === true, aborted: detail.aborted === true, truncated: detail.truncated === true,
      inputChars: number(detail.inputChars), outputChars: number(detail.outputChars),
    }))
  } catch { /* Diagnostics must not affect extraction. */ }
}

/** Scope each generator advancement, not the caller's async context. */
export async function* withDocumentFlowDebug<T>(sessionId: string, iterator: AsyncGenerator<T>): AsyncGenerator<T> {
  if (!documentFlowDebugEnabled()) { yield* iterator; return }
  try {
    while (true) {
      const next = await scope.run({ sessionId }, () => iterator.next())
      if (next.done) return
      yield next.value
    }
  } finally { await scope.run({ sessionId }, () => iterator.return(undefined as never)) }
}

/** Only known Codex wire fields; no recursive traversal of arguments/payloads. */
function summarizeCodexWire(items: readonly unknown[]) {
  const counts = { items: items.length, textParts: 0, textChars: 0, imageParts: 0, audioParts: 0, urlChars: 0, pdfDataUrls: 0, toolCalls: 0, toolResults: 0, otherParts: 0 }
  function part(value: unknown) {
    if (!value || typeof value !== 'object') { counts.otherParts++; return }
    const item = value as Record<string, unknown>
    switch (item.type) {
      case 'text': case 'input_text': case 'output_text': case 'inputText':
        counts.textParts++; counts.textChars += size(item.text); break
      case 'image': case 'input_image': case 'audio': {
        if (item.type === 'audio') counts.audioParts++; else counts.imageParts++
        const url = item.type === 'input_image' ? item.image_url : item.url
        counts.urlChars += size(url)
        if (typeof url === 'string' && url.startsWith('data:application/pdf;')) counts.pdfDataUrls++
        break
      }
      case 'function_call': counts.toolCalls++; break
      case 'function_call_output': counts.toolResults++; counts.textChars += size(item.output); break
      default: counts.otherParts++
    }
  }
  for (const value of items) {
    const item = value && typeof value === 'object' ? value as Record<string, unknown> : undefined
    if (item?.type === 'message' && Array.isArray(item.content)) for (const content of item.content) part(content)
    else part(value)
  }
  return counts
}

// Exact fixed keys only: never emit external names or inspect schemas/arguments.
const declarationNames = ['listDocumentExtractionConnectors', 'prepareDocumentExtraction', 'startDocumentExtraction', 'readDocumentExtraction', 'proposeOfficeEvidenceFill', 'mcp_search', 'mcp_call'] as const
export function summarizeDocumentTools(declarations: Iterable<{ name: string }>) {
  const presence = Object.fromEntries(declarationNames.map(name => [name, false]))
  let total = 0
  for (const declaration of declarations) {
    total++
    if ((declarationNames as readonly string[]).includes(declaration.name)) presence[declaration.name] = true
  }
  return { total, presence }
}

type GeminiToolWire = {
  tools?: readonly { functionDeclarations?: readonly { name: string }[] }[];
  cachedContent?: string;
  toolConfig?: { functionCallingConfig?: { mode?: string } };
}
function summarizeGeminiTools(request: GeminiToolWire) {
  const inline = summarizeDocumentTools((request.tools ?? []).flatMap(tool => tool.functionDeclarations ?? []))
  const cached = !!request.cachedContent
  return {
    cached, inline,
    declarationSource: cached ? (inline.total ? 'cached_and_inline' : 'cached') : 'inline',
    // This adapter does not create explicit caches. If a reference is ever supplied,
    // its declarations are unknown, not absent. Implicit cache hits retain inline tools.
    effectiveKnown: !cached,
    effective: cached ? null : inline,
    toolChoiceMode: request.toolConfig?.functionCallingConfig?.mode === undefined
      ? 'omitted' : known(request.toolConfig.functionCallingConfig.mode, ['AUTO', 'NONE', 'ANY', 'VALIDATED', 'MODE_UNSPECIFIED']),
  }
}
