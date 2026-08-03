/**
 * Persistent last-known-good cache for Brain content.
 *
 * The in-memory surface cache removes repeat-navigation skeletons, but dies on
 * reload and cannot help during a network outage. Brain content that has
 * already been loaded is safe and useful to keep on-device, provided cache
 * identity includes every access-shaping axis. Every key therefore carries:
 *
 *   viewer id + workspace id + assistant viewpoint + resource
 *
 * The backing IndexedDB database is the same one `clearLocalDocCaches()` drops
 * on sign-out, so an explicit account exit removes these snapshots together
 * with offline page content.
 *
 * This module owns only envelopes, keys, and the local projection of the
 * DEFAULT entries snapshot. Callers still decide that an HTTP denial is
 * authoritative and only use a cached detail after a thrown network failure.
 *
 * [COMP:app-web/brain-content-cache]
 */

import type {
  BrainGraph,
  BrainPrimitive,
  BrainRow,
} from "@/lib/api/brain";
import { idbDelete, idbGet, idbSet } from "./idb";

const CACHE_VERSION = 1;
const KEY_PREFIX = "brain-content";

export type BrainContentCacheScope = {
  viewerId: string;
  workspaceId: string;
  viewpointAssistantId?: string | null;
};

export type BrainContentCacheEntry<T> = {
  value: T;
  updatedAt: number;
};

type StoredEnvelope = {
  version: typeof CACHE_VERSION;
  updatedAt: number;
  value: unknown;
};

export type BrainEntriesSnapshot = {
  rows: BrainRow[];
  nextCursor: string | null;
};

export const BRAIN_ENTRIES_RESOURCE = "entries:default";

/**
 * Non-OK responses stay distinguishable from thrown network failures. Cached
 * content may survive a transient outage or 5xx, but a 401/403/404 is an
 * authoritative loss of access (or deletion) and must evict the local copy.
 */
export class BrainContentHttpError extends Error {
  constructor(
    public readonly status: number,
    resource: string,
  ) {
    super(`${resource} failed (${status})`);
    this.name = "BrainContentHttpError";
  }
}

export function isAuthoritativeBrainDenial(error: unknown): boolean {
  if (error instanceof BrainContentHttpError) {
    return error.status === 401 || error.status === 403 || error.status === 404;
  }
  // The existing Views SDK owns blueprint reads and reports HTTP status in its
  // error message rather than a typed error. Keep this narrow to its prefix.
  if (error instanceof Error) {
    const status = /^HTTP (\d{3})\b/.exec(error.message)?.[1];
    return status === "401" || status === "403" || status === "404";
  }
  return false;
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

/** Stable, access-scoped IndexedDB key for one Brain resource. */
export function brainContentCacheKey(
  scope: BrainContentCacheScope,
  resource: string,
): string {
  return [
    KEY_PREFIX,
    `v${CACHE_VERSION}`,
    segment(scope.viewerId),
    segment(scope.workspaceId),
    segment(scope.viewpointAssistantId ?? ""),
    segment(resource),
  ].join(":");
}

function isEnvelope(value: unknown): value is StoredEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredEnvelope>;
  return (
    candidate.version === CACHE_VERSION &&
    typeof candidate.updatedAt === "number" &&
    Number.isFinite(candidate.updatedAt) &&
    "value" in candidate
  );
}

/**
 * Read + validate a cached resource. Corrupt, old-version, private-mode, and
 * missing entries all collapse to `null`; cache failure must never break Brain.
 */
export async function readBrainContentCache<T>(
  scope: BrainContentCacheScope,
  resource: string,
  isValue: (value: unknown) => value is T,
): Promise<BrainContentCacheEntry<T> | null> {
  const stored = await idbGet<unknown>(brainContentCacheKey(scope, resource));
  if (!isEnvelope(stored) || !isValue(stored.value)) return null;
  return { value: stored.value, updatedAt: stored.updatedAt };
}

