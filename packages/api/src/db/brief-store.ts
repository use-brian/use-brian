/**
 * Governed Brief state (migration 751). Thin typed access to the actor-bound
 * `brief_*` SQL commands and the RLS-visible Brief tables. Every mutation is
 * one call into a SECURITY DEFINER function on the RLS app connection, which
 * locks, rechecks authority and refuses stale revisions inside the
 * transaction. The service (`briefs/service.ts`) composes these; REST routes
 * and Brian's tools only ever reach them through the service.
 * Spec: docs/architecture/features/project-briefs.md -> "Canonical state".
 *
 * [COMP:api/brief-publication]
 */
import type { PoolClient } from 'pg'
import type { BriefLayout, BriefOwnerKind, Ops, Page } from '@use-brian/core'
import { applyRLSGucs, getAppPool, query, rollbackAndRelease } from './client.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'

export type BriefRole = 'owner' | 'participant' | 'oversight'

export type BriefBinding = {
  id: string
  workspaceId: string
  ownerKind: BriefOwnerKind
  ownerId: string
  pageId: string | null
  layout: BriefLayout
  locale: string
  directionRevision: number
  selectionRevision: number
  acceptedDirectionHash: string
  createdAt: string
  updatedAt: string
}

export type BriefEvidence = {
  kind: string
  id?: string | null
  version?: string | null
  /** The original passage, verbatim. An assistant summary is not evidence. */
  passage?: string | null
  label?: string | null
}

export type BriefEnvelope = {
  sensitivity: 'public' | 'internal' | 'confidential'
  compartments: string[]
  privateToUser: string | null
}

export type BriefProposal = {
  id: string
  bindingId: string
  kind: 'draft' | 'proposal'
  status: 'open' | 'applied' | 'dismissed' | 'superseded'
  authorUserId: string
  authorAssistantId: string | null
  summary: string | null
  ops: Ops
  baseDirectionRevision: number
  baseDirectionHash: string
  restoreOf: string | null
  evidence: BriefEvidence[]
  envelope: BriefEnvelope
  revisionId: string | null
  createdAt: string
  updatedAt: string
}

export type BriefRevision = {
  id: string
  bindingId: string
  kind: 'created' | 'apply' | 'restore' | 'repair' | 'selection'
  directionRevision: number
  selectionRevision: number
  directionHash: string
  directionSnapshot: Page['blocks'] | null
  selection: string[]
  contentSeq: number | null
  actorUserId: string | null
  actingAssistantId: string | null
  proposalId: string | null
  appliedOps: Ops
  evidence: BriefEvidence[]
  activeWork: 'pause' | 'continue'
  broadcastAt: string | null
  createdAt: string
}

export type BriefPublicationReceipt = {
  revisionId: string
  directionRevision: number
  selectionRevision: number
  contentSeq?: number | null
  replayed: boolean
}

export type BriefPageState = {
  snapshot: Page
  title: string
  seq: number
  ydoc: Buffer | null
}

export type BriefEffectiveBasis = {
  binding: string
  direction: number
  selection: number
  departments: Array<{ binding: string; direction: number }>
}

/** Typed codes shared by REST and Brian (project-briefs.md -> "Authority"). */
export const BRIEF_ERRORS: Record<string, number> = {
  brief_actor_required: 401,
  brief_not_found: 404,
  brief_owner_required: 403,
  brief_revision_stale: 409,
  brief_page_changed: 409,
  brief_direction_protected: 409,
  brief_page_bound: 409,
  brief_ops_invalid: 400,
  brief_proposal_closed: 409,
  brief_idempotency_conflict: 409,
  brief_selection_invalid: 400,
  brief_unavailable: 409,
  brief_requires_shared_project: 409,
  brief_requires_department_read: 409,
  brief_history_immutable: 409,
}

