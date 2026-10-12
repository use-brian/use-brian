/**
 * The one Brief service behind REST routes and Brian's tools
 * (project-briefs.md -> "Commands"). Every persistent operation is a typed
 * command here; humans and Brian reach the same functions with the same
 * inputs, authority checks, conflicts and receipts.
 *
 * [COMP:api/brief-publication]
 */
import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import * as Y from 'yjs'
import { FRAGMENT_FIELD, healBlockIds, pageToYDoc, yDocToSnapshot } from '@use-brian/doc-model'
import {
  BRIEF_DIRECTION_SECTIONS,
  buildBriefSkeleton,
  buildDirectionSectionOps,
  canonicalBlocksJson,
  contextSections,
  directionSections,
  extractDirectionRegion,
  isDirectionEmpty,
  normalizeBriefLocale,
  sectionLines,
  validateDirectionOps,
  type BriefContextContent,
  type BriefDirectionContent,
  type BriefDirectionSection,
  type BriefLayout,
  type BriefOwnerKind,
  type Ops,
  type Page,
} from '@use-brian/core'
import { query } from '../db/client.js'
import { withPagePlacement } from '../db/page-placement-admission.js'
import {
  bindPage,
  briefError,
  briefFail,
  dismiss as dismissCommand,
  findBinding,
  getBinding,
  getProposal,
  getRole,
  listProposals,
  listRevisions,
  listSelections,
  readPageState,
  repairBind,
  saveProposal,
  selectDepartments as selectDepartmentsCommand,
  withBriefActor,
  type BriefBinding,
  type BriefEnvelope,
  type BriefEvidence,
  type BriefProposal,
  type BriefPublicationReceipt,
  type BriefRevision,
  type BriefRole,
} from '../db/brief-store.js'
import { hashCommandReviewIntent } from '../workspace-access/command-review.js'
import { BRIEF_CONTEXT_SECTIONS, BRIEF_SECTION_LABELS, type BriefLocale } from '@use-brian/core'

export type BriefActor = { userId: string; workspaceId: string; assistantId: string | null }
export type BriefOwner = { kind: BriefOwnerKind; id: string }

const SENSITIVITY_RANK = { public: 0, internal: 1, confidential: 2 } as const
type Sensitivity = keyof typeof SENSITIVITY_RANK
const maxSensitivity = (a: Sensitivity, b: Sensitivity): Sensitivity => (SENSITIVITY_RANK[a] >= SENSITIVITY_RANK[b] ? a : b)

export type BriefView = {
  binding: BriefBinding
  role: BriefRole
  pageId: string | null
  missing: boolean
  title: string | null
  established: boolean
  direction: Record<BriefDirectionSection, string[]> | null
  directionBlocks: BriefDirectionContent | null
  context: BriefContextContent | null
  contentSeq: number | null
  proposals: Array<BriefProposal & { stale: boolean }>
  myDraft: (BriefProposal & { stale: boolean }) | null
  selections: string[]
}

// ── Envelope resolution ──────────────────────────────────────────────────

/** The Brief page's own audience: its Project label or Department compartment, at the page clearance. */
async function pageEnvelope(client: PoolClient, pageId: string): Promise<BriefEnvelope> {
  const row = (await client.query<{ clearance: Sensitivity; shared: string | null; compartment: string | null }>(
    `SELECT sv.clearance, sv.shared_project_id AS shared, g.compartment_key AS compartment
       FROM saved_views sv LEFT JOIN teamspaces t ON t.id = sv.teamspace_id
       LEFT JOIN workspace_groups g ON g.id = t.workspace_group_id
      WHERE sv.id = $1`, [pageId])).rows[0]
  if (!row) briefFail('brief_unavailable')
  return {
    sensitivity: row.clearance,
    compartments: [...(row.shared ? [`project:${row.shared}`] : []), ...(row.compartment ? [row.compartment] : [])],
    privateToUser: null,
  }
}

/**
 * Fold every cited source's audience into the proposal envelope, reading each
 * source as the actor (an unreadable source is refused, never assumed). A
 * personal/private source makes the proposal private to its author, so it can
 * never surface in a shared review card or count.
 */
