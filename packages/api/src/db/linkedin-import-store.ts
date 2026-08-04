/**
 * Durable queue, row ledger, exact-identity map, and bulk graph writer for the
 * lossless LinkedIn importer.
 *
 * [COMP:api/linkedin-import-store]
 */

import type { PoolClient } from 'pg'

import { getPool, query } from './client.js'
import type {
  ExternalIdentity,
  LinkedInImportRun,
  LinkedInLedgerRow,
  LinkedInProjection,
} from '../linkedin-import/types.js'
import { normalizeEmail, normalizePhone } from '../linkedin-import/projector.js'

const MAX_ATTEMPTS = 3
const STALE_LEASE_MINUTES = 15

const RUN_RETURNING = `
  id,
  workspace_id AS "workspaceId",
  acting_user_id AS "actingUserId",
  assistant_id AS "assistantId",
  archive_file_id AS "archiveFileId",
  archive_name AS "archiveName",
  archive_sha256 AS "archiveSha256",
  archive_size_bytes AS "archiveSizeBytes",
  status,
  stage,
  attempts,
  last_error AS "lastError",
  lease_token AS "leaseToken",
  member_count AS "memberCount",
  completed_member_count AS "completedMemberCount",
  row_count AS "rowCount",
  mapped_count AS "mappedCount",
  stored_count AS "storedCount",
  unresolved_count AS "unresolvedCount",
  malformed_count AS "malformedCount",
  entity_count AS "entityCount",
  edge_count AS "edgeCount",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  completed_at AS "completedAt"
`

type RunRow = Omit<LinkedInImportRun, 'archiveSizeBytes'> & { archiveSizeBytes: number | string }

function toRun(row: RunRow): LinkedInImportRun {
  return { ...row, archiveSizeBytes: Number(row.archiveSizeBytes) }
}

export type LinkedInImportMember = {
  id: string
  runId: string
  memberPath: string
  fileId: string | null
  parseStatus: 'pending' | 'completed' | 'failed' | 'stored'
}

const MEMBER_RETURNING = `
  id,
  run_id AS "runId",
  member_path AS "memberPath",
  file_id AS "fileId",
  parse_status AS "parseStatus"
`

export async function getLinkedInImportRun(id: string): Promise<LinkedInImportRun | null> {
  const result = await query<RunRow>(`SELECT ${RUN_RETURNING} FROM linkedin_import_runs WHERE id = $1`, [id])
  return result.rows[0] ? toRun(result.rows[0]) : null
}

export async function findLinkedInImportRunByHash(
  workspaceId: string,
  actingUserId: string,
  archiveSha256: string,
): Promise<LinkedInImportRun | null> {
  const result = await query<RunRow>(
    `SELECT ${RUN_RETURNING}
       FROM linkedin_import_runs
      WHERE workspace_id = $1 AND acting_user_id = $2 AND archive_sha256 = $3`,
    [workspaceId, actingUserId, archiveSha256],
  )
  return result.rows[0] ? toRun(result.rows[0]) : null
}

export async function createOrGetLinkedInImportRun(input: {
  workspaceId: string
  actingUserId: string
  assistantId: string | null
  archiveFileId: string
  archiveName: string
  archiveSha256: string
  archiveSizeBytes: number
}): Promise<{ run: LinkedInImportRun; created: boolean }> {
  const result = await query<RunRow & { inserted: boolean }>(
    `INSERT INTO linkedin_import_runs (
       workspace_id, acting_user_id, assistant_id, archive_file_id,
       archive_name, archive_sha256, archive_size_bytes
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (workspace_id, acting_user_id, archive_sha256) DO UPDATE
       SET archive_file_id = COALESCE(linkedin_import_runs.archive_file_id, EXCLUDED.archive_file_id),
           status = CASE WHEN linkedin_import_runs.status = 'failed' THEN 'pending' ELSE linkedin_import_runs.status END,
           stage = CASE WHEN linkedin_import_runs.status = 'failed' THEN 'requeued' ELSE linkedin_import_runs.stage END,
           attempts = CASE WHEN linkedin_import_runs.status = 'failed' THEN 0 ELSE linkedin_import_runs.attempts END,
           last_error = CASE WHEN linkedin_import_runs.status = 'failed' THEN NULL ELSE linkedin_import_runs.last_error END,
           locked_at = CASE WHEN linkedin_import_runs.status = 'failed' THEN NULL ELSE linkedin_import_runs.locked_at END,
           lease_token = CASE WHEN linkedin_import_runs.status = 'failed' THEN NULL ELSE linkedin_import_runs.lease_token END,
           updated_at = now()
     RETURNING ${RUN_RETURNING}, (xmax = 0) AS inserted`,
    [
      input.workspaceId,
      input.actingUserId,
      input.assistantId,
      input.archiveFileId,
      input.archiveName,
      input.archiveSha256,
      input.archiveSizeBytes,
    ],
  )
  return { run: toRun(result.rows[0]), created: result.rows[0].inserted }
}

