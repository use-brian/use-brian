/**
 * Logic behind the Brain's Reviews master-detail surface.
 *
 * The Reviews section lists every pending inbox row in the SIDEBAR (the
 * master) and renders the selected one in the main pane (`review-panel.tsx`,
 * the detail). Both sides fetch independently (the same "sidebar fetches its
 * own copy" pattern as facets) THROUGH the shared `fetchReviewItems` below —
 * one composition over `listBrainInbox` keeps the two queues identically
 * scoped + ordered, which the selection key in `brain-surface-context`
 * depends on. Everything else here is pure: item identity, the Reviews
 * filter → inbox-primitive scoping (incl. the `relationships` → `entity_link`
 * chip), the search needle filter, default selection, and what to select next
 * after a verify/delete (auto-advance).
 *
 * [COMP:app-web/brain-review-panel]
 */

import type { BrainPrimitive, BrainRow } from "@/lib/api/brain";
import { brainToInboxPrimitive, projectInboxRowToBrainRow } from "@/lib/api/brain";
import { listBrainInbox } from "@/lib/api/brain-inbox";
import type {
  BrainInboxRow,
  BrainPrimitive as InboxPrimitive,
} from "@/lib/api/brain-inbox";

/** One pending review item: the inbox identity (what verify/delete take)
 *  plus the projected `BrainRow` (what the list rows + drawer render). */
export type PendingReviewItem = {
  primitive: InboxPrimitive;
  id: string;
  row: BrainRow;
};

/** Stable selection key. Uses the INBOX primitive (not the projected row
 *  kind) so e.g. an `entity_link` row — projected to kind `other` — still
 *  round-trips to the right verify/delete endpoint. */
export function reviewItemKey(
  item: Pick<PendingReviewItem, "primitive" | "id">,
): string {
  return `${item.primitive}:${item.id}`;
}

/** Project raw inbox rows into review items, preserving endpoint order. */
export function toReviewItems(rows: BrainInboxRow[]): PendingReviewItem[] {
  return rows.map((row) => ({
    primitive: row.primitive,
    id: row.id,
    row: projectInboxRowToBrainRow(row),
  }));
}

/** The Reviews filter token set. Six map 1:1 to a chip-mappable brain
 *  primitive; `relationships` is the review-only token for the `entity_link`
 *  inbox primitive (graph edges like "Documented by file: roadmap.pdf"),
 *  which has no `BrainPrimitive` of its own. This module is the SINGLE source
 *  for the Reviews chip set + its inbox scoping — the sidebar imports
 *  `REVIEW_FILTERS` rather than re-deriving it. */
export type ReviewFilter = BrainPrimitive | "relationships";

/** Reviews chip order — the six inbox-mappable primitives, then the
 *  relationships (entity_link) token last. */
export const REVIEW_FILTERS: ReviewFilter[] = [
  "people",
  "companies",
  "deals",
  "tasks",
  "memories",
  "files",
  "relationships",
];

/** Map a Reviews filter token to its inbox primitive. `relationships` ⇒
 *  `entity_link`; every other token defers to `brainToInboxPrimitive`
 *  (knowledge / sessions map to null and never appear as review chips). */
function reviewFilterToInboxPrimitive(
  f: ReviewFilter,
): InboxPrimitive | null {
  return f === "relationships" ? "entity_link" : brainToInboxPrimitive(f);
}

/** Every inbox primitive a Reviews chip can resolve to — the chip-reachable
 *  cover, derived (never hardcoded) from `REVIEW_FILTERS` so a new chip flows
 *  in automatically. The inbox carries ONE more primitive no chip maps to,
 *  `entity` (generic, un-promoted entities); only the unscoped fetch returns
 *  it. */
const CHIP_REACHABLE_INBOX_PRIMITIVES: InboxPrimitive[] = REVIEW_FILTERS.map(
  reviewFilterToInboxPrimitive,
).filter((p): p is InboxPrimitive => p !== null);

