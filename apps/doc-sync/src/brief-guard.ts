/**
 * Brief Direction guard for the live document (project-briefs.md -> "The
 * publication barrier"). A bound Brief page's Direction region changes only
 * through `brief_publish`; every live writer is checked here BEFORE Hocuspocus
 * integrates or broadcasts anything:
 *
 *   - `assertBriefDirection` (beforeSync): a WebSocket update (typing, offline
 *     replay, client Undo, paste/import) is applied to a scratch clone and the
 *     region compared. A change makes the connection read-only, sends the
 *     stateless `brief-direction-protected`, closes with 4409 and throws, so
 *     the update is never applied or broadcast (the drawing-protocol pattern).
 *   - `directionChangedByOps` (`/internal/apply`): Brian's `patchPage`,
 *     imports and maintenance are refused the same way.
 *   - `recoverBriefDocument`: merges the committed persisted state into the
 *     live document after a publication (the `/internal/brief-sync` notice, or
 *     the recovery when a store is refused because the live doc missed it).
 *
 * [COMP:doc-sync/brief-publication]
 */
import * as Y from 'yjs'
import { applyOpsToYDoc, type DocOp, yDocToSnapshot } from '@use-brian/doc-model'
import { canonicalBlocksJson, extractDirectionRegion, type BriefLayout } from '@use-brian/core/dist/doc/brief-types.js'
import { storePageSnapshot, type SysQuery } from './persistence.js'

export type BriefRegionLayout = Pick<BriefLayout, 'directionStartId' | 'contextStartId'>

export const BRIEF_PROTECTED_REASON = 'brief-direction-protected'

export const BRIEF_LAYOUT_SQL =
  'SELECT direction_start_id AS "directionStartId", context_start_id AS "contextStartId" FROM brief_bindings WHERE page_id = $1'

export async function briefLayoutFor(pageId: string, query: SysQuery): Promise<BriefRegionLayout | null> {
  const rows = await query<BriefRegionLayout>(BRIEF_LAYOUT_SQL, [pageId])
  return rows[0] ?? null
}

function regionOf(doc: Y.Doc, layout: BriefRegionLayout): string {
  const { page } = yDocToSnapshot(doc)
  return canonicalBlocksJson(extractDirectionRegion(page, layout as BriefLayout))
}

function cloneOf(doc: Y.Doc): Y.Doc {
  const clone = new Y.Doc()
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc))
  return clone
}

/** Would this Yjs update change the accepted Direction region? */
export function directionChangedByUpdate(doc: Y.Doc, update: Uint8Array, layout: BriefRegionLayout): boolean {
  const before = regionOf(doc, layout)
  const clone = cloneOf(doc)
  try {
    Y.applyUpdate(clone, update)
    return regionOf(clone, layout) !== before
  } finally {
    clone.destroy()
  }
}

/** Would this op batch change the accepted Direction region? */
export function directionChangedByOps(doc: Y.Doc, ops: DocOp[], layout: BriefRegionLayout): boolean {
  const before = regionOf(doc, layout)
  const clone = cloneOf(doc)
  try {
    applyOpsToYDoc(clone, ops)
    return regionOf(clone, layout) !== before
  } finally {
    clone.destroy()
  }
}

/** Called by beforeSync, before Hocuspocus can integrate a client update. */
export function assertBriefDirection(params: {
  doc: Y.Doc
  type: number
  update: Uint8Array
  layout: BriefRegionLayout | null
  connection: { readOnly: boolean; sendStateless: (payload: string) => void; close: (event: { code: number; reason: string }) => void }
}): void {
  // Sync step 1 carries a state vector, not content.
  if (params.type === 0 || !params.layout) return
  if (!directionChangedByUpdate(params.doc, params.update, params.layout)) return
  params.connection.readOnly = true
  params.connection.sendStateless(BRIEF_PROTECTED_REASON)
  params.connection.close({ code: 4409, reason: BRIEF_PROTECTED_REASON })
  throw new Error(BRIEF_PROTECTED_REASON)
}

/**
 * Merge the committed persisted state into a live document. Yjs merge is
 * idempotent, so a repeated notice or a recovery after a missed one is safe;
 * Hocuspocus broadcasts the merged changes to every connected tab.
 */
export async function recoverBriefDocument(params: { pageId: string; ydoc: Y.Doc; query: SysQuery }): Promise<boolean> {
  const rows = await params.query<{ ydoc: Buffer | null }>('SELECT ydoc FROM documents WHERE page_id = $1', [params.pageId])
  const persisted = rows[0]?.ydoc
  if (!persisted) return false
  Y.applyUpdate(params.ydoc, new Uint8Array(persisted), 'brief-publication')
  return true
}

export function isBriefDirectionRefusal(error: unknown): boolean {
  return /brief_direction_protected/.test((error as Error | undefined)?.message ?? '')
}

/**
 * The page store used by the live service: a Brief publication that
 * committed while this document missed its notice makes the guard trigger
 * refuse the stale Direction; merge the committed state (broadcasting it) and
 * store again. Any other failure propagates unchanged.
 */
export async function storePageSnapshotGuarded(params: { pageId: string; ydoc: Y.Doc; query: SysQuery }): ReturnType<typeof storePageSnapshot> {
  try {
    return await storePageSnapshot(params)
  } catch (error) {
    if (!isBriefDirectionRefusal(error)) throw error
    await recoverBriefDocument(params)
    return storePageSnapshot(params)
  }
}
