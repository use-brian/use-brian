/**
 * Apply doc `Op`s to a *live* Y.Doc — the server-side AI write path.
 *
 * The legacy AI authoring path version-CAS'd the whole page JSON into
 * `saved_views.page` (`patchPage` → `doc-page-store`). Under the Yjs
 * rebuild the page body is a CRDT, so AI edits must land in the same Y.Doc
 * humans edit or they diverge (AI writes a column the editor never reads).
 * This module is the bridge: it mutates the doc's XML fragment **surgically,
 * block-by-block, keyed on the `blockId` attribute**, so an AI edit to block
 * B merges cleanly with a concurrent human edit to block A instead of
 * clobbering the whole page.
 *
 * New / replaced nodes are built by round-tripping the block through the
 * existing `pageToYDoc` encoder (y-prosemirror's own converter) and
 * `clone()`-ing the resulting node into the target fragment — so marks,
 * list wrapping, and embed atoms are encoded *exactly* as the browser/sync
 * encoder produces them. We never hand-build Y.XmlText/marks (that desyncs).
 *
 * The caller (the `apps/doc-sync` direct-connection endpoint) wraps this
 * against the authoritative in-memory doc; Hocuspocus then broadcasts the
 * update to every connected human tab and persists the debounced snapshot.
 *
 * Observe-then-reconcile (Lock #6): an op whose target `blockId` no longer
 * exists (a human deleted it) is **skipped, not forced** — it comes back in
 * `skipped[]` so the model can re-read the outline and re-plan rather than
 * resurrecting a deleted block. See `docs/architecture/features/doc.md`
 * → "Real-time collaboration".
 *
 * [COMP:doc-model/apply-ops]
 */

import * as Y from 'yjs'
import type { Block, Page } from '@sidanclaw/core/dist/views/blocks.js'
import { FRAGMENT_FIELD, ID_NODE_TYPES, META_MAP } from './schema.js'
import { pageToYDoc, yDocToSnapshot } from './encode.js'

/**
 * The doc op vocabulary, structurally identical to `Op` in
 * `@sidanclaw/core` `doc/page-types.ts`. Declared locally so this
 * fs-free package doesn't take a runtime import on the core doc module;
 * the shapes are asserted compatible by the chat-route wiring that feeds it.
 */
export type DocOp =
  | { op: 'add'; after: string | 'start' | 'end'; block: Block }
  | { op: 'edit'; blockId: string; patch: Partial<Block> }
  | { op: 'delete'; blockId: string }
  | { op: 'move'; blockId: string; after: string | 'start' | 'end' }
  | { op: 'setTitle'; title: string }
  // `setIcon` is page metadata (`saved_views.icon`), NOT a Y.Doc concern — the
  // doc carries no icon. `patchPage` filters it out before POSTing here, so in
  // practice it never arrives; the variant + no-op case keep this union a
  // faithful mirror of core's `Op` and make a stray forward harmless.
  | { op: 'setIcon'; icon: string | null }

export type ApplyOpsResult = {
  /** tmpId → server-assigned real id, for `add` ops carrying a `tmp-*` id. */
  idMap: Record<string, string>
  /** Ops that could not apply (target gone, or unsupported shape). */
  skipped: { opIndex: number; reason: string }[]
}

const LIST_WRAPPERS = new Set(['bulletList', 'orderedList', 'taskList'])

/** The list-wrapper node name a list-item block encodes into, or null for a
 *  non-list block. Mirrors `block-mapping`'s `listWrapper` so the live AI write
 *  path groups consecutive same-kind items exactly like the full-page
 *  `blocksToPMDoc` conversion does. */
function listWrapperKind(block: Block): string | null {
  switch (block.kind) {
    case 'bulleted_list_item':
      return 'bulletList'
    case 'numbered_list_item':
      return 'orderedList'
    case 'to_do':
      return 'taskList'
    default:
      return null
  }
}