/** Map a raised SQL code (or a known code thrown in TS) to the typed error. */
export function briefError(error: unknown): unknown {
  if (error instanceof WorkspaceAccessError) return error
  const message = (error as Error | undefined)?.message ?? ''
  if (message in BRIEF_ERRORS) return new WorkspaceAccessError(message, BRIEF_ERRORS[message])
  // A concurrent writer on the same binding or page: retry with the current state.
  if (['40001', '40P01', '23505'].includes((error as { code?: string }).code ?? '')) {
    return new WorkspaceAccessError('brief_revision_stale', 409)
  }
  return error
}

export function briefFail(code: keyof typeof BRIEF_ERRORS): never {
  throw new WorkspaceAccessError(code, BRIEF_ERRORS[code])
}

/** One actor-bound transaction on the RLS app connection. */
export async function withBriefActor<T>(actor: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getAppPool().connect()
  try {
    await client.query('BEGIN')
    await applyRLSGucs(client, actor)
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    throw briefError(error)
  } finally {
    await rollbackAndRelease(client)
  }
}

type BindingRow = {
  id: string; workspace_id: string; owner_kind: BriefOwnerKind; owner_id: string; page_id: string | null
  direction_start_id: string; context_start_id: string; section_ids: BriefLayout['sectionIds']; locale: string
  direction_revision: number; selection_revision: number; accepted_direction_hash: string; created_at: Date; updated_at: Date
}
const BINDING_COLUMNS = `id, workspace_id, owner_kind, owner_id, page_id, direction_start_id, context_start_id, section_ids,
  locale, direction_revision, selection_revision, accepted_direction_hash, created_at, updated_at`

function binding(row: BindingRow): BriefBinding {
  return {
    id: row.id, workspaceId: row.workspace_id, ownerKind: row.owner_kind, ownerId: row.owner_id, pageId: row.page_id,
    layout: { directionStartId: row.direction_start_id, contextStartId: row.context_start_id, sectionIds: row.section_ids },
    locale: row.locale, directionRevision: row.direction_revision, selectionRevision: row.selection_revision,
    acceptedDirectionHash: row.accepted_direction_hash,
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
  }
}

type ProposalRow = {
  id: string; binding_id: string; kind: 'draft' | 'proposal'; status: BriefProposal['status']; author_user_id: string
  author_assistant_id: string | null; summary: string | null; ops: Ops; base_direction_revision: number
  base_direction_hash: string; restore_of: string | null; evidence: BriefEvidence[]; sensitivity: BriefEnvelope['sensitivity']
  compartments: string[]; private_to_user: string | null; revision_id: string | null; created_at: Date; updated_at: Date
}
const PROPOSAL_COLUMNS = `id, binding_id, kind, status, author_user_id, author_assistant_id, summary, ops, base_direction_revision,
  base_direction_hash, restore_of, evidence, sensitivity, compartments, private_to_user, revision_id, created_at, updated_at`

function proposal(row: ProposalRow): BriefProposal {
  return {
    id: row.id, bindingId: row.binding_id, kind: row.kind, status: row.status, authorUserId: row.author_user_id,
    authorAssistantId: row.author_assistant_id, summary: row.summary, ops: row.ops,
    baseDirectionRevision: row.base_direction_revision, baseDirectionHash: row.base_direction_hash, restoreOf: row.restore_of,
    evidence: row.evidence, envelope: { sensitivity: row.sensitivity, compartments: row.compartments, privateToUser: row.private_to_user },
    revisionId: row.revision_id, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
  }
}

type RevisionRow = {
  id: string; binding_id: string; kind: BriefRevision['kind']; direction_revision: number; selection_revision: number
  direction_hash: string; direction_snapshot: Page['blocks'] | null; selection: string[]; content_seq: string | null
  actor_user_id: string | null; acting_assistant_id: string | null; proposal_id: string | null; applied_ops: Ops
  evidence: BriefEvidence[]; active_work: 'pause' | 'continue'; broadcast_at: Date | null; created_at: Date
}

