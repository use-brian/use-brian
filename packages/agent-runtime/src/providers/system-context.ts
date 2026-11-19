import type { Message } from './types.js'

/** System-only context shared by every provider, never a user-message prefix. */
export type SystemContext = {
  systemPrompt: string
  runtimeSystemContext?: string
  /**
   * Text of the `role: 'system'` rows found in the conversation array — the
   * compaction summary `runProactiveCompaction` prepends, the context-budget
   * wrapper's `[N earlier message(s) omitted…]` breadcrumb, a pre-migration-049
   * synthetic boundary row. No adapter renders a system-role message as a
   * conversation content, so the adapter hoists them here via
   * `extractHistorySystemContext` and they ride the system channel as one
   * `<compacted_history>` part. Before 2026-09-17 Gemini and Anthropic dropped
   * these rows outright, so the compaction summary never reached a hosted turn.
   * See docs/architecture/context-engine/compaction.md → "Summary delivery".
   */
  historySystemContext?: string[]
}

/** Fixed lead line inside `<compacted_history>` so the model reads the block as conversation, not private metadata. */
export const COMPACTED_HISTORY_LEAD =
  'Earlier turns of this conversation were compacted out of the transcript below. The user took part in them; treat this as conversation history.'

/**
 * Collect the text of every `role: 'system'` message in the conversation
 * array, in order, skipping empty ones. String content is taken verbatim;
 * block content contributes its text blocks joined by newlines.
 */
export function extractHistorySystemContext(messages: readonly Message[]): string[] {
  const out: string[] = []
  for (const msg of messages) {
    if (msg.role !== 'system') continue
    const text = typeof msg.content === 'string'
      ? msg.content
      : msg.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n')
    if (text.trim().length > 0) out.push(text)
  }
  return out
}

/**
 * Preserve the stable bytes; wrap runtime addenda without changing provenance.
 * Order is `[stable, <compacted_history>, <runtime_context>]`: history changes
 * only at a compaction, so keeping it ahead of the per-turn runtime section
 * leaves it inside the provider's cacheable prefix between firings — and
 * outside the `# Runtime context boundary` that heads the runtime section, so
 * "what did we decide earlier" may resolve against it.
 */
export function systemContextParts(context: SystemContext): string[] {
  const parts = context.systemPrompt ? [context.systemPrompt] : []
  const history = (context.historySystemContext ?? []).filter((t) => t.trim().length > 0)
  if (history.length > 0) {
    parts.push(`<compacted_history>\n${COMPACTED_HISTORY_LEAD}\n\n${history.join('\n\n')}\n</compacted_history>`)
  }
  if (context.runtimeSystemContext?.trim()) {
    parts.push(`<runtime_context>\n${context.runtimeSystemContext}\n</runtime_context>`)
  }
  return parts
}

/** For single-string transports and complete prompt accounting/diagnostics. */
export function renderSystemContext(context: SystemContext): string {
  return systemContextParts(context).join('\n\n')
}
