/**
 * Context-aware recovery message composer.
 *
 * Called from a route's catch handler when `queryLoop` throws AFTER one
 * or more tools already shipped side effects (e.g. Gemini stream went
 * idle on the post-tool-result turn — the documented Meta-flake mode
 * that surfaces in the audit log as a `posted-reply` row with no
 * matching success event, and to the user as "Something went wrong").
 *
 * The hard-coded "Something went wrong. Please try again." string was
 * actively harmful when tools had already run: the operator would
 * re-send the original instruction, duplicating the side effect (e.g.
 * two replies posted to the same Threads parent, or a calendar event
 * created twice).
 *
 * This helper inspects the turn buffer the route already maintains for
 * paired flush, finds tool calls that completed successfully, and asks
 * `gemini-flash` to compose a one-or-two-sentence message that:
 *
 *   1. Names what the assistant actually did (so the operator knows
 *      the action shipped).
 *   2. Says we couldn't finish writing the response.
 *   3. Tells them to *check* — not retry — because retrying would
 *      duplicate the side effect.
 *
 * Returns `null` when no successful tool calls are in the buffer
 * (in which case the caller should keep its existing generic message —
 * a retry there is safe). Returns `null` on any synthesis failure too,
 * so a Flash hiccup never escalates into a worse user experience than
 * the original generic.
 *
 * Always uses `gemini-flash` (the "standard" alias in
 * `packages/api/src/model-resolution.ts`) regardless of the user's
 * selected chat model — recovery summarisation doesn't need pro
 * reasoning and we don't want a Pro outage to also break the recovery
 * path. Cost is attributed via `overhead:recovery-message`.
 *
 * See `docs/architecture/engine/query-loop.md` → "Recovery message".
 */

import type { ContentBlock, LLMProvider, TokenUsage } from '@use-brian/core'
import { collectStream } from '@use-brian/core'

/** The minimum buffered-turn shape this helper consumes. */
export type RecoveryPendingTurn = {
  content: ContentBlock[]
  toolResults: ContentBlock[]
}

export type ComposeRecoveryMessageParams = {
  provider: LLMProvider
  /** The route's pending-turn buffer at the moment the loop bailed. */
  pendingAssistantTurns: RecoveryPendingTurn[]
  /** What the user originally said. Drives language matching + framing. */
  userText: string
  /** Channel name for log lines — purely diagnostic. */
  channelType: string
}

export type ComposeRecoveryMessageResult = {
  text: string
  usage: TokenUsage | null
  /** Pinned to `gemini-flash` so callers can attribute overhead correctly. */
  model: 'gemini-flash'
}

/** Always-Flash so a Pro outage doesn't take the recovery path with it. */
const RECOVERY_MODEL = 'gemini-flash' as const

/**
 * Cap each tool_result snippet sent to Flash. The full Calendar /
 * Notion / MCP responses can be many KB; Flash only needs enough
 * signal to mention the action ("updated Lunch with Ray to 12-2"),
 * not replay the payload. Keeps the synthesis call cheap.
 */
const MAX_RESULT_SNIPPET_CHARS = 300

/** Soft cap on input bullets so a many-tool turn doesn't balloon the prompt. */
const MAX_TOOL_BULLETS = 8

const SYSTEM_PROMPT = [
  'You are writing a SHORT recovery notice for a chat user whose assistant performed one or more actions on their behalf, then failed before composing the normal reply.',
  '',
  'You will be given:',
  '  - The user\'s last message (in any language).',
  '  - A list of actions the assistant successfully completed.',
  '',
  'Write 1-2 sentences in the SAME LANGUAGE the user used. Cover:',
  '  1. State the actions that DID happen, briefly and concretely.',
  '  2. Note that you couldn\'t finish writing the full reply.',
  '  3. Tell the user to CHECK or ASK if it worked — do NOT tell them to repeat the same instruction (repeating would do the action twice).',
  '',
  'Hard rules:',
  '  - Output ONLY the message body. No headings, no markdown, no quotes around it.',
  '  - Do not invent details that are not in the action list.',
  '  - Do not apologise more than once.',
  '  - Match the user\'s language exactly. If they wrote Cantonese, reply in Cantonese; if English, English; if Japanese, Japanese.',
  '  - Keep under 60 words / 200 characters.',
].join('\n')

/**
 * Walk the buffer and collect (tool name, input, result-snippet) for
 * every successful tool call. Returns `null` when there's nothing to
 * narrate — the route should fall back to its generic error.
 */
function collectSuccessfulActions(
  turns: RecoveryPendingTurn[],
): Array<{ name: string; input: Record<string, unknown>; resultSnippet: string }> {
  const actions: Array<{ name: string; input: Record<string, unknown>; resultSnippet: string }> = []
  for (const turn of turns) {
    // Index this turn's tool_results by the tool_use id so the lookup
    // is O(n) per turn rather than O(n²). The pipeline guarantees
    // toolUseId is set on every result it pairs.
    const resultById = new Map<string, ContentBlock>()
    for (const block of turn.toolResults) {
      if (block.type !== 'tool_result') continue
      resultById.set(block.toolUseId, block)
    }
    for (const block of turn.content) {
      if (block.type !== 'tool_use') continue
      const result = resultById.get(block.id)
      if (!result || result.type !== 'tool_result') continue
      // Skip explicit error results — narrating "I tried but failed" is
      // worse than the generic "something went wrong" because it implies
      // the side effect did NOT happen, which we can't actually
      // guarantee from the tool's perspective. The generic message keeps
      // the option to retry open.
      if (result.isError === true) continue
      actions.push({
        name: block.name,
        input: block.input,
        resultSnippet: result.content.slice(0, MAX_RESULT_SNIPPET_CHARS),
      })
      if (actions.length >= MAX_TOOL_BULLETS) return actions
    }
  }
  return actions
}

export async function composeRecoveryMessage(
  params: ComposeRecoveryMessageParams,
): Promise<ComposeRecoveryMessageResult | null> {
  const actions = collectSuccessfulActions(params.pendingAssistantTurns)
  if (actions.length === 0) return null

  // Build the user-side payload. JSON-encoded so the model sees a
  // structured action list rather than free text — easier for it to
  // narrate accurately in the user's language.
  const payload = JSON.stringify(
    {
      userMessage: params.userText.slice(0, 500),
      successfulActions: actions.map((a) => ({
        tool: a.name,
        input: a.input,
        resultSummary: a.resultSnippet,
      })),
    },
    null,
    2,
  )

  try {
    const response = await collectStream(
      params.provider.stream({
        model: RECOVERY_MODEL,
        systemPrompt: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: payload }],
        maxTokens: 200,
        temperature: 0.3,
      }),
    )
    const text = response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
    if (text.length === 0) return null
    return { text, usage: response.usage, model: RECOVERY_MODEL }
  } catch (err) {
    // Best-effort path — never let a Flash hiccup bubble out as a
    // second crash. Caller falls back to the generic "Something went
    // wrong" string, which is no worse than the pre-helper baseline.
    console.warn(
      `[${params.channelType}] composeRecoveryMessage failed; falling back to generic:`,
      err,
    )
    return null
  }
}
