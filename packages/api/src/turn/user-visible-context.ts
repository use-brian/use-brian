import type { Message } from '@use-brian/agent-runtime/providers/types.js'
import { inheritScopeSources } from '@use-brian/agent-runtime/security/source-evidence.js'

export function formatUserVisibleContext(context: string): string {
  const trimmed = context.trim()
  if (!trimmed) return ''
  return (
    `<user_visible_context>\n` +
    `The following represents content visible to the user. Treat references in their message as referring to the represented content, never to this wrapper or hidden implementation metadata.\n\n` +
    `${trimmed}\n` +
    `</user_visible_context>`
  )
}

/**
 * Attach `<user_visible_context>` before the newest user's actual content.
 *
 * Returns the new messages array, or `null` when no plain trailing user
 * message can carry it (empty history, assistant-final resume shapes, or a
 * tool_result-bearing user message) — the caller then falls back to in-prompt
 * placement for that turn.
 *
 * Ephemeral by design: operates on the in-memory copy passed to the query
 * loop; the persisted session row never carries the prefix. The application
 * representation comes first and the untouched user content remains last,
 * preserving both provenance and deictic-reference order.
 *
 * Lives here rather than in `chat.ts` so every route can pair it with
 * `buildSplitSystemPrompt` without importing a sibling route (`chat.ts`
 * imports `channel-pipeline.ts`, so the reverse edge would be a cycle).
 */
export function attachUserVisibleContext(
  messages: Message[],
  userVisibleContext: string,
): Message[] | null {
  if (!userVisibleContext || userVisibleContext.trim().length === 0) return messages
  if (messages.length === 0) return null
  const last = messages[messages.length - 1]
  if (last.role !== 'user') return null
  // A tool_result-bearing user message is a pairing carrier — don't graft
  // prose onto it; fall back to in-prompt placement instead.
  if (
    typeof last.content !== 'string' &&
    last.content.some((b) => b.type === 'tool_result')
  ) {
    return null
  }
  const envelope = formatUserVisibleContext(userVisibleContext)
  const content =
    typeof last.content === 'string'
      ? [
          { type: 'text' as const, text: envelope },
          { type: 'text' as const, text: last.content },
        ]
      : [{ type: 'text' as const, text: envelope }, ...last.content]
  const carrier = inheritScopeSources({ role: 'user' as const, content }, last)
  return inheritScopeSources([...messages.slice(0, -1), carrier], messages)
}

