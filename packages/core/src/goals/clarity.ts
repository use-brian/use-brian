/**
 * [COMP:goals/clarity] Goal clarity gate — the confirmation guard.
 *
 * The agentic pivot (`docs/plans/task-goal-seeker.md` §12) relocates
 * verifiability from termination-time to confirmation-time: a goal may only run
 * autonomously once its definition of done is unambiguous. This assessor is that
 * guard. At confirm time it judges whether an agent working in the company could
 * recognise the goal as complete (and tell what to actually do); an unclear goal
 * is blocked with a single clarifying question instead of being armed.
 *
 * Lenient by design (err toward clear) and **fail-open** (a model error or an
 * unparseable verdict never blocks a confirmation) — it is a quality guard, not
 * a security gate.
 */
import type { LLMProvider, TokenUsage } from '../providers/types.js'
import { collectStream } from '../providers/accumulator.js'

export type GoalClarityVerdict = {
  clear: boolean
  /** Present only when `clear` is false: one question that would make the goal verifiable. */
  clarifyingQuestion?: string
}

export type AssessGoalClarityInput = {
  /** The goal's outcome — the agent's work target and recognisable end state. */
  outcome: string
  /** Confirming user, for COGS attribution only; the assessment ignores it. */
  userId?: string
}

export type GoalClarityAssessor = (input: AssessGoalClarityInput) => Promise<GoalClarityVerdict>

const CLARITY_SYSTEM_PROMPT = [
  'You review GOAL definitions for an autonomous assistant. A confirmed goal is worked autonomously, iteration after iteration, until it is "done".',
  'Decide ONE thing: could an agent working in this company recognise when this goal is complete, and tell what to actually do?',
  'Return clear=true when the outcome names a concrete deliverable, state, or condition (work being involved is fine).',
  'Return clear=false ONLY when it is too vague to ever recognise as done — open-ended aspirations with no end state ("grow the business", "improve marketing", "misc stuff").',
  'Be LENIENT: err toward clear. Block only the genuinely unverifiable.',
  'When clear=false, give ONE short question that would pin down a recognisable done state.',
  'Respond with ONLY a JSON object: {"clear": true|false, "question": "<question, or empty when clear>"}.',
].join('\n')

/**
 * Construct the assessor over an injected LLM provider (boot passes a Flash-class
 * model). Following the `classifyTopic` injected-port pattern.
 */
export function createGoalClarityAssessor(deps: {
  provider: LLMProvider
  model: string
  /** Optional COGS sink — boot records this under an `overhead:goal-clarity` source. */
  onUsage?: (usage: TokenUsage, userId?: string) => void
}): GoalClarityAssessor {
  return async ({ outcome, userId }) => {
    try {
      const response = await collectStream(
        deps.provider.stream({
          model: deps.model,
          systemPrompt: CLARITY_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: `GOAL OUTCOME: ${outcome}` }],
          maxTokens: 400,
          temperature: 0.1,
        }),
      )
      if (response.usage) deps.onUsage?.(response.usage, userId)
      const text = response.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
      return parseClarityVerdict(text)
    } catch (err) {
      // Fail-open — a model hiccup must never block a confirmation.
      console.error('[goal-clarity] assessment failed; allowing confirm:', err)
      return { clear: true }
    }
  }
}

/**
 * Parse the assessor's JSON verdict. Fail-open: an unparseable response, or one
 * that does not explicitly say `clear:false`, is treated as clear.
 */
export function parseClarityVerdict(text: string): GoalClarityVerdict {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return { clear: true }
  try {
    const obj = JSON.parse(match[0]) as { clear?: unknown; question?: unknown }
    if (obj.clear === false) {
      const q = typeof obj.question === 'string' ? obj.question.trim() : ''
      return { clear: false, clarifyingQuestion: q || 'How will we know this goal is complete?' }
    }
    return { clear: true }
  } catch {
    return { clear: true }
  }
}