export async function claimNextLinkedInImportRun(): Promise<LinkedInImportRun | null> {
  await query(
    `UPDATE linkedin_import_runs
        SET status = CASE WHEN attempts >= $1 THEN 'failed' ELSE 'pending' END,
            stage = CASE WHEN attempts >= $1 THEN 'failed_stale_lease' ELSE 'requeued_stale_lease' END,
            last_error = 'Worker lease expired before completion',
            locked_at = NULL,
            lease_token = NULL,
            updated_at = now()
      WHERE status = 'processing'
        AND locked_at < now() - make_interval(mins => $2)`,
    [MAX_ATTEMPTS, STALE_LEASE_MINUTES],
  )
  const result = await query<RunRow>(
    `UPDATE linkedin_import_runs
        SET status = 'processing',
            stage = 'reading_archive',
            attempts = attempts + 1,
            started_at = COALESCE(started_at, now()),
            locked_at = now(),
            lease_token = gen_random_uuid(),
            updated_at = now()
      WHERE id = (
        SELECT id
          FROM linkedin_import_runs
         WHERE status = 'pending' AND attempts < $1
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING ${RUN_RETURNING}`,
    [MAX_ATTEMPTS],
  )
  return result.rows[0] ? toRun(result.rows[0]) : null
}

export async function setLinkedInImportStage(
  runId: string,
  leaseToken: string,
  stage: string,
): Promise<void> {
  const result = await query<{ id: string }>(
    `UPDATE linkedin_import_runs
        SET stage = $3, locked_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'processing' AND lease_token = $2
      RETURNING id`,
    [runId, leaseToken, stage],
  )
  if (!result.rows[0]) throw new Error(`LinkedIn import ${runId} lost its worker lease`)
}

export async function markLinkedInImportFailed(
  runId: string,
  leaseToken: string,
  error: string,
): Promise<{ retrying: boolean }> {
  const result = await query<{ attempts: number; status: string }>(
    `UPDATE linkedin_import_runs
        SET status = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'pending' END,
            stage = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'retry_pending' END,
            last_error = $3,
            locked_at = NULL,
            lease_token = NULL,
            updated_at = now()
      WHERE id = $1 AND status = 'processing' AND lease_token = $4
      RETURNING attempts, status`,
    [runId, MAX_ATTEMPTS, error.slice(0, 4000), leaseToken],
  )
  return { retrying: result.rows[0]?.status === 'pending' }
}

export async function upsertLinkedInImportMember(input: {
  runId: string
  workspaceId: string
  memberPath: string
  contentSha256: string
  compressedSize: number | null
  sizeBytes: number
  mime: string
}): Promise<LinkedInImportMember> {
  const result = await query<LinkedInImportMember>(
    `INSERT INTO linkedin_import_members (
       run_id, workspace_id, member_path, content_sha256,
       compressed_size, size_bytes, mime
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (run_id, member_path) DO UPDATE
       SET content_sha256 = EXCLUDED.content_sha256,
           compressed_size = EXCLUDED.compressed_size,
           size_bytes = EXCLUDED.size_bytes,
           mime = EXCLUDED.mime,
           updated_at = now()
     RETURNING ${MEMBER_RETURNING}`,
    [
      input.runId,
      input.workspaceId,
      input.memberPath,
      input.contentSha256,
      input.compressedSize,
      input.sizeBytes,
      input.mime,
    ],
  )
  return result.rows[0]
}

