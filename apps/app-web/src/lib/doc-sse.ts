/**
 * Doc SSE bridge — Lock #7 client side.
 *
 * Lock #7 says the server streams page edits op-by-op so the user
 * watches blocks land on the page. The chat route (Agent P1I) fires an
 * SSE `doc_op` event for every op `patchPage` applies, carried on
 * the existing chat SSE channel — there's no dedicated per-page SSE
 * endpoint in Phase 1.
 *
 * The chat panel (`floating-chat.tsx`) owns the SSE consumer, but the
 * page renderer (`page-renderer.tsx`) needs the events to update its
 * React state. Since they're sibling components, we bridge through a
 * `window` CustomEvent — the same pattern `view_payload` already uses
 * via `doc:draft-created`:
 *
 *     server SSE  →  floating-chat onEvent
 *                 →  window.dispatchEvent('doc:op-applied', {…})
 *                 →  page-renderer subscribeDocOps callback
 *                 →  setPage(applyOpsLocal(prev, [op]))
 *
 * The helper here owns three things:
 *
 *   1. The wire shape of the per-op SSE event (`DocOpEvent`).
 *   2. A pure local `applyOpsLocal` clone of `@sidanclaw/core`'s
 *      `applyOps` — mirrors the canonical executor in
 *      `packages/core/src/doc/ops.ts` so the optimistic update
 *      stays in sync with what the server commits. Vendored rather
 *      than imported because `@sidanclaw/core`'s barrel pulls in
 *      `skills/loader` (Node `fs`) and breaks browser bundles —
 *      same constraint that drives `lib/api/views.ts` to mirror
 *      types locally.
 *   3. `subscribeDocOps(pageId, handlers)` — wraps the window
 *      event with a pageId filter so multiple page renderers on the
 *      same surface don't cross-talk.
 *
 * Spec: `docs/plans/doc-v1-execution.md` §5.5 (server-streamed ops)
 * + §5.7 (app-web wiring). Lock #7 in §1.
 *
 * [COMP:app-web/sse-bridge]
 */

import type { Block, Page } from "@/lib/api/views";

// ── Wire shape ────────────────────────────────────────────────────────

/**
 * The local `Op` union — mirrors `@sidanclaw/core/src/doc/page-types.ts`.
 * The server sends `op.block.id` as `tmp-*` for `add` ops within a
 * patch; the renderer treats the temp id as the working id locally and
 * relies on the post-patch `getCurrentPage` refresh (or the tool
 * response's `idMap`) to reconcile to the real id.
 */
export type DocOp =
  | {
      op: "add";
      after: string | "start" | "end";
      block: Block;
    }
  | { op: "edit"; blockId: string; patch: Partial<Block> }
  | { op: "delete"; blockId: string }
  | { op: "move"; blockId: string; after: string | "start" | "end" }
  | { op: "setTitle"; title: string };

/**
 * One SSE event from the server. The chat route emits this inside
 * `onOpApplied` per Lock #7 (master plan §5.5):
 *
 *   { kind: 'doc_op', pageId, op, opIndex, newVersion }
 *
 * `newVersion` is the version the patch will land at *after* the full
 * patch commits — it's not bumped between ops, since the DB write is a
 * single atomic CAS at the end of the patch (Lock #8). The renderer
 * uses it to keep its local version counter aligned without having to
 * round-trip a fresh page after every patch.
 */
export type DocOpEvent = {
  pageId: string;
  op: DocOp;
  opIndex: number;
  newVersion: number;
};

/** The window CustomEvent name the bridge dispatches on. */
export const DOC_OP_EVENT = "doc:op-applied" as const;

export type DocSseHandlers = {
  /**
   * Fired for every op the server applied to `pageId`. The renderer
   * folds the op into local state via `applyOpsLocal` and bumps its
   * version mirror.
   */
  onOp: (event: DocOpEvent) => void;
};

/**
 * Subscribe to doc op events scoped to one page. Returns an
 * unsubscribe function — call it from a React `useEffect` cleanup.
 *
 * Events for other pages (e.g. background drafts that aren't the
 * active view) are silently dropped — the bridge fans out to every
 * subscriber and each one filters on its own pageId.
 */
export function subscribeDocOps(
  pageId: string,
  handlers: DocSseHandlers,
): () => void {
  if (typeof window === "undefined") {
    // SSR-safe no-op. The renderer mounts on the client, so this
    // branch only fires on the very first render frame.
    return () => {};
  }

  const handler = (e: Event) => {
    const detail = (e as CustomEvent<unknown>).detail;
    const parsed = parseDocOpEvent(detail);
    if (!parsed) return;
    if (parsed.pageId !== pageId) return;
    handlers.onOp(parsed);
  };

  window.addEventListener(DOC_OP_EVENT, handler);
  return () => {
    window.removeEventListener(DOC_OP_EVENT, handler);
  };
}

