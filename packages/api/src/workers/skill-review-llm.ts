/**
 * Skill-review LLM port — the concrete Flash implementation of the
 * `SkillReviewLLM` the background skill-review worker (WS-B) invokes once
 * per review cycle.
 *
 * The worker is provider-agnostic: it depends on the `SkillReviewLLM`
 * interface and calls `plan(input)` exactly once per session-review cycle.
 * This module turns that into a real model call. It is deliberately split
 * from `apps/api/src/index.ts` (which owns the provider singleton + cost
 * attribution) so the prompt + parse + corrective-retry logic is unit-
 * testable with a fake `SkillReviewModelCall` and no network.
 *
 * Shape (mirrors the background-extraction recipe used across the codebase
 * — feed defense L3 classifier, consolidation reclassifier, splitter):
 *
 *   model output (string)
 *     → strip ``` fences
 *     → regex the first {...} block
 *     → JSON.parse
 *     → PLAN_SCHEMA.safeParse  (same shape as skill_manage's INPUT_SCHEMA)
 *     → on failure: ONE corrective re-prompt (spec "Failure modes")
 *     → still invalid: emit an empty plan (a safe no-op cycle)
 *
 * The empty-plan fallback is load-bearing: the worker treats `{ actions: [] }`
 * as a clean review (marks the session reviewed, writes nothing), so a flaky
 * or malformed model response can never corrupt a workspace's skills — it
 * just costs one wasted cycle.
 *
 * Spec: `docs/architecture/engine/skill-system.md` → "Auto-generation (V2)"
 *   (update-first preference order, the four actions, anti-patterns,
 *    class-level naming, failure modes).
 *
 * [COMP:workers/skill-review-llm]
 */

import { z } from 'zod'
import type { SkillReviewActionPlan, SkillReviewLLM } from './skill-review-worker.js'

/**
 * Max output tokens for one plan call. The model usually emits a tiny
 * `{"actions":[]}` (the common, conservative case); the ceiling exists for
 * the occasional full skill body (a `create_umbrella` / `patch_skill`
 * `content`). `gemini-3.1-flash-lite` is a non-thinking model, so the whole
 * budget is available to the JSON output — no reasoning-token drain (cf. the
 * Gemini-3 thinking-truncation class the consolidation worker budgets around).
 */
export const SKILL_REVIEW_MAX_TOKENS = 8192

/** Per-cycle action ceiling — below the per-workspace daily cap (10) so a
 *  single cycle can't exhaust the day's budget in one shot. */
const MAX_ACTIONS_PER_CYCLE = 5

/**
 * The model-call seam. `apps/api` supplies a closure over the provider
 * singleton that streams the request, records `overhead:skill-review`
 * usage against `attribution`, and returns the joined text. Tests supply a
 * fake returning canned strings.
 */
export type SkillReviewModelCall = (req: {
  systemPrompt: string
  prompt: string
  maxTokens: number
  attribution: { userId: string; assistantId: string; sessionId: string }
}) => Promise<string>

// ── Output schema ─────────────────────────────────────────────────
// Mirrors `skill_manage`'s INPUT_SCHEMA (packages/core/src/skills/
// manage-tool.ts). The worker re-validates every action through the tool,
// so this is the first of two gates; keeping the shapes identical means a
// plan that passes here can't surprise the tool layer.

const FILE_SCHEMA = z.object({
  kind: z.enum(['reference', 'template', 'script']),
  name: z
    .string()
    .min(1)
    .max(200)
    .refine((n) => !/[{}\r\n]/.test(n), 'name may not contain newlines or curly braces'),
  content: z.string().min(1).max(50_000),
  description: z.string().max(500).optional(),
})

const PATCH_SCHEMA = z
  .object({
    newContent: z.string().min(1).optional(),
    diff: z.string().min(1).optional(),
  })
  .refine((p) => p.newContent !== undefined || p.diff !== undefined, {
    message: 'patch must include newContent and/or diff',
  })