export async function setLinkedInMemberArtifact(memberId: string, fileId: string): Promise<void> {
  await query(
    `UPDATE linkedin_import_members SET file_id = $2, updated_at = now() WHERE id = $1`,
    [memberId, fileId],
  )
}

export async function completeLinkedInImportMember(input: {
  memberId: string
  status: 'completed' | 'stored'
  headerRowOrdinal: number | null
  headerCells: string[] | null
  recordCount: number
}): Promise<void> {
  await query(
    `UPDATE linkedin_import_members
        SET parse_status = $2,
            header_row_ordinal = $3,
            header_cells = $4::jsonb,
            record_count = $5,
            last_error = NULL,
            updated_at = now()
      WHERE id = $1`,
    [
      input.memberId,
      input.status,
      input.headerRowOrdinal,
      input.headerCells ? JSON.stringify(input.headerCells) : null,
      input.recordCount,
    ],
  )
}

export async function failLinkedInImportMember(memberId: string, error: string): Promise<void> {
  await query(
    `UPDATE linkedin_import_members
        SET parse_status = 'failed', last_error = $2, updated_at = now()
      WHERE id = $1`,
    [memberId, error.slice(0, 2000)],
  )
}

export async function upsertLinkedInImportRows(input: {
  runId: string
  memberId: string
  workspaceId: string
  rows: LinkedInLedgerRow[]
}): Promise<void> {
  const chunkSize = 500
  for (let offset = 0; offset < input.rows.length; offset += chunkSize) {
    const rows = input.rows.slice(offset, offset + chunkSize).map((row) => ({
      member_path: row.memberPath,
      row_ordinal: row.rowOrdinal,
      data_ordinal: row.dataOrdinal,
      record_kind: row.recordKind,
      start_line: row.startLine,
      end_line: row.endLine,
      cells: row.cells,
      values: row.values,
      raw_sha256: row.rawSha256,
      outcome: row.outcome,
      outcome_reason: row.outcomeReason,
      entity_ids: row.entityIds,
    }))
    await query(
      `INSERT INTO linkedin_import_rows (
         run_id, member_id, workspace_id, member_path,
         row_ordinal, data_ordinal, record_kind, start_line, end_line,
         cells, values, raw_sha256, outcome, outcome_reason, entity_ids
       )
       SELECT $1, $2, $3,
              x.member_path, x.row_ordinal, x.data_ordinal, x.record_kind,
              x.start_line, x.end_line, x.cells, x.values, x.raw_sha256,
              x.outcome, x.outcome_reason,
              ARRAY(SELECT jsonb_array_elements_text(x.entity_ids))::uuid[]
         FROM jsonb_to_recordset($4::jsonb) AS x(
           member_path text, row_ordinal integer, data_ordinal integer,
           record_kind text, start_line integer, end_line integer,
           cells jsonb, values jsonb, raw_sha256 text,
           outcome text, outcome_reason text, entity_ids jsonb
         )
       ON CONFLICT (run_id, member_path, row_ordinal) DO UPDATE
         SET member_id = EXCLUDED.member_id,
             data_ordinal = EXCLUDED.data_ordinal,
             record_kind = EXCLUDED.record_kind,
             start_line = EXCLUDED.start_line,
             end_line = EXCLUDED.end_line,
             cells = EXCLUDED.cells,
             values = EXCLUDED.values,
             raw_sha256 = EXCLUDED.raw_sha256,
             outcome = EXCLUDED.outcome,
             outcome_reason = EXCLUDED.outcome_reason,
             entity_ids = EXCLUDED.entity_ids,
             updated_at = now()`,
      [input.runId, input.memberId, input.workspaceId, JSON.stringify(rows)],
    )
  }
}

