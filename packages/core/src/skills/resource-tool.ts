/**
 * Progressive-disclosure tools for native skill bundles.
 *
 * Both tools resolve only against the same already-governed skill array that
 * backs `useSkill`; they cannot reveal a disabled or clearance-hidden skill.
 *
 * [COMP:skills/resource-tool]
 */

import { z } from 'zod'
import { buildTool } from '../tools/types.js'
import { findSkillResource, searchSkillResourceContent } from './bundle.js'
import type { SkillContent } from './types.js'

export type SkillResourceToolParams = {
  getAvailableSkills: () => SkillContent[]
  isSkillActivated?: (skillSlug: string) => boolean
}

/**
 * Message-first failure copy for the two resource tools
 * (docs/architecture/engine/tool-executor.md → "Failure copy").
 *
 * These returned `{ error: … }` — and, for the path miss, the multi-key
 * `{ error, validPaths }` the executor serializes as JSON, so the model had
 * to parse JSON to read a sentence and then read the one key that mattered
 * out of it. Every failure is now TEXT: what did not happen on which skill,
 * why, the next call that resolves it, and whether the same arguments can
 * ever work. The valid paths stay in the text — they are the whole remedy.
 */
function bundleUnreadable(
  tool: string,
  verb: string,
  requested: string,
  skill: SkillContent | undefined,
): { data: string; isError: true } {
  const why = skill
    ? `skill "${skill.id}" is a legacy (v1) bundle — its body is returned whole by useSkill and it has no separately addressable resource files`
    : `no skill with the id "${requested}" is available to this assistant (it may not exist, be switched off, or sit above this session's clearance)`
  const next = skill
    ? `Call useSkill with skill "${skill.id}" and read the body it returns.`
    : 'Pick an id VERBATIM from the "# Available Skills" listing in the system prompt — ids are exact and are not the skill\'s display name.'
  return {
    data: `${tool} could not ${verb} skill "${requested}": ${why}. ${next} Do NOT retry this exact skill id.`,
    isError: true,
  }
}

function notActivated(tool: string, verb: string, skillId: string): { data: string; isError: true } {
  return {
    data:
      `${tool} did not ${verb} skill "${skillId}": the skill is not activated in this turn, and a bundle's resources are only reachable after activation (progressive disclosure: listing → useSkill → resource read). ` +
      `Call useSkill with skill "${skillId}" first — its result lists the exact resource paths — then call ${tool} again. Repeating this call before that will fail the same way.`,
    isError: true,
  }
}

const readInputSchema = z.object({
  skill: z.string().describe('Skill ID from the Available Skills listing'),
  path: z.string().describe('Exact relative resource path returned by useSkill'),
})

export function createReadSkillResourceTool(params: SkillResourceToolParams) {
  return buildTool({
    name: 'readSkillResource',
    description:
      'Read one resource from an activated skill bundle by exact relative path. ' +
      'Use only paths listed by useSkill. Scripts are returned as text and are never executed.',
    inputSchema: readInputSchema,
    isConcurrencySafe: true,
    isReadOnly: true,
    requiresConfirmation: false,
    async execute(input) {
      const skill = params.getAvailableSkills().find((candidate) => candidate.id === input.skill)
      if (!skill || skill.bundleVersion !== 2) {
        return bundleUnreadable('readSkillResource', 'read from', input.skill, skill)
      }
      if (params.isSkillActivated && !params.isSkillActivated(skill.id)) {
        return notActivated('readSkillResource', 'read from', skill.id)
      }
      const resource = findSkillResource(skill, input.path)
      if (!resource) {
        const validPaths = (skill.resources ?? []).map((item) => item.path)
        return {
          data:
            `readSkillResource found no resource "${input.path}" in skill "${skill.id}". ` +
            'Resource paths are exact and case-sensitive — a near-miss does not resolve. ' +
            (validPaths.length > 0
              ? `Valid paths in this bundle: ${validPaths.join(', ')}. Copy one verbatim, or call searchSkillResources on "${skill.id}" when several look plausible.`
              : 'This bundle ships no resource files at all, so no path will resolve — use the skill body useSkill already returned.') +
            ' Do NOT retry this exact path.',
          isError: true,
        }
      }
      return {
        data: {
          skill: skill.id,
          path: resource.path,
          kind: resource.kind,
          description: resource.description ?? null,
          content: resource.content,
        },
      }
    },
  })
}

const searchInputSchema = z.object({
  skill: z.string().describe('Skill ID from the Available Skills listing'),
  query: z.string().min(2).describe('Terms to find inside this skill bundle'),
  limit: z.number().int().min(1).max(10).optional().default(5),
})

export function createSearchSkillResourcesTool(params: SkillResourceToolParams) {
  return buildTool({
    name: 'searchSkillResources',
    description:
      'Search paths, descriptions, and text inside one activated skill bundle. ' +
      'Use this when useSkill lists several resources and the relevant path is unclear.',
    inputSchema: searchInputSchema,
    isConcurrencySafe: true,
    isReadOnly: true,
    requiresConfirmation: false,
    async execute(input) {
      const skill = params.getAvailableSkills().find((candidate) => candidate.id === input.skill)
      if (!skill || skill.bundleVersion !== 2) {
        return bundleUnreadable('searchSkillResources', 'search', input.skill, skill)
      }
      if (params.isSkillActivated && !params.isSkillActivated(skill.id)) {
        return notActivated('searchSkillResources', 'search', skill.id)
      }
      const matches = searchSkillResourceContent(skill, input.query, input.limit).map((match) => ({
        path: match.path,
        kind: match.kind,
        description: match.description ?? null,
        score: match.score,
        excerpt: match.excerpt,
      }))
      return { data: { skill: skill.id, query: input.query, matches } }
    },
  })
}