function isTmpId(id: string | undefined | null): boolean {
  return !id || id.startsWith('tmp')
}

function genId(): string {
  return crypto.randomUUID()
}

/** Build the top-level Y.XmlElement(s) for one block via the canonical
 *  encoder, detached (`clone()`) so they can be inserted into a live doc.
 *  `clone()` must be called on the *integrated* temp-doc node — a detached
 *  clone can't be read into further. */
function buildBlockNodes(block: Block): Y.XmlElement[] {
  const tmp = pageToYDoc({ blocks: [block] } as Page, '')
  const frag = tmp.getXmlFragment(FRAGMENT_FIELD)
  const clones = frag
    .toArray()
    .filter((n): n is Y.XmlElement => n instanceof Y.XmlElement)
    .map((n) => n.clone())
  tmp.destroy()
  return clones
}

/** Build the inner list-item node for a single list-item block (the block
 *  encodes as a one-item list wrapper; we lift its item out, cloned from the
 *  integrated temp doc so it's insertable into an existing wrapper). */
function buildListItemNode(block: Block): Y.XmlElement | null {
  const tmp = pageToYDoc({ blocks: [block] } as Page, '')
  const frag = tmp.getXmlFragment(FRAGMENT_FIELD)
  const wrapper = frag.get(0)
  let item: Y.XmlElement | null = null
  if (wrapper instanceof Y.XmlElement && wrapper.length > 0) {
    const first = wrapper.get(0)
    if (first instanceof Y.XmlElement) item = first.clone()
  }
  tmp.destroy()
  return item
}

/**
 * One nesting frame on the path to a list item: the list the item sits in, the
 * item's index there, and where that list itself lives (so an empty list can be
 * removed, or a sibling wrapper inserted beside it). Nested lists live INSIDE a
 * `listItem`'s content (after its paragraph), so `listParent` is the fragment at
 * depth 0 and the enclosing `listItem` deeper.
 */
type ItemFrame = {
  listParent: Y.XmlElement | Y.XmlFragment
  listIndex: number
  list: Y.XmlElement
  itemIndex: number
  item: Y.XmlElement
}

type Loc =
  | { kind: 'top'; index: number }
  | { kind: 'item'; topIndex: number; path: ItemFrame[] }
  | null

/** Recursively find a list item by id within a wrapper, returning the frame
 *  path from this wrapper down to the item (depth = path.length - 1). */
function searchList(
  list: Y.XmlElement,
  listParent: Y.XmlElement | Y.XmlFragment,
  listIndex: number,
  blockId: string,
): ItemFrame[] | null {
  const items = list.toArray()
  for (let j = 0; j < items.length; j++) {
    const item = items[j]
    if (!(item instanceof Y.XmlElement)) continue
    const here: ItemFrame = { listParent, listIndex, list, itemIndex: j, item }
    if (item.getAttribute('blockId') === blockId) return [here]
    const kids = item.toArray()
    for (let c = 0; c < kids.length; c++) {
      const kid = kids[c]
      if (kid instanceof Y.XmlElement && LIST_WRAPPERS.has(kid.nodeName)) {
        const sub = searchList(kid, item, c, blockId)
        if (sub) return [here, ...sub]
      }
    }
  }
  return null
}

/** Find a block by id: a top-level node, or a list item nested at ANY depth
 *  inside a list wrapper. */
function locate(frag: Y.XmlFragment, blockId: string): Loc {
  const arr = frag.toArray()
  for (let i = 0; i < arr.length; i++) {
    const node = arr[i]
    if (!(node instanceof Y.XmlElement)) continue
    if (node.getAttribute('blockId') === blockId) return { kind: 'top', index: i }
    if (LIST_WRAPPERS.has(node.nodeName)) {
      const path = searchList(node, frag, i, blockId)
      if (path) return { kind: 'item', topIndex: i, path }
    }
  }
  return null
}