export async function resolveEvidenceEnvelope(client: PoolClient, actor: BriefActor, base: BriefEnvelope, evidence: BriefEvidence[]): Promise<BriefEnvelope> {
  let sensitivity = base.sensitivity
  const compartments = new Set(base.compartments)
  let privateToUser = base.privateToUser
  for (const item of evidence) {
    if (!item.id) continue
    let row: { sensitivity: Sensitivity; compartments: string[] | null; privateOwner: string | null } | undefined
    switch (item.kind) {
      case 'page':
        row = (await client.query<{ sensitivity: Sensitivity; compartments: string[] | null; privateOwner: string | null }>(
          `SELECT sv.clearance AS sensitivity,
                  array_remove(ARRAY[CASE WHEN sv.shared_project_id IS NOT NULL THEN 'project:' || sv.shared_project_id END, g.compartment_key], NULL) AS compartments,
                  CASE WHEN sv.teamspace_id IS NULL AND sv.shared_project_id IS NULL THEN sv.created_by END AS "privateOwner"
             FROM saved_views sv LEFT JOIN teamspaces t ON t.id = sv.teamspace_id
             LEFT JOIN workspace_groups g ON g.id = t.workspace_group_id
            WHERE sv.id = $1 AND sv.workspace_id = $2`, [item.id, actor.workspaceId])).rows[0]
        break
      case 'session':
        row = (await client.query<{ sensitivity: Sensitivity; compartments: string[] | null; privateOwner: string | null }>(
          `SELECT 'internal'::text AS sensitivity, s.context_compartments AS compartments,
                  CASE WHEN s.visibility = 'workspace' THEN NULL ELSE s.user_id END AS "privateOwner"
             FROM sessions s WHERE s.id = $1 AND s.workspace_id = $2`, [item.id, actor.workspaceId])).rows[0]
        break
      case 'memory':
      case 'task':
      case 'file': {
        const table = item.kind === 'memory' ? 'memories' : item.kind === 'task' ? 'tasks' : 'workspace_files'
        row = (await client.query<{ sensitivity: Sensitivity; compartments: string[] | null; privateOwner: string | null }>(
          `SELECT x.sensitivity, x.compartments, x.user_id AS "privateOwner" FROM ${table} x
            WHERE x.id = $1 AND x.workspace_id = $2 AND x.valid_to IS NULL`, [item.id, actor.workspaceId])).rows[0]
        break
      }
      default:
        continue
    }
    if (!row) briefFail('brief_unavailable')
    sensitivity = maxSensitivity(sensitivity, row.sensitivity)
    for (const label of row.compartments ?? []) compartments.add(label)
    if (row.privateOwner) privateToUser = actor.userId
  }
  return { sensitivity, compartments: [...compartments].sort(), privateToUser }
}

// ── Ensure / inspect ─────────────────────────────────────────────────────

