/**
 * Doc v1 — pure ops executor.
 *
 * Three pure functions over the `Op` vocabulary declared in
 * `./page-types.ts`. No DB access, no I/O, no React — safe to import
 * from server, client, and tests. The shared HTTP route, the chat
 * `patchPage` tool, and the optimistic-client undo path all go through
 * the same three entry points so the semantics stay identical end-to-end.
 *
 *   - `applyOps`     — folds an ordered op list into a new page, returning
 *                      the resulting page + the `tmp-*` → real id map
 *                      callers need so they can echo it back to the model
 *   - `invertOps`    — given the pre-state page and the ops applied to it,
 *                      produces the ops that undo the patch (single-step
 *                      undo, Tier 3 #9 in master plan)
 *   - `validateOps`  — read-only "would this patch apply cleanly?" check
 *                      used by `patchPage` before the DB transaction so
 *                      we can fast-fail with a 400 instead of `BEGIN`+
 *                      `ROLLBACK`
 *
 * Anchor semantics for `add` / `move`:
 *   - `after` omitted (`add` only) — append at the end of the page. A run of
 *                      anchor-less `add` ops thus lands in document order, so
 *                      the model can scaffold a page without chaining
 *                      `after: tmp-*` references (the dominant cause of
 *                      "anchor not found" patch failures).
 *   - `after: 'start'` — insert at index 0
 *   - `after: 'end'`   — append
 *   - `after: <id>`    — insert immediately after the named block
 *
 * Title handling: `setTitle` writes the page's `title` field if the host
 * page object has one (the production `VersionedPage` always does). A
 * bare `Page` (no title field) still parses and applies — the title
 * write lands on the cloned object harmlessly. `setIcon` is the same
 * shape for the page's emoji `icon` (a metadata field, not a block);
 * `patchPage` reads the resulting `icon` off the working copy and
 * persists it to `saved_views.icon`.
 *
 * Spec: `docs/plans/doc-v1-execution.md` §4.1.
 *
 * [COMP:doc/ops]
 */

import type {
  Block,
  BlockId,
  Op,
  Ops,
  Page,
  TmpId,
} from './page-types.js'
import { bindingConfigSchema } from '../views/schemas.js'
import { chartBlockSchema, coerceHeadingLevel } from '../views/blocks.js'

// ── id generator default ─────────────────────────────────────────────

/**
 * The default id generator — `crypto.randomUUID()` from the Web Crypto
 * standard available in Node 18+ and modern browsers. Callers can
 * inject their own for tests (`applyOps(page, ops, () => 'fixed-id')`).
 */