export async function listLinkedInExternalIdentities(input: {
  workspaceId: string
  userId: string
}): Promise<ExternalIdentity[]> {
  const identities = await query<ExternalIdentity>(
    `SELECT identity_kind AS kind,
            normalized_value AS "normalizedValue",
            original_value AS "originalValue",
            entity_id AS "entityId"
       FROM entity_external_identities
      WHERE workspace_id = $1 AND user_id = $2 AND provider = 'linkedin'`,
    [input.workspaceId, input.userId],
  )
  const entities = await query<{
    entityId: string
    canonicalId: string | null
    attributes: Record<string, unknown>
  }>(
    `SELECT id AS "entityId", canonical_id AS "canonicalId", attributes
       FROM entities
      WHERE workspace_id = $1
        AND user_id = $2
        AND kind = 'person'
        AND valid_to IS NULL
        AND retracted_at IS NULL`,
    [input.workspaceId, input.userId],
  )

  const exact = [...identities.rows]
  const strings = (value: unknown): string[] => {
    if (typeof value === 'string') return [value]
    if (Array.isArray(value)) return value.flatMap(strings)
    return []
  }
  for (const entity of entities.rows) {
    const emailValues = [entity.canonicalId, ...strings(entity.attributes.email)]
    for (const originalValue of emailValues) {
      if (!originalValue) continue
      const normalizedValue = normalizeEmail(originalValue)
      if (normalizedValue) exact.push({
        kind: 'email', normalizedValue, originalValue, entityId: entity.entityId,
      })
    }
    for (const originalValue of strings(entity.attributes.phone)) {
      const normalizedValue = normalizePhone(originalValue)
      if (normalizedValue) exact.push({
        kind: 'phone', normalizedValue, originalValue, entityId: entity.entityId,
      })
    }
  }
  return exact
}

function externalIdentityKey(kind: string, normalizedValue: string): string {
  return `${kind}\u0000${normalizedValue}`
}

/**
 * The worker reads identities before it builds a pure projection. A different
 * archive can commit a matching exact identity before this transaction obtains
 * its advisory lock. Rebase every draft id onto that now-canonical entity while
 * holding the lock, so concurrent archives cannot leave duplicate people or
 * edges/ledger rows pointing at an orphan draft.
 */
async function rebaseProjectionOntoCommittedIdentities(
  client: PoolClient,
  run: LinkedInImportRun,
  projection: LinkedInProjection,
): Promise<LinkedInProjection> {
  if (projection.identities.length === 0) return projection
  const candidates = projection.identities.map((identity) => ({
    identity_kind: identity.kind,
    normalized_value: identity.normalizedValue,
  }))
  const existing = await client.query<{
    kind: string
    normalizedValue: string
    entityId: string
  }>(
    `SELECT candidate.identity_kind AS kind,
            candidate.normalized_value AS "normalizedValue",
            identity.entity_id AS "entityId"
       FROM jsonb_to_recordset($3::jsonb) AS candidate(
         identity_kind text, normalized_value text
       )
       JOIN entity_external_identities identity
         ON identity.workspace_id = $1
        AND identity.user_id = $2
        AND identity.provider = 'linkedin'
        AND identity.identity_kind = candidate.identity_kind
        AND identity.normalized_value = candidate.normalized_value`,
    [run.workspaceId, run.actingUserId, JSON.stringify(candidates)],
  )
  if (existing.rows.length === 0) return projection

  const committedByIdentity = new Map(
    existing.rows.map((identity) => [
      externalIdentityKey(identity.kind, identity.normalizedValue),
      identity.entityId,
    ]),
  )
  const targetsByDraft = new Map<string, Set<string>>()
  for (const identity of projection.identities) {
    const committed = committedByIdentity.get(externalIdentityKey(identity.kind, identity.normalizedValue))
    if (!committed || committed === identity.entityId) continue
    const targets = targetsByDraft.get(identity.entityId) ?? new Set<string>()
    targets.add(committed)
    targetsByDraft.set(identity.entityId, targets)
  }
  if (targetsByDraft.size === 0) return projection

  const draftEntityIds = new Set(projection.entities.map((entity) => entity.id))
  const remap = new Map<string, string>()
  for (const [draftId, targets] of targetsByDraft) {
    // A self/existing entity changing underneath the plan, or two strong
    // identities now resolving to different entities, must be rebuilt from a
    // fresh identity snapshot on the worker retry instead of guessed here.
    if (!draftEntityIds.has(draftId) || targets.size !== 1) {
      throw new Error('LinkedIn exact-identity map changed during projection; retry with a fresh snapshot')
    }
    remap.set(draftId, [...targets][0])
  }
  const canonical = (id: string) => remap.get(id) ?? id

  const edges = new Map<string, LinkedInProjection['edges'][number]>()
  for (const edge of projection.edges) {
    const sourceId = canonical(edge.sourceId)
    const targetId = canonical(edge.targetId)
    if (sourceId === targetId) continue
    const key = `${sourceId}\u0000${targetId}\u0000${edge.edgeType}`
    const previous = edges.get(key)
    if (!previous) {
      edges.set(key, { ...edge, sourceId, targetId })
      continue
    }
    edges.set(key, {
      ...previous,
      attributes: {
        ...previous.attributes,
        ...edge.attributes,
        observation_count:
          Number(previous.attributes.observation_count ?? 1) +
          Number(edge.attributes.observation_count ?? 1),
      },
    })
  }

  return {
    entities: projection.entities.filter((entity) => !remap.has(entity.id)),
    identities: projection.identities.map((identity) => ({
      ...identity,
      entityId: canonical(identity.entityId),
    })),
    edges: [...edges.values()],
    rowOutcomes: projection.rowOutcomes.map((outcome) => ({
      ...outcome,
      entityIds: [...new Set(outcome.entityIds.map(canonical))],
    })),
  }
}