async function departmentTeamspace(workspaceId: string, departmentId: string): Promise<string | null> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM teamspaces WHERE workspace_id = $1 AND workspace_group_id = $2 ORDER BY is_default DESC, created_at LIMIT 1`,
    [workspaceId, departmentId])
  return rows.rows[0]?.id ?? null
}

/** Build the Yjs state and its derived snapshot for a fresh Brief page. */
export function encodeBriefPage(page: Page, title: string): { ydoc: Buffer; stateVector: Buffer; snapshot: Page; title: string } {
  const doc = pageToYDoc(page, title)
  doc.transact(() => healBlockIds(doc.getXmlFragment(FRAGMENT_FIELD)))
  const snap = yDocToSnapshot(doc)
  return { ydoc: Buffer.from(Y.encodeStateAsUpdate(doc)), stateVector: Buffer.from(Y.encodeStateVector(doc)), snapshot: snap.page, title: snap.title }
}

/**
 * Create or resolve the one correctly placed Brief Page and binding. Name-only
 * creation yields an empty, not-established Direction; an existing Project
 * description is offered as a pending source-backed proposal, never accepted.
 */
export async function ensureBrief(actor: BriefActor, owner: BriefOwner, opts: { locale?: string; title?: string } = {}): Promise<{ bindingId: string; created: boolean }> {
  const existing = await withBriefActor(actor.userId, client => findBinding(client, actor.workspaceId, owner.kind, owner.id))
  if (existing) return { bindingId: existing.id, created: false }
  const ws = (await query<{ v2: boolean }>('SELECT department_read_v2 AS v2 FROM workspaces WHERE id = $1', [actor.workspaceId])).rows[0]
  if (!ws) briefFail('brief_not_found')
  if (!ws.v2) briefFail('brief_requires_department_read')
  let placement: { sharedProjectId?: string; teamspaceId?: string }
  let description: string | null = null
  if (owner.kind === 'project') {
    const project = (await query<{ shared: boolean; description: string | null }>(
      `SELECT EXISTS (SELECT 1 FROM project_shared_scopes s WHERE s.project_id = p.id) AS shared, p.description
         FROM workspace_projects p WHERE p.id = $1 AND p.workspace_id = $2`, [owner.id, actor.workspaceId])).rows[0]
    if (!project) briefFail('brief_not_found')
    if (!project.shared) briefFail('brief_requires_shared_project')
    placement = { sharedProjectId: owner.id }
    description = project.description?.trim() || null
  } else {
    const teamspaceId = await departmentTeamspace(actor.workspaceId, owner.id)
    if (!teamspaceId) briefFail('brief_unavailable')
    placement = { teamspaceId }
  }
  const locale = normalizeBriefLocale(opts.locale)
  const { layout, page } = buildBriefSkeleton(locale, () => randomUUID())
  const title = opts.title?.trim() || 'Brief'
  try {
    return await withPagePlacement(actor.workspaceId, actor.userId, placement, async (client, placed) => {
      // The workspace row lock taken by placement serializes concurrent ensures.
      const raced = (await client.query<{ id: string }>(
        'SELECT id FROM brief_bindings WHERE workspace_id = $1 AND owner_kind = $2 AND owner_id = $3', [actor.workspaceId, owner.kind, owner.id])).rows[0]
      if (raced) return { bindingId: raced.id, created: false }
      const encoded = encodeBriefPage(page, title)
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO saved_views (workspace_id, created_by, name, name_origin, entity, view_type, binding, page, state,
            teamspace_id, project_id, clearance, shared_project_id, position)
         VALUES ($1, $2, $3, 'user', 'tasks', 'table', '{"entity":"tasks","viewType":"table"}'::jsonb, $4::jsonb, 'saved',
            $5, $6, $7, $8, 0)
         RETURNING id`,
        [actor.workspaceId, actor.userId, title, JSON.stringify(encoded.snapshot), placed.teamspaceId ?? null,
          placed.projectId ?? null, placed.clearance ?? 'internal', placed.sharedProjectId ?? null])
      const pageId = inserted.rows[0].id
      await client.query(
        `INSERT INTO documents (page_id, ydoc, state_vector, snapshot_json, snapshot_title, seq, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, 1, now())`,
        [pageId, encoded.ydoc, encoded.stateVector, JSON.stringify(encoded.snapshot), encoded.title])
      const bindingId = await bindPage(client, { ownerKind: owner.kind, ownerId: owner.id, pageId, layout, locale, assistantId: actor.assistantId })
      if (description) {
        // Legacy description: evidence for a proposal, never accepted direction.
        const ops = buildDirectionSectionOps(encoded.snapshot, layout, { outcome: [description] }, () => randomUUID())
        const envelope = await pageEnvelope(client, pageId)
        const region = extractDirectionRegion(encoded.snapshot, layout)
        await saveProposal(client, {
          bindingId, kind: 'proposal', ops, baseRevision: 0, baseHash: hashRegion(region), envelope,
          evidence: [{ kind: 'project_description', id: owner.id, passage: description }],
          summary: 'The existing Project description, offered as the outcome. It is not accepted direction until an owner applies it.',
          assistantId: actor.assistantId,
        })
      }
      return { bindingId, created: true }
    }, { provenance: { kind: 'human-authored', actorId: actor.userId } } as never)
  } catch (error) {
    throw briefError(error)
  }
}