const ACTION_SCHEMA = z.discriminatedUnion('action', [
  z.object({ action: z.literal('patch_skill'), skillId: z.string().uuid(), patch: PATCH_SCHEMA }),
  z.object({ action: z.literal('update_umbrella'), skillId: z.string().uuid(), patch: PATCH_SCHEMA }),
  z.object({ action: z.literal('add_support_file'), skillId: z.string().uuid(), file: FILE_SCHEMA }),
  z.object({
    action: z.literal('create_umbrella'),
    umbrella: z.object({
      name: z.string().min(1).max(100),
      description: z.string().min(1).max(500),
      content: z.string().min(1).max(50_000),
      supportFiles: z.array(FILE_SCHEMA).max(20).optional(),
    }),
  }),
])

const PLAN_SCHEMA = z.object({
  actions: z.array(ACTION_SCHEMA).max(MAX_ACTIONS_PER_CYCLE),
})

// ── Prompts ───────────────────────────────────────────────────────

/**
 * The review prompt. Cloud-adapted for DB vs filesystem / multi-tenant vs
 * single-user. The preference order, anti-patterns, and class-level naming
 * rules are the load-bearing parts — they keep the curator from minting
 * session-artifact skills (`fix-the-thing-today`) instead of durable
 * class-level ones.
 */
export const SKILL_REVIEW_SYSTEM_PROMPT = `You are the background skill curator for a company-brain assistant. After every few turns of a real conversation you review what happened and decide whether the workspace's reusable skills should change. Skills are markdown playbooks the assistant loads on demand; good ones encode durable, reusable know-how about how this company works.

Your job is NOT to summarize the conversation. It is to capture a learning moment: a repeatable procedure, a hard-won preference, a pitfall to avoid, or a correction the user gave ("stop doing X", "always do Y"). Most cycles you will find nothing worth changing. That is the correct and expected outcome — when in doubt, return {"actions": []}.

PREFERENCE ORDER (strict — always prefer the earliest that fits):
1. patch_skill        - Improve a skill that is already loaded / in play. Patch the one closest to the pattern.
2. update_umbrella    - Broaden an existing class-level skill: add a subsection, a pitfall, a new trigger.
3. add_support_file   - Attach a reference, template, or script under an existing skill.
4. create_umbrella    - Mint a brand-new class-level skill. ONLY when nothing above fits.

Reach for create_umbrella last. A workspace with one sharp skill per class beats a workspace with fifty narrow ones.

WHAT MAKES A GOOD SKILL:
- Class-level and reusable: "Drafting investor updates", not "draft the May update".
- Generalizable: it will help on a future, different instance of the same task.
- Specific in content: name the real steps, tools, and decisions; vague skills are noise.
- Embeds the user's actual preferences in the skill BODY (not just memory). If the user expressed a standing preference, write it into the relevant skill so it is honored next time.

NEVER capture (these are anti-patterns — they make skills worse, not better):
- Environment-dependent failures ("command not found", "the server was down"). Transient, not knowledge.
- Negative tool claims ("tool X is broken", "the API doesn't work"). State changes; do not bake it in.
- Session-specific transients: a one-off value, a single ID, today's date, a specific error string.
- One-off task narratives: "what we did in this conversation". A skill is a procedure, not a log.

create_umbrella NAMING (class-level only):
- The name must describe a CLASS of task, not an instance.
- REJECT for yourself any name that looks like a session artifact: prefixes fix-*, debug-*, audit-*, today-*; dated names; PR-numbered names; names that are a specific error message.
- Good: "Weekly metrics report". Bad: "fix-metrics-2026-06-04".

OUTPUT CONTRACT:
Return ONLY a single JSON object. No prose, no markdown, no code fences. Shape:
{
  "actions": [ <0 to ${MAX_ACTIONS_PER_CYCLE} action objects> ]
}
Each action is exactly one of:
- { "action": "patch_skill",     "skillId": "<uuid of an existing skill>", "patch": { "newContent": "<full new markdown body>" } }
- { "action": "update_umbrella", "skillId": "<uuid of an existing skill>", "patch": { "newContent": "<full new markdown body>" } }
- { "action": "add_support_file","skillId": "<uuid of an existing skill>", "file": { "kind": "reference"|"template"|"script", "name": "<file name>", "content": "<file body>", "description": "<optional>" } }
- { "action": "create_umbrella", "umbrella": { "name": "<class-level name>", "description": "<one line>", "content": "<full markdown body>", "supportFiles": [ <optional file objects> ] } }

skillId MUST be the UUID of a skill listed in "Existing workspace skills". Never invent a skillId. If nothing is worth doing, return {"actions": []}.`

