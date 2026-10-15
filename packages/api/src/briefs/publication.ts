/**
 * Apply direction: the one canonical publication (project-briefs.md -> "The
 * publication barrier"). Explicit owner acceptance of exact typed ops:
 *
 *   1. Read the persisted Yjs state and its seq through the owner's page RLS;
 *      apply the exact ops to a fresh Y.Doc and derive the snapshot.
 *   2. `brief_publish` locks the binding and the documents row, rechecks the
 *      owner, expected revisions, base seq and request hash, and commits the
 *      binding, Page state, immutable revision, proposal status and receipt
 *      together. A concurrent Current-context edit moves the seq; the exact ops
 *      are rebuilt on the new base (bounded). A changed Direction is stale.
 *   3. After commit, doc-sync merges the committed state into the live
 *      document (broadcast). A failed notice self-heals on doc-sync's next
 *      refused store.
 *
 * [COMP:api/brief-publication]
 */
import * as Y from 'yjs'
import { applyOpsToYDoc, FRAGMENT_FIELD, healBlockIds, yDocToSnapshot, type DocOp } from '@use-brian/doc-model'
import { extractDirectionRegion, validateDirectionOps, type Ops } from '@use-brian/core'
import { hashCommandReviewIntent } from '../workspace-access/command-review.js'
import { createBriefSyncClient } from '../doc/doc-gateway.js'
import {
  briefFail,
  findRevisionByKey,
  getBinding,
  getProposal,
  getRevision,
  getRole,
  markBroadcastSystem,
  publish,
  readPageState,
  withBriefActor,
  type BriefEvidence,
  type BriefPublicationReceipt,
} from '../db/brief-store.js'
import { compileDirectionChange, proposeChange, type BriefActor, type DirectionChange } from './service.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'

export type ApplyDirectionInput = {
  /** An open proposal, or the owner's own draft. Omit to apply `change` directly. */
  proposalId?: string | null
  /** The owner's exact edit (also how an edited proposal is accepted). */
  change?: DirectionChange
  expectedDirectionRevision: number
  expectedSelectionRevision: number
  idempotencyKey: string
  /** `continue` declares the change compatible with running work. */
  activeWork?: 'pause' | 'continue'
  evidence?: BriefEvidence[]
}

type SyncClient = { syncBrief: (pageId: string) => Promise<boolean> }
let syncOverride: SyncClient | null | undefined
let syncResolved: SyncClient | undefined | null = null

/** Test seam: replace (or disable with `null`) the live broadcast client. */
export function setBriefSyncClientForTests(client: SyncClient | null | undefined): void {
  syncOverride = client
}

function syncClient(): SyncClient | undefined {
  if (syncOverride !== undefined) return syncOverride ?? undefined
  if (syncResolved === null) syncResolved = createBriefSyncClient()
  return syncResolved ?? undefined
}

const MAX_REBASES = 3

/** Exact ops applied to the persisted Yjs state, with the derived snapshot. */
export function buildPublishedState(persisted: Uint8Array, ops: Ops): { ydoc: Uint8Array; stateVector: Uint8Array; snapshot: ReturnType<typeof yDocToSnapshot>; skipped: number } {
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, persisted)
    const result = applyOpsToYDoc(doc, ops as DocOp[])
    doc.transact(() => healBlockIds(doc.getXmlFragment(FRAGMENT_FIELD)))
    return { ydoc: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc), snapshot: yDocToSnapshot(doc), skipped: result.skipped.length }
  } finally {
    doc.destroy()
  }
}