/** Stable digest of a region used as a draft's base marker (not the SQL hash). */
export function hashRegion(region: Page['blocks'] | null): string {
  return createHash('sha256').update(canonicalBlocksJson(region)).digest('hex')
}

function lines(sections: BriefDirectionContent | null): Record<BriefDirectionSection, string[]> | null {
  if (!sections) return null
  return Object.fromEntries(BRIEF_DIRECTION_SECTIONS.map(key => [key, sectionLines(sections[key])])) as Record<BriefDirectionSection, string[]>
}

async function view(client: PoolClient, actor: BriefActor, binding: BriefBinding, role: BriefRole): Promise<BriefView> {
  const state = binding.pageId ? await readPageState(client, binding.pageId) : null
  const region = state ? extractDirectionRegion(state.snapshot, binding.layout) : null
  const sections = directionSections(region, binding.layout)
  const proposals = await listProposals(client, binding.id, { status: ['open'] })
  const stale = (p: BriefProposal) => p.baseDirectionRevision !== binding.directionRevision
  const marked = proposals.map(p => ({ ...p, stale: stale(p) }))
  return {
    binding, role, pageId: binding.pageId, missing: !binding.pageId || !state, title: state?.title ?? null,
    established: binding.directionRevision > 0 && !isDirectionEmpty(sections),
    direction: lines(sections), directionBlocks: sections,
    context: state ? contextSections(state.snapshot, binding.layout) : null,
    contentSeq: state?.seq ?? null,
    proposals: marked.filter(p => p.kind === 'proposal'),
    myDraft: marked.find(p => p.kind === 'draft' && p.authorUserId === actor.userId) ?? null,
    selections: binding.ownerKind === 'project' ? await listSelections(client, binding.id) : [],
  }
}

async function loadBinding(client: PoolClient, actor: BriefActor, bindingId: string): Promise<{ binding: BriefBinding; role: BriefRole }> {
  const binding = await getBinding(client, bindingId)
  if (!binding || binding.workspaceId !== actor.workspaceId) briefFail('brief_not_found')
  const role = await getRole(client, binding.id, actor.userId, actor.assistantId)
  if (!role) briefFail('brief_not_found')
  return { binding, role }
}

export async function inspectBrief(actor: BriefActor, ref: { bindingId: string } | { owner: BriefOwner }): Promise<BriefView> {
  return withBriefActor(actor.userId, async client => {
    const bindingId = 'bindingId' in ref ? ref.bindingId
      : (await findBinding(client, actor.workspaceId, ref.owner.kind, ref.owner.id))?.id
    if (!bindingId) briefFail('brief_not_found')
    const { binding, role } = await loadBinding(client, actor, bindingId)
    return view(client, actor, binding, role)
  })
}

export async function briefHistory(actor: BriefActor, bindingId: string): Promise<BriefRevision[]> {
  return withBriefActor(actor.userId, async client => {
    await loadBinding(client, actor, bindingId)
    return listRevisions(client, bindingId)
  })
}

// ── Drafts and proposals ─────────────────────────────────────────────────

export type DirectionChange =
  | { ops: Ops }
  | { sections: Partial<Record<BriefDirectionSection, string[]>> }

async function currentDirection(client: PoolClient, binding: BriefBinding) {
  if (!binding.pageId) briefFail('brief_unavailable')
  const state = await readPageState(client, binding.pageId)
  if (!state) briefFail('brief_unavailable')
  return state
}

/** Compile a change to exact typed ops against the current accepted page and validate it. */
export function compileDirectionChange(page: Page, layout: BriefLayout, change: DirectionChange): Ops {
  const ops = 'ops' in change ? change.ops : buildDirectionSectionOps(page, layout, change.sections, () => randomUUID())
  const checked = validateDirectionOps(page, ops, layout)
  if (!checked.ok) briefFail('brief_ops_invalid')
  return ops
}

/**
 * Save the author's own draft (autosave). Never touches the Page or accepted
 * direction. An explicit owner edit is human intent evidence; it need not cite
 * an external source.
 */
