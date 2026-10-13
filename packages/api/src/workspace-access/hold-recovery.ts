/**
 * Held-memory recovery: an automatic re-check, and a release that is a
 * re-derivation, never an un-hold. Spec: docs/plans/scope-hold-recovery.md.
 * [COMP:api/scope-hold-recovery]
 *
 * A hold is applied on top of every read rule (RESTRICTIVE
 * `memories_scope_holding`), so a held memory is invisible to everyone. That
 * is right when a source really changed, and the recovery for that is
 * reclassifying the source. It is wrong when the hold was a false positive
 * (a summary regenerated, a bookkeeping stamp): the memory's sources still
 * certify exactly its envelope. The re-check proves that case; the release
 * writes a replacement row with fresh lineage at the sources' current heads and
 * retires the held row, which stays held as history.
 */
import type { PoolClient } from 'pg'
import { DerivedScopeError, deriveWriteScope, resourceScopeKey, type ResourceScope, type ScopeSource, type Sensitivity } from '@use-brian/core'
import type { HeldMemorySummary, ScopeHoldBlockedReason, ScopeHoldReleasePlan, ScopeReviewKind } from '@use-brian/shared'
import { getPool } from '../db/client.js'
import { recordDerivedResource, validateDerivedWriteInputs } from '../db/derived-scope-store.js'
import { insertHeldMemoryReplacement } from '../db/memories.js'
import { WorkspaceAccessError } from './policy.js'

export const HOLD_RELEASE_PRODUCER = 'scope-review:release'
/** Bounded walks: a lineage or a supersession chain beyond these is not re-checked. */
const MAX_SOURCES = 500
const MAX_CHAIN = 64

type Query = Pick<PoolClient, 'query'>

type HeldMemory = {
  id: string; userId: string | null; assistantId: string | null; sensitivity: Sensitivity
  compartments: string[]; projectIds: string[]; held: boolean; retired: boolean; version: string
  createdByUserId: string | null
}

type Snapshot = ResourceScope & { version: string; held: boolean; retractedAt: unknown; validTo: unknown }

export type HoldRecheck =
  | { recovery: { status: 'safe' }; plan: ScopeHoldReleasePlan; heads: ScopeSource[]; memory: HeldMemory }
  | { recovery: { status: 'blocked'; reason: ScopeHoldBlockedReason } }

const blocked = (reason: ScopeHoldBlockedReason): HoldRecheck => ({ recovery: { status: 'blocked', reason } })

async function readHeldMemory(client: Query, workspaceId: string, id: string, lock: boolean): Promise<HeldMemory | null> {
  return (await client.query<HeldMemory>(
    `SELECT id, user_id AS "userId", assistant_id AS "assistantId", sensitivity, compartments,
            project_ids AS "projectIds", scope_held AS held,
            (valid_to IS NOT NULL OR retracted_at IS NOT NULL) AS retired,
            scope_version::text AS version, created_by_user_id AS "createdByUserId"
       FROM memories WHERE workspace_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`,
    [workspaceId, id],
  )).rows[0] ?? null
}

/** A memory source follows its supersession chain to the live row that replaced it. */
async function memoryHead(client: Query, workspaceId: string, id: string): Promise<string | null> {
  return (await client.query<{ id: string }>(
    `WITH RECURSIVE chain(id, depth) AS (
       SELECT $2::uuid, 0
       UNION ALL
       SELECT m.superseded_by, c.depth + 1 FROM chain c
         JOIN memories m ON m.id = c.id AND m.workspace_id = $1
        WHERE m.superseded_by IS NOT NULL AND c.depth < ${MAX_CHAIN})
     SELECT c.id FROM chain c JOIN memories m ON m.id = c.id AND m.workspace_id = $1
      WHERE m.valid_to IS NULL AND m.retracted_at IS NULL
      ORDER BY c.depth DESC LIMIT 1`,
    [workspaceId, id],
  )).rows[0]?.id ?? null
}

/** Bounded recursion through held recorded sources (an edited memory lists its held predecessor). */
const MAX_DEPTH = 8

/**
 * An administrator's hold is a person's decision and is never offered for
 * release. Read it from the immutable applied review item: the state row's
 * `holding_reason` is overwritten to `source_changed` by any later
 * invalidation, so it cannot prove the hold was never administrative.
 */
