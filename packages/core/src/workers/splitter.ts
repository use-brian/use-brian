/**
 * Pre-flight classifier for automatic parallel worker delegation.
 *
 * Determines whether a user message requires multiple independent research
 * tasks that can be run in parallel. Uses the Standard-tier model (Gemini
 * 3.1 Flash Lite) for the classification — the decision itself is cheap
 * (~200ms, ~50 tokens out). Standard-tier per the bucketed routing rules
 * in docs/architecture/platform/cost-and-pricing.md → Model routing
 * (extraction / classification / structured-output bucket).
 */

import type { LLMProvider, TokenUsage } from '../providers/types.js'
import { collectStream } from '../providers/accumulator.js'

const CLASSIFIER_SYSTEM_PROMPT = `You decide if a user message requires parallel independent research.
Return JSON only. No explanation.

Split when ALL of these are true:
1. The task requires 2-3 genuinely INDEPENDENT topics
2. Each topic requires a separate search or lookup
3. The topics do NOT depend on each other (can be researched simultaneously)

Do NOT split when:
- Simple question or single lookup
- Follow-up on previous conversation context
- The topics are dependent (need result A before searching B)
- Message is short and casual
- Message is a greeting or acknowledgment
- A SINGLE broad search can cover the request (e.g. "best restaurants in Tokyo" = 1 search, not 10 individual restaurant searches)

RULES:
- Maximum 3 tasks. If you think of more, merge related ones.
- Each task prompt = 1 web search. Example: "Search for top rated restaurants in Osaka with price range info. Return top 5 with name, cuisine, and price range."
- Do NOT enumerate individual items as separate tasks (e.g. do NOT create one task per restaurant or per attraction).
- Do NOT write open-ended prompts like "research everything about X."
- Only write deeper prompts when the user EXPLICITLY asks for thorough/deep/comprehensive research.
- Each task prompt must have a clear end condition so the worker knows when to stop.

If split: {"split":true,"tasks":["self-contained research prompt 1","..."]}
If not: {"split":false}`

const MIN_MESSAGE_LENGTH = 40
const CLASSIFIER_MODEL = 'gemini-3.1-flash-lite'

export type SplitOptions = {
  provider: LLMProvider
  message: string
  minMessageLength?: number
  /**
   * Background-lane model. Callers with boot context (the API routes) pass an
   * id already checked servable against the configured providers; the default
   * keeps standalone/test use on the historical literal.
   */
  model?: string
}

export type SplitResult = {
  /** Parallel task prompts, or null when splitting was not warranted. */
  tasks: string[] | null
  /** Token usage from the classifier call — null when no call was made. */
  usage: TokenUsage | null
  /** Model used for the call — null when no call was made. */
  model: string | null
}

/**
 * Classify whether a user message should be split into parallel sub-tasks.
 *
 * Returns `tasks` (array of self-contained task prompts, or null if no split
 * is needed) together with the token usage + model so the caller can record
 * the classifier cost as `overhead:splitter`.
 */
export async function classifySplit(options: SplitOptions): Promise<SplitResult> {
  const model = options.model ?? CLASSIFIER_MODEL
  const { provider, message, minMessageLength = MIN_MESSAGE_LENGTH } = options

  // Short messages never need splitting — short-circuit before the LLM call.
  if (message.length <= minMessageLength) return { tasks: null, usage: null, model: null }

  try {
    const stream = provider.stream({
      model: model,
      systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: message }],
      maxTokens: 512,
      temperature: 0,
    })

    const response = await collectStream(stream)
    const text = response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('')

    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return { tasks: null, usage: response.usage, model: model }
    }

    const parsed = JSON.parse(jsonMatch[0])
    if (!parsed.split || !Array.isArray(parsed.tasks) || parsed.tasks.length < 2) {
      return { tasks: null, usage: response.usage, model: model }
    }

    return { tasks: parsed.tasks as string[], usage: response.usage, model: model }
  } catch {
    // Any failure in classification → safe default, no split. Usage is lost
    // because the stream didn't complete — caller records nothing.
    return { tasks: null, usage: null, model: null }
  }
}