function revision(row: RevisionRow): BriefRevision {
  return {
    id: row.id, bindingId: row.binding_id, kind: row.kind, directionRevision: row.direction_revision,
    selectionRevision: row.selection_revision, directionHash: row.direction_hash, directionSnapshot: row.direction_snapshot,
    selection: row.selection, contentSeq: row.content_seq === null ? null : Number(row.content_seq),
    actorUserId: row.actor_user_id, actingAssistantId: row.acting_assistant_id, proposalId: row.proposal_id,
    appliedOps: row.applied_ops, evidence: row.evidence, activeWork: row.active_work,
    broadcastAt: row.broadcast_at ? new Date(row.broadcast_at).toISOString() : null, createdAt: new Date(row.created_at).toISOString(),
  }
}

// ── Reads (RLS, as the actor) ────────────────────────────────────────────

export async function findBinding(client: PoolClient, workspaceId: string, ownerKind: BriefOwnerKind, ownerId: string): Promise<BriefBinding | null> {
  const rows = await client.query<BindingRow>(
    `SELECT ${BINDING_COLUMNS} FROM brief_bindings WHERE workspace_id = $1 AND owner_kind = $2 AND owner_id = $3`,
    [workspaceId, ownerKind, ownerId])
  return rows.rows[0] ? binding(rows.rows[0]) : null
}

export async function getBinding(client: PoolClient, bindingId: string): Promise<BriefBinding | null> {
  const rows = await client.query<BindingRow>(`SELECT ${BINDING_COLUMNS} FROM brief_bindings WHERE id = $1`, [bindingId])
  return rows.rows[0] ? binding(rows.rows[0]) : null
}

export async function getRole(client: PoolClient, bindingId: string, actor: string, assistantId: string | null): Promise<BriefRole | null> {
  const rows = await client.query<{ role: BriefRole | null }>('SELECT brief_role($1, $2, $3) AS role', [bindingId, actor, assistantId])
  return rows.rows[0]?.role ?? null
}

/** The persisted live Page state, read through the actor's page RLS. */
export async function readPageState(client: PoolClient, pageId: string, opts: { forUpdate?: boolean; withYdoc?: boolean } = {}): Promise<BriefPageState | null> {
  const rows = await client.query<{ snapshot: Page | null; title: string | null; seq: string; ydoc: Buffer | null }>(
    `SELECT d.snapshot_json AS snapshot, d.snapshot_title AS title, d.seq::text AS seq, ${opts.withYdoc ? 'd.ydoc' : 'NULL::bytea'} AS ydoc
       FROM documents d JOIN saved_views sv ON sv.id = d.page_id
      WHERE d.page_id = $1${opts.forUpdate ? ' FOR UPDATE OF d' : ''}`, [pageId])
  const row = rows.rows[0]
  if (!row?.snapshot) return null
  return { snapshot: row.snapshot, title: row.title ?? '', seq: Number(row.seq), ydoc: row.ydoc }
}

export async function listProposals(client: PoolClient, bindingId: string, opts: { status?: BriefProposal['status'][] } = {}): Promise<BriefProposal[]> {
  const rows = await client.query<ProposalRow>(
    `SELECT ${PROPOSAL_COLUMNS} FROM brief_proposals WHERE binding_id = $1 AND ($2::text[] IS NULL OR status = ANY($2))
      ORDER BY created_at DESC LIMIT 100`, [bindingId, opts.status ?? null])
  return rows.rows.map(proposal)
}

export async function getProposal(client: PoolClient, proposalId: string): Promise<BriefProposal | null> {
  const rows = await client.query<ProposalRow>(`SELECT ${PROPOSAL_COLUMNS} FROM brief_proposals WHERE id = $1`, [proposalId])
  return rows.rows[0] ? proposal(rows.rows[0]) : null
}