async function administratorHeld(client: Query, workspaceId: string, memoryId: string): Promise<boolean> {
  return (await client.query(
    `SELECT 1 FROM workspace_scope_review_items i
       JOIN workspace_scope_reviews r ON r.workspace_id=i.workspace_id AND r.id=i.review_id
      WHERE i.workspace_id=$1 AND i.resource_kind='memory' AND i.resource_id=$2
        AND i.status='applied' AND r.action='hold'
     UNION ALL
     SELECT 1 FROM scope_resource_states
      WHERE workspace_id=$1 AND resource_kind='memory' AND resource_id=$2
        AND review_state='held' AND holding_reason='administrator_review'
     LIMIT 1`,
    [workspaceId, memoryId],
  )).rows.length > 0
}

async function snapshotOf(client: Query, workspaceId: string, kind: string, id: string): Promise<Snapshot | null> {
  return (await client.query<{ snapshot: Snapshot | null }>(
    'SELECT read_scope_source($1,$2,$3) AS snapshot', [workspaceId, kind, id],
  )).rows[0]?.snapshot ?? null
}

const scopeOf = (workspaceId: string, kind: string, id: string, snapshot: Snapshot): ScopeSource => ({
  workspaceId, resourceKind: kind, resourceId: id, version: snapshot.version,
  userId: snapshot.userId, assistantId: snapshot.assistantId, sensitivity: snapshot.sensitivity,
  compartments: snapshot.compartments, projectIds: snapshot.projectIds,
})

type Collected = { heads: Map<string, ScopeSource>; floor: Map<string, ScopeSource> }

/**
 * Collect the current heads (lineage for the replacement) and every row whose
 * labels the replacement must still carry (the floor). A recorded memory
 * source that is not its own head contributes itself to the floor as well as
 * its head: the held memory read THAT row, so a regenerated summary cannot
 * hide an input the old one had. A recorded source that is itself held must
 * re-check safe in turn; its heads and floor fold into this one.
 */
async function collect(
  client: Query, workspaceId: string, memoryId: string, version: string,
  depth: number, visited: Set<string>, into: Collected,
): Promise<ScopeHoldBlockedReason | null> {
  const recorded = (await client.query<{ kind: ScopeReviewKind; id: string; version: string }>(
    `SELECT ds.source_kind AS kind, ds.source_id::text AS id, ds.source_version AS version
       FROM scope_derivations d
       JOIN scope_derivation_sources ds ON ds.workspace_id=d.workspace_id AND ds.derivation_id=d.id
      WHERE d.workspace_id=$1 AND d.resource_kind='memory' AND d.resource_id=$2 AND d.resource_version=$3
      ORDER BY ds.source_kind, ds.source_id LIMIT ${MAX_SOURCES + 1}`,
    [workspaceId, memoryId, version],
  )).rows
  if (recorded.length === 0 || recorded.length > MAX_SOURCES) return 'no_lineage'
  for (const source of recorded) {
    if (into.heads.size + into.floor.size > MAX_SOURCES) return 'no_lineage'
    if (source.kind !== 'memory') {
      const snapshot = await snapshotOf(client, workspaceId, source.kind, source.id)
      if (!snapshot) return 'source_removed'
      if (snapshot.held) return 'source_held'
      if (snapshot.retractedAt || snapshot.validTo) return 'source_removed'
      into.heads.set(`${source.kind}:${source.id}`, scopeOf(workspaceId, source.kind, source.id, snapshot))
      continue
    }
    const key = `memory:${source.id}`
    if (visited.has(key)) continue
    visited.add(key)
    // The CURRENT snapshot, not the recorded version: a release is a
    // re-derivation, and the floor must still equal the held row's envelope.
    const read = await snapshotOf(client, workspaceId, 'memory', source.id)
    if (!read) return 'source_removed'
    if (read.retractedAt) return 'source_removed'
    if (read.held) {
      // The edited predecessor (updateMemory records it) or any held input:
      // only as releasable as its own sources.
      if (depth >= MAX_DEPTH || await administratorHeld(client, workspaceId, source.id)) return 'source_held'
      const nested = await collect(client, workspaceId, source.id, read.version, depth + 1, visited, into)
      if (nested) return nested === 'no_lineage' ? 'source_held' : nested
      into.floor.set(key, scopeOf(workspaceId, 'memory', source.id, read))
      continue
    }
    const headId = await memoryHead(client, workspaceId, source.id)
    if (!headId) return 'source_removed'
    if (headId !== source.id) {
      // What was actually read keeps its labels in the floor.
      into.floor.set(key, scopeOf(workspaceId, 'memory', source.id, read))
    }
    if (headId === memoryId) continue
    const head = headId === source.id ? read : await snapshotOf(client, workspaceId, 'memory', headId)
    if (!head) return 'source_removed'
    if (head.held) return 'source_held'
    if (head.retractedAt || head.validTo) return 'source_removed'
    // A supersession chain must not move the content to another partition.
    if (head.userId !== read.userId || head.assistantId !== read.assistantId) return 'labels_changed'
    into.heads.set(`memory:${headId}`, scopeOf(workspaceId, 'memory', headId, head))
  }
  return null
}

