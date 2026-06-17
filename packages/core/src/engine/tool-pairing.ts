/**
 * Tool-use / tool-result pairing invariant helpers.
 *
 * A persisted message history is only valid for the next LLM call if every
 * `tool_use` block in an assistant message has a matching `tool_result`
 * block (with the same `toolUseId`) in the following user message. A single
 * orphan breaks the next request — Gemini, OpenAI, and Anthropic all reject
 * the malformed history with a protocol error.
 *
 * This module enforces the invariant at two places:
 *
 * 1. **Write time** — `synthesizeMissingToolResults` lets the caller fill in
 *    synthetic `is_error: true` stubs for any tool_use that did not receive
 *    a real result (API error mid-execution, stream abort, empty follow-up
 *    turn). Callers flush the resulting paired sequence atomically.
 *
 * 2. **Read time** — `ensureToolResultPairing` is an idempotent repair pass
 *    over an existing message history. It walks the array bidirectionally,
 *    inserting synthetic tool_results for orphan tool_use and stripping
 *    orphan tool_result blocks that don't match any preceding tool_use.
 *    Running it on every API call is the defence-in-depth layer: even if a
 *    past session was persisted corrupt (e.g. by code written before this
 *    fix), the next request will still succeed.
 *
 * Inspired by claude-code's `yieldMissingToolResultBlocks` (query.ts:123)
 * and `ensureToolResultPairing` (messages.ts:5133). See
 * `docs/architecture/engine/query-loop.md` for the invariant write-up.
 */

import type { ContentBlock, Message } from '../providers/types.js'

/** Placeholder body for synthetic tool_results created by the repair pass. */
export const SYNTHETIC_TOOL_RESULT_PLACEHOLDER =
  '[Tool result was lost before persistence. Treat this tool call as failed and do not retry.]'

/**
 * Pull tool_use blocks out of an assistant-role content array.
 * Non-tool_use blocks are ignored.
 */
function collectToolUses(content: ContentBlock[]): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = []
  for (const block of content) {
    if (block.type === 'tool_use') {
      out.push({ id: block.id, name: block.name })
    }
  }
  return out
}

/**
 * Pull tool_use_ids from a set of tool_result blocks.
 */
function collectToolResultIds(content: ContentBlock[]): Set<string> {
  const ids = new Set<string>()
  for (const block of content) {
    if (block.type === 'tool_result') ids.add(block.toolUseId)
  }
  return ids
}

/**
 * Normalise a message's content into a ContentBlock[]. String content
 * (legacy shape) gets wrapped into a single text block.
 */
function asBlocks(content: Message['content']): ContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return content
}

/**
 * For each tool_use in `assistantContent` that does NOT have a matching
 * tool_result in `existingResults`, return a synthetic error result block.
 *
 * Returns ONLY the newly-synthesised blocks. The caller decides how to merge
 * them with the existing results — usually by appending to an accumulator
 * array that will become the next user-role message.
 *
 * `errorMessage` explains why the tool was not executed. Keep it short and
 * action-guiding so the model knows not to retry (e.g. "Stream aborted",
 * "Model fallback triggered", "Tool executor was cancelled").
 */
export function synthesizeMissingToolResults(
  assistantContent: ContentBlock[],
  existingResults: ContentBlock[],
  errorMessage: string,
): ContentBlock[] {
  const have = collectToolResultIds(existingResults)
  const synthetic: ContentBlock[] = []

  for (const toolUse of collectToolUses(assistantContent)) {
    if (have.has(toolUse.id)) continue
    synthetic.push({
      type: 'tool_result',
      toolUseId: toolUse.id,
      name: toolUse.name,
      content: errorMessage,
      isError: true,
    })
  }

  return synthetic
}

/**
 * Bidirectional repair of a message array so that every tool_use has a
 * matching tool_result and every tool_result references a tool_use that
 * actually exists earlier in the conversation.
 *
 * Idempotent: a history that's already well-formed passes through unchanged.
 *
 * Rules:
 * - System messages are passed through untouched.
 * - Fully-empty assistant rows (`content: []`) are dropped. These are
 *   artefacts of legacy turn_complete events that fired with no text and
 *   no tool_use (Gemini thinking-burnt turns before the empty-response
 *   recovery covered turn 0 — see query-loop.ts EMPTY_RETRY_PLAN). They
 *   carry no signal and break role-alternation when sent back to the
 *   provider, so we self-heal on read.
 * - For every assistant message with tool_use blocks, the NEXT non-system
 *   message must carry matching tool_result blocks. If some are missing, a
 *   synthetic user-role message of tool_results is inserted immediately
 *   after the assistant message (or the missing blocks are added to an
 *   existing following user message if one exists).
 * - Tool_result blocks whose toolUseId does not match any earlier,
 *   not-yet-resolved tool_use are stripped (they're dangling pointers).
 * - If stripping tool_results empties a user message, it's dropped rather
 *   than left as a content-less row.
 *
 * This function operates on a shallow copy; the input array is not mutated.
 * Inner message objects are only cloned when their content actually changes.
 */
