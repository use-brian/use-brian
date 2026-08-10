/**
 * Recent "Act on the numbers" runs, per workspace.
 *
 * Why this is local and the draft list is not: a drafted product is a real
 * object in the store, so its history is `status:draft` sorted by date - true
 * for every teammate, on every device, with nothing to keep in sync. An
 * analysis leaves no trace anywhere. It is a question plus a window, and the
 * only place that pairing exists is the browser that asked.
 *
 * So this is `localStorage`, the same mechanism the operator-app sticky
 * selection uses. That has a real consequence and the UI says it rather than
 * implying a synced history: **this browser only**. Persisting it properly
 * would mean a workspace-scoped table, which is not worth a migration for a
 * convenience list.
 *
 * Stores the question and the window, never the answer - the answer is model
 * output about numbers that have since moved, and showing a stale one next to
 * a live store is worse than not showing it.
 *
 * [COMP:app-web/shopify-app]
 */

export type ShopifyRun = {
  /** The analysis key (`dropout`, `changed`, …). */
  key: string;
  /** Its label at the time it ran, so an older run still reads correctly. */
  title: string;
  since: string;
  until: string;
  /** Epoch ms. */
  at: number;
  /** The owner's own question, when they asked one. */
  ask?: string;
};

/** Enough to be useful, short enough that the panel never becomes the page. */
export const MAX_RUNS = 8;

const keyFor = (workspaceId: string) => `shopify:runs:${workspaceId}`;

function safeParse(raw: string | null): ShopifyRun[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Written by an older build, or hand-edited. Drop what does not fit rather
    // than throwing: a corrupt history must never break the sidebar.
    return parsed.filter(
      (r): r is ShopifyRun =>
        !!r &&
        typeof r === "object" &&
        typeof (r as ShopifyRun).key === "string" &&
        typeof (r as ShopifyRun).title === "string" &&
        typeof (r as ShopifyRun).at === "number",
    );
  } catch {
    return [];
  }
}

export function readRuns(workspaceId: string): ShopifyRun[] {
  if (typeof window === "undefined" || !workspaceId) return [];
  try {
    return safeParse(window.localStorage.getItem(keyFor(workspaceId)));
  } catch {
    // Private mode, or storage disabled. A missing history is not an error.
    return [];
  }
}

/**
 * Record a run, newest first.
 *
 * Re-running the same question over the same window replaces the earlier entry
 * instead of stacking duplicates - otherwise the list fills with one repeated
 * row and pushes real history off the end.
 */
export function recordRun(workspaceId: string, run: ShopifyRun): ShopifyRun[] {
  if (typeof window === "undefined" || !workspaceId) return [];
  const existing = readRuns(workspaceId).filter(
    (r) => !(r.key === run.key && r.since === run.since && r.until === run.until),
  );
  const next = [run, ...existing].slice(0, MAX_RUNS);
  try {
    window.localStorage.setItem(keyFor(workspaceId), JSON.stringify(next));
  } catch {
    // Quota or disabled storage. The run still happened and is on screen; the
    // history is a convenience, so failing to persist must not surface as an
    // error over the answer the owner is reading.
  }
  return next;
}

export function clearRuns(workspaceId: string): void {
  if (typeof window === "undefined" || !workspaceId) return;
  try {
    window.localStorage.removeItem(keyFor(workspaceId));
  } catch {
    /* see recordRun */
  }
}

/** The href that reopens a run: same question, same window. */
export function runHref(workspaceId: string, run: ShopifyRun): string {
  const q = new URLSearchParams({
    section: "analyse",
    an: run.key,
    since: run.since,
    until: run.until,
  });
  return `/w/${workspaceId}/shopify?${q.toString()}`;
}