/** Resolve an `after` anchor to an insertion index in the top-level fragment.
 *  A nested (list-item) anchor resolves to *after its top-level wrapper*. */
function resolveInsertIndex(
  frag: Y.XmlFragment,
  after: string | 'start' | 'end',
  idMap: Record<string, string>,
): number {
  if (after === 'start') return 0
  if (after === 'end') return frag.length
  const id = idMap[after] ?? after
  const loc = locate(frag, id)
  if (!loc) return frag.length // unknown anchor → append
  return loc.kind === 'top' ? loc.index + 1 : loc.topIndex + 1
}

/** A list-item block's authored nesting depth (non-lists → 0). */
function rawIndentOf(block: Block): number {
  if (
    block.kind !== 'bulleted_list_item' &&
    block.kind !== 'numbered_list_item' &&
    block.kind !== 'to_do'
  ) {
    return 0
  }
  const indent = (block as { indent?: number }).indent
  return typeof indent === 'number' && indent > 0 ? Math.floor(indent) : 0
}

/** Detached clones of an item's nested child lists (everything after its lead
 *  paragraph). Cloned so they survive a delete-then-reinsert of the item. */
function nestedListClones(item: Y.XmlElement): Y.XmlElement[] {
  const out: Y.XmlElement[] = []
  const kids = item.toArray()
  for (let c = 0; c < kids.length; c++) {
    const kid = kids[c]
    if (kid instanceof Y.XmlElement && LIST_WRAPPERS.has(kid.nodeName)) out.push(kid.clone())
  }
  return out
}

/**
 * Place a bulleted/numbered item at `indent` depth relative to its `after`
 * anchor, mutating the live tree. Returns true on success, false to fall back to
 * a flat top-level insert (no anchor item, or depth resolves to 0). The depth is
 * clamped to one level deeper than the anchor, so an orphan jump can't float.
 */
function addNested(
  frag: Y.XmlFragment,
  anchorId: string,
  block: Block,
  indent: number,
): boolean {
  const loc = locate(frag, anchorId)
  if (!loc || loc.kind !== 'item') return false
  const wrapperKind = listWrapperKind(block)
  if (!wrapperKind) return false
  const path = loc.path
  const anchorDepth = path.length - 1
  const targetDepth = Math.max(0, Math.min(indent, anchorDepth + 1))
  if (targetDepth === 0) return false // flat insert handles top level

  if (targetDepth <= anchorDepth) {
    // Sibling after the anchor's ancestor at targetDepth (closing deeper levels).
    const frame = path[targetDepth]
    if (frame.list.nodeName === wrapperKind) {
      const item = buildListItemNode(block)
      if (!item) return false
      frame.list.insert(frame.itemIndex + 1, [item])
    } else {
      const wrapper = buildBlockNodes(block)[0]
      if (!wrapper) return false
      frame.listParent.insert(frame.listIndex + 1, [wrapper])
    }
    return true
  }

  // targetDepth === anchorDepth + 1 → first child of the anchor item.
  const parentItem = path[anchorDepth].item
  const kids = parentItem.toArray()
  const lastKid = kids[kids.length - 1]
  if (lastKid instanceof Y.XmlElement && lastKid.nodeName === wrapperKind) {
    const item = buildListItemNode(block)
    if (!item) return false
    lastKid.insert(lastKid.length, [item])
  } else {
    const wrapper = buildBlockNodes(block)[0]
    if (!wrapper) return false
    parentItem.insert(parentItem.length, [wrapper])
  }
  return true
}

/** Node types whose `blockId` attribute is part of the doc contract —
 *  exactly the schema's `ID_NODE_TYPES` (the global-attribute node list). */
const ID_CARRYING_NODES = new Set<string>(ID_NODE_TYPES)

