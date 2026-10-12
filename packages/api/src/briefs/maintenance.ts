/**
 * Source-backed Current-context maintenance (project-briefs.md -> "Commands",
 * plan §4). Brian and participants add attributable findings, questions and
 * references from inspected admitted sources, through the native Page write
 * path, with an idempotent receipt per item:
 *
 *   - a repeated or unchanged item is `no_change` and makes zero Page writes;
 *   - a source the Brief audience cannot read is `unavailable` (never written
 *     into a shared Page);
 *   - Task/Goal progress lines are composed from the canonical record, never
 *     from model text; `coverage: 'partial'` is written as partial.
 *
 * Maintenance never changes the direction revision and authorizes nothing.
 *
 * [COMP:api/brief-publication]
 */
import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import * as Y from 'yjs'
import { applyOpsToYDoc, FRAGMENT_FIELD, healBlockIds, yDocToSnapshot, type DocOp } from '@use-brian/doc-model'
import { contextSections, type BriefContextSection, type DocGateway, type Ops } from '@use-brian/core'
import { createDocGateway } from '../doc/doc-gateway.js'
import {
  briefFail,
  findReceipt,
  getBinding,
  getRole,
  readPageState,
  recordReceipt,
  withBriefActor,
  type BriefBinding,
  type BriefEnvelope,
  type BriefEvidence,
  type BriefReceiptResult,
} from '../db/brief-store.js'
import { resolveEvidenceEnvelope, type BriefActor } from './service.js'

export type MaintainItem = {
  /** The finding/question/reference text. Ignored for task/goal sources: status comes from the record. */
  text?: string
  source: BriefEvidence
}

export type MaintainResult = { key: string; result: BriefReceiptResult; blockId: string | null; replayed: boolean }

let gatewayOverride: DocGateway | null | undefined
/** Test seam: replace (or disable with `null`) the live Page write path. */
export function setBriefGatewayForTests(gateway: DocGateway | null | undefined): void {
  gatewayOverride = gateway
}
function gateway(): DocGateway | undefined {
  if (gatewayOverride !== undefined) return gatewayOverride ?? undefined
  return createDocGateway()
}

const RANK = { public: 0, internal: 1, confidential: 2 } as const
const day = (date = new Date()) => date.toISOString().slice(0, 10)

/** The source fits the Brief audience only if it adds no label, privacy or tier. */
function fitsAudience(page: BriefEnvelope, source: BriefEnvelope): boolean {
  return !source.privateToUser
    && RANK[source.sensitivity] <= RANK[page.sensitivity]
    && source.compartments.every(label => page.compartments.includes(label))
}

async function pageAudience(client: PoolClient, pageId: string): Promise<BriefEnvelope> {
  const row = (await client.query<{ clearance: BriefEnvelope['sensitivity']; shared: string | null; compartment: string | null }>(
    `SELECT sv.clearance, sv.shared_project_id AS shared, g.compartment_key AS compartment FROM saved_views sv
       LEFT JOIN teamspaces t ON t.id = sv.teamspace_id LEFT JOIN workspace_groups g ON g.id = t.workspace_group_id
      WHERE sv.id = $1`, [pageId])).rows[0]
  if (!row) briefFail('brief_unavailable')
  return { sensitivity: row.clearance, compartments: [...(row.shared ? [`project:${row.shared}`] : []), ...(row.compartment ? [row.compartment] : [])], privateToUser: null }
}

/** Canonical progress for a Task/Goal source; null when it is not readable. */
async function canonicalProgress(client: PoolClient, actor: BriefActor, source: BriefEvidence): Promise<string | null> {
  if (!source.id) return null
  if (source.kind === 'task') {
    const row = (await client.query<{ title: string; status: string | null }>(
      'SELECT title, status FROM tasks WHERE id = $1 AND workspace_id = $2 AND valid_to IS NULL', [source.id, actor.workspaceId])).rows[0]
    return row ? `Task "${row.title}": ${row.status ?? 'open'}` : null
  }
  if (source.kind === 'goal') {
    const row = (await client.query<{ outcome: string; status: string }>(
      'SELECT outcome, status FROM goals WHERE id = $1 AND workspace_id = $2', [source.id, actor.workspaceId])).rows[0]
    return row ? `Goal "${row.outcome}": ${row.status}` : null
  }
  return null
}

function itemKey(bindingId: string, section: BriefContextSection, source: BriefEvidence, text: string): string {
  return createHash('sha256').update(JSON.stringify([bindingId, section, source.kind, source.id ?? null, source.version ?? null, text.trim()])).digest('hex')
}