/**
 * Re-check one held memory against its sources' CURRENT heads. Pure read; the
 * release repeats it under locks. `safe` means the held row's own envelope
 * already certifies every head and every row it actually read, so a
 * replacement neither widens nor narrows access. Anything else stays held
 * with a closed reason.
 */
export async function recheckHeldMemory(client: Query, workspaceId: string, memoryId: string, lock = false): Promise<HoldRecheck> {
  const memory = await readHeldMemory(client, workspaceId, memoryId, lock)
  if (!memory || !memory.held || memory.retired) return blocked('not_held')
  if (await administratorHeld(client, workspaceId, memoryId)) return blocked('administrator_hold')

  const collected: Collected = { heads: new Map(), floor: new Map() }
  const failed = await collect(client, workspaceId, memoryId, memory.version, 0, new Set([`memory:${memoryId}`]), collected)
  if (failed) return blocked(failed)
  const order = (a: ScopeSource, b: ScopeSource) => `${a.resourceKind}:${a.resourceId}`.localeCompare(`${b.resourceKind}:${b.resourceId}`)
  const heads = [...collected.heads.values()].sort(order)
  if (heads.length === 0) return blocked('no_lineage')
  const floorSources = [...heads, ...[...collected.floor.values()].filter(row => !collected.heads.has(`${row.resourceKind}:${row.resourceId}`))]

  const target: ResourceScope = {
    workspaceId, userId: memory.userId, assistantId: memory.assistantId,
    sensitivity: memory.sensitivity, compartments: memory.compartments, projectIds: memory.projectIds,
  }
  try {
    // Same rule the replacement write enforces (recordDerivedResource): the
    // original author may have fed their own private rows into the memory.
    const floor = deriveWriteScope({ producer: HOLD_RELEASE_PRODUCER, sources: floorSources }, target, memory.createdByUserId)
    if (resourceScopeKey(floor) !== resourceScopeKey(target)) return blocked('labels_changed')
  } catch (error) {
    if (error instanceof DerivedScopeError) return blocked('labels_changed')
    throw error
  }
  return {
    recovery: { status: 'safe' },
    plan: { heads: heads.map(head => ({ resourceKind: head.resourceKind as ScopeReviewKind, resourceId: head.resourceId, version: head.version })) },
    heads,
    memory,
  }
}

function planKey(plan: ScopeHoldReleasePlan): string {
  return JSON.stringify(plan.heads.map(head => [head.resourceKind, head.resourceId, head.version]))
}

/**
 * Release one held memory inside the caller's (admin-authorized) transaction.
 * Re-runs the re-check under a row lock and refuses unless it yields exactly
 * the frozen plan, then: revalidates every head at its exact version, inserts
 * the replacement (same content and envelope), records its lineage, and
 * retires the held row with `superseded_by`. The held row is never un-held.
 */
export async function releaseHeldMemory(
  client: PoolClient,
  workspaceId: string,
  memoryId: string,
  plan: ScopeHoldReleasePlan,
): Promise<{ replacementId: string } | { stale: true }> {
  const recheck = await recheckHeldMemory(client, workspaceId, memoryId, true)
  // The frozen plan round-trips through JSONB, which reorders keys: compare by value.
  if (recheck.recovery.status !== 'safe' || !('plan' in recheck)
    || planKey(recheck.plan) !== planKey(plan)) return { stale: true }
  const evidence = { producer: HOLD_RELEASE_PRODUCER, sources: recheck.heads }
  let replacement: { id: string; version: string }
  try {
    // A head may change between the unlocked read and these FOR SHARE locks.
    await validateDerivedWriteInputs(client, evidence)
    replacement = await insertHeldMemoryReplacement(client, workspaceId, memoryId)
  } catch (error) {
    if (error instanceof DerivedScopeError || (error instanceof Error && error.message.startsWith('memory_'))) return { stale: true }
    throw error
  }
  const memory = recheck.memory
  await recordDerivedResource(client, evidence, {
    workspaceId, resourceKind: 'memory', resourceId: replacement.id, version: replacement.version,
    userId: memory.userId, assistantId: memory.assistantId, sensitivity: memory.sensitivity,
    compartments: memory.compartments, projectIds: memory.projectIds,
  }, memory.createdByUserId)
  await client.query(
    `UPDATE memories SET valid_to = now(), superseded_by = $3, updated_at = now() WHERE workspace_id=$1 AND id=$2`,
    [workspaceId, memoryId, replacement.id],
  )
  return { replacementId: replacement.id }
}

