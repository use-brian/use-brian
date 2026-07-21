/**
 * [COMP:goals/triage-judge] Task triage judge — can the assistant honestly help?
 *
 * Task autopilot v2 (`docs/plans/task-goal-autopilot.md` §8): a top-level task
 * create no longer mints a templated draft goal. Instead this judge spends ONE
 * cheap LLM call to decide whether the assistant can honestly help with the
 * task — grounded in the workspace's actual capability surface — and, on a
 * pass, generates the goal conditions in the same response: an outcome scoped
 * to what the assistant can really deliver, verification criteria, and an
 * approach naming the capabilities it would use.
 *
 * **Fail-closed for drafting** (the inverse of the clarity gate's fail-open):
 * a model error, an unparseable verdict, or a fail verdict all return `null` —
 * no goal row is minted. A missing draft is benign; a slop draft is the
 * failure mode v2 exists to remove.
 */
import type { LLMProvider, TokenUsage } from '../providers/types.js'
import { collectStream } from '../providers/accumulator.js'

/** A passing verdict: the drafted goal conditions. */
export type TaskTriageBrief = {
  /** The goal outcome — scoped to what the assistant can actually deliver. */
  outcome: string
  /** How completion should be checked (acceptance criteria prose). */
  verification: string
  /** How the assistant would drive the task, naming real capabilities. */
  approach: string
  /** Why the judge deemed the task assistable. */
  judgeReason: string
}

export type TaskTriageInput = {
  title: string
  description?: string | null
  /** Human-readable summary of what this workspace's assistant can actually
   *  do (connected connectors + built-in capabilities). Composed by the
   *  caller — this module stays I/O-free. */
  capabilities: string[]
  /** Task creator, for COGS attribution only; the judgment ignores it. */
  userId?: string
}

/** `null` = do not draft (cannot honestly help, or the judge failed). */
export type TaskTriageJudge = (input: TaskTriageInput) => Promise<TaskTriageBrief | null>

const TRIAGE_SYSTEM_PROMPT = [
  'You triage newly created tasks for a company AI assistant. Decide whether the assistant can HONESTLY help drive this task, using only the capabilities listed.',
  'PASS when the assistant can complete the task itself (research, drafting, compiling, updating records, scheduling, sending through connected services) OR can deliver substantial preparation for a human-anchored task (briefs, drafts, summaries, chasing status).',
  'FAIL when the task needs a human for essentially all of it — physical presence, phone calls, signatures, payments, judgment calls that belong to a person — and the assistant would add nothing beyond a generic reminder. When in doubt, FAIL: a missed draft is cheap, a useless one erodes trust.',
  'On PASS, also write the goal conditions:',
  '- "outcome": one sentence naming the concrete deliverable or end state, scoped ONLY to what the assistant itself can deliver. For a human-anchored task, scope it to the preparation (e.g. "A one-page brief with contract deltas is attached to the task"), never to the human act.',
  '- "verification": one or two sentences saying how a reviewer checks the outcome is met.',
  '- "approach": two or three sentences on how the assistant would do it, naming the specific listed capabilities it would use. Never name a capability that is not listed.',
  'Respond with ONLY a JSON object: {"canAssist": true|false, "reason": "<one sentence>", "outcome": "<...>", "verification": "<...>", "approach": "<...>"} — the last three present only when canAssist is true.',
].join('\n')

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s)

/**
 * Construct the judge over an injected LLM provider (boot passes the pinned
 * background model, `gemini-3.1-flash-lite`). Same injected-port pattern as
 * `createGoalClarityAssessor`.
 */
export function createTaskTriageJudge(deps: {
  provider: LLMProvider
  model: string
  /** Optional COGS sink — boot records this under a goal-overhead source. */
  onUsage?: (usage: TokenUsage, userId?: string) => void
}): TaskTriageJudge {
  return async ({ title, description, capabilities, userId }) => {
    try {
      const lines = [
        `TASK: ${clip(title.trim(), 300)}`,
        description?.trim() ? `DETAILS: ${clip(description.trim(), 1200)}` : null,
        'ASSISTANT CAPABILITIES IN THIS WORKSPACE:',
        ...(capabilities.length > 0 ? capabilities.map((c) => `- ${c}`) : ['- (none connected)']),
      ].filter((l): l is string => l !== null)
      const response = await collectStream(
        deps.provider.stream({
          model: deps.model,
          systemPrompt: TRIAGE_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: lines.join('\n') }],
          maxTokens: 700,
          temperature: 0.1,
        }),
      )
      if (response.usage) deps.onUsage?.(response.usage, userId)
      const text = response.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
      return parseTriageVerdict(text)
    } catch (err) {
      // Fail-closed — no judge, no draft. Task creation is never blocked.
      console.error('[goal-triage] judge failed; not drafting:', err)
      return null
    }
  }
}

/**
 * Parse the judge's JSON verdict. Fail-closed: an unparseable response, a fail
 * verdict, or a pass missing any brief field returns `null` (no draft).
 */
export function parseTriageVerdict(text: string): TaskTriageBrief | null {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const obj = JSON.parse(match[0]) as {
      canAssist?: unknown
      reason?: unknown
      outcome?: unknown
      verification?: unknown
      approach?: unknown
    }
    if (obj.canAssist !== true) return null
    const outcome = typeof obj.outcome === 'string' ? obj.outcome.trim() : ''
    const verification = typeof obj.verification === 'string' ? obj.verification.trim() : ''
    const approach = typeof obj.approach === 'string' ? obj.approach.trim() : ''
    if (!outcome || !verification || !approach) return null
    const judgeReason = typeof obj.reason === 'string' && obj.reason.trim() ? obj.reason.trim() : 'Judged assistable.'
    return { outcome, verification, approach, judgeReason }
  } catch {
    return null
  }
}
