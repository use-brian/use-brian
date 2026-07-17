/**
 * Empty-turn synthesis: salvage an answer when the coordinator
 * thought-burnt into silence.
 *
 * Background — surfaced 2026-05-27 (Anson / GRI / session 0ab76e65).
 * Gemini 3.1 Pro Preview (the Research-mode coordinator model) emits
 * thinking-only turns under some prompts: `stopReason=end_turn` with
 * no text and no tool_use. The query-loop's EMPTY_RETRY_PLAN tries
 * two recovery turns (default + thinkingLevel='low'); when both also
 * thought-burn the chat route falls into the "final turn was empty"
 * branch and used to ship a canned "I ran out of tool calls" banner
 * — misleading copy that pointed at the wrong lever (the user's
 * tool budget was nowhere near exhausted).
 *
 * This helper is the better fallback. Flash runs in one of two modes:
 *
 *   1. Evidence mode — the buffer carries at least one successful
 *      tool result (worker findings, webSearch, urlReader, …). Flash
 *      composes the answer the coordinator skipped using that
 *      evidence as ground truth.
 *
 *   2. No-evidence mode — the model thought-burnt before calling any
 *      tool (or every tool errored). Flash writes a brief reply that
 *      names *the specific thing it would need* to answer (a missing
 *      connector, a data source, more context). This is the gap that
 *      previously fell through to the canned banner — the model
 *      should always be able to compose a human-readable response,
 *      even when it has nothing in the buffer.
 *
 * Compared to `_recovery-message.ts`: that helper assumes side
 * effects shipped and tells the user to CHECK rather than retry. This
 * one is for empty turns where nothing happened — there's nothing to
 * check, only an answer to compose.
 *
 * Always Flash so a Pro outage doesn't take the synthesis with it.
 * Returns `null` only when Flash itself errors or yields empty text —
 * never escalate a model hiccup into a worse UX than the canned
 * banner.
 */

import type { ContentBlock, LLMProvider, TokenUsage } from '@use-brian/core'
import { collectStream } from '@use-brian/core'

export type EmptyTurnSynthesisInputTurn = {
  content: ContentBlock[]
  toolResults: ContentBlock[]
}

export type EmptyTurnSynthesisParams = {
  provider: LLMProvider
  pendingAssistantTurns: EmptyTurnSynthesisInputTurn[]
  userText: string
  channelType: string
}

export type EmptyTurnSynthesisResult = {
  text: string
  usage: TokenUsage | null
  model: 'gemini-flash'
}

const SYNTHESIS_MODEL = 'gemini-flash' as const

/** Cap each tool result snippet — Flash needs signal, not the full payload. */
const MAX_RESULT_SNIPPET_CHARS = 1500

/** Soft cap on the number of tool results we feed Flash. */
const MAX_TOOL_BULLETS = 12

const SYSTEM_PROMPT = [
  'You are a synthesis assistant. The primary model thought-burnt and failed to produce a reply — write the answer the user was waiting for on its behalf.',
  '',
  'You will be given:',
  '  - The user\'s last message (in any language).',
  '  - A list of tool calls that already ran and their results — your evidence (may be empty).',
  '',
  'Pick the mode based on whether toolEvidence has entries.',
  '',
  'EVIDENCE MODE — toolEvidence has at least one entry:',
  '  - Write the reply the user is waiting for, grounded in the evidence.',
  '  - Quote concrete details from the tool results (URLs, prices, names, times) — do not invent specifics that are not in the evidence.',
  '  - If the evidence does not contain a clean answer, say so honestly in one sentence and suggest one specific follow-up the user can ask.',
  '',
  'NO-EVIDENCE MODE — toolEvidence is empty:',
  '  - The model never gathered any data for this question.',
  '  - Write a brief reply (1-2 sentences) that names the specific thing required to answer: a connected tool, a data source, a file, or a clarification.',
  '  - Be concrete. "I\'d need GitHub connected to pull yesterday\'s commits by author" beats "I can\'t answer that".',
  '  - Do NOT apologise generically. Do NOT tell the user to "try again" with the same wording.',
  '',
  'Hard rules in both modes:',
  '  - Reply in the SAME LANGUAGE the user used.',
  '  - No headings, no markdown lists unless the user explicitly asked for a list.',
  '  - Keep it under 200 words.',
].join('\n')

/**
 * Pull every successful tool call + result snippet out of the buffer.
 * May return an empty array — that's the no-evidence path and Flash
 * is still called so it can compose a "what I'd need to answer" reply.
 */
function collectEvidence(
  turns: EmptyTurnSynthesisInputTurn[],
): Array<{ name: string; input: Record<string, unknown>; resultSnippet: string }> {
  const evidence: Array<{ name: string; input: Record<string, unknown>; resultSnippet: string }> = []
  for (const turn of turns) {
    const resultById = new Map<string, ContentBlock>()
    for (const block of turn.toolResults) {
      if (block.type !== 'tool_result') continue
      resultById.set(block.toolUseId, block)
    }
    for (const block of turn.content) {
      if (block.type !== 'tool_use') continue
      const result = resultById.get(block.id)
      if (!result || result.type !== 'tool_result') continue
      if (result.isError === true) continue
      const content = typeof result.content === 'string' ? result.content : ''
      if (!content) continue
      evidence.push({
        name: block.name,
        input: block.input,
        resultSnippet: content.slice(0, MAX_RESULT_SNIPPET_CHARS),
      })
      if (evidence.length >= MAX_TOOL_BULLETS) return evidence
    }
  }
  return evidence
}

export async function composeEmptyTurnSynthesis(
  params: EmptyTurnSynthesisParams,
): Promise<EmptyTurnSynthesisResult | null> {
  const evidence = collectEvidence(params.pendingAssistantTurns)

  const payload = JSON.stringify(
    {
      userMessage: params.userText.slice(0, 1000),
      toolEvidence: evidence.map((a) => ({
        tool: a.name,
        input: a.input,
        result: a.resultSnippet,
      })),
    },
    null,
    2,
  )

  try {
    const response = await collectStream(
      params.provider.stream({
        model: SYNTHESIS_MODEL,
        systemPrompt: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: payload }],
        // `gemini-flash` resolves to `gemini-3-flash-preview`, which thinks on
        // every turn, and Gemini bills thinking tokens against `maxOutputTokens`
        // (outputTokens = candidatesTokenCount + thoughtsTokenCount). With the
        // old `maxTokens: 600` and no thinking cap, default-level thinking ate
        // ~570 of the budget and the ≤200-word reply was truncated mid-sentence
        // and persisted that way (incident 2026-06-04, session 6ca76404:
        // "…telling me your name and" with nothing after). Pin thinking LOW
        // (the task is simple synthesis, not deep reasoning) and give the
        // budget real headroom so the reply always completes under the cap.
        thinkingLevel: 'low',
        maxTokens: 2048,
        temperature: 0.3,
      }),
    )
    const text = response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
    if (text.length === 0) return null
    return { text, usage: response.usage, model: SYNTHESIS_MODEL }
  } catch (err) {
    console.warn(
      `[${params.channelType}] composeEmptyTurnSynthesis failed; falling back to canned banner:`,
      err,
    )
    return null
  }
}