export async function listRevisions(client: PoolClient, bindingId: string, limit = 50): Promise<BriefRevision[]> {
  const rows = await client.query<RevisionRow>(
    `SELECT id, binding_id, kind, direction_revision, selection_revision, direction_hash, direction_snapshot, selection,
            content_seq::text, actor_user_id, acting_assistant_id, proposal_id, applied_ops, evidence, active_work, broadcast_at, created_at
       FROM brief_revisions WHERE binding_id = $1 ORDER BY created_at DESC, direction_revision DESC LIMIT $2`, [bindingId, limit])
  return rows.rows.map(revision)
}

export async function getRevision(client: PoolClient, revisionId: string): Promise<BriefRevision | null> {
  const rows = await client.query<RevisionRow>(
    `SELECT id, binding_id, kind, direction_revision, selection_revision, direction_hash, direction_snapshot, selection,
            content_seq::text, actor_user_id, acting_assistant_id, proposal_id, applied_ops, evidence, active_work, broadcast_at, created_at
       FROM brief_revisions WHERE id = $1`, [revisionId])
  return rows.rows[0] ? revision(rows.rows[0]) : null
}

export async function listSelections(client: PoolClient, bindingId: string): Promise<string[]> {
  const rows = await client.query<{ id: string }>(
    'SELECT department_binding_id AS id FROM brief_department_selections WHERE project_binding_id = $1 ORDER BY position', [bindingId])
  return rows.rows.map(row => row.id)
}

// ── Commands (actor-bound SQL) ───────────────────────────────────────────

export async function bindPage(client: PoolClient, input: {
  ownerKind: BriefOwnerKind; ownerId: string; pageId: string; layout: BriefLayout; locale: string; assistantId: string | null
}): Promise<string> {
  const rows = await client.query<{ id: string }>('SELECT brief_bind_page($1, $2, $3, $4::jsonb, $5, $6) AS id',
    [input.ownerKind, input.ownerId, input.pageId, JSON.stringify(input.layout), input.locale, input.assistantId])
  return rows.rows[0].id
}

export async function saveProposal(client: PoolClient, input: {
  bindingId: string; kind: 'draft' | 'proposal'; ops: Ops; baseRevision: number; baseHash: string; evidence: BriefEvidence[]
  envelope: BriefEnvelope; summary: string | null; assistantId: string | null; restoreOf?: string | null
}): Promise<string> {
  const rows = await client.query<{ id: string }>(
    'SELECT brief_save_proposal($1, $2, $3::jsonb, $4, $5, $6::jsonb, $7, $8::text[], $9, $10, $11, $12) AS id',
    [input.bindingId, input.kind, JSON.stringify(input.ops), input.baseRevision, input.baseHash, JSON.stringify(input.evidence),
      input.envelope.sensitivity, input.envelope.compartments, input.envelope.privateToUser, input.summary, input.assistantId,
      input.restoreOf ?? null])
  return rows.rows[0].id
}

export async function publish(client: PoolClient, input: {
  bindingId: string; proposalId: string | null; ops: Ops; expectedDirection: number; expectedSelection: number; baseSeq: number
  nextYdoc: Uint8Array; nextStateVector: Uint8Array; nextSnapshot: Page; nextTitle: string | null; idempotencyKey: string
  requestHash: string; evidence: BriefEvidence[]; activeWork: 'pause' | 'continue'; kind: 'apply' | 'restore'; assistantId: string | null
}): Promise<BriefPublicationReceipt> {
  const rows = await client.query<{ receipt: BriefPublicationReceipt }>(
    `SELECT brief_publish($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13::jsonb, $14, $15, $16) AS receipt`,
    [input.bindingId, input.proposalId, JSON.stringify(input.ops), input.expectedDirection, input.expectedSelection, input.baseSeq,
      Buffer.from(input.nextYdoc), Buffer.from(input.nextStateVector), JSON.stringify(input.nextSnapshot), input.nextTitle,
      input.idempotencyKey, input.requestHash, JSON.stringify(input.evidence), input.activeWork, input.kind, input.assistantId])
  return rows.rows[0].receipt
}