async function persistEntities(
  client: PoolClient,
  run: LinkedInImportRun,
  projection: LinkedInProjection,
): Promise<void> {
  if (projection.entities.length === 0) return
  const payload = projection.entities.map((entity) => ({
    id: entity.id,
    kind: entity.kind,
    display_name: entity.displayName,
    canonical_id: entity.canonicalId,
    attributes: entity.attributes,
  }))
  await client.query(
    `INSERT INTO entities (
       id, kind, display_name, canonical_id, attributes, sensitivity,
       workspace_id, user_id, assistant_id,
       created_by_user_id, created_by_assistant_id, source
     )
     SELECT x.id, x.kind, x.display_name, x.canonical_id, x.attributes,
            'confidential', $1, $2, NULL, $2, $3, 'user'
       FROM jsonb_to_recordset($4::jsonb) AS x(
         id uuid, kind text, display_name text, canonical_id text, attributes jsonb
       )
     ON CONFLICT (id) DO NOTHING`,
    [run.workspaceId, run.actingUserId, run.assistantId, JSON.stringify(payload)],
  )
}

async function persistIdentities(
  client: PoolClient,
  run: LinkedInImportRun,
  projection: LinkedInProjection,
): Promise<void> {
  if (projection.identities.length === 0) return
  const payload = projection.identities.map((identity) => ({
    identity_kind: identity.kind,
    normalized_value: identity.normalizedValue,
    original_value: identity.originalValue,
    entity_id: identity.entityId,
  }))
  await client.query(
    `INSERT INTO entity_external_identities (
       workspace_id, user_id, provider, identity_kind, normalized_value,
       original_value, entity_id, attributes, first_seen_run_id, last_seen_run_id
     )
     SELECT $1, $2, 'linkedin', x.identity_kind, x.normalized_value,
            x.original_value, x.entity_id,
            jsonb_build_object('source', 'linkedin_archive'), $3, $3
       FROM jsonb_to_recordset($4::jsonb) AS x(
         identity_kind text, normalized_value text, original_value text, entity_id uuid
       )
     ON CONFLICT (workspace_id, user_id, provider, identity_kind, normalized_value)
     DO UPDATE SET last_seen_run_id = EXCLUDED.last_seen_run_id,
                   original_value = EXCLUDED.original_value,
                   updated_at = now()`,
    [run.workspaceId, run.actingUserId, run.id, JSON.stringify(payload)],
  )
}

