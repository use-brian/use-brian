/**
 * Deterministic CRM person identity and duplicate-review hard state.
 *
 * Names, emails, phones, aliases, company context, and fuzzy matches are never
 * accepted here. Automatic person mutation has exactly one authority: an
 * active provider-scoped stable identity binding. Keep-separate constraints
 * are equally hard state and are consulted before every merge/candidate read.
 *
 * [COMP:crm/identity-bindings]
 */

import {
  EntityMergeError,
  stableExternalIdentityFromCrmRef,
  type StableExternalIdentity,
} from '@use-brian/core'
import type pg from 'pg'

import { getPool } from './client.js'
import { appendDecisionEvent } from './decision-event-store.js'
import { appendDecisionDerivation } from './decision-provenance-store.js'

type Sensitivity = 'public' | 'internal' | 'confidential' | 'restricted'
type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>

export type CrmIdentityBinding = StableExternalIdentity & {
  id: string
  workspaceId: string
  entityId: string
  sensitivity: Sensitivity
  boundByDecisionEventId: string | null
  boundAt: Date
}

export type CrmIdentityResolution =
  | { status: 'not_found' }
  | { status: 'resolved'; binding: CrmIdentityBinding }
  | { status: 'conflict'; entityIds: string[] }

export type CrmSeparation = {
  id: string
  workspaceId: string
  leftEntityId: string
  rightEntityId: string
  leftName: string
  rightName: string
  reason: string | null
  actorUserId: string
  sensitivity: Sensitivity
  createdByDecisionEventId: string | null
  createdAt: Date
}

export type CrmIdentityBootstrapResult = {
  bindingsCreated: number
  separationsCreated: number
  collisionsSkipped: number
}

function orderedPair(leftEntityId: string, rightEntityId: string): [string, string] {
  if (leftEntityId === rightEntityId) {
    throw new EntityMergeError('self_merge', 'A record cannot be kept separate from itself')
  }
  return leftEntityId < rightEntityId
    ? [leftEntityId, rightEntityId]
    : [rightEntityId, leftEntityId]
}

function maxSensitivity(values: readonly Sensitivity[]): Sensitivity {
  const rank: Record<Sensitivity, number> = {
    public: 0,
    internal: 1,
    confidential: 2,
    restricted: 3,
  }
  return values.reduce((highest, value) => rank[value] > rank[highest] ? value : highest, 'public')
}

function bindingFromRow(row: Record<string, unknown>): CrmIdentityBinding {
  return {
    id: row.id as string,
    workspaceId: row.workspaceId as string,
    provider: row.provider as string,
    providerInstanceKey: row.providerInstanceKey as string,
    subjectId: row.subjectId as string,
    entityId: row.entityId as string,
    sensitivity: row.sensitivity as Sensitivity,
    boundByDecisionEventId: (row.boundByDecisionEventId as string | null) ?? null,
    boundAt: row.boundAt as Date,
  }
}

const BINDING_COLUMNS = `
  id,
  workspace_id                 AS "workspaceId",
  provider,
  provider_instance_key       AS "providerInstanceKey",
  subject_id                  AS "subjectId",
  entity_id                   AS "entityId",
  sensitivity,
  bound_by_decision_event_id  AS "boundByDecisionEventId",
  bound_at                    AS "boundAt"
`

async function lockWorkspace(client: Queryable, workspaceId: string): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [`crm-identity:${workspaceId}`],
  )
}