/** Replay probe: the stored receipt for this request key, without any write. */
export async function findRevisionByKey(client: PoolClient, bindingId: string, idempotencyKey: string): Promise<{ id: string; requestHash: string | null; directionRevision: number; selectionRevision: number; contentSeq: number | null } | null> {
  const rows = await client.query<{ id: string; request_hash: string | null; direction_revision: number; selection_revision: number; content_seq: string | null }>(
    'SELECT id, request_hash, direction_revision, selection_revision, content_seq::text FROM brief_revisions WHERE binding_id = $1 AND idempotency_key = $2',
    [bindingId, idempotencyKey])
  const row = rows.rows[0]
  return row ? { id: row.id, requestHash: row.request_hash, directionRevision: row.direction_revision, selectionRevision: row.selection_revision,
    contentSeq: row.content_seq === null ? null : Number(row.content_seq) } : null
}

export async function dismiss(client: PoolClient, proposalId: string, assistantId: string | null): Promise<void> {
  await client.query('SELECT brief_dismiss($1, $2)', [proposalId, assistantId])
}

export async function selectDepartments(client: PoolClient, input: {
  bindingId: string; departmentBindingIds: string[]; expectedSelection: number; idempotencyKey: string; requestHash: string
  activeWork: 'pause' | 'continue'; assistantId: string | null
}): Promise<BriefPublicationReceipt> {
  const rows = await client.query<{ receipt: BriefPublicationReceipt }>(
    'SELECT brief_select_departments($1, $2::uuid[], $3, $4, $5, $6, $7) AS receipt',
    [input.bindingId, input.departmentBindingIds, input.expectedSelection, input.idempotencyKey, input.requestHash, input.activeWork, input.assistantId])
  return rows.rows[0].receipt
}

export type BriefReceiptResult = 'maintained' | 'proposed' | 'no_change' | 'conflict' | 'unavailable'

export async function recordReceipt(client: PoolClient, input: {
  bindingId: string; key: string; sourceKind: string; sourceId: string | null; sourceVersion: string | null; contentHash: string | null
  result: BriefReceiptResult; basis: Record<string, unknown>; proposalId: string | null; envelope: BriefEnvelope; assistantId: string | null
}): Promise<{ receiptId: string; result: BriefReceiptResult; basis: Record<string, unknown>; replayed: boolean }> {
  const rows = await client.query<{ receipt: { receiptId: string; result: BriefReceiptResult; basis: Record<string, unknown>; replayed: boolean } }>(
    'SELECT brief_record_receipt($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11::text[], $12, $13) AS receipt',
    [input.bindingId, input.key, input.sourceKind, input.sourceId, input.sourceVersion, input.contentHash, input.result,
      JSON.stringify(input.basis), input.proposalId, input.envelope.sensitivity, input.envelope.compartments, input.envelope.privateToUser,
      input.assistantId])
  return rows.rows[0].receipt
}

export async function findReceipt(client: PoolClient, bindingId: string, key: string): Promise<{ id: string; result: BriefReceiptResult; basis: Record<string, unknown> } | null> {
  const rows = await client.query<{ id: string; result: BriefReceiptResult; basis: Record<string, unknown> }>(
    'SELECT id, result, basis FROM brief_receipts WHERE binding_id = $1 AND idempotency_key = $2', [bindingId, key])
  return rows.rows[0] ?? null
}

export async function repairBind(client: PoolClient, bindingId: string, pageId: string, assistantId: string | null): Promise<{ revisionId: string; directionRevision: number; pageId: string }> {
  const rows = await client.query<{ receipt: { revisionId: string; directionRevision: number; pageId: string } }>(
    'SELECT brief_repair_bind($1, $2, $3) AS receipt', [bindingId, pageId, assistantId])
  return rows.rows[0].receipt
}

// ── System reads (ids and revisions only; never content) ─────────────────