async function persistEdges(
  client: PoolClient,
  run: LinkedInImportRun,
  projection: LinkedInProjection,
): Promise<void> {
  if (projection.edges.length === 0) return
  const payload = projection.edges.map((edge) => ({
    source_id: edge.sourceId,
    target_id: edge.targetId,
    edge_type: edge.edgeType,
    attributes: edge.attributes,
  }))
  await client.query(
    `INSERT INTO entity_links (
       source_kind, source_id, target_kind, target_id, edge_type,
       attributes, source, sensitivity, workspace_id, user_id, assistant_id
     )
     SELECT 'entity', x.source_id, 'entity', x.target_id, x.edge_type,
            x.attributes, 'user', 'confidential', $1, $2, NULL
       FROM jsonb_to_recordset($3::jsonb) AS x(
         source_id uuid, target_id uuid, edge_type text, attributes jsonb
       )
     ON CONFLICT (workspace_id, source_kind, source_id, target_kind, target_id, edge_type)
       WHERE valid_to IS NULL AND retracted_at IS NULL
     DO UPDATE SET attributes = entity_links.attributes || EXCLUDED.attributes`,
    [run.workspaceId, run.actingUserId, JSON.stringify(payload)],
  )
}

async function persistRowOutcomes(
  client: PoolClient,
  runId: string,
  projection: LinkedInProjection,
): Promise<void> {
  const chunkSize = 500
  for (let offset = 0; offset < projection.rowOutcomes.length; offset += chunkSize) {
    const payload = projection.rowOutcomes.slice(offset, offset + chunkSize).map((outcome) => ({
      member_path: outcome.memberPath,
      row_ordinal: outcome.rowOrdinal,
      outcome: outcome.outcome,
      outcome_reason: outcome.outcomeReason,
      entity_ids: outcome.entityIds,
    }))
    await client.query(
      `UPDATE linkedin_import_rows AS rows
          SET outcome = x.outcome,
              outcome_reason = x.outcome_reason,
              entity_ids = ARRAY(SELECT jsonb_array_elements_text(x.entity_ids))::uuid[],
              updated_at = now()
         FROM jsonb_to_recordset($2::jsonb) AS x(
           member_path text, row_ordinal integer, outcome text,
           outcome_reason text, entity_ids jsonb
         )
        WHERE rows.run_id = $1
          AND rows.member_path = x.member_path
          AND rows.row_ordinal = x.row_ordinal`,
      [runId, JSON.stringify(payload)],
    )
  }
}

export async function persistLinkedInProjection(
  run: LinkedInImportRun,
  projection: LinkedInProjection,
): Promise<void> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    // Serialize identity projection for one private LinkedIn namespace. This
    // closes the otherwise possible race where two different archives create
    // entities for the same exact profile URL before either identity row lands.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
      [run.workspaceId, `${run.actingUserId}:linkedin`],
    )
    const rebased = await rebaseProjectionOntoCommittedIdentities(client, run, projection)
    await persistEntities(client, run, rebased)
    await persistIdentities(client, run, rebased)
    await persistEdges(client, run, rebased)
    await persistRowOutcomes(client, run.id, rebased)
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