/**
 * Defensive parse of an inbound `doc:op-applied` payload. Returns
 * `null` if the shape doesn't match — the bridge silently drops
 * malformed events rather than throwing into a React event handler.
 */
export function parseDocOpEvent(detail: unknown): DocOpEvent | null {
  if (!detail || typeof detail !== "object") return null;
  const d = detail as Record<string, unknown>;
  if (typeof d.pageId !== "string" || d.pageId.length === 0) return null;
  if (typeof d.opIndex !== "number" || !Number.isFinite(d.opIndex)) return null;
  if (typeof d.newVersion !== "number" || !Number.isFinite(d.newVersion)) {
    return null;
  }
  const op = d.op;
  if (!op || typeof op !== "object") return null;
  const opTag = (op as { op?: unknown }).op;
  if (typeof opTag !== "string") return null;
  switch (opTag) {
    case "add":
    case "edit":
    case "delete":
    case "move":
    case "setTitle":
      // Shallow shape check is enough — the server is authoritative
      // and `applyOpsLocal` is defensive for missing anchors / target
      // blocks. Detailed validation lives server-side.
      return {
        pageId: d.pageId,
        op: op as DocOp,
        opIndex: d.opIndex,
        newVersion: d.newVersion,
      };
    default:
      return null;
  }
}

/**
 * Convenience for the SSE consumer in `floating-chat.tsx` — packages
 * the event payload and dispatches the window event. Kept here so the
 * bridge contract has exactly one publisher and one subscriber path.
 */
export function publishDocOpEvent(event: DocOpEvent): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<DocOpEvent>(DOC_OP_EVENT, { detail: event }),
  );
}

// ── applyOpsLocal — vendored from packages/core/src/doc/ops.ts ────

/**
 * Pure client-side fold of an op list into a new page. Mirrors
 * `@sidanclaw/core/src/doc/ops.ts` `applyOps` semantics but stays
 * within app-web so we don't pull the core barrel into the browser
 * bundle. The two are kept in sync; the canonical executor remains
 * the server-side `applyOps` — drift means a temporary visual blip
 * until the renderer refetches via `getView`.
 *
 * Returns the new page or throws on a reference to a missing
 * anchor / target. Callers (the renderer) catch and trigger a full
 * refetch so the user sees a consistent state.
 */
export function applyOpsLocal(
  page: Page,
  ops: DocOp[],
  title?: string,
): { page: Page; title: string | undefined } {
  const working: Page = { blocks: [...page.blocks] };
  let workingTitle = title;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    switch (op.op) {
      case "add": {
        const insertAt = insertionIndex(working.blocks, op.after);
        if (insertAt < 0) {
          throw new Error(
            `applyOpsLocal[${i}]: anchor "${op.after}" not found`,
          );
        }
        working.blocks.splice(insertAt, 0, op.block);
        break;
      }
      case "edit": {
        const idx = working.blocks.findIndex((b) => b.id === op.blockId);
        if (idx < 0) {
          throw new Error(
            `applyOpsLocal[${i}]: edit target "${op.blockId}" not found`,
          );
        }
        const current = working.blocks[idx];
        // Shallow merge; preserve `id` + `kind` per the canonical
        // ops.ts semantics — edit never re-discriminates a block.
        const merged = {
          ...current,
          ...op.patch,
          id: current.id,
          kind: current.kind,
        } as Block;
        working.blocks[idx] = merged;
        break;
      }
      case "delete": {
        const idx = working.blocks.findIndex((b) => b.id === op.blockId);
        if (idx < 0) {
          throw new Error(
            `applyOpsLocal[${i}]: delete target "${op.blockId}" not found`,
          );
        }
        working.blocks.splice(idx, 1);
        break;
      }
      case "move": {
        const fromIdx = working.blocks.findIndex((b) => b.id === op.blockId);
        if (fromIdx < 0) {
          throw new Error(
            `applyOpsLocal[${i}]: move target "${op.blockId}" not found`,
          );
        }
        const [block] = working.blocks.splice(fromIdx, 1);
        const insertAt = insertionIndex(working.blocks, op.after);
        if (insertAt < 0) {
          // Re-insert at the original index so the array stays
          // consistent before throwing.
          working.blocks.splice(fromIdx, 0, block);
          throw new Error(
            `applyOpsLocal[${i}]: move anchor "${op.after}" not found`,
          );
        }
        working.blocks.splice(insertAt, 0, block);
        break;
      }
      case "setTitle": {
        workingTitle = op.title;
        break;
      }
    }
  }
  return { page: working, title: workingTitle };
}

function insertionIndex(
  blocks: Block[],
  after: string | "start" | "end",
): number {
  if (after === "start") return 0;
  if (after === "end") return blocks.length;
  const idx = blocks.findIndex((b) => b.id === after);
  if (idx < 0) return -1;
  return idx + 1;
}