export async function saveDraft(actor: BriefActor, bindingId: string, change: DirectionChange, opts: { summary?: string | null } = {}): Promise<BriefProposal> {
  return withBriefActor(actor.userId, async client => {
    const { binding, role } = await loadBinding(client, actor, bindingId)
    if (role === 'oversight') briefFail('brief_owner_required')
    const state = await currentDirection(client, binding)
    const ops = compileDirectionChange(state.snapshot, binding.layout, change)
    const envelope = await pageEnvelope(client, binding.pageId!)
    const id = await saveProposal(client, {
      bindingId, kind: 'draft', ops, baseRevision: binding.directionRevision,
      baseHash: hashRegion(extractDirectionRegion(state.snapshot, binding.layout)), envelope: { ...envelope, privateToUser: actor.userId },
      evidence: [{ kind: 'human', id: actor.userId, label: 'Owner edit' }], summary: opts.summary ?? null, assistantId: actor.assistantId,
    })
    return (await getProposal(client, id))!
  })
}

/**
 * Store a reviewable proposal with its original source passages and versions.
 * Brian and ordinary participants propose; nothing is accepted here.
 */
export async function proposeChange(actor: BriefActor, bindingId: string, change: DirectionChange, opts: { evidence: BriefEvidence[]; summary?: string | null; restoreOf?: string | null }): Promise<BriefProposal> {
  return withBriefActor(actor.userId, async client => {
    const { binding, role } = await loadBinding(client, actor, bindingId)
    if (role === 'oversight') briefFail('brief_owner_required')
    const state = await currentDirection(client, binding)
    const ops = compileDirectionChange(state.snapshot, binding.layout, change)
    const envelope = await resolveEvidenceEnvelope(client, actor, await pageEnvelope(client, binding.pageId!), opts.evidence)
    const id = await saveProposal(client, {
      bindingId, kind: 'proposal', ops, baseRevision: binding.directionRevision,
      baseHash: hashRegion(extractDirectionRegion(state.snapshot, binding.layout)), envelope, evidence: opts.evidence,
      summary: opts.summary ?? null, assistantId: actor.assistantId, restoreOf: opts.restoreOf ?? null,
    })
    return (await getProposal(client, id))!
  })
}

export async function dismissProposal(actor: BriefActor, proposalId: string): Promise<void> {
  await withBriefActor(actor.userId, async client => {
    const prop = await getProposal(client, proposalId)
    if (!prop) briefFail('brief_not_found')
    const binding = await getBinding(client, prop.bindingId)
    if (!binding || binding.workspaceId !== actor.workspaceId) briefFail('brief_not_found')
    await dismissCommand(client, proposalId, actor.assistantId)
  })
}


// ── Department rule bindings ─────────────────────────────────────────────

export type DepartmentBriefOption = { bindingId: string; departmentId: string; name: string | null; directionRevision: number }

/** Department Briefs the actor can see, for an owner's explicit selection. */
export async function listDepartmentBriefs(actor: BriefActor): Promise<DepartmentBriefOption[]> {
  return withBriefActor(actor.userId, async client => {
    const rows = await client.query<{ id: string; department_id: string; name: string | null; direction_revision: number }>(
      `SELECT b.id, b.department_id, g.name, b.direction_revision FROM brief_bindings b
         LEFT JOIN workspace_groups g ON g.id = b.department_id
        WHERE b.workspace_id = $1 AND b.owner_kind = 'department' ORDER BY g.name NULLS LAST, b.id`, [actor.workspaceId])
    return rows.rows.map(row => ({ bindingId: row.id, departmentId: row.department_id, name: row.name, directionRevision: row.direction_revision }))
  })
}

/**
 * Replace a Project's selected Department Briefs (D29). Explicit ids and the
 * expected selection revision; selection grants no source access, copies no
 * rule, and order is display only.
 */