async function withTransaction<T>(
  transactionClient: pg.PoolClient | undefined,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  if (transactionClient) return fn(transactionClient)
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

export async function resolveCrmPersonIdentity(
  workspaceId: string,
  identity: StableExternalIdentity,
  queryable: Queryable = getPool(),
): Promise<CrmIdentityResolution> {
  const rows = await queryable.query(
    `SELECT ${BINDING_COLUMNS}
       FROM crm_identity_bindings b
       JOIN entities e
         ON e.workspace_id = b.workspace_id AND e.id = b.entity_id
      WHERE b.workspace_id = $1
        AND b.provider = $2
        AND b.provider_instance_key = $3
        AND b.subject_id = $4
        AND b.revoked_at IS NULL
        AND e.kind = 'person'
        AND e.valid_to IS NULL
        AND e.retracted_at IS NULL
        AND NOT COALESCE((e.attributes->>'self')::boolean, false)
      ORDER BY b.bound_at, b.id`,
    [workspaceId, identity.provider, identity.providerInstanceKey, identity.subjectId],
  )
  if (rows.rows.length === 0) return { status: 'not_found' }
  const bindings = rows.rows.map((row) => bindingFromRow(row as Record<string, unknown>))
  const entityIds = [...new Set(bindings.map((binding) => binding.entityId))]
  if (entityIds.length !== 1) return { status: 'conflict', entityIds }
  return { status: 'resolved', binding: bindings[0] }
}

/** Bind an adapter-verified identity. A collision is returned, never chosen. */
export async function bindImportedCrmIdentity(params: {
  workspaceId: string
  entityId: string
  identity: StableExternalIdentity
  sensitivity: Sensitivity
  boundByDecisionEventId?: string | null
}, transactionClient?: pg.PoolClient): Promise<
  | { status: 'bound'; binding: CrmIdentityBinding; inserted: boolean }
  | { status: 'conflict'; entityId: string }
> {
  return withTransaction(transactionClient, async (client) => {
    await lockWorkspace(client, params.workspaceId)
    const entity = await client.query<{ id: string }>(
      `SELECT id FROM entities
        WHERE id = $1 AND workspace_id = $2 AND kind = 'person'
          AND valid_to IS NULL AND retracted_at IS NULL
          AND NOT COALESCE((attributes->>'self')::boolean, false)
        FOR UPDATE`,
      [params.entityId, params.workspaceId],
    )
    if (!entity.rows[0]) throw new Error('Stable identity target must be a live non-self person')

    const current = await client.query(
      `SELECT ${BINDING_COLUMNS}
         FROM crm_identity_bindings
        WHERE workspace_id = $1 AND provider = $2
          AND provider_instance_key = $3 AND subject_id = $4
          AND revoked_at IS NULL
        FOR UPDATE`,
      [
        params.workspaceId,
        params.identity.provider,
        params.identity.providerInstanceKey,
        params.identity.subjectId,
      ],
    )
    if (current.rows[0]) {
      const binding = bindingFromRow(current.rows[0] as Record<string, unknown>)
      return binding.entityId === params.entityId
        ? { status: 'bound' as const, binding, inserted: false }
        : { status: 'conflict' as const, entityId: binding.entityId }
    }

    const inserted = await client.query(
      `INSERT INTO crm_identity_bindings (
         workspace_id, provider, provider_instance_key, subject_id, entity_id,
         sensitivity, bound_by_decision_event_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING ${BINDING_COLUMNS}`,
      [
        params.workspaceId,
        params.identity.provider,
        params.identity.providerInstanceKey,
        params.identity.subjectId,
        params.entityId,
        params.sensitivity,
        params.boundByDecisionEventId ?? null,
      ],
    )
    if (params.boundByDecisionEventId) {
      await appendDecisionDerivation({
        decisionEventId: params.boundByDecisionEventId,
        artifactKind: 'crm_identity_binding',
        artifactId: inserted.rows[0].id as string,
        relation: 'supports',
      }, client)
    }
    return {
      status: 'bound' as const,
      binding: bindingFromRow(inserted.rows[0] as Record<string, unknown>),
      inserted: true,
    }
  })
}

async function lockedPairRows(
  client: pg.PoolClient,
  workspaceId: string,
  leftEntityId: string,
  rightEntityId: string,
): Promise<Array<{
  id: string
  kind: string
  name: string
  sensitivity: Sensitivity
  attributes: Record<string, unknown>
  aliases: string[]
}>> {
  await lockWorkspace(client, workspaceId)
  const result = await client.query<{
    id: string
    kind: string
    name: string
    sensitivity: Sensitivity
    attributes: Record<string, unknown>
    aliases: string[]
  }>(
    `SELECT id, kind, display_name AS name, sensitivity, attributes, aliases
       FROM entities
      WHERE workspace_id = $1 AND id = ANY($2::uuid[])
        AND valid_to IS NULL AND retracted_at IS NULL
        AND NOT COALESCE((attributes->>'self')::boolean, false)
      ORDER BY id
      FOR UPDATE`,
    [workspaceId, [leftEntityId, rightEntityId]],
  )
  if (result.rows.length !== 2 || result.rows[0].kind !== result.rows[1].kind) {
    throw new EntityMergeError(
      'entity_inactive',
      'Both records must be live, non-self records of the same kind',
    )
  }
  return result.rows
}

export async function keepCrmEntitiesSeparate(params: {
  workspaceId: string
  leftEntityId: string
  rightEntityId: string
  actorUserId: string
  assistantId?: string | null
  reason?: string | null
}): Promise<{ separation: CrmSeparation; inserted: boolean }> {
  return withTransaction(undefined, async (client) => {
    const [leftEntityId, rightEntityId] = orderedPair(params.leftEntityId, params.rightEntityId)
    const entities = await lockedPairRows(client, params.workspaceId, leftEntityId, rightEntityId)
    const existing = await client.query(
      `SELECT s.*, le.display_name AS "leftName", re.display_name AS "rightName"
         FROM crm_entity_separations s
         JOIN entities le ON le.id = s.left_entity_id
         JOIN entities re ON re.id = s.right_entity_id
        WHERE s.workspace_id = $1 AND s.left_entity_id = $2
          AND s.right_entity_id = $3 AND s.invalidated_at IS NULL
        FOR UPDATE OF s`,
      [params.workspaceId, leftEntityId, rightEntityId],
    )
    if (existing.rows[0]) return { separation: separationFromRow(existing.rows[0]), inserted: false }

    const sensitivity = maxSensitivity(entities.map((entity) => entity.sensitivity))
    const inserted = await client.query(
      `INSERT INTO crm_entity_separations (
         workspace_id, left_entity_id, right_entity_id, reason,
         actor_user_id, sensitivity
       ) VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [
        params.workspaceId,
        leftEntityId,
        rightEntityId,
        params.reason?.trim().slice(0, 1000) || null,
        params.actorUserId,
        sensitivity,
      ],
    )
    const separationId = inserted.rows[0].id as string
    const captured = await appendDecisionEvent({
      idempotencyKey: `crm-separation:${separationId}:created`,
      workspaceId: params.workspaceId,
      actorUserId: params.actorUserId,
      assistantId: params.assistantId ?? null,
      eventKind: 'crm.entities_kept_separate',
      sourceKind: 'crm_entity_separation',
      sourceId: separationId,
      declaredScope: 'entity',
      visibility: 'workspace',
      sensitivity,
      reason: params.reason ?? null,
      payload: { separationId, leftEntityId, rightEntityId },
    }, client)
    await client.query(
      `UPDATE crm_entity_separations
          SET created_by_decision_event_id = $2
        WHERE id = $1`,
      [separationId, captured.event.id],
    )
    await appendDecisionDerivation({
      decisionEventId: captured.event.id,
      artifactKind: 'crm_entity_separation',
      artifactId: separationId,
      relation: 'supports',
    }, client)
    return {
      separation: {
        ...separationFromRow({
          ...inserted.rows[0],
          created_by_decision_event_id: captured.event.id,
          leftName: entities.find((entity) => entity.id === leftEntityId)!.name,
          rightName: entities.find((entity) => entity.id === rightEntityId)!.name,
        }),
      },
      inserted: true,
    }
  })
}

export async function retireCrmEntitySeparation(params: {
  workspaceId: string
  separationId: string
  actorUserId: string
  assistantId?: string | null
  reason?: string | null
}): Promise<CrmSeparation | null> {
  return withTransaction(undefined, async (client) => {
    await lockWorkspace(client, params.workspaceId)
    const result = await client.query(
      `SELECT s.*, le.display_name AS "leftName", re.display_name AS "rightName"
         FROM crm_entity_separations s
         JOIN entities le ON le.id = s.left_entity_id
         JOIN entities re ON re.id = s.right_entity_id
        WHERE s.id = $1 AND s.workspace_id = $2 AND s.invalidated_at IS NULL
        FOR UPDATE OF s`,
      [params.separationId, params.workspaceId],
    )
    if (!result.rows[0]) return null
    const separation = separationFromRow(result.rows[0])
    const captured = await appendDecisionEvent({
      idempotencyKey: `crm-separation:${separation.id}:retired`,
      workspaceId: params.workspaceId,
      actorUserId: params.actorUserId,
      assistantId: params.assistantId ?? null,
      eventKind: 'crm.separation_retired',
      sourceKind: 'crm_entity_separation',
      sourceId: separation.id,
      declaredScope: 'entity',
      visibility: 'workspace',
      sensitivity: separation.sensitivity,
      reason: params.reason ?? null,
      reversesEventId: separation.createdByDecisionEventId,
      payload: {
        separationId: separation.id,
        leftEntityId: separation.leftEntityId,
        rightEntityId: separation.rightEntityId,
      },
    }, client)
    await client.query(
      `UPDATE crm_entity_separations
          SET invalidated_at = now(), invalidated_by_decision_event_id = $2
        WHERE id = $1`,
      [separation.id, captured.event.id],
    )
    await appendDecisionDerivation({
      decisionEventId: captured.event.id,
      artifactKind: 'crm_entity_separation',
      artifactId: separation.id,
      relation: 'invalidates',
    }, client)
    return separation
  })
}

export async function listActiveCrmEntitySeparations(
  workspaceId: string,
  queryable: Queryable = getPool(),
): Promise<CrmSeparation[]> {
  const result = await queryable.query(
    `SELECT s.*, le.display_name AS "leftName", re.display_name AS "rightName"
       FROM crm_entity_separations s
       JOIN entities le ON le.id = s.left_entity_id
       JOIN entities re ON re.id = s.right_entity_id
      WHERE s.workspace_id = $1 AND s.invalidated_at IS NULL
        AND le.valid_to IS NULL AND le.retracted_at IS NULL
        AND re.valid_to IS NULL AND re.retracted_at IS NULL
      ORDER BY s.created_at DESC, s.id DESC`,
    [workspaceId],
  )
  return result.rows.map(separationFromRow)
}

export async function assertNoActiveCrmSeparation(
  client: pg.PoolClient,
  workspaceId: string,
  leftEntityId: string,
  rightEntityId: string,
): Promise<void> {
  const [left, right] = orderedPair(leftEntityId, rightEntityId)
  const found = await client.query<{ id: string }>(
    `SELECT id FROM crm_entity_separations
      WHERE workspace_id = $1 AND left_entity_id = $2 AND right_entity_id = $3
        AND invalidated_at IS NULL
      FOR UPDATE`,
    [workspaceId, left, right],
  )
  if (found.rows[0]) {
    throw new EntityMergeError(
      'conflict_requires_resolution',
      'These records are marked Keep separate. Choose Review again before merging.',
    )
  }
}

export type PreparedCrmMergeIdentityProjection = {
  workspaceId: string
  survivingEntityId: string
  mergedEntityId: string
  mergedDisplayName: string
  survivingAttributes: Record<string, unknown>
  mergedAttributes: Record<string, unknown>
  sensitivity: Sensitivity
  bindingNamespaces: StableExternalIdentity[]
  aliasArtifactId: string | null
}

/** Lock/revalidate the pair and freeze the deterministic hard-state plan. */
export async function prepareCrmMergeIdentityProjection(
  client: pg.PoolClient,
  params: {
    workspaceId: string
    survivingEntityId: string
    mergedEntityId: string
  },
): Promise<PreparedCrmMergeIdentityProjection> {
  const entities = await lockedPairRows(
    client,
    params.workspaceId,
    params.survivingEntityId,
    params.mergedEntityId,
  )
  await assertNoActiveCrmSeparation(
    client,
    params.workspaceId,
    params.survivingEntityId,
    params.mergedEntityId,
  )
  const survivor = entities.find((entity) => entity.id === params.survivingEntityId)!
  const merged = entities.find((entity) => entity.id === params.mergedEntityId)!

  const existing = await client.query<{
    provider: string
    providerInstanceKey: string
    subjectId: string
    entityId: string
  }>(
    `SELECT provider, provider_instance_key AS "providerInstanceKey",
            subject_id AS "subjectId", entity_id AS "entityId"
       FROM crm_identity_bindings
      WHERE workspace_id = $1 AND entity_id = ANY($2::uuid[])
        AND revoked_at IS NULL
      FOR UPDATE`,
    [params.workspaceId, [params.survivingEntityId, params.mergedEntityId]],
  )
  const identities = new Map<string, StableExternalIdentity>()
  for (const identity of [
    ...existing.rows,
    ...stableIdentitiesFromEntityAttributes(survivor.attributes),
    ...stableIdentitiesFromEntityAttributes(merged.attributes),
  ]) {
    const key = `${identity.provider}\u0000${identity.providerInstanceKey}\u0000${identity.subjectId}`
    identities.set(key, {
      provider: identity.provider,
      providerInstanceKey: identity.providerInstanceKey,
      subjectId: identity.subjectId,
    })
  }

  for (const identity of identities.values()) {
    const collision = await client.query<{ entityId: string }>(
      `SELECT entity_id AS "entityId" FROM crm_identity_bindings
        WHERE workspace_id = $1 AND provider = $2
          AND provider_instance_key = $3 AND subject_id = $4
          AND revoked_at IS NULL
        FOR UPDATE`,
      [
        params.workspaceId,
        identity.provider,
        identity.providerInstanceKey,
        identity.subjectId,
      ],
    )
    if (
      collision.rows[0]
      && collision.rows[0].entityId !== params.survivingEntityId
      && collision.rows[0].entityId !== params.mergedEntityId
    ) {
      throw new EntityMergeError(
        'conflict_requires_resolution',
        'A stable provider identity is already bound to another live person',
      )
    }
  }
  return {
    workspaceId: params.workspaceId,
    survivingEntityId: params.survivingEntityId,
    mergedEntityId: params.mergedEntityId,
    mergedDisplayName: merged.name,
    survivingAttributes: survivor.attributes,
    mergedAttributes: merged.attributes,
    sensitivity: maxSensitivity([survivor.sensitivity, merged.sensitivity]),
    bindingNamespaces: [...identities.values()],
    aliasArtifactId: (() => {
      const alias = merged.name.trim().toLowerCase()
      return alias
        && alias !== survivor.name.trim().toLowerCase()
        && !survivor.aliases.map((value) => value.trim().toLowerCase()).includes(alias)
        ? `${params.survivingEntityId}:${alias}`
        : null
    })(),
  }
}

/** Apply bindings + retrieval alias after the merge event exists. */
export async function applyCrmMergeIdentityProjection(
  client: pg.PoolClient,
  prepared: PreparedCrmMergeIdentityProjection,
  decisionEventId: string,
): Promise<void> {
  for (const identity of prepared.bindingNamespaces) {
    const current = await client.query<{ id: string; entityId: string }>(
      `SELECT id, entity_id AS "entityId" FROM crm_identity_bindings
        WHERE workspace_id = $1 AND provider = $2
          AND provider_instance_key = $3 AND subject_id = $4
          AND revoked_at IS NULL
        FOR UPDATE`,
      [
        prepared.workspaceId,
        identity.provider,
        identity.providerInstanceKey,
        identity.subjectId,
      ],
    )
    if (current.rows[0]?.entityId === prepared.survivingEntityId) continue
    if (current.rows[0]) {
      await client.query(
        `UPDATE crm_identity_bindings
            SET revoked_at = now(), revoked_by_decision_event_id = $2
          WHERE id = $1`,
        [current.rows[0].id, decisionEventId],
      )
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO crm_identity_bindings (
         workspace_id, provider, provider_instance_key, subject_id, entity_id,
         sensitivity, bound_by_decision_event_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id`,
      [
        prepared.workspaceId,
        identity.provider,
        identity.providerInstanceKey,
        identity.subjectId,
        prepared.survivingEntityId,
        prepared.sensitivity,
        decisionEventId,
      ],
    )
    await appendDecisionDerivation({
      decisionEventId,
      artifactKind: 'crm_identity_binding',
      artifactId: inserted.rows[0].id,
      relation: 'supports',
    }, client)
  }

  const alias = prepared.mergedDisplayName.trim().toLowerCase()
  if (prepared.aliasArtifactId) {
    await client.query(
      `UPDATE entities
          SET aliases = ARRAY(
                SELECT DISTINCT value
                  FROM unnest(aliases || ARRAY[$2]::text[]) AS value
              ),
              updated_at = now()
        WHERE id = $1 AND workspace_id = $3`,
      [prepared.survivingEntityId, alias, prepared.workspaceId],
    )
    await appendDecisionDerivation({
      decisionEventId,
      artifactKind: 'entity_alias',
      artifactId: prepared.aliasArtifactId,
      relation: 'supports',
    }, client)
  }
}

/** Reverse every merge-derived hard-state artifact and suppress the pair. */
export async function applyCrmUndoIdentityProjection(
  client: pg.PoolClient,
  params: {
    workspaceId: string
    survivingEntityId: string
    restoredEntityId: string
    restoredDisplayName: string
    restoredAttributes: Record<string, unknown>
    actorUserId: string
    reason: string | null
    originalDecisionEventId: string
    undoDecisionEventId: string
    sensitivity: Sensitivity
  },
): Promise<string> {
  await lockWorkspace(client, params.workspaceId)
  const mergeBindings = await client.query<{
    id: string
    provider: string
    providerInstanceKey: string
    subjectId: string
  }>(
    `UPDATE crm_identity_bindings
        SET revoked_at = now(), revoked_by_decision_event_id = $2
      WHERE workspace_id = $1
        AND bound_by_decision_event_id = $3
        AND revoked_at IS NULL
      RETURNING id, provider, provider_instance_key AS "providerInstanceKey",
                subject_id AS "subjectId"`,
    [params.workspaceId, params.undoDecisionEventId, params.originalDecisionEventId],
  )
  for (const binding of mergeBindings.rows) {
    await appendDecisionDerivation({
      decisionEventId: params.undoDecisionEventId,
      artifactKind: 'crm_identity_binding',
      artifactId: binding.id,
      relation: 'invalidates',
    }, client)
  }

  // Restore namespaces that belonged to the restored row before the merge.
  const prior = await client.query<{
    provider: string
    providerInstanceKey: string
    subjectId: string
  }>(
    `SELECT provider, provider_instance_key AS "providerInstanceKey",
            subject_id AS "subjectId"
       FROM crm_identity_bindings
      WHERE workspace_id = $1 AND entity_id = $2
        AND revoked_by_decision_event_id = $3`,
    [params.workspaceId, params.restoredEntityId, params.originalDecisionEventId],
  )
  const restoreIdentities = new Map<string, StableExternalIdentity>()
  for (const identity of [
    ...prior.rows,
    ...stableIdentitiesFromEntityAttributes(params.restoredAttributes),
  ]) {
    restoreIdentities.set(
      `${identity.provider}\u0000${identity.providerInstanceKey}\u0000${identity.subjectId}`,
      identity,
    )
  }
  for (const identity of restoreIdentities.values()) {
    const rebound = await client.query<{ id: string }>(
      `INSERT INTO crm_identity_bindings (
         workspace_id, provider, provider_instance_key, subject_id, entity_id,
         sensitivity, bound_by_decision_event_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (workspace_id, provider, provider_instance_key, subject_id)
         WHERE revoked_at IS NULL DO NOTHING
       RETURNING id`,
      [
        params.workspaceId,
        identity.provider,
        identity.providerInstanceKey,
        identity.subjectId,
        params.restoredEntityId,
        params.sensitivity,
        params.undoDecisionEventId,
      ],
    )
    if (rebound.rows[0]) {
      await appendDecisionDerivation({
        decisionEventId: params.undoDecisionEventId,
        artifactKind: 'crm_identity_binding',
        artifactId: rebound.rows[0].id,
        relation: 'supports',
      }, client)
    }
  }

  const alias = params.restoredDisplayName.trim().toLowerCase()
  if (alias) {
    const artifactId = `${params.survivingEntityId}:${alias}`
    const derived = await client.query<{ id: string }>(
      `SELECT id FROM decision_derivations
        WHERE decision_event_id = $1 AND artifact_kind = 'entity_alias'
          AND artifact_id = $2 AND relation = 'supports'
        FOR UPDATE`,
      [params.originalDecisionEventId, artifactId],
    )
    if (derived.rows[0]) {
      await client.query(
        `UPDATE entities
            SET aliases = array_remove(aliases, $2), updated_at = now()
          WHERE id = $1 AND workspace_id = $3`,
        [params.survivingEntityId, alias, params.workspaceId],
      )
      await appendDecisionDerivation({
        decisionEventId: params.undoDecisionEventId,
        artifactKind: 'entity_alias',
        artifactId,
        relation: 'invalidates',
      }, client)
    }
  }

  const [leftEntityId, rightEntityId] = orderedPair(
    params.survivingEntityId,
    params.restoredEntityId,
  )
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO crm_entity_separations (
       workspace_id, left_entity_id, right_entity_id, reason, actor_user_id,
       sensitivity, created_by_decision_event_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (workspace_id, left_entity_id, right_entity_id)
       WHERE invalidated_at IS NULL DO UPDATE SET reason = EXCLUDED.reason
     RETURNING id`,
    [
      params.workspaceId,
      leftEntityId,
      rightEntityId,
      params.reason,
      params.actorUserId,
      params.sensitivity,
      params.undoDecisionEventId,
    ],
  )
  await appendDecisionDerivation({
    decisionEventId: params.undoDecisionEventId,
    artifactKind: 'crm_entity_separation',
    artifactId: inserted.rows[0].id,
    relation: 'supports',
  }, client)
  return inserted.rows[0].id
}

export function stableIdentitiesFromEntityAttributes(
  attributes: Record<string, unknown>,
): StableExternalIdentity[] {
  const identity = stableExternalIdentityFromCrmRef(attributes.external_ref)
  return identity ? [identity] : []
}

function separationFromRow(row: Record<string, unknown>): CrmSeparation {
  return {
    id: row.id as string,
    workspaceId: (row.workspaceId ?? row.workspace_id) as string,
    leftEntityId: (row.leftEntityId ?? row.left_entity_id) as string,
    rightEntityId: (row.rightEntityId ?? row.right_entity_id) as string,
    leftName: row.leftName as string,
    rightName: row.rightName as string,
    reason: (row.reason as string | null) ?? null,
    actorUserId: (row.actorUserId ?? row.actor_user_id) as string,
    sensitivity: row.sensitivity as Sensitivity,
    createdByDecisionEventId:
      (row.createdByDecisionEventId ?? row.created_by_decision_event_id ?? null) as string | null,
    createdAt: (row.createdAt ?? row.created_at) as Date,
  }
}

/**
 * Idempotent historical pass. Only provider-complete external refs from live
 * merge participants become bindings. Undone pairs receive a separation.
 * Namespace collisions are counted and left unresolved for human review.
 */
export async function bootstrapHistoricalCrmIdentityState(): Promise<CrmIdentityBootstrapResult> {
  const result: CrmIdentityBootstrapResult = {
    bindingsCreated: 0,
    separationsCreated: 0,
    collisionsSkipped: 0,
  }
  const merges = await getPool().query<{
    id: string
    workspaceId: string
    survivingId: string
    mergedId: string
    undoneAt: Date | null
    mergedBy: string
    attributes: Record<string, unknown>
    sensitivity: Sensitivity
    decisionEventId: string
    undoDecisionEventId: string | null
  }>(
    `SELECT em.id, em.workspace_id AS "workspaceId",
            em.surviving_id AS "survivingId", em.merged_id AS "mergedId",
            em.undone_at AS "undoneAt",
            COALESCE(em.undone_by, em.merged_by, w.owner_user_id) AS "mergedBy",
            e.attributes, e.sensitivity,
            de.id AS "decisionEventId",
            undo_event.id AS "undoDecisionEventId"
       FROM entity_merges em
       JOIN workspaces w ON w.id = em.workspace_id
       JOIN entities e ON e.id = em.merged_id
       JOIN decision_events de
         ON de.idempotency_key = 'merge:' || em.id::text || ':confirmed'
       LEFT JOIN decision_events undo_event
         ON undo_event.idempotency_key = 'merge:' || em.id::text || ':undone'
      ORDER BY em.created_at, em.id`,
  )
  for (const merge of merges.rows) {
    if (merge.undoneAt) {
      if (!merge.undoDecisionEventId) continue
      const inserted = await withTransaction(undefined, async (client) => {
        const [leftEntityId, rightEntityId] = orderedPair(merge.survivingId, merge.mergedId)
        const entities = await lockedPairRows(
          client,
          merge.workspaceId,
          leftEntityId,
          rightEntityId,
        )
        const separation = await client.query<{ id: string }>(
          `INSERT INTO crm_entity_separations (
             workspace_id, left_entity_id, right_entity_id, reason,
             actor_user_id, sensitivity, created_by_decision_event_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (workspace_id, left_entity_id, right_entity_id)
             WHERE invalidated_at IS NULL DO NOTHING
           RETURNING id`,
          [
            merge.workspaceId,
            leftEntityId,
            rightEntityId,
            'Historical merge undo',
            merge.mergedBy,
            maxSensitivity(entities.map((entity) => entity.sensitivity)),
            merge.undoDecisionEventId,
          ],
        )
        if (!separation.rows[0]) return false
        await appendDecisionDerivation({
          decisionEventId: merge.undoDecisionEventId!,
          artifactKind: 'crm_entity_separation',
          artifactId: separation.rows[0].id,
          relation: 'supports',
        }, client)
        return true
      }).catch(() => false)
      if (inserted) result.separationsCreated += 1
      continue
    }
    for (const identity of stableIdentitiesFromEntityAttributes(merge.attributes)) {
      const bound = await bindImportedCrmIdentity({
        workspaceId: merge.workspaceId,
        entityId: merge.survivingId,
        identity,
        sensitivity: merge.sensitivity,
        boundByDecisionEventId: merge.decisionEventId,
      })
      if (bound.status === 'conflict') result.collisionsSkipped += 1
      else if (bound.inserted) result.bindingsCreated += 1
    }
  }
  return result
}