/** Write context blocks through the live gateway, or the persisted Yjs state with a seq CAS. */
async function writeContext(actor: BriefActor, binding: BriefBinding, ops: Ops): Promise<void> {
  const live = gateway()
  if (live) {
    const result = await live.applyOps({ userId: actor.userId, pageId: binding.pageId!, ops })
    if ('error' in result) briefFail('brief_unavailable')
    if (result.skipped.length) briefFail('brief_page_changed')
    return
  }
  await withBriefActor(actor.userId, async client => {
    const allowed = (await client.query<{ ok: boolean }>('SELECT saved_view_root_operation_scope_allows($1, true) AS ok', [binding.pageId])).rows[0]?.ok
    if (!allowed) briefFail('brief_unavailable')
    const state = await readPageState(client, binding.pageId!, { withYdoc: true, forUpdate: true })
    if (!state?.ydoc) briefFail('brief_unavailable')
    const doc = new Y.Doc()
    try {
      Y.applyUpdate(doc, new Uint8Array(state.ydoc))
      const applied = applyOpsToYDoc(doc, ops as DocOp[])
      if (applied.skipped.length) briefFail('brief_page_changed')
      doc.transact(() => healBlockIds(doc.getXmlFragment(FRAGMENT_FIELD)))
      const snap = yDocToSnapshot(doc)
      // The guard trigger refuses this write if it touched Direction.
      const updated = await client.query(
        `UPDATE documents SET ydoc = $2, state_vector = $3, snapshot_json = $4::jsonb, seq = seq + 1, updated_at = now()
          WHERE page_id = $1 AND seq = $5`,
        [binding.pageId, Buffer.from(Y.encodeStateAsUpdate(doc)), Buffer.from(Y.encodeStateVector(doc)), JSON.stringify(snap.page), state.seq])
      if (!updated.rowCount) briefFail('brief_page_changed')
    } finally {
      doc.destroy()
    }
  })
}

export async function maintainBriefContext(actor: BriefActor, bindingId: string, input: {
  section: BriefContextSection
  items: MaintainItem[]
  coverage?: 'complete' | 'partial'
}): Promise<{ results: MaintainResult[] }> {
  if (!input.items.length || input.items.length > 20) briefFail('brief_ops_invalid')
  const planned = await withBriefActor(actor.userId, async client => {
    const binding = await getBinding(client, bindingId)
    if (!binding || binding.workspaceId !== actor.workspaceId) briefFail('brief_not_found')
    const role = await getRole(client, bindingId, actor.userId, actor.assistantId)
    if (!role) briefFail('brief_not_found')
    if (role === 'oversight') briefFail('brief_owner_required')
    if (!binding.pageId) briefFail('brief_unavailable')
    const state = await readPageState(client, binding.pageId)
    if (!state) briefFail('brief_unavailable')
    const sections = contextSections(state.snapshot, binding.layout)
    if (!sections) briefFail('brief_unavailable')
    const audience = await pageAudience(client, binding.pageId)
    const items: Array<{ key: string; line: string | null; item: MaintainItem; envelope: BriefEnvelope; existing: { result: BriefReceiptResult; basis: Record<string, unknown> } | null }> = []
    for (const item of input.items) {
      const progress = item.source.kind === 'task' || item.source.kind === 'goal' ? await canonicalProgress(client, actor, item.source) : undefined
      const base = (progress ?? item.text ?? '').trim()
      if (!base) briefFail('brief_ops_invalid')
      const key = itemKey(bindingId, input.section, item.source, base)
      const existing = await findReceipt(client, bindingId, key)
      let envelope: BriefEnvelope
      try {
        envelope = progress === null ? { ...audience, privateToUser: actor.userId } : await resolveEvidenceEnvelope(client, actor, { ...audience, compartments: [] }, [item.source])
      } catch {
        envelope = { ...audience, privateToUser: actor.userId }
      }
      const source = item.source.label ?? item.source.kind
      const line = progress === null || !fitsAudience(audience, envelope) ? null
        : `${base} (source: ${source}${item.source.version ? ` v${item.source.version}` : ''}, ${day()})${input.coverage === 'partial' ? ' [partial capture]' : ''}`
      items.push({ key, line, item, envelope, existing })
    }
    return { binding, sections, items }
  })
  const results: MaintainResult[] = []
  const fresh = planned.items.filter(entry => !entry.existing && entry.line)
  const ids = new Map<string, string>()
  if (fresh.length) {
    const last = planned.sections[input.section].at(-1)?.id ?? planned.binding.layout.sectionIds[input.section]
    let after = last
    const ops: Ops = []
    for (const entry of fresh) {
      const id = randomUUID()
      ids.set(entry.key, id)
      ops.push({ op: 'add', after, block: { kind: 'text', id, text: entry.line! } })
      after = id
    }
    await writeContext(actor, planned.binding, ops)
  }
  await withBriefActor(actor.userId, async client => {
    for (const entry of planned.items) {
      if (entry.existing) {
        results.push({ key: entry.key, result: 'no_change', blockId: (entry.existing.basis.blockId as string | undefined) ?? null, replayed: true })
        continue
      }
      const result: BriefReceiptResult = entry.line ? 'maintained' : 'unavailable'
      const blockId = ids.get(entry.key) ?? null
      const receipt = await recordReceipt(client, {
        bindingId, key: entry.key, sourceKind: entry.item.source.kind, sourceId: entry.item.source.id ?? null,
        sourceVersion: entry.item.source.version ?? null, contentHash: entry.key, result,
        basis: { section: input.section, blockId, coverage: input.coverage ?? 'complete' }, proposalId: null,
        envelope: entry.line ? { ...entry.envelope, privateToUser: null } : entry.envelope, assistantId: actor.assistantId,
      })
      results.push({ key: entry.key, result: receipt.replayed ? 'no_change' : result, blockId, replayed: receipt.replayed })
    }
  })
  return { results }
}