/** Map the Reviews chip selection onto the inbox fetch:
 *  no selection ⇒ one unscoped fetch; a selection that maps to ≥1 inbox
 *  primitive ⇒ one fetch per mapped primitive; a selection of only
 *  inbox-less kinds (knowledge / sessions) ⇒ nothing to fetch.
 *
 *  One subtlety: selecting EVERY chip also collapses to the unscoped fetch.
 *  The chips still don't fully cover the inbox — `entity` (generic,
 *  un-promoted entities) has no chip, so a per-chip fetch never requests it.
 *  Without this collapse, "check every type" would show FEWER rows than
 *  "All" by silently dropping it. When the selection covers the whole
 *  chip-reachable cover it means "everything", so we fetch unscoped — which
 *  surfaces the chip-less `entity` too. */
export function inboxPrimitivesForSelection(
  filters: ReviewFilter[],
):
  | { kind: "all" }
  | { kind: "none" }
  | { kind: "some"; primitives: InboxPrimitive[] } {
  if (filters.length === 0) return { kind: "all" };
  const mapped = filters
    .map(reviewFilterToInboxPrimitive)
    .filter((p): p is InboxPrimitive => p !== null);
  if (mapped.length === 0) return { kind: "none" };
  const distinct = new Set(mapped);
  if (CHIP_REACHABLE_INBOX_PRIMITIVES.every((p) => distinct.has(p))) {
    return { kind: "all" };
  }
  return { kind: "some", primitives: mapped };
}

/** Search needle filter over the projected name/summary — the same match
 *  the old flat pending queue applied. Empty/whitespace needle passes all. */
export function filterReviewItems(
  items: PendingReviewItem[],
  search: string,
): PendingReviewItem[] {
  const needle = search.trim().toLowerCase();
  if (!needle) return items;
  return items.filter(
    (it) =>
      it.row.name.toLowerCase().includes(needle) ||
      (it.row.summary?.toLowerCase().includes(needle) ?? false),
  );
}

/** The one fetch composition both the sidebar list and the page's detail
 *  pool use — identical scoping + order on both sides is what makes the
 *  shared selection key (and auto-advance) coherent. */
export async function fetchReviewItems(
  workspaceId: string,
  filters: ReviewFilter[],
): Promise<PendingReviewItem[]> {
  const scope = inboxPrimitivesForSelection(filters);
  if (scope.kind === "none") return [];
  const fetches =
    scope.kind === "all"
      ? [listBrainInbox(workspaceId, { limit: 100 })]
      : scope.primitives.map((p) =>
          listBrainInbox(workspaceId, { primitive: p, limit: 100 }),
        );
  const results = await Promise.all(fetches);
  return toReviewItems(results.flatMap((r) => r.rows));
}

/** Index of the selected item — falls back to the FIRST item when nothing
 *  is selected or the selection vanished (acted on elsewhere), -1 when the
 *  queue is empty. The panel renders `items[resolveReviewIndex(...)]`. */
export function resolveReviewIndex(
  items: PendingReviewItem[],
  selectedKey: string | null,
): number {
  if (items.length === 0) return -1;
  if (selectedKey != null) {
    const i = items.findIndex((it) => reviewItemKey(it) === selectedKey);
    if (i !== -1) return i;
  }
  return 0;
}

/** Auto-advance: the key to select after acting on `actedKey` — the next
 *  item in queue order, the previous one when the acted item was last, and
 *  null when it was the only one (the all-clear state takes over). Computed
 *  against the PRE-refresh list, so it must tolerate a missing actedKey. */
export function nextReviewKey(
  items: PendingReviewItem[],
  actedKey: string,
): string | null {
  const i = items.findIndex((it) => reviewItemKey(it) === actedKey);
  if (i === -1) return items.length > 0 ? reviewItemKey(items[0]) : null;
  const next = items[i + 1] ?? items[i - 1];
  return next ? reviewItemKey(next) : null;
}
