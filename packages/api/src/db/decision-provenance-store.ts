/**
 * Cross-domain decision derivations and content-free application records.
 * Domain artifacts remain authoritative; these rows only explain support,
 * contradiction, invalidation, and exact prompt application.
 *
 * [COMP:api/decision-provenance-store]
 */

import type pg from 'pg'
import { z } from 'zod'

import { getPool } from './client.js'

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>

export const decisionArtifactRefSchema = z.object({
  kind: z.string().trim().min(1).max(64),
  id: z.string().trim().min(1).max(512),
}).strict()

const derivationInputSchema = z.object({
  decisionEventId: z.string().uuid(),
  artifactKind: z.string().trim().min(1).max(64),
  artifactId: z.string().trim().min(1).max(512),
  relation: z.enum(['supports', 'contradicts', 'invalidates']),
}).strict()

const applicationInputSchema = z.object({
  workspaceId: z.string().uuid().nullable(),
  actorUserId: z.string().uuid(),
  assistantId: z.string().uuid().nullable(),
  operationKind: z.string().trim().min(1).max(64),
  operationId: z.string().trim().min(1).max(512),
  artifactRefs: z.array(decisionArtifactRefSchema).min(1).max(20),
  sourceKind: z.string().trim().min(1).max(64).nullable().optional().default(null),
  sourceId: z.string().trim().min(1).max(512).nullable().optional().default(null),
  visibility: z.enum(['owner', 'workspace']),
  sensitivity: z.enum(['public', 'internal', 'confidential', 'restricted']),
}).strict()

export type DecisionArtifactRef = z.infer<typeof decisionArtifactRefSchema>
export type DecisionDerivationRelation = z.infer<typeof derivationInputSchema>['relation']
export type AppendDecisionApplicationInput = z.input<typeof applicationInputSchema>

export async function appendDecisionDerivation(
  input: z.input<typeof derivationInputSchema>,
  client?: pg.PoolClient,
): Promise<{ id: string; inserted: boolean }> {
  const parsed = derivationInputSchema.parse(input)
  const exec: Queryable = client ?? getPool()
  const result = await exec.query<{ id: string }>(
    `INSERT INTO decision_derivations (
       decision_event_id, workspace_id, artifact_kind, artifact_id, relation
     )
     SELECT $1, workspace_id, $2, $3, $4
       FROM decision_events
      WHERE id = $1
     ON CONFLICT (decision_event_id, artifact_kind, artifact_id, relation) DO NOTHING
     RETURNING id`,
    [parsed.decisionEventId, parsed.artifactKind, parsed.artifactId, parsed.relation],
  )
  if (result.rows[0]) return { id: result.rows[0].id, inserted: true }

  const existing = await exec.query<{ id: string }>(
    `SELECT id FROM decision_derivations
      WHERE decision_event_id = $1 AND artifact_kind = $2
        AND artifact_id = $3 AND relation = $4`,
    [parsed.decisionEventId, parsed.artifactKind, parsed.artifactId, parsed.relation],
  )
  if (!existing.rows[0]) throw new Error('Decision derivation conflicted but could not be read')
  return { id: existing.rows[0].id, inserted: false }
}

export async function appendDecisionApplication(
  input: AppendDecisionApplicationInput,
  client?: pg.PoolClient,
): Promise<{ id: string }> {
  const parsed = applicationInputSchema.parse(input)
  const exec: Queryable = client ?? getPool()
  const result = await exec.query<{ id: string }>(
    `INSERT INTO decision_applications (
       workspace_id, actor_user_id, assistant_id, operation_kind, operation_id,
       artifact_refs, source_kind, source_id, visibility, sensitivity
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
     ON CONFLICT (actor_user_id, assistant_id, operation_kind, operation_id)
       WHERE assistant_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      parsed.workspaceId,
      parsed.actorUserId,
      parsed.assistantId,
      parsed.operationKind,
      parsed.operationId,
      JSON.stringify(parsed.artifactRefs),
      parsed.sourceKind,
      parsed.sourceId,
      parsed.visibility,
      parsed.sensitivity,
    ],
  )
  if (result.rows[0]) return result.rows[0]
  const existing = await exec.query<{ id: string }>(
    `SELECT id FROM decision_applications
      WHERE actor_user_id = $1
        AND assistant_id IS NOT DISTINCT FROM $2::uuid
        AND operation_kind = $3 AND operation_id = $4`,
    [parsed.actorUserId, parsed.assistantId, parsed.operationKind, parsed.operationId],
  )
  if (!existing.rows[0]) {
    throw new Error('Decision application conflicted but could not be read')
  }
  return existing.rows[0]
}

export async function listDecisionDerivationsForArtifact(params: {
  artifactKind: string
  artifactId: string
}): Promise<Array<{
  decisionEventId: string
  relation: DecisionDerivationRelation
  createdAt: Date
}>> {
  const parsed = decisionArtifactRefSchema.parse({ kind: params.artifactKind, id: params.artifactId })
  const result = await getPool().query(
    `SELECT decision_event_id AS "decisionEventId", relation, created_at AS "createdAt"
       FROM decision_derivations
      WHERE artifact_kind = $1 AND artifact_id = $2
      ORDER BY created_at DESC, id DESC`,
    [parsed.kind, parsed.id],
  )
  return result.rows as Array<{
    decisionEventId: string
    relation: DecisionDerivationRelation
    createdAt: Date
  }>
}