/** Best-effort last-known-good replacement. */
export async function writeBrainContentCache<T>(
  scope: BrainContentCacheScope,
  resource: string,
  value: T,
): Promise<void> {
  const envelope: StoredEnvelope = {
    version: CACHE_VERSION,
    updatedAt: Date.now(),
    value,
  };
  await idbSet(brainContentCacheKey(scope, resource), envelope);
}

/** Evict a resource after an authoritative denial/deletion response. */
export async function deleteBrainContentCache(
  scope: BrainContentCacheScope,
  resource: string,
): Promise<void> {
  await idbDelete(brainContentCacheKey(scope, resource));
}

function isBrainRow(value: unknown): value is BrainRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<BrainRow>;
  return (
    typeof row.id === "string" &&
    typeof row.kind === "string" &&
    typeof row.name === "string"
  );
}

export function isBrainEntriesSnapshot(
  value: unknown,
): value is BrainEntriesSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<BrainEntriesSnapshot>;
  return (
    Array.isArray(snapshot.rows) &&
    snapshot.rows.every(isBrainRow) &&
    (snapshot.nextCursor === null || typeof snapshot.nextCursor === "string")
  );
}

export function isBrainGraph(value: unknown): value is BrainGraph {
  if (!value || typeof value !== "object") return false;
  const graph = value as Partial<BrainGraph>;
  return (
    Array.isArray(graph.nodes) &&
    graph.nodes.length <= 200 &&
    graph.nodes.every(
      (node) =>
        !!node &&
        typeof node === "object" &&
        typeof (node as { id?: unknown }).id === "string" &&
        typeof (node as { kind?: unknown }).kind === "string" &&
        typeof (node as { name?: unknown }).name === "string" &&
        (!("nodeType" in node) ||
          (node as { nodeType?: unknown }).nodeType !== "group" ||
          (typeof (node as { groupId?: unknown }).groupId === "string" &&
            typeof (node as { memberCount?: unknown }).memberCount === "number" &&
            !("memberIds" in node))),
    ) &&
    Array.isArray(graph.edges) &&
    graph.edges.length <= 600 &&
    graph.edges.every(
      (edge) =>
        !!edge &&
        typeof edge === "object" &&
        typeof (edge as { id?: unknown }).id === "string" &&
        typeof (edge as { source?: unknown }).source === "string" &&
        typeof (edge as { target?: unknown }).target === "string",
    ) &&
    typeof graph.truncated === "boolean"
  );
}

/** Validator for list-shaped resources whose item schema belongs to the SDK. */
export function isArrayValue(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** Validator for fixed object-shaped resources (facets, maps). */
export function isRecordValue(
  value: unknown,
): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const PRIMITIVE_KINDS: Record<BrainPrimitive, Set<string>> = {
  people: new Set(["people", "person"]),
  companies: new Set(["companies", "company"]),
  deals: new Set(["deals", "deal"]),
  knowledge: new Set(["knowledge"]),
  memories: new Set(["memories", "memory"]),
  files: new Set(["files", "workspace_file", "file_segment"]),
  sessions: new Set(["sessions", "session"]),
  tasks: new Set(["tasks", "task"]),
};

/**
 * Local offline projection over the one persisted default entries corpus.
 * Search is intentionally literal and conservative; reconnect replaces it
 * with the server's authoritative filter result.
 */
export function projectCachedBrainRows(
  rows: BrainRow[],
  primitives: BrainPrimitive[],
  search: string,
): BrainRow[] {
  const selected = primitives.length > 0 ? primitives : null;
  const needle = search.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    if (
      selected &&
      !selected.some((primitive) => PRIMITIVE_KINDS[primitive].has(row.kind))
    ) {
      return false;
    }
    if (!needle) return true;
    const haystack = [
      row.name,
      row.summary ?? "",
      row.fileName ?? "",
      row.snippet ?? "",
      ...(row.tags ?? []),
    ]
      .join("\n")
      .toLocaleLowerCase();
    return haystack.includes(needle);
  });
}
