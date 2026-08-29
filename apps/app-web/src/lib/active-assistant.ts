/**
 * Per-workspace persisted choice of which assistant the doc surface talks
 * to. Two surfaces share it: the floating dock's assistant switcher (which
 * writes it on a manual switch and on a seed-driven switch) and the landing's
 * draft-assistant picker (which reads it as the default for "who drafts this
 * page"). Keeping the key + read/write in one lib is what keeps the two
 * surfaces agreeing on a single "active assistant" per workspace.
 *
 * Spec: docs/architecture/features/doc.md → "Default-viewer landing"
 * (the draft-assistant picker) + "Doc prompt and surface" (the switcher).
 *
 * [COMP:app-web/empty-page-landing]
 */

export function activeAssistantStorageKey(workspaceId: string): string {
  return `doc-active-assistant-id:${workspaceId}`;
}

/** The persisted selection for this workspace, or null (none / SSR / private
 *  mode). */
export function readActiveAssistantId(workspaceId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(activeAssistantStorageKey(workspaceId));
  } catch {
    /* private mode */
    return null;
  }
}

export function writeActiveAssistantId(workspaceId: string, id: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(activeAssistantStorageKey(workspaceId), id);
  } catch {
    /* private mode — the selection just won't persist across reloads */
  }
}

/**
 * Which assistant the landing's draft picker should sit on. Pure so the
 * node-only vitest env can cover it. Repair-only, mirroring
 * `WorkspaceChrome`'s roster rule: while the roster hasn't loaded the
 * persisted/picked id (or the primary) is trusted as-is; once it has, an id
 * that left the roster falls back to the workspace primary rather than
 * pointing a build at a deleted assistant.
 */
export function resolveDraftAssistantId(opts: {
  /** The persisted per-workspace selection, or the user's in-flight pick. */
  persisted: string | null;
  /** The workspace primary (always exists once resolved). */
  primary: string | null;
  /** The loaded roster; empty while the fetch is in flight. */
  roster: ReadonlyArray<{ id: string }>;
}): string | null {
  const { persisted, primary, roster } = opts;
  if (roster.length === 0) return persisted ?? primary;
  if (persisted && roster.some((a) => a.id === persisted)) return persisted;
  if (primary && roster.some((a) => a.id === primary)) return primary;
  return primary ?? roster[0]?.id ?? null;
}
