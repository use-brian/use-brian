/**
 * Pre-flight classifier for adaptive research-mode entry.
 *
 * Decides whether a user message warrants research mode — the same flag the
 * web composer's manual toggle sets. When true, the chat / channel route
 * upgrades the model (Pro 3.1), raises the per-turn budget, and (on chat)
 * spins up worker delegation. Skipped for short messages and for callers
 * outside the research-eligible plan tier.
 *
 * Uses Gemini 3.1 Flash Lite — cheap classifier, JSON-only output. Mirrors
 * the pattern in `splitter.ts`.
 *
 * [COMP:workers/research-classifier]
 */

import type { LLMProvider, TokenUsage } from '../providers/types.js'
import { collectStream } from '../providers/accumulator.js'

const CLASSIFIER_SYSTEM_PROMPT = `You decide if a user message warrants deep research mode.
Return JSON only. No explanation.

Research mode is ON when the request needs DEEP INVESTIGATION — multi-source web synthesis,
comparative analysis across products / papers / events, in-depth competitive scans, structured
reports, anything where the user is asking the assistant to act like an analyst.

Research mode is OFF for:
- Greetings, acknowledgments, casual chat
- Simple factual lookups answerable in one step ("what time is it in Tokyo")
- Quick how-to questions
- Follow-ups that reference prior conversation context
- Tasks the assistant can do with its own memory + a couple of tool calls
- Messages under ~10 words

If research warranted: {"research":true,"reason":"<one short phrase, lower-case>"}
Otherwise: {"research":false}`

const MIN_MESSAGE_LENGTH = 40
const CLASSIFIER_MODEL = 'gemini-3.1-flash-lite'

export type ResearchClassifyOptions = {
  provider: LLMProvider
  message: string
  /** Override the short-message bypass; defaults to 40 chars. */
  minMessageLength?: number
}

export type ResearchClassifyResult = {
  /** Whether the classifier flagged the message as needing research mode. */
  research: boolean
  /** Optional one-phrase reason the classifier emitted (telemetry only). */
  reason: string | null
  /** Token usage from the classifier call — null when no call was made. */
  usage: TokenUsage | null
  /** Model used for the call — null when no call was made. */
  model: string | null
}

/**
 * Classify whether a user message should automatically enter research mode.
 *
 * Returns `research: true` only when the model is confident. Any error or
 * malformed JSON degrades to `research: false` — the safe default keeps the
 * cheap path on. Caller is responsible for plan / quota gating; this
 * classifier just answers the intent question.
 */
export async function classifyResearchIntent(
  options: ResearchClassifyOptions,
): Promise<ResearchClassifyResult> {
  const { provider, message, minMessageLength = MIN_MESSAGE_LENGTH } = options

  // Short messages never warrant research — short-circuit before the LLM call.
  if (message.length <= minMessageLength) {
    return { research: false, reason: null, usage: null, model: null }
  }

  try {
    const stream = provider.stream({
      model: CLASSIFIER_MODEL,
      systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: message }],
      maxTokens: 128,
      temperature: 0,
    })

    const response = await collectStream(stream)
    const text = response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('')

    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return { research: false, reason: null, usage: response.usage, model: CLASSIFIER_MODEL }
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      research?: unknown
      reason?: unknown
    }
    if (parsed.research !== true) {
      return { research: false, reason: null, usage: response.usage, model: CLASSIFIER_MODEL }
    }
    return {
      research: true,
      reason: typeof parsed.reason === 'string' ? parsed.reason : null,
      usage: response.usage,
      model: CLASSIFIER_MODEL,
    }
  } catch {
    // Any failure → safe default, no research. Usage is lost because the
    // stream didn't complete; caller records nothing.
    return { research: false, reason: null, usage: null, model: null }
  }
}
