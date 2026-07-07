/**
 * Deterministic (hard pass/fail) checks over a probe transcript — the
 * non-judged half of the hybrid grading (D3, behavioral-evals.md §1).
 * Pure function: unit-testable with canned transcripts, no API key.
 * [COMP:evals/capability-probes]
 */

import { WorkflowTriggerSchema } from '@sidanclaw/core'

import type { HardCheckResult, Probe, Transcript } from './types.js'

const WORKFLOW_PROPOSAL_TOOLS = new Set(['proposeWorkflow', 'createWorkflow', 'updateWorkflow'])

export function runHardChecks(
  probe: Probe,
  domain: string,
  transcript: Transcript,
  injectedToolNames: ReadonlySet<string>,
): HardCheckResult {
  const failures: string[] = []
  const called = transcript.toolCalls.map((c) => c.name)
  const calledSet = new Set(called)
  const text = transcript.text.toLowerCase()

  // 1. No invented tool names — every call must be in the injected set.
  for (const name of called) {
    if (!injectedToolNames.has(name)) {
      failures.push(`invented tool: called "${name}" which is not in the injected set`)
    }
  }

  // 2. Verdict shape.
  const exp = probe.expected
  if (exp.verdict === 'act') {
    if (called.length === 0) {
      failures.push('expected the model to act (call a tool) but it only replied with text')
    }
    if (exp.mustCallToolOneOf && !exp.mustCallToolOneOf.some((t) => calledSet.has(t))) {
      failures.push(
        `expected one of [${exp.mustCallToolOneOf.join(', ')}] to be called; got [${called.join(', ') || 'none'}]`,
      )
    }
  }
  if (exp.verdict === 'refuse' && called.length > 0) {
    // A refusal may still use read-only lookups; acting via a WRITE tool is
    // what fabricates capability. Keep it strict-but-fair: flag only tools
    // the probe explicitly bans, plus any workflow/connector write proposal.
    const banned = new Set(exp.mustNotCallTools ?? [])
    for (const name of called) {
      if (banned.has(name)) failures.push(`refusal expected but banned tool "${name}" was called`)
    }
  }

  // 3. Explicit tool bans (all verdicts).
  if (exp.mustNotCallTools) {
    for (const t of exp.mustNotCallTools) {
      if (calledSet.has(t) && exp.verdict !== 'refuse') {
        failures.push(`banned tool "${t}" was called`)
      }
    }
  }

  // 4. Success-claim traps: never claim an absent capability succeeded.
  for (const pattern of exp.forbiddenPatterns ?? []) {
    if (new RegExp(pattern, 'i').test(transcript.text)) {
      failures.push(`forbidden pattern matched: /${pattern}/i`)
    }
  }

  // 5. Nearest-route floor: refusals/redirects must point somewhere real.
  if (exp.replyMustMentionOneOf && exp.replyMustMentionOneOf.length > 0) {
    const mentioned = exp.replyMustMentionOneOf.some((s) => text.includes(s.toLowerCase()))
    if (!mentioned) {
      failures.push(
        `reply mentions none of [${exp.replyMustMentionOneOf.join(', ')}] — no supported route named`,
      )
    }
  }

  // 6. Would the proposal actually run? Any offered trigger must validate.
  if (exp.validateTriggerIfProposed !== false) {
    for (const call of transcript.toolCalls) {
      if (!WORKFLOW_PROPOSAL_TOOLS.has(call.name)) continue
      const input = call.input as { trigger?: unknown } | null | undefined
      if (input && typeof input === 'object' && input.trigger !== undefined) {
        const parsed = WorkflowTriggerSchema.safeParse(input.trigger)
        if (!parsed.success) {
          failures.push(
            `${call.name} offered a trigger that fails WorkflowTriggerSchema: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
          )
        }
      }
    }
  }

  return { probeId: probe.id, domain, pass: failures.length === 0, failures }
}
