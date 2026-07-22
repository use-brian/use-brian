/**
 * Workflow-digest LLM port — the model-facing half of the workflow
 * lifecycle sweep's digestion pass (mirrors `skill-review-llm.ts`).
 *
 * One call per workspace per sweep tick reviews a batch of RETIRING
 * (stale/archived, never-digested) workflows and decides whether the pile
 * encodes a repeatable procedure worth preserving as a skill candidate.
 * Most batches yield nothing — one-off reminders and finished project
 * automations are flotsam, not knowledge — and the empty plan is the
 * expected, correct outcome.
 *
 * Spec: docs/architecture/features/workflow-lifecycle.md → "Digestion".
 * Component tag: [COMP:workers/workflow-digest-llm]
 */

import { z } from 'zod'

/** Ceiling for one plan call (a candidate carries a full skill body). */
export const WORKFLOW_DIGEST_MAX_TOKENS = 8192

/** A batch distills to at most this many skill candidates. */
export const MAX_DIGEST_CANDIDATES = 3

/**
 * The model-call seam. `boot.ts` supplies a closure over the provider
 * singleton that streams the request, records `overhead:workflow-digest`
 * usage against `attribution`, and returns the joined text. Tests supply a
 * fake returning canned strings.
 */
export type WorkflowDigestModelCall = (req: {
  systemPrompt: string
  prompt: string
  maxTokens: number
  attribution: { workspaceId: string; userId: string }
}) => Promise<string>

/** One retiring workflow, summarized for the digest prompt. */
export type DigestWorkflowSummary = {
  id: string
  name: string
  description: string | null
  triggerKind: string
  runCount: number
  idleDays: number
  steps: Array<{ type: string; summary: string }>
}

export type WorkflowDigestInput = {
  workspaceId: string
  /** The batch under review (never-digested stale/archived workflows). */
  workflows: DigestWorkflowSummary[]
  /** Existing workspace skills, so the model never re-proposes one. */
  existingSkills: Array<{ slug: string; name: string; description: string }>
  /** Attribution target for the model spend (a source workflow's creator). */
  userId: string
}

export type WorkflowDigestCandidate = {
  slug: string
  name: string
  description: string
  content: string
  sourceWorkflowIds: string[]
}

export type WorkflowDigestPlan = { candidates: WorkflowDigestCandidate[] }

export type WorkflowDigestLLM = {
  plan(input: WorkflowDigestInput): Promise<WorkflowDigestPlan>
}

// ── Output schema ─────────────────────────────────────────────────

const CANDIDATE_SCHEMA = z.object({
  slug: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase kebab-case'),
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  content: z.string().min(1).max(50_000),
  sourceWorkflowIds: z.array(z.string().uuid()).min(1).max(64),
})

const PLAN_SCHEMA = z.object({
  candidates: z.array(CANDIDATE_SCHEMA).max(MAX_DIGEST_CANDIDATES),
})

// ── Prompts ───────────────────────────────────────────────────────

export const WORKFLOW_DIGEST_SYSTEM_PROMPT = `You are the retirement curator for a company-brain assistant. A batch of the workspace's WORKFLOWS (saved automations) has gone unused long enough that the system is retiring them. Before they disappear, you decide: does this pile encode a REPEATABLE PROCEDURE worth preserving as a skill — a markdown playbook the assistant loads on demand — or is it one-off flotsam?

Most batches are flotsam. Completed reminders, finished project automations, and experiments should retire silently. The empty plan {"candidates": []} is the expected, correct outcome — when in doubt, return it.

A candidate is justified ONLY when several retiring workflows (or one genuinely rich one) show the same class of procedure the team will plausibly need again: the same kind of report assembled the same way, the same delivery ritual, the same multi-step research pattern. Then write ONE class-level skill that captures HOW to do that class of task.

NEVER capture (anti-patterns — these make the skill library worse):
- One-off task narratives ("what this workflow did"). A skill is a procedure, not a log.
- A pile of trivial one-shot reminders. Twenty "remind me to X" workflows teach nothing a reminder tool doesn't already know.
- Session/date-specific transients: a specific date, ID, URL, or person the procedure doesn't generalize past.
- Anything an existing workspace skill already covers — never re-propose or near-duplicate one.

NAMING (class-level only): the name describes a CLASS of task, never an instance. Good: "Weekly investor metrics digest". Bad: "june-metrics-reminder", "fix-crm-sync-2026-05".

CONTENT: full markdown playbook — start with a title heading, include a "## When to use" section, then the concrete steps (which triggers, which assistants/tools, what to deliver where). Specific enough to run from; general enough to reuse.

OUTPUT CONTRACT:
Return ONLY a single JSON object. No prose, no markdown, no code fences. Shape:
{
  "candidates": [ <0 to ${MAX_DIGEST_CANDIDATES} candidate objects> ]
}
Each candidate is:
- { "slug": "<lowercase-kebab-case>", "name": "<class-level name>", "description": "<one line>", "content": "<full markdown playbook>", "sourceWorkflowIds": ["<uuid of a workflow in the batch>", ...] }

sourceWorkflowIds MUST cite only ids from the batch below — the workflows the pattern was distilled from. A workflow you don't cite is treated as not-repeatable and retires normally.`

