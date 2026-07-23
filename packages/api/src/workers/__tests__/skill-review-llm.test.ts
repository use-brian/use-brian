/**
 * Unit tests for the Flash skill-review LLM port.
 *
 * The port is the model-facing half of the skill-review worker: it builds
 * the review prompt, calls the model through an injected `SkillReviewModelCall`
 * seam (no network), validates the JSON plan against the same shape
 * `skill_manage` enforces, and — on a validation failure — re-prompts exactly
 * once before degrading to a safe empty (no-op) plan.
 *
 * Spec: `docs/architecture/engine/skill-system.md` → "Auto-generation (V2)"
 *   (the four actions, output contract, "Failure modes" one-retry rule).
 */

import { describe, it, expect, vi } from 'vitest'
import {
  createGeminiSkillReviewLLM,
  parseSkillReviewPlan,
  type SkillReviewModelCall,
} from '../skill-review-llm.js'

const SKILL_UUID = '11111111-1111-4111-8111-111111111111'

const PLAN_INPUT = {
  sessionId: '00000000-0000-0000-0000-0000000000a1',
  workspaceId: '00000000-0000-0000-0000-0000000000a2',
  assistantId: '00000000-0000-0000-0000-0000000000a3',
  userId: '00000000-0000-0000-0000-0000000000a4',
  transcriptExcerpt: 'USER: how do I draft the weekly update?\nASSISTANT: here is the procedure...',
  loadedSkills: [
    { id: SKILL_UUID, name: 'Weekly update', description: 'Draft the weekly update', content: '# Weekly update\nsteps...' },
  ],
  priorErrors: [] as string[],
}

/** A fake model seam that returns canned strings in sequence and records the
 *  requests it was given. */
function makeCall(responses: string[]): SkillReviewModelCall & { calls: Parameters<SkillReviewModelCall>[0][] } {
  const calls: Parameters<SkillReviewModelCall>[0][] = []
  let i = 0
  const fn = vi.fn(async (req: Parameters<SkillReviewModelCall>[0]) => {
    calls.push(req)
    return responses[Math.min(i++, responses.length - 1)]
  }) as unknown as SkillReviewModelCall & { calls: Parameters<SkillReviewModelCall>[0][] }
  ;(fn as unknown as { calls: typeof calls }).calls = calls
  return fn
}

describe('[COMP:workers/skill-review-llm] parseSkillReviewPlan', () => {
  it('parses a valid empty plan', () => {
    const r = parseSkillReviewPlan('{"actions": []}')
    expect(r.plan).toEqual({ actions: [] })
    expect(r.error).toBeUndefined()
  })

  it('parses a patch_skill action', () => {
    const raw = JSON.stringify({
      actions: [{ action: 'patch_skill', skillId: SKILL_UUID, patch: { newContent: 'NEW BODY' } }],
    })
    const r = parseSkillReviewPlan(raw)
    expect(r.plan?.actions).toHaveLength(1)
    expect(r.plan?.actions[0]).toMatchObject({ action: 'patch_skill', skillId: SKILL_UUID })
  })

  it('parses a create_umbrella action', () => {
    const raw = JSON.stringify({
      actions: [
        {
          action: 'create_umbrella',
          umbrella: { name: 'Weekly metrics report', description: 'one line', content: '# body' },
        },
      ],
    })
    const r = parseSkillReviewPlan(raw)
    expect(r.plan?.actions[0]).toMatchObject({ action: 'create_umbrella' })
  })

  it('strips ```json code fences', () => {
    const r = parseSkillReviewPlan('```json\n{"actions": []}\n```')
    expect(r.plan).toEqual({ actions: [] })
  })

  it('tolerates leading prose by grabbing the first {...} block', () => {
    const r = parseSkillReviewPlan('Here is the plan:\n{"actions": []}\nThanks!')
    expect(r.plan).toEqual({ actions: [] })
  })

  it('rejects a non-uuid skillId', () => {
    const raw = JSON.stringify({
      actions: [{ action: 'patch_skill', skillId: 'not-a-uuid', patch: { newContent: 'x' } }],
    })
    const r = parseSkillReviewPlan(raw)
    expect(r.plan).toBeUndefined()
    expect(r.error).toMatch(/skillId|uuid/i)
  })

  it('rejects a patch with neither newContent nor diff', () => {
    const raw = JSON.stringify({
      actions: [{ action: 'patch_skill', skillId: SKILL_UUID, patch: {} }],
    })
    const r = parseSkillReviewPlan(raw)
    expect(r.plan).toBeUndefined()
    expect(r.error).toMatch(/newContent|diff/i)
  })

  it('rejects output with no JSON object', () => {
    const r = parseSkillReviewPlan('I could not find anything to do.')
    expect(r.plan).toBeUndefined()
    expect(r.error).toMatch(/no JSON object/i)
  })

  it('rejects an unknown action discriminant', () => {
    const raw = JSON.stringify({ actions: [{ action: 'delete_skill', skillId: SKILL_UUID }] })
    const r = parseSkillReviewPlan(raw)
    expect(r.plan).toBeUndefined()
  })
})

