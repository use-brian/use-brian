/**
 * Capability probe battery — shared types.
 *
 * The battery grades whole PROPOSALS, not just Q&A: did the model act /
 * honestly refuse / redirect, does an offered workflow trigger actually
 * validate, does a refusal name the nearest supported route, does it
 * invent tools or UI surfaces. Probes are transcribed from the WS9 audit
 * battery (docs/plans/fable-agent-workstreams.md § Audit pass 2026-07-07);
 * design + locked decisions in docs/plans/behavioral-evals.md §3.
 * [COMP:evals/capability-probes]
 */

import { z } from 'zod'

export const ProbeSchema = z.object({
  id: z.string().min(1),
  bucket: z.enum(['supported', 'unsupported-plausible', 'adjacent']),
  prompt: z.string().min(1),
  expected: z.object({
    /** act = must call a tool; refuse = must NOT act and must say so; redirect = either, but must name the supported route. */
    verdict: z.enum(['act', 'refuse', 'redirect']),
    /** When verdict=act: at least one of these tools must be called. */
    mustCallToolOneOf: z.array(z.string()).optional(),
    /** Tools that must NOT be called (e.g. fabricating an absent connector's action). */
    mustNotCallTools: z.array(z.string()).optional(),
    /** Case-insensitive regexes that must NOT appear in the reply text (success-claim traps). */
    forbiddenPatterns: z.array(z.string()).optional(),
    /** Case-insensitive substrings, at least ONE of which must appear in the reply text (nearest-route floor). */
    replyMustMentionOneOf: z.array(z.string()).optional(),
    /** Validate any proposeWorkflow/createWorkflow trigger arg against WorkflowTriggerSchema. Default true. */
    validateTriggerIfProposed: z.boolean().optional(),
  }),
  /** Free-text note for the judge (what "grounded" means for this probe). */
  rubricNote: z.string().optional(),
})
export type Probe = z.infer<typeof ProbeSchema>

export type ProbeDomain = {
  domain: string
  probes: Probe[]
}

export type ToolCall = { name: string; input: unknown }

export type Transcript = {
  text: string
  toolCalls: ToolCall[]
}

export type HardCheckResult = {
  probeId: string
  domain: string
  pass: boolean
  failures: string[]
}

/** One judged dimension on one probe (0-4). */
export const ScoreEntrySchema = z.object({
  probeId: z.string(),
  dimension: z.enum(['justification-grounding', 'nearest-route', 'no-invented-ui']),
  score: z.number().min(0).max(4),
  note: z.string().optional(),
})

export const ScoresFileSchema = z.object({
  judgeModel: z.string().min(1),
  scores: z.array(ScoreEntrySchema),
})
export type ScoresFile = z.infer<typeof ScoresFileSchema>

/** Committed per-judge baseline: mean score per (domain, dimension). */
export type Baseline = {
  judgeModel: string
  domains: Record<string, Record<string, number>>
}

export const RATCHET = {
  /** Fail when a domain's mean (across dimensions) drops more than this below baseline. */
  domainMeanDrop: 0.5,
  /** Fail when a single (domain, dimension) mean drops at least this much. */
  dimensionDrop: 2.0,
} as const