function buildUserPrompt(input: WorkflowDigestInput): string {
  const workflowsBlock = input.workflows
    .map((w) => {
      const steps = w.steps.map((s, i) => `  ${i + 1}. [${s.type}] ${s.summary}`).join('\n')
      return [
        `### Workflow ${w.id}`,
        `Name: ${w.name}`,
        `Description: ${w.description ?? '(none)'}`,
        `Trigger: ${w.triggerKind} · Runs: ${w.runCount} · Idle: ${w.idleDays} days`,
        `Steps:\n${steps || '  (none)'}`,
      ].join('\n')
    })
    .join('\n\n')

  const skillsBlock =
    input.existingSkills.length === 0
      ? '(no skills exist in this workspace yet)'
      : input.existingSkills.map((s) => `- ${s.slug}: ${s.name} — ${s.description}`).join('\n')

  return [
    '# Retiring workflows (the batch under review)',
    workflowsBlock,
    '',
    '# Existing workspace skills (never re-propose these)',
    skillsBlock,
    '',
    'Decide whether the batch encodes a repeatable class-level procedure the existing skills do not already capture. If nothing qualifies, return {"candidates": []}.',
  ].join('\n')
}

// ── Parse ─────────────────────────────────────────────────────────

type ParseResult = { plan?: WorkflowDigestPlan; error?: string }

/**
 * Strip fences → first {...} → JSON.parse → PLAN_SCHEMA. Returns a
 * structured error string (not a throw) so the caller can feed it into the
 * one corrective re-prompt.
 */
export function parseWorkflowDigestPlan(raw: string): ParseResult {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
  const match = cleaned.match(/\{[\s\S]*\}/)
  if (!match) return { error: 'no JSON object found in model output' }

  let parsed: unknown
  try {
    parsed = JSON.parse(match[0])
  } catch (err) {
    return { error: `JSON parse failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  const result = PLAN_SCHEMA.safeParse(parsed)
  if (!result.success) {
    return {
      error: result.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; '),
    }
  }
  return { plan: result.data }
}

// ── Factory ───────────────────────────────────────────────────────

/**
 * Build the concrete `WorkflowDigestLLM` from a model-call seam. One call,
 * validate, ONE corrective re-prompt on a validation failure, then degrade
 * to the empty plan (the sweep leaves the batch undigested for a later
 * tick only on a thrown call — a *parsed-but-empty* plan marks the batch
 * reviewed with `not_repeatable`, the common case).
 */
export function createGeminiWorkflowDigestLLM(call: WorkflowDigestModelCall): WorkflowDigestLLM {
  return {
    async plan(input) {
      const attribution = { workspaceId: input.workspaceId, userId: input.userId }
      const userPrompt = buildUserPrompt(input)

      const first = await call({
        systemPrompt: WORKFLOW_DIGEST_SYSTEM_PROMPT,
        prompt: userPrompt,
        maxTokens: WORKFLOW_DIGEST_MAX_TOKENS,
        attribution,
      })
      const firstParse = parseWorkflowDigestPlan(first)
      if (firstParse.plan) return firstParse.plan

      const correctivePrompt = `${userPrompt}\n\n---\nYour previous response was rejected: ${firstParse.error}\nReturn ONLY a valid JSON object matching the schema above. No prose, no code fences.`
      const second = await call({
        systemPrompt: WORKFLOW_DIGEST_SYSTEM_PROMPT,
        prompt: correctivePrompt,
        maxTokens: WORKFLOW_DIGEST_MAX_TOKENS,
        attribution,
      })
      const secondParse = parseWorkflowDigestPlan(second)
      if (secondParse.plan) return secondParse.plan

      console.warn(
        `[workflow-digest-llm] plan still invalid after corrective retry (${secondParse.error}); emitting empty plan`,
      )
      return { candidates: [] }
    },
  }
}