describe('[COMP:workers/skill-review-llm] createGeminiSkillReviewLLM', () => {
  it('returns the parsed plan on a valid first response', async () => {
    const call = makeCall(['{"actions": []}'])
    const llm = createGeminiSkillReviewLLM(call)
    const plan = await llm.plan(PLAN_INPUT)
    expect(plan).toEqual({ actions: [] })
    expect(call.calls).toHaveLength(1)
  })

  it('passes attribution through to the model call for cost tracking', async () => {
    const call = makeCall(['{"actions": []}'])
    const llm = createGeminiSkillReviewLLM(call)
    await llm.plan(PLAN_INPUT)
    expect(call.calls[0].attribution).toEqual({
      userId: PLAN_INPUT.userId,
      assistantId: PLAN_INPUT.assistantId,
      sessionId: PLAN_INPUT.sessionId,
    })
  })

  it('includes the transcript and existing skills in the user prompt', async () => {
    const call = makeCall(['{"actions": []}'])
    const llm = createGeminiSkillReviewLLM(call)
    await llm.plan(PLAN_INPUT)
    expect(call.calls[0].prompt).toContain('weekly update')
    expect(call.calls[0].prompt).toContain(SKILL_UUID)
  })

  it('re-prompts exactly once with the rejection reason, then succeeds', async () => {
    const valid = JSON.stringify({
      actions: [{ action: 'patch_skill', skillId: SKILL_UUID, patch: { newContent: 'FIXED' } }],
    })
    const call = makeCall(['this is not json', valid])
    const llm = createGeminiSkillReviewLLM(call)
    const plan = await llm.plan(PLAN_INPUT)
    expect(plan.actions).toHaveLength(1)
    expect(call.calls).toHaveLength(2)
    // The corrective prompt carries the rejection reason.
    expect(call.calls[1].prompt).toMatch(/rejected/i)
  })

  it('degrades to an empty plan when still invalid after the one retry', async () => {
    const call = makeCall(['garbage', 'still garbage'])
    const llm = createGeminiSkillReviewLLM(call)
    const plan = await llm.plan(PLAN_INPUT)
    expect(plan).toEqual({ actions: [] })
    // Exactly two attempts — never more than one retry.
    expect(call.calls).toHaveLength(2)
  })
})

// ── Origin-aware induction (workflow-origin plans) ─────────────────

describe('[COMP:workers/skill-review-llm] workflow-origin plans', () => {
  const REFINEMENT = {
    action: 'propose_workflow_refinement',
    stepId: 'step-1',
    patch: { prompt: 'Summarize GitHub activity, paging past 30 events' },
    rationale: 'The run truncated at 30 events every fire',
  }

  it('accepts propose_workflow_refinement on a workflow-origin parse', () => {
    const r = parseSkillReviewPlan(JSON.stringify({ actions: [REFINEMENT] }), 'workflow')
    expect(r.error).toBeUndefined()
    expect(r.plan?.actions[0]).toMatchObject({ action: 'propose_workflow_refinement' })
  })

  it('rejects propose_workflow_refinement on an interactive parse', () => {
    const r = parseSkillReviewPlan(JSON.stringify({ actions: [REFINEMENT] }))
    expect(r.plan).toBeUndefined()
    expect(r.error).toBeTruthy()
  })

  it('uses the workflow-origin system prompt and threads origin into the parse', async () => {
    const call = makeCall([JSON.stringify({ actions: [REFINEMENT] })])
    const llm = createGeminiSkillReviewLLM(call)
    const plan = await llm.plan({
      ...PLAN_INPUT,
      origin: 'workflow',
      sourceWorkflow: {
        id: '11111111-2222-3333-4444-555555555555',
        name: 'Daily team standup',
        description: null,
        steps: [{ id: 'step-1', kind: 'assistant_call', prompt: 'Summarize GitHub activity' }],
      },
    })
    expect(plan.actions).toHaveLength(1)
    // The system prompt is the workflow-origin variant, and the user prompt
    // carries the definition block the reviewer diffs the run against.
    expect(call.calls[0].systemPrompt).toMatch(/AUTOMATED WORKFLOW/)
    expect(call.calls[0].prompt).toMatch(/# Workflow definition/)
    expect(call.calls[0].prompt).toMatch(/Daily team standup/)
  })

  it('keeps the interactive system prompt for interactive sessions', async () => {
    const call = makeCall(['{"actions": []}'])
    const llm = createGeminiSkillReviewLLM(call)
    await llm.plan(PLAN_INPUT)
    expect(call.calls[0].systemPrompt).not.toMatch(/AUTOMATED WORKFLOW/)
  })
})
