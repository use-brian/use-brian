/** Durable, viewer-scoped page creation and metadata cache.
 * Spec: docs/architecture/features/doc.md -> Offline page creation.
 * [COMP:app-web/offline-pages]
 */
import type { DraftInput, ViewListRow, ViewMetadata } from "@/lib/api/views";
import { getDictionary } from "@/lib/i18n/dictionaries";
import { isLocale } from "@/lib/i18n/config";
import { getUserInfo } from "@/lib/user";
import type { Teamspace } from "@/lib/api/teamspaces";
import { idbDelete, idbGet, idbSet, idbUpdate } from "./idb";

export const LOCAL_PAGES_CHANGED = "doc:local-pages-changed";
export type LocalPage = {
  input: DraftInput & { id: string };
  view: ViewMetadata;
  seed: Uint8Array;
  registered: boolean;
};
function localError(key: "offlinePageStorageFailed" | "offlinePageParentMissing" | "offlinePageSessionMissing"): Error {
  const locale = typeof document !== "undefined" ? document.cookie.match(/(?:^|;\s*)locale=([^;]+)/)?.[1] : undefined;
  return new Error(getDictionary(isLocale(locale) ? locale : "en").docPage[key]);
}
const owner = () => getUserInfo()?.id;
const outboxKey = (userId: string) => `offline:pages:${userId}`;
const metadataKey = (userId: string, id: string) => `offline:page:${userId}:${id}`;
function changed(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(LOCAL_PAGES_CHANGED));
}

/** The sidebar's IndexedDB families: the two page lists, the merged list, and the teamspace sections. */
export type SidebarCacheKind = "saved" | "drafts" | "all" | "teamspaces";

/**
 * The viewer-scoped IndexedDB key for one sidebar list of one workspace:
 * `sidebar:<kind>:<workspaceId>:<viewerId>`. Workspace before viewer, the
 * same order the in-memory `sidebarTreeCacheKey` uses.
 *
 * `null` when no viewer is signed in (SSR, a cleared cookie): the caller then
 * skips the disk tier entirely rather than reading or writing a key that
 * every account on the device would share. The 2026-09 phone review found
 * the previous workspace-only key would paint one viewer's page rows to a
 * second account in the same workspace on a shared device, rows the second
 * viewer's clearance may not permit. `clearLocalDocCaches` (sign-out) drops
 * the whole store, so these keys never outlive the session either way.
 */
export function sidebarCacheKey(kind: SidebarCacheKind, workspaceId: string): string | null {
  const userId = owner();
  return userId ? `sidebar:${kind}:${workspaceId}:${userId}` : null;
}

export type CachedSidebarTree = {
  saved: ViewListRow[];
  drafts: ViewListRow[];
  teamspaces: Teamspace[];
};

/**
 * The last-known sidebar tree for the signed-in viewer, merged with any
 * durable local page creations, or `null` when nothing is cached. This is
 * what the sidebar-data provider paints on a full reload while the network
 * fetch is still in flight (instant-navigation contract N1); it is never
 * returned for a viewer other than the one who wrote it, because the key
 * carries the viewer id.
 */
export async function readCachedSidebarTree(workspaceId: string): Promise<CachedSidebarTree | null> {
  const savedKey = sidebarCacheKey("saved", workspaceId);
  const draftsKey = sidebarCacheKey("drafts", workspaceId);
  const teamspacesKey = sidebarCacheKey("teamspaces", workspaceId);
  if (!savedKey || !draftsKey || !teamspacesKey) return null;
  const [saved, drafts, teamspaces] = await Promise.all([
    idbGet<ViewListRow[]>(savedKey),
    idbGet<ViewListRow[]>(draftsKey),
    idbGet<Teamspace[]>(teamspacesKey),
  ]);
  if (!saved && !drafts && !teamspaces) return null;
  return {
    saved: await mergeLocalPages(saved ?? [], workspaceId, "saved"),
    drafts: await mergeLocalPages(drafts ?? [], workspaceId, "draft"),
    teamspaces: teamspaces ?? [],
  };
}

