/**
 * useSkill tool — the model calls this to activate a skill.
 *
 * Mirrors Claude Code's Skill tool pattern: the model sees a compact listing
 * in the system prompt, then invokes this tool by skill ID to load the full
 * prompt content. The content is returned as the tool result — the model
 * reads it and follows the instructions.
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
        return {
          data: {
            error: `Skill "${input.skill}" not found. Check the Available Skills listing for valid IDs.`,
          },
          isError: true,
        }
      }

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

      // Load-time pointer expansion (best-effort). A lookup/DB failure must
      // never break the skill the model picked, so fall back to raw content.
      let instructions = skill.content
      if (params.expandContent) {
        try {
          instructions = await params.expandContent(skill)
        } catch {
          instructions = skill.content
        }
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