function buildUserPrompt(input: Parameters<SkillReviewLLM['plan']>[0]): string {
  const skillsBlock =
    input.loadedSkills.length === 0
      ? '(no skills exist in this workspace yet — only create_umbrella is possible, and only if a clear class-level pattern emerged)'
      : input.loadedSkills
          .map(
            (s) =>
              `### Skill ${s.id}\nName: ${s.name}\nDescription: ${s.description}\n--- body ---\n${s.content}`,
          )
          .join('\n\n')

  const priorBlock = input.priorErrors.length
    ? `\n\n# Validation errors to avoid (your prior attempts failed these)\n${input.priorErrors
        .map((e) => `- ${e}`)
        .join('\n')}`
    : ''

  return [
    '# Recent conversation transcript',
    input.transcriptExcerpt.trim() || '(empty transcript)',
    '',
    '# Existing workspace skills',
    skillsBlock,
    priorBlock,
    '',
    'Review the transcript against the existing skills. Decide whether a durable, reusable pattern or an explicit user correction emerged that the skills do not already capture. Prefer improving an existing skill over creating a new one. If nothing qualifies, return {"actions": []}.',
  ].join('\n')
}

// ── Parse ─────────────────────────────────────────────────────────

type ParseResult = { plan?: SkillReviewActionPlan; error?: string }

/**
 * Strip fences → regex first {...} → JSON.parse → PLAN_SCHEMA. Returns a
 * structured error string (not a throw) so the caller can feed it into the
 * one corrective re-prompt.
 */
export function parseSkillReviewPlan(raw: string): ParseResult {
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
  // The zod-inferred shape is structurally identical to SkillReviewActionPlan
  // (both derive the same discriminated union); the cast records that intent.
  return { plan: result.data as SkillReviewActionPlan }
}

// ── Factory ───────────────────────────────────────────────────────

/**
 * Build the concrete `SkillReviewLLM` from a model-call seam. `plan()`
 * calls the model once, validates, and on a validation failure re-prompts
 * exactly once with the error (spec "Failure modes": ONE re-prompt). If the
 * retry is still invalid it emits an empty plan — a safe no-op cycle.
 */
export function createGeminiSkillReviewLLM(call: SkillReviewModelCall): SkillReviewLLM {
  return {
    async plan(input) {
      const attribution = {
        userId: input.userId,
        assistantId: input.assistantId,
        sessionId: input.sessionId,
      }
      const userPrompt = buildUserPrompt(input)

      const first = await call({
        systemPrompt: SKILL_REVIEW_SYSTEM_PROMPT,
        prompt: userPrompt,
        maxTokens: SKILL_REVIEW_MAX_TOKENS,
        attribution,
      })
      const firstParse = parseSkillReviewPlan(first)
      if (firstParse.plan) return firstParse.plan

      // One corrective re-prompt carrying the rejection reason.
      const correctivePrompt = `${userPrompt}\n\n---\nYour previous response was rejected: ${firstParse.error}\nReturn ONLY a valid JSON object matching the schema above. No prose, no code fences.`
      const second = await call({
        systemPrompt: SKILL_REVIEW_SYSTEM_PROMPT,
        prompt: correctivePrompt,
        maxTokens: SKILL_REVIEW_MAX_TOKENS,
        attribution,
      })
      const secondParse = parseSkillReviewPlan(second)
      if (secondParse.plan) return secondParse.plan

      // Still invalid after the one allowed retry → no-op. The worker marks
      // the session reviewed and writes nothing; the wasted cycle is the cost.
      console.warn(
        `[skill-review-llm] plan still invalid after corrective retry (${secondParse.error}); emitting empty plan`,
      )
      return { actions: [] }
    },
  }
}