function defaultGenerateId(): BlockId {
  // `globalThis.crypto` is the standard surface in Node 18+ and browsers.
  // Fall back to a synthetic id only if the runtime lacks it entirely.
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } })
    .crypto
  if (cryptoObj?.randomUUID) {
    return cryptoObj.randomUUID()
  }
  return `block-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

// ── helpers ──────────────────────────────────────────────────────────

function isTmpId(id: string): id is TmpId {
  return id.startsWith('tmp-')
}

/**
 * Resolve a referenced block id through the temp-id map.
 *
 * A `tmp-*` id minted earlier in THIS patch (by an `add` op) resolves to
 * its freshly-assigned real id via `idMap`. Every other id passes through
 * literally — a normal real id, but ALSO a `tmp-*` id that is the
 * *canonical persisted id* of an existing block. Some pages were seeded
 * into the live doc with their authoring `tmp-*` ids verbatim (the seed
 * path didn't mint real ids the way the `add` path does), so an `edit` /
 * `delete` / `move` legitimately targets a block whose real id starts with
 * `tmp-`. `findBlockIndex` then decides whether the block actually exists.
 *
 * Returning the literal (not `undefined`) for an unmapped `tmp-*` id is the
 * whole fix: it lets `patchPage` edit/delete/move those blocks instead of
 * rejecting every op with "unresolved temp id". This mirrors what the live
 * Yjs write path already does (`apply-ops.ts`: `idMap[op.blockId] ?? id`).
 */
function resolveId(
  id: string,
  idMap: Record<TmpId, BlockId>,
): BlockId | undefined {
  if (isTmpId(id)) {
    return idMap[id] ?? id
  }
  return id
}

/**
 * Compute the insertion index given an `after` anchor. Returns -1 if
 * the anchor is a block id and not found.
 */
function insertionIndex(
  blocks: Block[],
  after: BlockId | 'start' | 'end' | undefined,
): number {
  // Omitted anchor (an `add` op with no `after`) means "append at the end",
  // identical to `after: 'end'`. Applied sequentially, a run of anchor-less
  // adds stacks in document order — the bulletproof scaffold path.
  if (after === undefined || after === 'end') return blocks.length
  if (after === 'start') return 0
  const idx = blocks.findIndex(b => b.id === after)
  if (idx < 0) return -1
  return idx + 1
}

function findBlockIndex(blocks: Block[], id: BlockId): number {
  return blocks.findIndex(b => b.id === id)
}

/**
 * Resolve an `after` anchor through the tmp map. `'start'` / `'end'` /
 * `undefined` pass through unchanged; a block id (real or `tmp-*`) is mapped
 * the same way `resolveId` maps edit/delete/move targets. This is what lets an
 * `add` / `move` anchor a block minted earlier in THIS patch
 * (`after: "tmp-h1"`) — without it the anchor looked up the literal `tmp-h1`,
 * which never matched the block's freshly-minted real id, so every
 * tmp-anchored insert failed with "anchor block not found" (a major class of
 * the 2026-06-04 doc patch rejections).
 */
function resolveAfter(
  after: BlockId | 'start' | 'end' | undefined,
  idMap: Record<TmpId, BlockId>,
): BlockId | 'start' | 'end' | undefined {
  if (after === undefined || after === 'start' || after === 'end') return after
  return resolveId(after, idMap)
}

/**
 * Deep-ish clone of a page — copies the blocks array and each block
 * shallowly so `applyOps` can mutate the working copy without
 * affecting the caller's input. Block payloads (`binding`, etc.) are
 * shared by reference because we never mutate them in place.
 */
function clonePage(page: Page): Page & { title?: string; icon?: string | null } {
  // Preserve any extra fields (like `title`, `icon`, `version`).
  const extra = page as Page & {
    title?: string
    icon?: string | null
    version?: number
  }
  return {
    ...extra,
    blocks: [...page.blocks],
  }
}

// ── applyOps ─────────────────────────────────────────────────────────

/**
 * Applies an ordered list of ops to a page, returning a new page.
 *
 * Each op operates on the state *after* the preceding ops — order
 * matters. `tmp-*` ids in `add` ops are resolved to fresh ids minted
 * by `generateId` and recorded in the returned `idMap`; subsequent
 * ops in the same patch may reference them via `tmp-*` and the
 * executor transparently rewires.
 *
 * Throws on any reference to a non-existent block id (after temp
 * resolution). Callers expecting a structured failure should call
 * `validateOps` first.
 */
export function applyOps(
  page: Page,
  ops: Ops,
  generateId: () => BlockId = defaultGenerateId,
): { page: Page; idMap: Record<TmpId, BlockId> } {
  const working = clonePage(page)
  const idMap: Record<TmpId, BlockId> = {}

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    applyOne(working, op, idMap, generateId, i)
  }

  return { page: working, idMap }
}

function applyOne(
  page: Page & { title?: string; icon?: string | null },
  op: Op,
  idMap: Record<TmpId, BlockId>,
  generateId: () => BlockId,
  opIndex: number,
): void {
  switch (op.op) {
    case 'add': {
      const incoming = op.block
      let realId: BlockId
      if (!incoming.id) {
        // Omitted id (the model let the server mint one — what the tool
        // description instructs). Assign a real id directly; no tmp mapping
        // is needed because nothing references it.
        realId = generateId()
      } else if (isTmpId(incoming.id)) {
        realId = generateId()
        idMap[incoming.id as TmpId] = realId
      } else {
        realId = incoming.id
      }
      const block: Block = { ...incoming, id: realId } as Block
      // Resolve the anchor through the tmp map (so `after: "tmp-h1"` targets a
      // block minted earlier in this patch), then degrade a genuinely-missing
      // anchor to append-at-end rather than throwing. The block still lands on
      // the page — far cheaper than failing the whole patch and forcing the
      // model to re-send everything and retry.
      const insertAt = insertionIndex(page.blocks, resolveAfter(op.after, idMap))
      const safeInsertAt = insertAt < 0 ? page.blocks.length : insertAt
      page.blocks.splice(safeInsertAt, 0, block)
      return
    }
    case 'edit': {
      const targetId = resolveId(op.blockId, idMap)
      if (!targetId) {
        throw new Error(
          `applyOps[${opIndex}]: edit references unresolved temp id "${op.blockId}"`,
        )
      }
      const idx = findBlockIndex(page.blocks, targetId)
      if (idx < 0) {
        throw new Error(
          `applyOps[${opIndex}]: edit target block "${targetId}" not found`,
        )
      }
      const current = page.blocks[idx]
      // Shallow merge — preserve `id` and `kind` no matter what the patch
      // contains. Per `docs/plans/doc-v1-execution.md` §4.1, edit
      // never re-discriminates a block.
      const merged = {
        ...current,
        ...op.patch,
        id: current.id,
        kind: current.kind,
      } as Block
      // Re-validate a `data` block's binding when the patch touches it.
      // The `edit` op's `patch` is `z.record(z.string(), z.unknown())` at
      // the schema layer (`page-schemas.ts`), so an in-place `binding`
      // change is NOT validated at the boundary — without this guard a
      // patch could replace a locked-shape binding (e.g. drop the required
      // `groupBy` on a board, or invent a viewType) and silently corrupt
      // the live view. Re-running `bindingConfigSchema` here keeps the
      // same guardrails an `add` op gets via `blockSchema`.
      if (current.kind === 'data' && 'binding' in op.patch) {
        const parsed = bindingConfigSchema.safeParse(
          (merged as Extract<Block, { kind: 'data' }>).binding,
        )
        if (!parsed.success) {
          throw new Error(
            `applyOps[${opIndex}]: edit produced an invalid data-block binding — ${parsed.error.issues[0]?.message ?? 'unknown binding error'}`,
          )
        }
      }
      // Mirror the binding guard for charts: an `edit` patch touching a chart's
      // `data` / `binding` / `chartType` is waved through by the open `patch`
      // record, so re-validate the MERGED chart through `chartBlockSchema` (the
      // xor + per-`chartType` shape `refineChartBlock` enforces on the `add`
      // path). Without this an edit could strip a chart to an empty shell — a
      // title with no points — that renders as a blank plot (the 2026-06-10
      // "nothing here except a heading" report).
      if (
        current.kind === 'chart' &&
        ('data' in op.patch || 'binding' in op.patch || 'chartType' in op.patch)
      ) {
        const parsed = chartBlockSchema.safeParse(merged)
        if (!parsed.success) {
          throw new Error(
            `applyOps[${opIndex}]: edit produced an invalid chart block — ${parsed.error.issues[0]?.message ?? 'unknown chart error'}`,
          )
        }
      }
      // Mirror the binding guard for headings: a model often patches a
      // heading's level with a Notion/Markdown-flavored value (`"h2"`, `"##"`),
      // which the open `patch` record waves through unvalidated. Coerce it back
      // to the canonical 1–4 so the merged block stays legal.
      if (current.kind === 'heading' && 'level' in op.patch) {
        ;(merged as Extract<Block, { kind: 'heading' }>).level = coerceHeadingLevel(
          (op.patch as Record<string, unknown>).level,
          (current as Extract<Block, { kind: 'heading' }>).level,
        )
      }
      page.blocks[idx] = merged
      return
    }
    case 'delete': {
      const targetId = resolveId(op.blockId, idMap)
      if (!targetId) {
        throw new Error(
          `applyOps[${opIndex}]: delete references unresolved temp id "${op.blockId}"`,
        )
      }
      const idx = findBlockIndex(page.blocks, targetId)
      if (idx < 0) {
        throw new Error(
          `applyOps[${opIndex}]: delete target block "${targetId}" not found`,
        )
      }
      page.blocks.splice(idx, 1)
      return
    }
    case 'move': {
      const targetId = resolveId(op.blockId, idMap)
      if (!targetId) {
        throw new Error(
          `applyOps[${opIndex}]: move references unresolved temp id "${op.blockId}"`,
        )
      }
      const fromIdx = findBlockIndex(page.blocks, targetId)
      if (fromIdx < 0) {
        throw new Error(
          `applyOps[${opIndex}]: move target block "${targetId}" not found`,
        )
      }
      const [block] = page.blocks.splice(fromIdx, 1)
      // Recompute anchor against the array *after* removal, because
      // 'end' / 'start' should still mean the new bounds. Resolve through the
      // tmp map so a move can anchor on a block minted earlier in this patch.
      const insertAt = insertionIndex(page.blocks, resolveAfter(op.after, idMap))
      if (insertAt < 0) {
        // Re-insert at the original index to keep the array consistent
        // before throwing — callers using try/catch get a clean state.
        page.blocks.splice(fromIdx, 0, block)
        throw new Error(
          `applyOps[${opIndex}]: move anchor "${op.after}" not found`,
        )
      }
      page.blocks.splice(insertAt, 0, block)
      return
    }
    case 'setTitle': {
      page.title = op.title
      return
    }
    case 'setIcon': {
      // Page-metadata write, like `setTitle`. `patchPage` reads `page.icon`
      // off the working copy afterward and persists it to `saved_views.icon`.
      page.icon = op.icon
      return
    }
    default: {
      // Exhaustiveness: every Op variant above returns. If we hit
      // here, the union was extended without updating this switch —
      // surface it loudly rather than silently no-op.
      const _exhaustive: never = op
      throw new Error(
        `applyOps[${opIndex}]: unknown op kind ${JSON.stringify(_exhaustive)}`,
      )
    }
  }
}

// ── validateOps ──────────────────────────────────────────────────────

/**
 * Simulates `applyOps` against a clone and returns a structured pass /
 * fail result. Same semantics as `applyOps` — any error inside the fold
 * becomes a `{ valid: false, error: { opIndex, reason } }` result.
 *
 * NOTE: the `patchPage` tool no longer uses this as a whole-patch gate — it
 * applies ops one-at-a-time and tolerantly SKIPS a stale-target op (mirroring
 * the Yjs sync service's reconcile guard) instead of rejecting the whole patch.
 * The old hard gate here was the dominant residual cause of the 2026-06-04
 * patch-rejection storm. Retained as a pure all-or-nothing check for callers
 * that genuinely want one (and for tests).
 */
export function validateOps(
  page: Page,
  ops: Ops,
):
  | { valid: true }
  | { valid: false; error: { opIndex: number; reason: string } } {
  // Run `applyOps` against a clone with a deterministic generator —
  // we only care about the structural validity, not the resulting ids.
  let counter = 0
  try {
    applyOps(page, ops, () => `validate-${counter++}`)
    return { valid: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Error messages are emitted as `applyOps[<idx>]: <reason>` — parse
    // back out the index so callers get a structured field.
    const match = /^applyOps\[(\d+)\]:\s*(.+)$/.exec(message)
    if (match) {
      return {
        valid: false,
        error: {
          opIndex: Number.parseInt(match[1], 10),
          reason: match[2],
        },
      }
    }
    return { valid: false, error: { opIndex: -1, reason: message } }
  }
}

// ── invertOps ────────────────────────────────────────────────────────

/**
 * Inverts an ops array — given the pre-state page and the ops applied
 * to it, returns the ops that revert the page back to pre-state.
 *
 * Inverse semantics:
 *   - `add { after, block }`     → `delete { blockId: <real id> }`
 *   - `delete { blockId }`       → `add { after: <prior-neighbor>, block: <captured> }`
 *   - `edit { blockId, patch }`  → `edit { blockId, patch: <prior values for changed keys> }`
 *   - `move { blockId, after }`  → `move { blockId, after: <prior anchor> }`
 *   - `setTitle { title }`       → `setTitle { title: <prior title> }`
 *   - `setIcon { icon }`         → `setIcon { icon: <prior icon> }`
 *
 * The reverse list is reversed in order so the inverses unwind in the
 * opposite direction they were applied. To invert an `add` op whose
 * incoming block used a `tmp-*` id, the caller MUST pass the `idMap`
 * returned by the matching `applyOps` call so the inverse `delete`
 * references the real id. Without it, the inverse falls back to a
 * deterministic `synth-<n>` id that won't match the post-state — the
 * inverse won't apply cleanly. (The undo path in `patchPage` always
 * has the `idMap` from the same patch, so this is a non-issue in
 * production; it's surfaced here for tests and exotic callers.)
 *
 * Standard round-trip invariant:
 *   const { page: post, idMap } = applyOps(pre, ops)
 *   const inverse = invertOps(pre, ops, { idMap })
 *   const { page: back } = applyOps(post, inverse)
 *   // back.blocks deep-equals pre.blocks
 */
export function invertOps(
  prePage: Page,
  ops: Ops,
  opts?: { idMap?: Record<TmpId, BlockId> },
): Ops {
  // Walk forward through the ops, capturing per-step inverses against
  // the state immediately before each op runs. We need a working copy
  // that mirrors `applyOps` so we know the actual ids / positions /
  // values each op touches.
  const working = clonePage(prePage)
  // Seed the working `idMap` from the caller's mapping (production
  // path) so `tmp-*` references resolve to the same real ids the
  // user-facing page actually carries.
  const idMap: Record<TmpId, BlockId> = { ...(opts?.idMap ?? {}) }
  // Synthetic generator — only used when the caller didn't pass an
  // `idMap` for a tmp-* add. Produces deterministic `synth-N` ids so
  // tests can still reason about behavior; the caller can then
  // post-process or just rely on the real id when the production
  // `idMap` is available.
  let synthCounter = 0
  const generateId = (): BlockId => {
    synthCounter += 1
    return `synth-${synthCounter}`
  }
  const inverses: Op[] = []

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    // For `add` we need to capture the inverse *after* applyOne runs
    // so we know the real id that was assigned. Everything else needs
    // the pre-state and is captured first.
    if (op.op === 'add') {
      // Prefer the caller-supplied real id when the original add used
      // a tmp; otherwise the working-copy applyOne will assign a
      // synthetic id and we capture that. Both branches keep the
      // working-copy state correct so subsequent inverses index
      // against the right blocks.
      const tmp = isTmpId(op.block.id) ? (op.block.id as TmpId) : undefined
      if (tmp && idMap[tmp]) {
        // Caller supplied the real id — use it for both the working
        // copy's applyOne (so position-based inverses downstream see
        // the right id) and the inverse delete.
        const realId = idMap[tmp]
        const concreteOp: Op = {
          op: 'add',
          after: op.after,
          block: { ...op.block, id: realId } as Block,
        }
        applyOne(working, concreteOp, idMap, generateId, i)
        inverses.push({ op: 'delete', blockId: realId })
      } else {
        applyOne(working, op, idMap, generateId, i)
        const realId = tmp ? idMap[tmp] : op.block.id
        inverses.push({ op: 'delete', blockId: realId })
      }
    } else {
      inverses.push(captureInverse(working, op, idMap, i))
      applyOne(working, op, idMap, generateId, i)
    }
  }

  // Unwind in reverse order — most recent op undone first.
  return inverses.reverse()
}

function captureInverse(
  page: Page & { title?: string; icon?: string | null },
  op: Exclude<Op, { op: 'add' }>,
  idMap: Record<TmpId, BlockId>,
  opIndex: number,
): Op {
  switch (op.op) {
    case 'edit': {
      const targetId = resolveId(op.blockId, idMap)
      if (!targetId) {
        throw new Error(
          `invertOps[${opIndex}]: edit references unresolved temp id "${op.blockId}"`,
        )
      }
      const idx = findBlockIndex(page.blocks, targetId)
      if (idx < 0) {
        throw new Error(
          `invertOps[${opIndex}]: edit target block "${targetId}" not found`,
        )
      }
      const current = page.blocks[idx]
      // Capture only the keys the patch touched, with their pre-edit
      // values. `id` and `kind` are intentionally skipped — `applyOne`
      // preserves them and so does the inverse.
      const priorPatch: Record<string, unknown> = {}
      for (const key of Object.keys(op.patch)) {
        if (key === 'id' || key === 'kind') continue
        priorPatch[key] = (current as unknown as Record<string, unknown>)[key]
      }
      return { op: 'edit', blockId: targetId, patch: priorPatch }
    }
    case 'delete': {
      const targetId = resolveId(op.blockId, idMap)
      if (!targetId) {
        throw new Error(
          `invertOps[${opIndex}]: delete references unresolved temp id "${op.blockId}"`,
        )
      }
      const idx = findBlockIndex(page.blocks, targetId)
      if (idx < 0) {
        throw new Error(
          `invertOps[${opIndex}]: delete target block "${targetId}" not found`,
        )
      }
      const block = page.blocks[idx]
      // The anchor for the re-add is the prior neighbor; if the block
      // was at index 0, anchor is `'start'`.
      const after: BlockId | 'start' | 'end' =
        idx === 0 ? 'start' : page.blocks[idx - 1].id
      // Clone the block so a later mutation of `page.blocks` doesn't
      // bleed into the captured inverse.
      return { op: 'add', after, block: { ...block } }
    }
    case 'move': {
      const targetId = resolveId(op.blockId, idMap)
      if (!targetId) {
        throw new Error(
          `invertOps[${opIndex}]: move references unresolved temp id "${op.blockId}"`,
        )
      }
      const fromIdx = findBlockIndex(page.blocks, targetId)
      if (fromIdx < 0) {
        throw new Error(
          `invertOps[${opIndex}]: move target block "${targetId}" not found`,
        )
      }
      // Prior anchor = the block currently before this one, or 'start'.
      const priorAfter: BlockId | 'start' | 'end' =
        fromIdx === 0 ? 'start' : page.blocks[fromIdx - 1].id
      return { op: 'move', blockId: targetId, after: priorAfter }
    }
    case 'setTitle': {
      return { op: 'setTitle', title: page.title ?? '' }
    }
    case 'setIcon': {
      // Prior icon, defaulting to `null` (no icon → derived glyph) when the
      // page hadn't carried one. `undefined` would mean "leave unchanged",
      // which isn't the inverse of a set.
      return { op: 'setIcon', icon: page.icon ?? null }
    }
    default: {
      const _exhaustive: never = op
      throw new Error(
        `invertOps[${opIndex}]: unknown op kind ${JSON.stringify(_exhaustive)}`,
      )
    }
  }
}
