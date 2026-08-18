/**
 * useSkill tool — the model calls this to activate a skill.
 *
 * The model sees a compact listing in the system prompt, then invokes this
 * tool by skill ID to load the full prompt content. The content is returned
 * as the tool result — the model reads it and follows the instructions.
 *
 * The optional `recordInvocation` callback fires on successful resolution
 * (skill found and content returned). It is the CL-8 invocation hook —
 * see `docs/architecture/context-engine/memory-consolidation.md` → "Skill invocation
 * feedback (CL-8 lock)". The hook is keyed by the slug surfaced to the
 * model (`SkillContent.id`); the wiring layer resolves slug → workspace_skills
 * row id and forwards to `WorkspaceSkillStore.recordInvocation` /
 * `SkillInvocationBuffer.addInvocation`. Built-in skills (no DB row) are
 * filtered at the wiring layer, not here.
 *
 * Callback errors are swallowed so a failing counter update never aborts
 * the tool result the model is waiting on — feedback bookkeeping must
 * never break the runtime path.
 *
 * [COMP:skills/tool]
 */

import { z } from 'zod'
import { buildTool } from '../tools/types.js'
import { formatSkillInstructions } from './bundle.js'
import type { SkillContent } from './types.js'

const inputSchema = z.object({
  skill: z.string().describe('The skill ID to activate (from the Available Skills listing)'),
})

export type UseSkillToolParams = {
  getAvailableSkills: () => SkillContent[]
  /**
   * Fired on successful skill resolution, keyed by the resolved skill's
   * slug. Optional so existing call-sites and tests that don't track
   * CL-8 counters keep compiling. The callback may be sync or async —
   * the tool fires it best-effort and does not await its result.
   */
  recordInvocation?: (skillSlug: string) => void | Promise<void>
  /** Marks the root as loaded so guarded resource tools can require the
   * progressive-disclosure order: listing → useSkill → resource read. */
  onActivated?: (skillSlug: string) => void
  /**
   * Optional load-time content transform — used by the wiring layer to
   * substitute `{{kind:name}}` support-file pointers with their content
   * before the body reaches the model. Returns the (possibly expanded)
   * content. If it throws, the tool falls back to the raw `skill.content`
   * (expansion must never break the result the model is waiting on).
   */
  expandContent?: (skill: SkillContent) => Promise<string> | string
}

export function createUseSkillTool(params: UseSkillToolParams) {
  return buildTool({
    name: 'useSkill',
    description:
      'Activate a skill to get specialized instructions for a task. ' +
      'Available skills are listed in the system prompt under "# Available Skills". ' +
      'Call this tool with the skill ID when a user request matches a skill\'s use case. ' +
      'The skill\'s full instructions will be returned — follow them to complete the task.',
    inputSchema,

    isConcurrencySafe: true,
    isReadOnly: true,
    requiresConfirmation: false,

    async execute(input) {
      const skills = params.getAvailableSkills()
      const skill = skills.find((s) => s.id === input.skill)

      if (!skill) {
        // Lookup failure must NOT record an invocation — the skill was
        // never picked, just badly addressed.
        //
        // Message-first failure copy (docs/architecture/engine/tool-executor.md
        // → "Failure copy"): the miss names the id, then ships the discovery
        // pointer as the ids that exist RIGHT NOW rather than telling the
        // model to re-read a listing it has evidently already misread.
        const ids = skills.map((s) => s.id)
        const shown = ids.slice(0, 20).join(', ')
        const more = ids.length > 20 ? `, …and ${ids.length - 20} more` : ''
        return {
          data:
            `useSkill activated nothing: no skill with the id "${input.skill}" is available to this assistant. ` +
            (ids.length > 0
              ? `Ids available right now: ${shown}${more}. Copy one VERBATIM — the id is not the skill's display name. `
              : 'This assistant has no skills available at all right now, so no id will resolve — carry on without one. ') +
            'Do NOT retry this exact id.',
          isError: true,
        }
      }
      params.onActivated?.(skill.id)

      // CL-8: count the pick. Best-effort, fire-and-forget — counter
      // bookkeeping must never break the tool result the model needs.
      // We await `void` so a sync throw is still caught by the
      // surrounding try/catch.
      if (params.recordInvocation) {
        try {
          const ret = params.recordInvocation(skill.id)
          if (ret && typeof (ret as Promise<void>).then === 'function') {
            ;(ret as Promise<void>).catch(() => {
              // Swallow — chat route logs at the sink layer. The async
              // branch in particular must not throw upward because
              // execute() has already returned by the time it settles.
            })
          }
        } catch {
          // Sync throw — swallow for the same reason.
        }
      }

      // Bundle v2 is progressive-disclosure: root + compact resource index,
      // never eager resource bodies. Legacy v1 retains pointer expansion.
      let instructions = formatSkillInstructions(skill)
      if (skill.bundleVersion !== 2 && params.expandContent) {
        try {
          instructions = await params.expandContent(skill)
        } catch {
          instructions = skill.content
        }
      }

      // Structural-synthesis Phase 2 (+ the output-contract posture): a skill
      // linked to a blueprint produces that blueprint's TYPED RECORD. Bound
      // context ⇒ the save is part of the job (no ask needed). Two paths:
      // work already done in-context saves directly (`saveBlueprintRecord`,
      // no second model run); a from-scratch synthesis over the brain uses
      // `fillBlueprintFromBrain`. This is dynamic tool-result content (not the
      // Layer-1 system prompt), so naming the tools is fine here; a
      // blueprint-linked skill is workspace-scoped, exactly where both tools
      // are injected. See docs/architecture/brain/structural-synthesis.md.
      if (skill.blueprintId) {
        instructions +=
          `\n\n---\n**This skill is bound to a blueprint.** Its deliverable is the typed record defined by blueprint \`${skill.blueprintId}\` — saving it is part of completing this job, not optional. Do NOT compose the output layout yourself. If you produce the content during this run, persist it with \`saveBlueprintRecord\` (blueprint: "${skill.blueprintId}", a \`subject\` for what this run is about, and \`fields\` keyed by the blueprint's field keys). If the content must instead be synthesized from what the brain already holds, call \`fillBlueprintFromBrain\` with the same blueprint + subject. The blueprint owns the fields and which entities to capture.`
      }

      return {
        data: {
          skill: skill.id,
          name: skill.name,
          instructions,
        },
      }
    },
  })
}