/**
 * Enforce the two blockId invariants the rest of this module assumes:
 * **every ID-carrying node has a `blockId`, and no two nodes share one.**
 * `locate` and the `edit` snapshot `find` are both **first-match**,
 * and the model's whole mental model is one-id-one-block — so two nodes sharing
 * a `blockId` is a silent trap: every id-keyed op (`edit`/`delete`/`move`)
 * reaches only the first copy, and the block the model actually wants returns
 * `edit-target-missing` forever, unrepairable through the op vocabulary.
 *
 * A Yjs element's identity is its internal ID, NOT its `blockId` attribute, so
 * the fork is invisible to Yjs: a whole-node `edit` rebuild (delete-old-element
 * + insert-new-element, `applyOne`'s `edit` case) merging with a concurrent
 * same-block edit from another peer — or a `buildBlockNodes` that emits more
 * than one top-level node — can leave two nodes carrying one `blockId`. This
 * pass walks every element (top-level AND nested list items, matching `locate`'s
 * reach) and reassigns a fresh id to the SECOND and later occurrence; the first,
 * in document order, keeps it (so no in-flight op in the same batch is surprised
 * — first-match still resolves to the same node). Non-destructive: a forked
 * block's content survives under its new id, degrading a trap into two
 * addressable blocks the model can see and merge or delete. Prod incident
 * 2026-06-11 (page `c4b01fe2` / session `d98e2acd`): block `3aa77bc9` forked
 * during concurrent two-session editing → 38 `patchPage` calls looping on
 * `edit-target-missing` → a confabulated "another session is editing, please
 * pause" reply. See `docs/architecture/features/doc.md` → "Real-time collaboration".
 *
 * The MISSING-id half is the same trap from the other direction: the editor
 * creates nodes with `blockId: null` (the schema default — nothing client-side
 * assigns one at creation), and `pmDocToBlocks` fabricates a fresh `genId()`
 * for an attr-less node on EVERY conversion. So each outline/snapshot read
 * showed the model a different id for the same human-typed block, and every
 * id-keyed op against it missed — same loop, but the id "rotates" per read
 * instead of hiding behind a dup. Stamping the id INTO the doc here (and at
 * doc-sync load/persist) makes whatever id a read surfaces a real, stable
 * attribute. Prod incident 2026-06-11 later the same day (page `c4b01fe2` /
 * session `81a56d8b`): the human-typed "Track 3" toggle had no `blockId`,
 * 17 consecutive `patchPage` calls failed across two turns while consecutive
 * error outlines re-minted its id (`e8570915` → `1fab55fe` → `4a813156` → …).
 *
 * Exported for the doc-sync hooks (document load + snapshot persist); callers
 * outside an existing transaction must wrap it in `doc.transact()`.
 */
export function healBlockIds(frag: Y.XmlFragment): void {
  const seen = new Set<string>()
  const visit = (node: Y.XmlElement): void => {
    const id = node.getAttribute('blockId')
    if (typeof id === 'string' && id.length > 0) {
      if (seen.has(id)) {
        const fresh = genId()
        node.setAttribute('blockId', fresh)
        seen.add(fresh)
      } else {
        seen.add(id)
      }
    } else if (ID_CARRYING_NODES.has(node.nodeName)) {
      const fresh = genId()
      node.setAttribute('blockId', fresh)
      seen.add(fresh)
    }
    const kids = node.toArray()
    for (let i = 0; i < kids.length; i++) {
      const kid = kids[i]
      if (kid instanceof Y.XmlElement) visit(kid)
    }
  }
  const top = frag.toArray()
  for (let i = 0; i < top.length; i++) {
    const node = top[i]
    if (node instanceof Y.XmlElement) visit(node)
  }
}

/**
 * Apply ops to a live Y.Doc in one transaction. Pure on `(doc, ops)` →
 * mutated doc; returns the id map for `add` tmpIds and the skipped list.
 * Safe to call inside an outer transaction (Yjs coalesces).
 */
