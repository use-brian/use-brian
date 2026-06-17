/**
 * Fine-grained text-span observe-then-reconcile guard (Lock #6).
 *
 * > **Scope note.** The *production* server-side AI write path is
 * > block-structured, not flat-text: it applies the `Op` vocabulary to the
 * > real y-prosemirror `XmlFragment` doc via `@sidanclaw/doc-model`
 * > `applyOpsToYDoc` (called by the `apps/doc-sync` `/internal/apply`
 * > endpoint). That path enforces the no-clobber rule at *block* granularity
 * > — an op whose target a human deleted is skipped, not forced. THIS module
 * > is the finer, *intra-block* `Y.Text` guard reserved for a future
 * > character-level reconcile (e.g. the AI rewriting one sentence inside a
 * > paragraph a human is also typing in); it is not yet on the live path.
 *
 * The AI plans an edit to a span of collaborative text, but commits in two
 * beats. At plan time it anchors the target span to Yjs `RelativePosition`s
 * (which survive concurrent insertions/deletions elsewhere) and records the
 * span's text. At commit time it re-resolves those anchors:
 *
 *   - target span unchanged → apply the edit;
 *   - the span moved but its content is intact (a human edited *elsewhere*) →
 *     the relative positions track it, so the edit still applies at the right
 *     place;
 *   - the span's own content changed (a human edited the same words) → DO NOT
 *     blind-apply. Return `span-changed` with the fresh text so the caller
 *     re-reads and re-plans against the human's latest version.
 *
 * This operates on a `Y.Text` — the collaborative text primitive a prose
 * block maps to. The AI authoring path plans/commits per block-text; the
 * version-mismatch → re-plan behavior replaces the old `patchPage` CAS
 * `stale_page` reject.
 *
 * [COMP:doc/reconcile]
 */

import * as Y from 'yjs'

export type EditIntent = {
  /** Inclusive start index into the Y.Text at plan time. */
  from: number
  /** Exclusive end index into the Y.Text at plan time. */
  to: number
  /** Replacement text for [from, to). */
  insert: string
}

export type EditPlan = {
  fromRel: Y.RelativePosition
  toRel: Y.RelativePosition
  /** The text of [from, to) captured at plan time — the staleness check. */
  baseText: string
  baseStateVector: Uint8Array
  insert: string
}

export type CommitResult =
  | { applied: true }
  | {
      applied: false
      reason: 'span-changed' | 'span-deleted'
      /** Current text at the (re-resolved) span — feed back to the model to re-plan. */
      freshText: string
      from: number
      to: number
    }

/** Capture relative-position anchors + the base content for a planned edit. */
export function planEdit(doc: Y.Doc, textName: string, intent: EditIntent): EditPlan {
  const ytext = doc.getText(textName)
  return {
    fromRel: Y.createRelativePositionFromTypeIndex(ytext, intent.from),
    toRel: Y.createRelativePositionFromTypeIndex(ytext, intent.to),
    baseText: ytext.toString().slice(intent.from, intent.to),
    baseStateVector: Y.encodeStateVector(doc),
    insert: intent.insert,
  }
}

/**
 * Re-resolve the plan against the doc's current state and either apply the
 * edit (in a transaction) or signal that the caller must re-plan.
 */
export function commitEdit(doc: Y.Doc, textName: string, plan: EditPlan): CommitResult {
  const ytext = doc.getText(textName)
  const from = Y.createAbsolutePositionFromRelativePosition(plan.fromRel, doc)
  const to = Y.createAbsolutePositionFromRelativePosition(plan.toRel, doc)

  if (!from || !to || from.type !== ytext || to.type !== ytext) {
    return { applied: false, reason: 'span-deleted', freshText: ytext.toString(), from: 0, to: 0 }
  }

  const lo = Math.min(from.index, to.index)
  const hi = Math.max(from.index, to.index)
  const currentSpan = ytext.toString().slice(lo, hi)

  if (currentSpan !== plan.baseText) {
    // The target span itself changed under us — re-plan, never clobber.
    return { applied: false, reason: 'span-changed', freshText: currentSpan, from: lo, to: hi }
  }

  doc.transact(() => {
    if (hi > lo) ytext.delete(lo, hi - lo)
    if (plan.insert) ytext.insert(lo, plan.insert)
  })
  return { applied: true }
}