export async function selectDepartmentBriefs(actor: BriefActor, bindingId: string, input: {
  departmentBindingIds: string[]; expectedSelectionRevision: number; idempotencyKey: string; activeWork?: 'pause' | 'continue'
}): Promise<BriefPublicationReceipt> {
  const activeWork = input.activeWork ?? 'pause'
  const requestHash = hashCommandReviewIntent({ bindingId, departmentBindingIds: input.departmentBindingIds, expectedSelectionRevision: input.expectedSelectionRevision, activeWork })
  return withBriefActor(actor.userId, async client => {
    const binding = await getBinding(client, bindingId)
    if (!binding || binding.workspaceId !== actor.workspaceId) briefFail('brief_not_found')
    return selectDepartmentsCommand(client, {
      bindingId, departmentBindingIds: input.departmentBindingIds, expectedSelection: input.expectedSelectionRevision,
      idempotencyKey: input.idempotencyKey, requestHash, activeWork, assistantId: actor.assistantId,
    })
  })
}

// ── Repair ───────────────────────────────────────────────────────────────

/**
 * Recreate a missing bound Page from the last accepted checkpoint (owner only).
 * The accepted Direction is restored exactly; missing rules are never
 * manufactured and General is never a fallback. Current context starts empty.
 */
export async function repairBrief(actor: BriefActor, bindingId: string): Promise<{ pageId: string; directionRevision: number }> {
  const plan = await withBriefActor(actor.userId, async client => {
    const binding = await getBinding(client, bindingId)
    if (!binding || binding.workspaceId !== actor.workspaceId) briefFail('brief_not_found')
    const role = await getRole(client, bindingId, actor.userId, actor.assistantId)
    if (!role) briefFail('brief_not_found')
    if (role !== 'owner') briefFail('brief_owner_required')
    if (binding.pageId) briefFail('brief_ops_invalid')
    const last = (await listRevisions(client, bindingId, 200)).find(r => r.directionSnapshot && r.kind !== 'selection')
    if (!last?.directionSnapshot) briefFail('brief_unavailable')
    return { binding, region: last.directionSnapshot }
  })
  const { binding, region } = plan
  const labels = BRIEF_SECTION_LABELS[normalizeBriefLocale(binding.locale) as BriefLocale]
  const page: Page = { blocks: [
    ...region,
    { kind: 'heading', id: binding.layout.contextStartId, level: 2, text: labels.context },
    ...BRIEF_CONTEXT_SECTIONS.map(key => ({ kind: 'heading' as const, id: binding.layout.sectionIds[key], level: 3 as const, text: labels[key] })),
  ] }
  const placement = binding.ownerKind === 'project'
    ? { sharedProjectId: binding.ownerId }
    : { teamspaceId: (await departmentTeamspace(actor.workspaceId, binding.ownerId)) ?? briefFail('brief_unavailable') }
  try {
    return await withPagePlacement(actor.workspaceId, actor.userId, placement, async (client, placed) => {
      const encoded = encodeBriefPage(page, 'Brief')
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO saved_views (workspace_id, created_by, name, name_origin, entity, view_type, binding, page, state,
            teamspace_id, project_id, clearance, shared_project_id, position)
         VALUES ($1, $2, 'Brief', 'user', 'tasks', 'table', '{"entity":"tasks","viewType":"table"}'::jsonb, $3::jsonb, 'saved', $4, $5, $6, $7, 0)
         RETURNING id`,
        [actor.workspaceId, actor.userId, JSON.stringify(encoded.snapshot), placed.teamspaceId ?? null, placed.projectId ?? null,
          placed.clearance ?? 'internal', placed.sharedProjectId ?? null])
      const pageId = inserted.rows[0].id
      await client.query(
        `INSERT INTO documents (page_id, ydoc, state_vector, snapshot_json, snapshot_title, seq, updated_at) VALUES ($1, $2, $3, $4::jsonb, $5, 1, now())`,
        [pageId, encoded.ydoc, encoded.stateVector, JSON.stringify(encoded.snapshot), encoded.title])
      const receipt = await repairBind(client, bindingId, pageId, actor.assistantId)
      return { pageId, directionRevision: receipt.directionRevision }
    }, { provenance: { kind: 'human-authored', actorId: actor.userId } } as never)
  } catch (error) {
    throw briefError(error)
  }
}
