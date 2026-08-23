/**
 * Workspace KB capture rules (migration 458).
 *
 * Interactive assistants are read-only by default. A deterministic phrase
 * match against the newest human turn is the only path that authorizes the
 * two KB write tools; the matched rule also fixes their destination and path
 * scope. Explicit workflow tool_call steps remain separately governed by the
 * workflow definition + approval pause.
 *
 * [COMP:knowledge/capture-rules]
 */

import { z } from 'zod'
import { query } from '../db/client.js'
import type { Sensitivity } from '@use-brian/core'

export type KnowledgeCaptureRule = {
  id: string
  workspaceId: string
  name: string
  matchPhrases: string[]
  instructions: string
  targetSourceId: string | null
  pathPrefix: string
  defaultSensitivity: Sensitivity
  enabled: boolean
  createdBy: string | null
  createdAt: Date
  updatedAt: Date
}

const normalizedPathPrefix = z.string().trim().max(240).transform((value, ctx) => {
  const normalized = value.replace(/^\/+|\/+$/g, '')
  const segments = normalized.length > 0 ? normalized.split('/') : []
  if (
    value.includes('\\')
    || value.includes('\0')
    || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    ctx.addIssue({ code: 'custom', message: 'pathPrefix must be a relative knowledge path' })
    return z.NEVER
  }
  return normalized
})

export const KnowledgeCaptureRuleInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  matchPhrases: z.array(z.string().trim().min(1).max(100)).min(1).max(32)
    .transform((values) => [...new Set(values.map((value) => value.normalize('NFKC')))]),
  instructions: z.string().trim().min(1).max(1000),
  targetSourceId: z.string().uuid().nullable(),
  pathPrefix: normalizedPathPrefix.default(''),
  defaultSensitivity: z.enum(['public', 'internal', 'confidential']).default('internal'),
  enabled: z.boolean().default(true),
})

export type KnowledgeCaptureRuleInput = z.infer<typeof KnowledgeCaptureRuleInputSchema>

export type KnowledgeCaptureRuleStore = {
  listForWorkspace(workspaceId: string): Promise<KnowledgeCaptureRule[]>
  listEnabledForWorkspace(workspaceId: string): Promise<KnowledgeCaptureRule[]>
  create(params: KnowledgeCaptureRuleInput & { workspaceId: string; createdBy: string }): Promise<KnowledgeCaptureRule>
  update(params: KnowledgeCaptureRuleInput & { id: string; workspaceId: string }): Promise<KnowledgeCaptureRule | null>
  delete(id: string, workspaceId: string): Promise<boolean>
}

const RULE_COLUMNS = `
  id, workspace_id AS "workspaceId", name,
  match_phrases AS "matchPhrases", instructions,
  target_source_id AS "targetSourceId", path_prefix AS "pathPrefix",
  default_sensitivity AS "defaultSensitivity", enabled,
  created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"
` as const

export function createDbKnowledgeCaptureRuleStore(): KnowledgeCaptureRuleStore {
  return {
    async listForWorkspace(workspaceId) {
      const result = await query<KnowledgeCaptureRule>(
        `SELECT ${RULE_COLUMNS}
         FROM knowledge_capture_rules
         WHERE workspace_id = $1
         ORDER BY created_at ASC, id ASC`,
        [workspaceId],
      )
      return result.rows
    },

    async listEnabledForWorkspace(workspaceId) {
      const result = await query<KnowledgeCaptureRule>(
        `SELECT ${RULE_COLUMNS}
         FROM knowledge_capture_rules
         WHERE workspace_id = $1 AND enabled = true
         ORDER BY created_at ASC, id ASC`,
        [workspaceId],
      )
      return result.rows
    },

    async create({ workspaceId, createdBy, ...input }) {
      const result = await query<KnowledgeCaptureRule>(
        `INSERT INTO knowledge_capture_rules
           (workspace_id, name, match_phrases, instructions, target_source_id,
            path_prefix, default_sensitivity, enabled, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING ${RULE_COLUMNS}`,
        [
          workspaceId, input.name, input.matchPhrases, input.instructions,
          input.targetSourceId, input.pathPrefix, input.defaultSensitivity,
          input.enabled, createdBy,
        ],
      )
      return result.rows[0]
    },

    async update({ id, workspaceId, ...input }) {
      const result = await query<KnowledgeCaptureRule>(
        `UPDATE knowledge_capture_rules SET
           name = $3, match_phrases = $4, instructions = $5,
           target_source_id = $6, path_prefix = $7,
           default_sensitivity = $8, enabled = $9, updated_at = now()
         WHERE id = $1 AND workspace_id = $2
         RETURNING ${RULE_COLUMNS}`,
        [
          id, workspaceId, input.name, input.matchPhrases, input.instructions,
          input.targetSourceId, input.pathPrefix, input.defaultSensitivity,
          input.enabled,
        ],
      )
      return result.rows[0] ?? null
    },

    async delete(id, workspaceId) {
      const result = await query(
        `DELETE FROM knowledge_capture_rules WHERE id = $1 AND workspace_id = $2`,
        [id, workspaceId],
      )
      return (result.rowCount ?? 0) > 0
    },
  }
}

function normalizedMatchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim()
}

/** Literal phrase OR over the newest human turn. Empty text/phrases fail closed. */
export function matchesKnowledgeCaptureRule(rule: KnowledgeCaptureRule, newestHumanText: string): boolean {
  if (!rule.enabled) return false
  const haystack = normalizedMatchText(newestHumanText)
  if (!haystack) return false
  return rule.matchPhrases.some((phrase) => {
    const needle = normalizedMatchText(phrase)
    return needle.length > 0 && haystack.includes(needle)
  })
}

export function matchKnowledgeCaptureRules(
  rules: readonly KnowledgeCaptureRule[],
  newestHumanText: string,
): KnowledgeCaptureRule[] {
  return rules.filter((rule) => matchesKnowledgeCaptureRule(rule, newestHumanText))
}

export type UsableKnowledgeCaptureRule = KnowledgeCaptureRule & {
  targetLabel: string
}

/**
 * Trusted per-turn instruction. It is emitted only after the injector has
 * proven the matching rules' destinations are usable and has built the write
 * tools, so capability language cannot drift from the live tool surface.
 */
export function buildKnowledgeCapturePrompt(rules: readonly UsableKnowledgeCaptureRule[]): string {
  if (rules.length === 0) return ''
  const lines = rules.map((rule) => [
    `- Rule id: ${rule.id}`,
    `  Category: ${rule.name}`,
    `  Destination: ${rule.targetLabel}`,
    `  Path scope: ${rule.pathPrefix ? `${rule.pathPrefix}/...` : 'any path in that destination'}`,
    `  Default sensitivity: ${rule.defaultSensitivity}`,
    `  Capture guidance: ${rule.instructions}`,
  ].join('\n'))
  return [
    '# Knowledge capture',
    '',
    'The newest human message matched the workspace capture categories below. Finish the requested task first. Then, without asking a prose confirmation, propose a knowledge capture only when this turn produced durable new or changed information covered by a matched category.',
    'Prefer updating an existing matching entry over creating a duplicate. Do not capture transient chat, speculation, or facts outside the matched guidance. The approval interface is the human confirmation; if no durable fact changed, make no write.',
    '',
    ...lines,
  ].join('\n')
}