export async function readLocalPages(): Promise<LocalPage[]> {
  const userId = owner();
  return userId ? (await idbGet<LocalPage[]>(outboxKey(userId))) ?? [] : [];
}
export async function readLocalPage(id: string): Promise<LocalPage | null> {
  return (await readLocalPages()).find((p) => p.view.id === id) ?? null;
}
export async function cachePage(view: ViewMetadata): Promise<void> {
  const userId = owner();
  if (userId) await idbSet(metadataKey(userId, view.id), view);
}
export async function readCachedPage(id: string): Promise<ViewMetadata | null> {
  const local = await readLocalPage(id);
  if (local) return local.view;
  const userId = owner();
  return userId ? idbGet<ViewMetadata>(metadataKey(userId, id)) : null;
}
export async function evictCachedPage(id: string): Promise<void> {
  const userId = owner();
  if (userId) await idbDelete(metadataKey(userId, id));
}
export async function mergeLocalPages(rows: ViewListRow[], workspaceId: string, state?: string): Promise<ViewListRow[]> {
  const local = (await readLocalPages()).filter((p) => p.view.workspaceId === workspaceId);
  const ids = new Set(local.map((p) => p.view.id));
  return [...rows.filter((p) => !ids.has(p.id)), ...local
    .filter((p) => !state || state === "all" || p.view.state === state)
    .map((p) => p.view)];
}

export async function createLocalPage(input: DraftInput & { id: string }): Promise<ViewMetadata> {
  const userId = owner();
  if (!userId) throw localError("offlinePageSessionMissing");
  const parent = input.nestParentId ? await readCachedPage(input.nestParentId) : null;
  // Sidebar-only parents are also legitimate offline nesting destinations.
  const savedKey = sidebarCacheKey("saved", input.workspaceId);
  const draftsKey = sidebarCacheKey("drafts", input.workspaceId);
  const saved = (savedKey ? await idbGet<ViewListRow[]>(savedKey) : null) ?? [];
  const drafts = (draftsKey ? await idbGet<ViewListRow[]>(draftsKey) : null) ?? [];
  const pending = await readLocalPages();
  const rows = [...saved, ...drafts, ...pending.map((p) => p.view)];
  const parentRow = parent ?? rows.find((p) => p.id === input.nestParentId);
  if (input.nestParentId && (!parentRow || parentRow.workspaceId !== input.workspaceId)) {
    throw localError("offlinePageParentMissing");
  }
  const teamspacesKey = sidebarCacheKey("teamspaces", input.workspaceId);
  const teamspaces = (teamspacesKey ? await idbGet<Teamspace[]>(teamspacesKey) : null) ?? [];
  // A shared Project collection page (migration 749) has no teamspace; a child stays in its parent's collection.
  const sharedProjectId = parentRow ? parentRow.sharedProjectId ?? null : input.sharedProjectId ?? null;
  const teamspaceId = parentRow ? parentRow.teamspaceId : sharedProjectId ? null : (input.teamspaceId !== undefined
    ? input.teamspaceId : teamspaces.find((t) => t.isDefault)?.id ?? null);
  const now = new Date().toISOString();
  // Keep the canonical REST placeholder and seed identical to doc-sync's
  // deterministic seed. Placeholder titles are rendered through UI i18n.
  const name = input.name?.trim().slice(0, 256) || "New draft";
  const view: ViewMetadata = {
    id: input.id, workspaceId: input.workspaceId, createdBy: userId,
    name, nameOrigin: input.name?.trim() ? "user" : "placeholder",
    description: null, entity: input.binding?.entity === "custom" ? "tasks" : input.binding?.entity ?? "tasks",
    viewType: input.binding?.viewType ?? "table", state: "draft",
    nestParentId: input.nestParentId ?? null, teamspaceId,
    projectId: parentRow?.projectId ?? sharedProjectId ?? null, sharedProjectId,
    position: Math.max(-1, ...rows.filter((p) => p.nestParentId === (input.nestParentId ?? null)).map((p) => p.position)) + 1,
    icon: null, fullWidth: false, clearance: "internal", originPrompt: null,
    autoPruneAt: null, brainSyncEnabled: false, createdEventPending: true,
    page: { blocks: input.blocks ?? [] }, createdAt: now, updatedAt: now,
    anchorKey: null, linkedRecordingId: null,
  };
  const { pageToYDocUpdate, pageSchema } = await import("@use-brian/doc-model");
  const record: LocalPage = {
    input, view, seed: pageToYDocUpdate(pageSchema.parse(view.page), name), registered: false,
  };
  try {
    await idbUpdate<LocalPage[]>(outboxKey(userId), (pages) => [...(pages ?? []), record]);
  } catch {
    throw localError("offlinePageStorageFailed");
  }
  changed();
  return view;
}

