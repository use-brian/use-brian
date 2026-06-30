/**
 * [COMP:goals/verifier] Adversarial goal-completion verifier (§12).
 *
 * The agentic-termination guard: when an agent claims a goal is done, this
 * verifier is prompted to DISPROVE the claim against the goal's outcome (the
 * criterion, `docs/plans/task-goal-seeker.md` §12 — the outcome IS the bar) plus
 * read-only evidence. It gates the `done` transition — only a claim it cannot
 * refute stamps the verified-done marker the `verify` leaf reads.
 *
 * FAIL-CLOSED (the deliberate opposite of the clarity gate's fail-open): a model
 * error, an unparseable verdict, or any doubt resolves to NOT verified
 * (refuted -> continue). A goal must never be falsely completed; an
 * unverifiable claim simply keeps the goal working until budget.
 */
import type { LLMProvider, TokenUsage } from '../providers/types.js'
import { collectStream } from '../providers/accumulator.js'

export type GoalVerifyVerdict = {
  verified: boolean
  /** Present when not verified: why the claim was refuted (fed back to the agent). */
  refutation?: string
}

export type VerifyGoalInput = {
  /** The goal's outcome — the criterion the claim is judged against. */
  outcome: string
  /** The agent's stated reason it believes the goal is complete ("because X"). */
  because: string
  /** Optional read-only evidence (host state, recent work) for the verifier. */
  evidence?: string
  /** Confirming user, for COGS attribution only; the verdict ignores it. */
  userId?: string
}

export type GoalVerifier = (input: VerifyGoalInput) => Promise<GoalVerifyVerdict>

const VERIFY_SYSTEM_PROMPT = [
  'You are a strict, adversarial verifier for an autonomous assistant. An agent claims it has COMPLETED a goal. Your job is to DISPROVE that claim.',
  "You are given the goal OUTCOME (the bar for done), the agent's stated reason (\"because\"), and any EVIDENCE.",
  'Default to NOT verified. Return verified=true ONLY if the outcome is unambiguously achieved by the evidence + reason — no gaps, no "probably", no unsupported assertion.',
  'If anything the outcome requires is missing, unproven, or merely asserted without evidence, return verified=false with a SHORT refutation naming exactly what is not yet done.',
  'Respond with ONLY a JSON object: {"verified": true|false, "refutation": "<what is missing, or empty when verified>"}.',
].join('\n')

export function createGoalVerifier(deps: {
  provider: LLMProvider
  model: string
  /** Optional COGS sink — boot records this under an `overhead:goal-verify` source. */
  onUsage?: (usage: TokenUsage, userId?: string) => void
}): GoalVerifier {
  return async ({ outcome, because, evidence, userId }) => {
    try {
      const response = await collectStream(
        deps.provider.stream({
          model: deps.model,
          systemPrompt: VERIFY_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: buildVerifyPrompt(outcome, because, evidence) }],
          maxTokens: 600,
          temperature: 0.1,
        }),
      )
      if (response.usage) deps.onUsage?.(response.usage, userId)
      const text = response.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
      return parseVerifyVerdict(text)
    } catch (err) {
      // FAIL-CLOSED — a model hiccup must never falsely complete a goal.
      console.error('[goal-verify] verification failed; treating as NOT verified:', err)
      return {
        verified: false,
        refutation: 'Could not verify completion (verifier unavailable); keep working.',
      }
    }
  }
}

function buildVerifyPrompt(outcome: string, because: string, evidence?: string): string {
  return [
    `GOAL OUTCOME (the bar for "done"): ${outcome}`,
    `AGENT'S CLAIM (why it thinks it's done): ${because}`,
    evidence ? `EVIDENCE:\n${evidence}` : 'EVIDENCE: (none provided)',
    '',
    'Disprove the claim if you can. Respond with ONLY {"verified": true|false, "refutation": "..."}.',
  ].join('\n')
}

/**
 * Parse the verifier's JSON verdict. FAIL-CLOSED: anything that is not an
 * explicit `verified:true` is treated as not verified (with a refutation).
 */
export function parseVerifyVerdict(text: string): GoalVerifyVerdict {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return { verified: false, refutation: 'Verifier returned no parseable verdict.' }
  try {
    const obj = JSON.parse(match[0]) as { verified?: unknown; refutation?: unknown }
    if (obj.verified === true) return { verified: true }
    const r = typeof obj.refutation === 'string' ? obj.refutation.trim() : ''
    return { verified: false, refutation: r || 'Completion not established by the evidence.' }
  } catch {
    return { verified: false, refutation: 'Verifier returned malformed output.' }
  }
}