export async function applyDirection(actor: BriefActor, bindingId: string, input: ApplyDirectionInput): Promise<BriefPublicationReceipt> {
  if (!input.proposalId && !input.change) briefFail('brief_ops_invalid')
  const activeWork = input.activeWork ?? 'pause'
  // The request identity is what the owner asked for, never the compiled ops
  // (section edits mint fresh block ids on every compile).
  const requestHash = hashCommandReviewIntent({
    bindingId, proposalId: input.proposalId ?? null, change: input.change ?? null,
    expectedDirectionRevision: input.expectedDirectionRevision, expectedSelectionRevision: input.expectedSelectionRevision,
    activeWork,
  })
  let receipt: BriefPublicationReceipt | undefined
  let pageId: string | null = null
  for (let attempt = 0; attempt <= MAX_REBASES && !receipt; attempt += 1) {
    try {
      receipt = await withBriefActor(actor.userId, async client => {
        const prior = await findRevisionByKey(client, bindingId, input.idempotencyKey)
        if (prior) {
          if (prior.requestHash !== requestHash) briefFail('brief_idempotency_conflict')
          return { revisionId: prior.id, directionRevision: prior.directionRevision, selectionRevision: prior.selectionRevision, contentSeq: prior.contentSeq, replayed: true }
        }
        const binding = await getBinding(client, bindingId)
        if (!binding || binding.workspaceId !== actor.workspaceId) briefFail('brief_not_found')
        const role = await getRole(client, bindingId, actor.userId, actor.assistantId)
        if (!role) briefFail('brief_not_found')
        if (role !== 'owner') briefFail('brief_owner_required')
        if (binding.directionRevision !== input.expectedDirectionRevision || binding.selectionRevision !== input.expectedSelectionRevision) {
          briefFail('brief_revision_stale')
        }
        if (!binding.pageId) briefFail('brief_unavailable')
        pageId = binding.pageId
        const state = await readPageState(client, binding.pageId, { withYdoc: true })
        if (!state?.ydoc) briefFail('brief_unavailable')
        let ops: Ops
        let evidence = input.evidence ?? [{ kind: 'human', id: actor.userId, label: 'Owner applied direction' }]
        let kind: 'apply' | 'restore' = 'apply'
        if (input.proposalId) {
          const proposal = await getProposal(client, input.proposalId)
          if (!proposal || proposal.bindingId !== bindingId) briefFail('brief_not_found')
          if (proposal.status !== 'open') briefFail('brief_proposal_closed')
          // A proposal drafted against an older accepted Direction needs review
          // against the current state; it is never silently rebased.
          if (proposal.baseDirectionRevision !== binding.directionRevision) briefFail('brief_revision_stale')
          ops = input.change ? compileDirectionChange(state.snapshot, binding.layout, input.change) : proposal.ops
          evidence = [...proposal.evidence, ...(input.evidence ?? [])]
          if (proposal.restoreOf) kind = 'restore'
        } else {
          ops = compileDirectionChange(state.snapshot, binding.layout, input.change!)
        }
        const checked = validateDirectionOps(state.snapshot, ops, binding.layout)
        if (!checked.ok) briefFail('brief_ops_invalid')
        const next = buildPublishedState(new Uint8Array(state.ydoc), ops)
        if (next.skipped > 0 || !extractDirectionRegion(next.snapshot.page, binding.layout)) briefFail('brief_revision_stale')
        return publish(client, {
          bindingId, proposalId: input.proposalId ?? null, ops, expectedDirection: input.expectedDirectionRevision,
          expectedSelection: input.expectedSelectionRevision, baseSeq: state.seq, nextYdoc: next.ydoc,
          nextStateVector: next.stateVector, nextSnapshot: next.snapshot.page, nextTitle: next.snapshot.title || null,
          idempotencyKey: input.idempotencyKey, requestHash, evidence, activeWork, kind, assistantId: actor.assistantId,
        })
      })
    } catch (error) {
      // Only an unrelated Current-context edit moved the Page: rebuild on it.
      if (error instanceof WorkspaceAccessError && error.code === 'brief_page_changed' && attempt < MAX_REBASES) continue
      throw error
    }
  }
  if (!receipt) briefFail('brief_page_changed')
  if (!receipt.replayed && pageId) await broadcastPublication(pageId, receipt.revisionId)
  return receipt
}

/** Deliver committed state to live tabs; a failure is recovered by doc-sync. */
export async function broadcastPublication(pageId: string, revisionId: string): Promise<boolean> {
  const client = syncClient()
  if (!client) return false
  const delivered = await client.syncBrief(pageId).catch(() => false)
  if (delivered) await markBroadcastSystem(revisionId).catch(() => undefined)
  return delivered
}

/**
 * Restore a historical revision as a NEW proposal against the current state.
 * The owner then applies it under current authority; history and permissions
 * are never rolled back.
 */
export async function restoreRevision(actor: BriefActor, bindingId: string, revisionId: string): Promise<{ proposalId: string }> {
  const plan = await withBriefActor(actor.userId, async client => {
    const binding = await getBinding(client, bindingId)
    if (!binding || binding.workspaceId !== actor.workspaceId || !binding.pageId) briefFail('brief_not_found')
    const revision = await getRevision(client, revisionId)
    if (!revision || revision.bindingId !== bindingId || !revision.directionSnapshot) briefFail('brief_not_found')
    const state = await readPageState(client, binding.pageId)
    if (!state) briefFail('brief_unavailable')
    const current = extractDirectionRegion(state.snapshot, binding.layout) ?? []
    const historic = revision.directionSnapshot
    const structural = new Set([binding.layout.directionStartId, binding.layout.sectionIds.outcome, binding.layout.sectionIds.rules, binding.layout.sectionIds.decisions])
    // Replace every non-structural block with the historic ones, in order.
    const ops: Ops = [
      ...current.filter(block => !structural.has(block.id)).map(block => ({ op: 'delete' as const, blockId: block.id })),
    ]
    let after = binding.layout.directionStartId
    for (const block of historic) {
      if (structural.has(block.id)) {
        if (block.id !== binding.layout.directionStartId) ops.push({ op: 'edit', blockId: block.id, patch: { text: (block as { text?: string }).text ?? '' } })
        after = block.id
        continue
      }
      const id = `tmp-restore-${ops.length}`
      ops.push({ op: 'add', after, block: { ...block, id } as never })
      after = id
    }
    return { ops, revision }
  })
  const proposal = await proposeChange(actor, bindingId, { ops: plan.ops }, {
    evidence: [{ kind: 'brief_revision', id: revisionId, version: String(plan.revision.directionRevision), label: 'Restore of an accepted revision' }],
    summary: `Restore accepted direction revision ${plan.revision.directionRevision}`,
    restoreOf: revisionId,
  })
  return { proposalId: proposal.id }
}