export async function completeLinkedInImportRun(input: {
  runId: string
  leaseToken: string
}): Promise<LinkedInImportRun> {
  const counts = await query<{
    memberCount: string
    completedMemberCount: string
    rowCount: string
    mappedCount: string
    storedCount: string
    unresolvedCount: string
    malformedCount: string
    entityCount: string
    edgeCount: string
  }>(
    `SELECT
       (SELECT count(*)::text FROM linkedin_import_members WHERE run_id = $1) AS "memberCount",
       (SELECT count(*)::text FROM linkedin_import_members
         WHERE run_id = $1 AND parse_status IN ('completed','stored')) AS "completedMemberCount",
       count(*)::text AS "rowCount",
       count(*) FILTER (WHERE outcome = 'mapped')::text AS "mappedCount",
       count(*) FILTER (WHERE outcome = 'stored')::text AS "storedCount",
       count(*) FILTER (WHERE outcome = 'unresolved')::text AS "unresolvedCount",
       count(*) FILTER (WHERE outcome = 'malformed')::text AS "malformedCount",
       (SELECT count(DISTINCT entity_id)::text
          FROM linkedin_import_rows lir,
               LATERAL unnest(lir.entity_ids) AS entity_id
         WHERE lir.run_id = $1) AS "entityCount",
       (SELECT count(*)::text
          FROM entity_links link
          JOIN linkedin_import_runs run ON run.id = $1
         WHERE link.workspace_id = run.workspace_id
           AND link.user_id = run.acting_user_id
           AND link.valid_to IS NULL
           AND link.retracted_at IS NULL
           AND link.attributes ->> 'source_run_id' = $1::text) AS "edgeCount"
     FROM linkedin_import_rows
     WHERE run_id = $1`,
    [input.runId],
  )
  const c = counts.rows[0]
  const memberCount = Number(c.memberCount)
  const completedMemberCount = Number(c.completedMemberCount)
  const rowCount = Number(c.rowCount)
  const mappedCount = Number(c.mappedCount)
  const storedCount = Number(c.storedCount)
  const unresolvedCount = Number(c.unresolvedCount)
  const malformedCount = Number(c.malformedCount)
  const entityCount = Number(c.entityCount)
  const edgeCount = Number(c.edgeCount)
  if (memberCount !== completedMemberCount) {
    throw new Error(`LinkedIn reconciliation failed: ${completedMemberCount}/${memberCount} members completed`)
  }
  if (rowCount !== mappedCount + storedCount + unresolvedCount + malformedCount) {
    throw new Error('LinkedIn reconciliation failed: terminal row outcomes do not sum to row count')
  }
  const result = await query<RunRow>(
    `UPDATE linkedin_import_runs
        SET status = 'completed', stage = 'completed', last_error = NULL,
            locked_at = NULL, lease_token = NULL, completed_at = now(), updated_at = now(),
            member_count = $2, completed_member_count = $3,
            row_count = $4, mapped_count = $5, stored_count = $6,
            unresolved_count = $7, malformed_count = $8,
            entity_count = $9, edge_count = $10
      WHERE id = $1 AND status = 'processing' AND lease_token = $11
      RETURNING ${RUN_RETURNING}`,
    [
      input.runId,
      memberCount,
      completedMemberCount,
      rowCount,
      mappedCount,
      storedCount,
      unresolvedCount,
      malformedCount,
      entityCount,
      edgeCount,
      input.leaseToken,
    ],
  )
  if (!result.rows[0]) throw new Error(`LinkedIn import ${input.runId} lost its worker lease`)
  return toRun(result.rows[0])
}

export type LinkedInImportStore = {
  claim: typeof claimNextLinkedInImportRun
  setStage: typeof setLinkedInImportStage
  markFailed: typeof markLinkedInImportFailed
  upsertMember: typeof upsertLinkedInImportMember
  setMemberArtifact: typeof setLinkedInMemberArtifact
  completeMember: typeof completeLinkedInImportMember
  failMember: typeof failLinkedInImportMember
  upsertRows: typeof upsertLinkedInImportRows
  listIdentities: typeof listLinkedInExternalIdentities
  persistProjection: typeof persistLinkedInProjection
  completeRun: typeof completeLinkedInImportRun
}

export const linkedinImportStore: LinkedInImportStore = {
  claim: claimNextLinkedInImportRun,
  setStage: setLinkedInImportStage,
  markFailed: markLinkedInImportFailed,
  upsertMember: upsertLinkedInImportMember,
  setMemberArtifact: setLinkedInMemberArtifact,
  completeMember: completeLinkedInImportMember,
  failMember: failLinkedInImportMember,
  upsertRows: upsertLinkedInImportRows,
  listIdentities: listLinkedInExternalIdentities,
  persistProjection: persistLinkedInProjection,
  completeRun: completeLinkedInImportRun,
}