export function applyOpsToYDoc(doc: Y.Doc, ops: DocOp[]): ApplyOpsResult {
  const frag = doc.getXmlFragment(FRAGMENT_FIELD)
  const idMap: Record<string, string> = {}
  const skipped: { opIndex: number; reason: string }[] = []

  doc.transact(() => {
    // Heal blockId forks AND stamp missing ids BEFORE applying this turn's
    // ops, so they anchor on a clean doc (the model's retry finally lands).
    // Run again after, so an op that itself forks a block can't leave the
    // doc corrupt for the next turn.
    healBlockIds(frag)
    ops.forEach((op, opIndex) => {
      // Per-op isolation. Building a block's ProseMirror node round-trips the
      // block through `pageToYDoc` → `Node.fromJSON`, which THROWS on rich text
      // the shared schema can't represent (e.g. a model-authored inline node
      // whose `type` is `text` plus a stray char → "Unknown node type: text").
      // Without this guard that throw escapes the whole `doc.transact`, so a
      // single malformed block sinks the entire patch — the ops that already
      // ran stay committed, the rest are lost, and the caller 500s. That opaque
      // failure is what made the model retry blindly and stack empty "Sources"
      // headings. Catching here turns an unappliable op into a `skipped[]` entry
      // (the same observe-then-reconcile contract a missing target already gets),
      // so its neighbours land and the model is told what failed and why. This
      // matches the legacy CAS write path (`doc/tools.ts`), which already
      // applies ops one-at-a-time and tolerantly skips the ones that throw.
      try {
        applyOne(doc, frag, op, opIndex, idMap, skipped)
      } catch (err) {
        skipped.push({
          opIndex,
          reason: `apply-threw: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    })
    healBlockIds(frag)
  })

  return { idMap, skipped }
}

/** Apply a single op to the live fragment. May throw (node build / schema
 *  rejection); `applyOpsToYDoc` wraps each call so a throw is recorded in
 *  `skipped[]` rather than aborting the surrounding transaction. */
function applyOne(
  doc: Y.Doc,
  frag: Y.XmlFragment,
  op: DocOp,
  opIndex: number,
  idMap: Record<string, string>,
  skipped: { opIndex: number; reason: string }[],
): void {
  switch (op.op) {
    case 'setTitle': {
      doc.getMap(META_MAP).set('title', op.title)
      return
    }
    case 'setIcon': {
      // No Y.Doc representation — the icon lives only in `saved_views.icon`,
      // written by `patchPage` directly. No-op here (and normally filtered
      // out upstream). See the `DocOp` declaration above.
      return
    }
    case 'add': {
      // Resolve a tmp id to a stable server id and remember it so later
      // ops in this batch can reference the block by its tmp id.
      const origId = op.block.id
      const realId = isTmpId(origId) ? genId() : origId
      if (origId && realId !== origId) idMap[origId] = realId
      const block = { ...op.block, id: realId } as Block

      // Nested bullet/numbered item: place it by depth relative to its anchor
      // (sub-bullet under the row above, or back out to a shallower level).
      // Falls through to the flat insert below when there's no anchor item to
      // nest against (e.g. an `end`/`start` anchor) — degrade visible, not lost.
      const indent = rawIndentOf(block)
      if (indent > 0 && op.after !== 'start' && op.after !== 'end') {
        const anchorId = idMap[op.after] ?? op.after
        if (addNested(frag, anchorId, block, indent)) return
      }

      const at = resolveInsertIndex(frag, op.after, idMap)

      // List-item blocks: if the insertion point abuts a list wrapper of the
      // SAME kind, fold the new item INTO that wrapper instead of dropping a
      // fresh one-item wrapper beside it. This mirrors `blocksToPMDoc`'s
      // consecutive-grouping, so a model that builds a list one `add` op per
      // item produces ONE list (Tab-nestable in the editor; ordered lists
      // keep counting 1,2,3…) rather than a stack of sibling <ul>/<ol>s.
      const wrapperKind = listWrapperKind(block)
      if (wrapperKind) {
        const item = buildListItemNode(block)
        const before = at > 0 ? frag.get(at - 1) : null
        const after = at < frag.length ? frag.get(at) : null
        if (item && before instanceof Y.XmlElement && before.nodeName === wrapperKind) {
          before.insert(before.length, [item])
          return
        }
        if (item && after instanceof Y.XmlElement && after.nodeName === wrapperKind) {
          after.insert(0, [item])
          return
        }
      }

      const nodes = buildBlockNodes(block)
      if (nodes.length === 0) {
        skipped.push({ opIndex, reason: 'add-produced-no-node' })
        return
      }
      frag.insert(at, nodes)
      return
    }
    case 'delete': {
      const loc = locate(frag, idMap[op.blockId] ?? op.blockId)
      if (!loc) {
        skipped.push({ opIndex, reason: 'delete-target-missing' })
        return
      }
      if (loc.kind === 'top') {
        frag.delete(loc.index, 1)
      } else {
        // Remove the item (and, naturally, any sub-items nested under it) from
        // its list; if that empties the list, remove the now-empty wrapper too.
        const frame = loc.path[loc.path.length - 1]
        frame.list.delete(frame.itemIndex, 1)
        if (frame.list.length === 0) frame.listParent.delete(frame.listIndex, 1)
      }
      return
    }
    case 'move': {
      const id = idMap[op.blockId] ?? op.blockId
      const loc = locate(frag, id)
      if (!loc) {
        skipped.push({ opIndex, reason: 'move-target-missing' })
        return
      }
      if (loc.kind !== 'top') {
        // Moving a list item across/within wrappers changes grouping + nesting;
        // out of scope for v1 AI moves. Re-plan as delete+add if needed.
        skipped.push({ opIndex, reason: 'move-nested-unsupported' })
        return
      }
      const node = (frag.get(loc.index) as Y.XmlElement).clone()
      frag.delete(loc.index, 1)
      const at = resolveInsertIndex(frag, op.after, idMap)
      frag.insert(at, [node])
      return
    }
    case 'edit': {
      const id = idMap[op.blockId] ?? op.blockId
      const loc = locate(frag, id)
      if (!loc) {
        skipped.push({ opIndex, reason: 'edit-target-missing' })
        return
      }
      // Merge the patch onto the block's current snapshot, then rebuild
      // just that node. Whole-node replace (vs in-place text splice) is
      // the v1 granularity: cross-block human edits still merge; a human
      // editing the *same* block concurrently is last-writer-wins on that
      // one block (same guarantee the old CAS gave, minus the reject).
      const { page } = yDocToSnapshot(doc)
      const current = page.blocks.find((b) => b.id === id)
      if (!current) {
        skipped.push({ opIndex, reason: 'edit-target-unreadable' })
        return
      }
      const merged = { ...current, ...op.patch, id } as Block
      if (loc.kind === 'top') {
        const rebuilt = buildBlockNodes(merged)
        if (rebuilt.length === 0) {
          skipped.push({ opIndex, reason: 'edit-produced-no-node' })
          return
        }
        frag.delete(loc.index, 1)
        frag.insert(loc.index, rebuilt)
      } else {
        // Replace the item inside its existing list, preserving its siblings AND
        // its own nested sub-items: clone the sub-lists out first, rebuild the
        // item from the merged block, then re-attach the sub-lists. (A whole-
        // node rebuild without this would silently drop every sub-bullet.)
        const frame = loc.path[loc.path.length - 1]
        const innerItem = buildListItemNode(merged)
        if (!innerItem) {
          skipped.push({ opIndex, reason: 'edit-item-rebuild-failed' })
          return
        }
        const nested = nestedListClones(frame.item)
        frame.list.delete(frame.itemIndex, 1)
        frame.list.insert(frame.itemIndex, [innerItem])
        if (nested.length > 0) {
          const integrated = frame.list.get(frame.itemIndex) as Y.XmlElement
          integrated.insert(integrated.length, nested)
        }
      }
      return
    }
  }
}