/** D3: hidden memories the member owns (private) or saved (workspace-shared), as a count. Never content or reason. */
export async function countOwnHeldMemories(client: Query, workspaceId: string, userId: string): Promise<number> {
  return Number((await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM memories
      WHERE workspace_id=$1 AND (user_id=$2 OR (user_id IS NULL AND created_by_user_id=$2))
        AND scope_held AND valid_to IS NULL AND retracted_at IS NULL`,
    [workspaceId, userId],
  )).rows[0]?.count ?? '0')
}

export const HOLD_REVIEW_REQUESTED = 'scope.hold.review_requested'
/** One open request per member per day; a repeat returns the existing one. */
export const HOLD_REVIEW_REQUEST_WINDOW_HOURS = 24

export async function latestOwnReviewRequest(client: Query, workspaceId: string, userId: string): Promise<string | null> {
  return (await client.query<{ at: string }>(
    `SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at FROM workspace_access_events
      WHERE workspace_id=$1 AND kind=$2 AND actor_user_id=$3
        AND created_at > now() - make_interval(hours => ${HOLD_REVIEW_REQUEST_WINDOW_HOURS})
      ORDER BY created_at DESC LIMIT 1`,
    [workspaceId, HOLD_REVIEW_REQUESTED, userId],
  )).rows[0]?.at ?? null
}

/** Admin count: members who asked recently and still have hidden memories. */
export async function countOpenReviewRequests(client: Query, workspaceId: string): Promise<number> {
  return Number((await client.query<{ count: string }>(
    `SELECT count(DISTINCT e.actor_user_id)::text AS count FROM workspace_access_events e
      WHERE e.workspace_id=$1 AND e.kind=$2 AND e.created_at > now() - interval '30 days'
        AND EXISTS(SELECT 1 FROM memories m WHERE m.workspace_id=e.workspace_id
                     AND (m.user_id=e.actor_user_id OR (m.user_id IS NULL AND m.created_by_user_id=e.actor_user_id))
                     AND m.scope_held AND m.valid_to IS NULL AND m.retracted_at IS NULL)`,
    [workspaceId, HOLD_REVIEW_REQUESTED],
  )).rows[0]?.count ?? '0')
}

async function memberTransaction<T>(workspaceId: string, userId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    // Any member: the summary is the caller's own rows only.
    const member = (await client.query('SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspaceId, userId])).rows[0]
    if (!member) throw new WorkspaceAccessError('not_found', 404)
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

/** GET /workspaces/:id/held-memories/summary (D3). */
export function getHeldMemorySummary(workspaceId: string, userId: string): Promise<HeldMemorySummary> {
  return memberTransaction(workspaceId, userId, async client => ({
    count: await countOwnHeldMemories(client, workspaceId, userId),
    requestedAt: await latestOwnReviewRequest(client, workspaceId, userId),
  }))
}

/**
 * POST /workspaces/:id/held-memories/review-request (D3). Records an immutable
 * access event the admin review screen counts. Idempotent within the window;
 * refuses when the member has nothing hidden.
 */
export function requestHeldMemoryReview(workspaceId: string, userId: string): Promise<HeldMemorySummary> {
  return memberTransaction(workspaceId, userId, async client => {
    // Serialize one member's requests without blocking workspace writers.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('scope.hold.review:' || $1 || ':' || $2))", [workspaceId, userId])
    const count = await countOwnHeldMemories(client, workspaceId, userId)
    if (count === 0) throw new WorkspaceAccessError('nothing_held', 409)
    const existing = await latestOwnReviewRequest(client, workspaceId, userId)
    if (existing) return { count, requestedAt: existing }
    await client.query('INSERT INTO workspace_access_policies(workspace_id) VALUES($1) ON CONFLICT DO NOTHING', [workspaceId])
    await client.query(
      `INSERT INTO workspace_access_events(workspace_id,actor_user_id,kind,subject_id,policy_revision,changes)
       SELECT $1,$2,$3,NULL,revision,$4::jsonb FROM workspace_access_policies WHERE workspace_id=$1`,
      [workspaceId, userId, HOLD_REVIEW_REQUESTED, JSON.stringify({ count })],
    )
    return { count, requestedAt: await latestOwnReviewRequest(client, workspaceId, userId) }
  })
}
