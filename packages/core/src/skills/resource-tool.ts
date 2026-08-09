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
        return {
          data: { error: `Skill "${input.skill}" has no readable native bundle.` },
          isError: true,
        }
      }
      if (params.isSkillActivated && !params.isSkillActivated(skill.id)) {
        return {
          data: { error: `Activate skill "${skill.id}" with useSkill before reading its resources.` },
          isError: true,
        }
      }
      const resource = findSkillResource(skill, input.path)
      if (!resource) {
        return {
          data: {
            error: `Resource "${input.path}" was not found in skill "${input.skill}".`,
            validPaths: (skill.resources ?? []).map((item) => item.path),
          },
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
        return {
          data: { error: `Skill "${input.skill}" has no searchable native bundle.` },
          isError: true,
        }
      }
      if (params.isSkillActivated && !params.isSkillActivated(skill.id)) {
        return {
          data: { error: `Activate skill "${skill.id}" with useSkill before searching its resources.` },
          isError: true,
        }
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
