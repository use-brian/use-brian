/**
 * Active-assistant viewpoint cache (app-web) — the minimal slice of
 * `apps/web/src/lib/sidebar-cache.ts` the brain surface depends on.
 *
 * Ported as part of the brain surface migration
 * (docs/architecture/features/doc.md §5a). The brain page reads
 * `getActiveAssistantId()` to scope its rows by the active assistant's
 * `clearance` (the server's `resolveBrainCtx` uses it as the visibility
 * ceiling), and subscribes via `onActiveAssistantChanged` so the list
 * re-fetches when the viewpoint changes. The detail-drawer reads it to
 * scope its entity-rollup fetches the same way.
 *
 * DEGRADED vs apps/web: web's full sidebar-cache also caches
 * sessions / assistants / usage / trial and exposes a floating-pill
 * assistant picker that *writes* the active id. app-web's brain
 * chrome has no such picker yet, so `getActiveAssistantId()` returns
 * `null` until/unless a future app-web surface writes it — which the
 * server reads as "no viewpoint cap", i.e. the brain shows every row the
 * user's own workspace clearance permits. The localStorage key + the
 * pub/sub contract are kept identical so a future app-web assistant
 * picker (or a cross-app session) drops in without changing this module.
 */

const ACTIVE_ASSISTANT_STORAGE_KEY = "active-assistant-id";

type AssistantIdListener = (id: string | null) => void;
const activeAssistantListeners = new Set<AssistantIdListener>();

// ── Assistant list cache ─────────────────────────────────────────
//
// Added for the Studio surface migration
// (docs/architecture/features/doc.md §9 #5): the Studio
// Assistants rail + <AssistantDetail> mirror apps/web's behaviour of
// reading and broadcasting the cached assistant list so a rename / icon
// regenerate / clearance change in the detail flips the rail row without
// a refetch. Mirrors `apps/web/src/lib/sidebar-cache.ts` so the ported
// components import the same names unchanged.

export type Assistant = {
  id: string;
  name: string;
  role: "owner" | "admin" | "member";
  channels: string[];
  memoryCount: number;
  lastActive: string;
  iconSeed?: number;
  description?: string | null;
  workspaceId?: string | null;
  kind?: "primary" | "standard" | "app";
  clearance?: "public" | "internal" | "confidential";
};

let cachedAssistants: Assistant[] = [];
type AssistantListener = (assistants: Assistant[]) => void;
const assistantListeners = new Set<AssistantListener>();

export function getCachedAssistants(): Assistant[] {
  return cachedAssistants;
}

export function setCachedAssistants(assistants: Assistant[]): void {
  if (!Array.isArray(assistants)) return;
  cachedAssistants = assistants;
  assistantListeners.forEach((fn) => fn(assistants));
}

export function onAssistantsChanged(fn: AssistantListener): () => void {
  assistantListeners.add(fn);
  return () => {
    assistantListeners.delete(fn);
  };
}

export function getActiveAssistantId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(ACTIVE_ASSISTANT_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setActiveAssistantId(id: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ACTIVE_ASSISTANT_STORAGE_KEY, id);
  } catch {
    /* storage may be unavailable (private mode) — still notify subscribers */
  }
  activeAssistantListeners.forEach((fn) => fn(id));
}

export function onActiveAssistantChanged(fn: AssistantIdListener): () => void {
  activeAssistantListeners.add(fn);
  return () => {
    activeAssistantListeners.delete(fn);
  };
}