export async function findBindingSystem(workspaceId: string, ownerKind: BriefOwnerKind, ownerId: string): Promise<BriefBinding | null> {
  const rows = await query<BindingRow>(
    `SELECT ${BINDING_COLUMNS} FROM brief_bindings WHERE workspace_id = $1 AND owner_kind = $2 AND owner_id = $3`,
    [workspaceId, ownerKind, ownerId])
  return rows.rows[0] ? binding(rows.rows[0]) : null
}

export async function getBindingSystem(bindingId: string): Promise<BriefBinding | null> {
  const rows = await query<BindingRow>(`SELECT ${BINDING_COLUMNS} FROM brief_bindings WHERE id = $1`, [bindingId])
  return rows.rows[0] ? binding(rows.rows[0]) : null
}

export async function bindingForPageSystem(pageId: string): Promise<BriefBinding | null> {
  const rows = await query<BindingRow>(`SELECT ${BINDING_COLUMNS} FROM brief_bindings WHERE page_id = $1`, [pageId])
  return rows.rows[0] ? binding(rows.rows[0]) : null
}

export async function effectiveBasisSystem(projectBindingId: string): Promise<BriefEffectiveBasis | null> {
  const rows = await query<{ basis: BriefEffectiveBasis | null }>('SELECT brief_effective_basis($1) AS basis', [projectBindingId])
  return rows.rows[0]?.basis ?? null
}

/** Revisions applied after a basis, per binding, with their declared active-work effect. */
export async function revisionsSinceSystem(entries: Array<{ binding: string; direction: number; selection?: number }>): Promise<Array<{ bindingId: string; kind: string; activeWork: 'pause' | 'continue' }>> {
  if (!entries.length) return []
  const rows = await query<{ binding_id: string; kind: string; active_work: 'pause' | 'continue' }>(
    `SELECT r.binding_id, r.kind, r.active_work FROM brief_revisions r
       JOIN jsonb_to_recordset($1::jsonb) AS e(binding uuid, direction int, selection int) ON e.binding = r.binding_id
      WHERE (r.kind IN ('apply','restore') AND r.direction_revision > e.direction)
         OR (r.kind = 'selection' AND e.selection IS NOT NULL AND r.selection_revision > e.selection)`,
    [JSON.stringify(entries)])
  return rows.rows.map(row => ({ bindingId: row.binding_id, kind: row.kind, activeWork: row.active_work }))
}

export async function departmentFitsAudienceSystem(departmentBindingId: string, projectId: string): Promise<boolean> {
  const rows = await query<{ ok: boolean }>('SELECT brief_department_fits_audience($1, $2) AS ok', [departmentBindingId, projectId])
  return rows.rows[0]?.ok === true
}

export async function markBroadcastSystem(revisionId: string): Promise<void> {
  await query('UPDATE brief_revisions SET broadcast_at = now() WHERE id = $1 AND broadcast_at IS NULL', [revisionId])
}

export async function getWorkBasisSystem(kind: 'goal' | 'job', workId: string): Promise<{ projectId: string; basis: BriefEffectiveBasis; fingerprint: string } | null> {
  const rows = await query<{ project_id: string; basis: BriefEffectiveBasis; fingerprint: string }>(
    'SELECT project_id, basis, fingerprint FROM brief_work_bases WHERE work_kind = $1 AND work_id = $2', [kind, workId])
  const row = rows.rows[0]
  return row ? { projectId: row.project_id, basis: row.basis, fingerprint: row.fingerprint } : null
}

export async function putWorkBasisSystem(input: { kind: 'goal' | 'job'; workId: string; workspaceId: string; projectId: string; basis: BriefEffectiveBasis; fingerprint: string }): Promise<void> {
  await query(
    `INSERT INTO brief_work_bases(work_kind, work_id, workspace_id, project_id, basis, fingerprint)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     ON CONFLICT (work_kind, work_id) DO UPDATE SET basis = EXCLUDED.basis, fingerprint = EXCLUDED.fingerprint,
       project_id = EXCLUDED.project_id, captured_at = now()`,
    [input.kind, input.workId, input.workspaceId, input.projectId, JSON.stringify(input.basis), input.fingerprint])
}