/** Preserve local metadata through navigation/reload as the REST queue waits. */
export async function patchLocalPage(id: string, patch: Partial<ViewMetadata>): Promise<void> {
  const userId = owner();
  if (!userId) return;
  const local = await readLocalPage(id);
  if (local) {
    await idbUpdate<LocalPage[]>(outboxKey(userId), (pages) => (pages ?? []).map((p) =>
      p.view.id === id ? { ...p, view: { ...p.view, ...patch } } : p));
    changed();
  }
  const cached = await readCachedPage(id);
  if (cached) await cachePage({ ...cached, ...patch });
}

let flushing: Promise<void> | null = null;
/** Registration precedes Yjs upload; failures retain the entire record. */
export function flushLocalPages(): Promise<void> {
  if (flushing) return flushing;
  flushing = flush().finally(() => { flushing = null; });
  return flushing;
}
async function flush(): Promise<void> {
  const userId = owner();
  if (!userId) return;
  const pages = await readLocalPages();
  if (pages.length === 0) return;
  const { createDraftOnServer, commitPageCreatedEvent, supportsOfflinePageIds } = await import("@/lib/api/views");
  const { syncLocalPage } = await import("./sync-local-page");
  const supportedWorkspaces = new Set<string>();
  for (const page of pages) {
    if (owner() !== userId || (typeof navigator !== "undefined" && !navigator.onLine)) return;
    try {
      if (!page.registered) {
        if (!supportedWorkspaces.has(page.view.workspaceId)) {
          if (!await supportsOfflinePageIds(page.view.workspaceId)) return;
          supportedWorkspaces.add(page.view.workspaceId);
        }
        const server = await createDraftOnServer(page.input);
        if (server.id !== page.view.id) throw new Error("offline_page_id_mismatch");
        if (owner() !== userId) return;
        await idbUpdate<LocalPage[]>(outboxKey(userId), (pages) => (pages ?? []).map((p) =>
          p.view.id === page.view.id ? {
            ...p, registered: true,
            view: { ...p.view,
              autoPruneAt: server.autoPruneAt ?? null,
              teamspaceId: server.teamspaceId !== undefined ? server.teamspaceId : p.view.teamspaceId,
              projectId: server.projectId !== undefined ? server.projectId : p.view.projectId,
              position: server.position ?? p.view.position,
            },
          } : p));
        changed();
      }
      await syncLocalPage(page.view.id, page.seed);
      if (owner() !== userId) return;
      await commitPageCreatedEvent(page.view.id);
      // Cache the latest metadata, including edits made during this upload.
      const latest = await readLocalPage(page.view.id);
      if (latest) await cachePage({ ...latest.view, createdEventPending: false });
      await idbUpdate<LocalPage[]>(outboxKey(userId), (pages) => (pages ?? []).filter((p) => p.view.id !== page.view.id));
      changed();
    } catch {
      // Never discard authored work after an arbitrary retry count. Keep
      // parents ahead of children and retry after connectivity recovers.
      return;
    }
  }
}