export function ensureToolResultPairing(messages: Message[]): Message[] {
  // Walk forward, tracking tool_uses that have not yet been paired with a
  // tool_result in a later message. When we hit an assistant turn with
  // tool_use, those ids become "open" until the next message resolves them.
  const out: Message[] = []

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]

    if (msg.role === 'system') {
      out.push(msg)
      continue
    }

    if (msg.role === 'assistant') {
      const blocks = asBlocks(msg.content)
      const openIds = new Set(collectToolUses(blocks).map((t) => t.id))

      // No tool_use → nothing to repair. Preserve the original message
      // object (including string-shaped content) untouched, *unless* the
      // content is a fully-empty array (legacy artefact of an empty
      // turn_complete event). Empty rows carry no signal and break
      // role-alternation when sent to the provider, so drop them.
      if (openIds.size === 0) {
        if (Array.isArray(msg.content) && msg.content.length === 0) continue
        out.push(msg)
        continue
      }

      out.push({ role: 'assistant', content: blocks })

      // Look at the next non-system message.
      let next = messages[i + 1]
      let nextIdx = i + 1
      while (next && next.role === 'system') {
        out.push(next)
        nextIdx += 1
        next = messages[nextIdx]
      }

      const toolUses = collectToolUses(blocks)
      const resolvedResults: ContentBlock[] = []

      if (next && next.role === 'user') {
        const nextBlocks = asBlocks(next.content)
        // Keep: tool_result blocks that match an open tool_use, plus any
        // non-tool_result blocks (text/image — these may exist in rare
        // edge cases but will be preserved intact). Strip orphan results.
        const keptBlocks: ContentBlock[] = []
        for (const b of nextBlocks) {
          if (b.type !== 'tool_result') {
            keptBlocks.push(b)
            continue
          }
          if (openIds.has(b.toolUseId)) {
            keptBlocks.push(b)
            resolvedResults.push(b)
          }
          // else: orphan tool_result, strip
        }

        // Append synthetic tool_results for any tool_use still missing.
        const synthetic = synthesizeMissingToolResults(
          blocks,
          resolvedResults,
          SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
        )
        for (const s of synthetic) keptBlocks.push(s)

        if (keptBlocks.length > 0) {
          out.push({ role: 'user', content: keptBlocks })
        }
        // else: user message became empty after stripping orphan results,
        // drop it entirely. This is safe because the preceding assistant
        // message's tool_uses are now all answered by the synthesised blocks
        // we just pushed (or there were no tool_uses to begin with, in which
        // case the empty user message was already noise).
        i = nextIdx
      } else {
        // No following user message (or it was a system message that we've
        // already forwarded). Synthesise results for every open tool_use and
        // append them as a fresh user-role message.
        const synthetic = toolUses.map<ContentBlock>((t) => ({
          type: 'tool_result',
          toolUseId: t.id,
          name: t.name,
          content: SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
          isError: true,
        }))
        if (synthetic.length > 0) {
          out.push({ role: 'user', content: synthetic })
        }
        // Don't advance i past next — we want the loop to reach the next
        // message naturally.
      }

      continue
    }

    // User-role message with no preceding assistant-with-tool_use. Strip
    // orphan tool_result blocks (they point at nothing).
    const blocks = asBlocks(msg.content)
    const hasToolResults = blocks.some((b) => b.type === 'tool_result')
    if (!hasToolResults) {
      out.push(msg)
      continue
    }
    const keptBlocks = blocks.filter((b) => b.type !== 'tool_result')
    if (keptBlocks.length > 0) {
      out.push({ role: 'user', content: keptBlocks })
    }
    // else: drop empty message
  }

  return out
}

/**
 * Strip tool_use blocks that have no `providerSignature` (plus their paired
 * tool_result blocks), so legacy pre-signature rows persisted before the fix
 * don't trigger Gemini 3.x's "Function call is missing a thought_signature"
 * 400 on the next turn.
 *
 * This is a one-way compatibility shim: any tool_use persisted from this
 * point forward carries a signature. Only rows from before that change are
 * affected, and dropping them is safe because the assistant's accompanying
 * text (if any) is preserved, and the tool's actual output was already
 * summarised into that text by the original response.
 *
 * Idempotent: histories with all-signed tool_uses pass through unchanged.
 */
export function stripUnsignedToolUses(messages: Message[]): Message[] {
  const droppedIds = new Set<string>()
  const out: Message[] = []

  for (const msg of messages) {
    const blocks = asBlocks(msg.content)

    if (msg.role === 'assistant') {
      const kept: ContentBlock[] = []
      let changed = false
      for (const b of blocks) {
        if (b.type === 'tool_use' && !b.providerSignature) {
          droppedIds.add(b.id)
          changed = true
          continue
        }
        kept.push(b)
      }
      if (kept.length > 0) {
        out.push(changed ? { role: 'assistant', content: kept } : msg)
      }
      // else: assistant turn was nothing but unsigned tool_use — drop it
      continue
    }

    if (msg.role === 'user') {
      const kept: ContentBlock[] = []
      let changed = false
      for (const b of blocks) {
        if (b.type === 'tool_result' && droppedIds.has(b.toolUseId)) {
          changed = true
          continue
        }
        kept.push(b)
      }
      if (kept.length > 0) {
        out.push(changed ? { role: 'user', content: kept } : msg)
      }
      // else: user turn was nothing but orphan tool_results — drop it
      continue
    }

    out.push(msg)
  }

  return out
}
