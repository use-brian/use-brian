/** Durable, viewer-scoped page creation and metadata cache.
 * Spec: docs/architecture/features/doc.md -> Offline page creation.
 * [COMP:app-web/offline-pages]
 */
import { withoutPageReadCapabilities, type DraftInput, type ViewListRow, type ViewMetadata } from "@/lib/api/views";
import { getDictionary } from "@/lib/i18n/dictionaries";
import { isLocale } from "@/lib/i18n/config";
import type { Teamspace } from "@/lib/api/teamspaces";
import { idbDelete, idbGet, idbSet, idbUpdate } from "./idb";
import { currentOfflineWriteAuthority, sameOfflineWriteAuthority, pinOfflineWriteSession,
  offlineWriteUnavailable, type OfflineWriteAuthority, type PinnedOfflineSession } from "./application-write-authority";

export const LOCAL_PAGES_CHANGED = "doc:local-pages-changed";
export type LocalPage = {
  input: DraftInput & { id: string };
  view: ViewMetadata;
  seed: Uint8Array;
  registered: boolean;
  authority: OfflineWriteAuthority;
  effects: Record<UploadStage, UploadEffect>;
  claim?: { stage: UploadStage; id: string };
};
type UploadStage = "registration" | "upload" | "createdEvent";
type UploadEffect = "pending" | "uncertain" | "applied";
const UPLOAD_STAGES: readonly UploadStage[] = ["registration", "upload", "createdEvent"];
function localError(key: "offlinePageStorageFailed" | "offlinePageParentMissing" | "offlinePageSessionMissing"): Error {
  const locale = typeof document !== "undefined" ? document.cookie.match(/(?:^|;\s*)locale=([^;]+)/)?.[1] : undefined;
  return new Error(getDictionary(isLocale(locale) ? locale : "en").docPage[key]);
}
const scopeKey = (authority: OfflineWriteAuthority) => [authority.apiOrigin, authority.viewerId,
  authority.workspaceId, authority.applicationId].map(encodeURIComponent).join(":");
const outboxKey = (authority: OfflineWriteAuthority) => `offline:pages:v2:${scopeKey(authority)}`;
const metadataKey = (authority: OfflineWriteAuthority, id: string) => `offline:page:v2:${scopeKey(authority)}:${id}`;
const current = (authority: OfflineWriteAuthority) => sameOfflineWriteAuthority(authority, currentOfflineWriteAuthority(authority.workspaceId));
function changed(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(LOCAL_PAGES_CHANGED));
}

/** The sidebar's IndexedDB families: the two page lists, the merged list, and the teamspace sections. */
export type SidebarCacheKind = "saved" | "drafts" | "all" | "teamspaces";

/**
 * The viewer-scoped IndexedDB key for one sidebar list of one workspace:
 * The v2 partition includes deployment, viewer, workspace and native app.
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
  const authority = currentOfflineWriteAuthority(workspaceId);
  return authority ? `sidebar:${kind}:v2:${scopeKey(authority)}` : null;
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
  const authority = currentOfflineWriteAuthority(workspaceId);
  if (!authority) return null;
  const savedKey = sidebarCacheKey("saved", workspaceId);
  const draftsKey = sidebarCacheKey("drafts", workspaceId);
  const teamspacesKey = sidebarCacheKey("teamspaces", workspaceId);
  if (!savedKey || !draftsKey || !teamspacesKey) return null;
  const [saved, drafts, teamspaces] = await Promise.all([
    idbGet<ViewListRow[]>(savedKey),
    idbGet<ViewListRow[]>(draftsKey),
    idbGet<Teamspace[]>(teamspacesKey),
  ]);
  if (!current(authority) || !saved && !drafts && !teamspaces) return null;
  const tree = {
    saved: await mergeLocalPages((saved ?? []).map(withoutPageReadCapabilities), workspaceId, "saved"),
    drafts: await mergeLocalPages((drafts ?? []).map(withoutPageReadCapabilities), workspaceId, "draft"),
    teamspaces: teamspaces ?? [],
  };
  return current(authority) ? tree : null;
}

export async function readLocalPages(workspaceId?: string): Promise<LocalPage[]> {
  const authority = currentOfflineWriteAuthority(workspaceId);
  if (!authority) return [];
  const pages = await idbGet<LocalPage[]>(outboxKey(authority));
  return current(authority) && Array.isArray(pages) ? pages.filter(page => page
    && sameOfflineWriteAuthority(page.authority, authority) && page.view.workspaceId === authority.workspaceId
    && page.input.workspaceId === authority.workspaceId && page.view.createdBy === authority.viewerId
    && page.effects && UPLOAD_STAGES.every(stage =>
      ["pending", "uncertain", "applied"].includes(page.effects[stage]))
    && page.view.id === page.input.id) : [];
}
export async function readLocalPage(id: string, workspaceId?: string): Promise<LocalPage | null> {
  return (await readLocalPages(workspaceId)).find((p) => p.view.id === id) ?? null;
}
export async function cachePage(view: ViewMetadata, expected?: OfflineWriteAuthority): Promise<void> {
  const authority = expected ?? currentOfflineWriteAuthority(view.workspaceId);
  if (authority && current(authority) && authority.workspaceId === view.workspaceId) await idbSet(metadataKey(authority, view.id), view);
}
export async function readCachedPage(id: string, workspaceId?: string): Promise<ViewMetadata | null> {
  const authority = currentOfflineWriteAuthority(workspaceId);
  if (!authority) return null;
  const local = await readLocalPage(id, authority.workspaceId);
  if (!current(authority)) return null;
  if (local) return withoutPageReadCapabilities(local.view);
  const cached = await idbGet<ViewMetadata>(metadataKey(authority, id));
  return current(authority) && cached?.workspaceId === authority.workspaceId ? withoutPageReadCapabilities(cached) : null;
}
export async function evictCachedPage(id: string, expected?: OfflineWriteAuthority): Promise<void> {
  const authority = expected ?? currentOfflineWriteAuthority();
  if (authority) await idbDelete(metadataKey(authority, id));
}
export async function mergeLocalPages(rows: ViewListRow[], workspaceId: string, state?: string): Promise<ViewListRow[]> {
  const local = (await readLocalPages(workspaceId)).filter((p) => p.view.workspaceId === workspaceId);
  const ids = new Set(local.map((p) => p.view.id));
  const canonical = new Map(rows.map(row => [row.id, row]));
  return [...rows.filter((p) => !ids.has(p.id)), ...local
    .filter((p) => !state || state === "all" || p.view.state === state)
    .map((p) => {
      // Pending authored fields overlay content, never the matching read decision.
      // Disk/fallback callers already withhold these fields before merging.
      const read = canonical.get(p.view.id);
      return {
        ...withoutPageReadCapabilities(p.view),
        ...(read?.effectiveRole !== undefined ? { effectiveRole: read.effectiveRole } : {}),
        ...(typeof read?.canEdit === "boolean" ? { canEdit: read.canEdit } : {}),
      };
    })];
}

export async function createLocalPage(input: DraftInput & { id: string },
  expected: OfflineWriteAuthority | null = currentOfflineWriteAuthority(input.workspaceId), registration: UploadEffect = "pending"): Promise<ViewMetadata> {
  input = structuredClone(input);
  if (!expected || !current(expected) || expected.workspaceId !== input.workspaceId) throw localError("offlinePageSessionMissing");
  const authority = structuredClone(expected), userId = authority.viewerId;
  const parent = input.nestParentId ? await readCachedPage(input.nestParentId, authority.workspaceId) : null;
  // Sidebar-only parents are also legitimate offline nesting destinations.
  const savedKey = sidebarCacheKey("saved", input.workspaceId);
  const draftsKey = sidebarCacheKey("drafts", input.workspaceId);
  const saved = (savedKey ? await idbGet<ViewListRow[]>(savedKey) : null) ?? [];
  const drafts = (draftsKey ? await idbGet<ViewListRow[]>(draftsKey) : null) ?? [];
  const pending = await readLocalPages(authority.workspaceId);
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
    authority, effects: { registration, upload: "pending", createdEvent: "pending" },
  };
  if (!current(authority)) throw localError("offlinePageSessionMissing");
  try {
    await idbUpdate<LocalPage[]>(outboxKey(authority), (pages) => {
      if ((pages ?? []).some(page => page.view.id === input.id)) throw offlineWriteUnavailable();
      return [...(pages ?? []), record];
    });
  } catch {
    throw localError("offlinePageStorageFailed");
  }
  if (!current(authority)) throw localError("offlinePageSessionMissing");
  changed();
  return view;
}

/** Preserve local metadata through navigation/reload as the REST queue waits. */
export async function patchLocalPage(id: string, patch: Partial<ViewMetadata>): Promise<void> {
  const authority = currentOfflineWriteAuthority();
  if (!authority) return;
  patch = structuredClone(patch);
  const local = await readLocalPage(id);
  if (!current(authority)) return;
  if (local) {
    await idbUpdate<LocalPage[]>(outboxKey(authority), (pages) => (pages ?? []).map((p) =>
      p.view.id === id ? { ...p, view: { ...p.view, ...patch } } : p));
    changed();
  }
  const cached = await readCachedPage(id);
  if (cached) await cachePage({ ...cached, ...patch }, authority);
}

let flushing: Promise<void> | null = null;
/** Registration precedes Yjs upload; failures retain the entire record. */
export function flushLocalPages(): Promise<void> {
  if (flushing) return flushing;
  flushing = flush().finally(() => { flushing = null; });
  return flushing;
}
async function flush(): Promise<void> {
  const authority = currentOfflineWriteAuthority();
  if (!authority) return;
  const pages = await readLocalPages();
  if (pages.length === 0) return;
  const { createDraftOnServer, commitPageCreatedEvent, supportsOfflinePageIds } = await import("@/lib/api/views");
  const { syncLocalPage } = await import("./sync-local-page");
  for (const page of pages) {
    if (!current(authority) || !sameOfflineWriteAuthority(page.authority, authority)
      || UPLOAD_STAGES.some(stage => page.effects[stage] === "uncertain")
      || (typeof navigator !== "undefined" && !navigator.onLine)) return;
    try {
      let latest = page;
      if (latest.effects.registration === "pending") {
        const session = await pinOfflineWriteSession(authority);
        if (!await supportsOfflinePageIds(authority.workspaceId, session)) return;
        session.assertCurrent();
        const claimed = await claimStage(authority, latest, "registration");
        if (!claimed) return;
        const server = await createDraftOnServer(claimed.input, session);
        const settled = await settleStage(authority, claimed, server);
        if (!settled) return;
        latest = settled;
      }
      if (latest.effects.upload === "pending") {
        const session = await pinOfflineWriteSession(authority);
        await assertServerPage(session, latest);
        const claimed = await claimStage(authority, latest, "upload");
        if (!claimed) return;
        session.assertCurrent();
        await syncLocalPage(claimed.view.id, claimed.seed, authority);
        const settled = await settleStage(authority, claimed);
        if (!settled) return;
        latest = settled;
      }
      if (latest.effects.createdEvent === "pending") {
        const session = await pinOfflineWriteSession(authority);
        await assertServerPage(session, latest);
        const claimed = await claimStage(authority, latest, "createdEvent");
        if (!claimed) return;
        await commitPageCreatedEvent(claimed.view.id, session);
        const settled = await settleStage(authority, claimed);
        if (!settled) return;
        latest = settled;
      }
      if (!UPLOAD_STAGES.every(stage => latest.effects[stage] === "applied")) return;
      const session = await pinOfflineWriteSession(authority);
      await assertServerPage(session, latest);
      // Cache the latest metadata, including edits made during this upload.
      const final = await readLocalPage(latest.view.id);
      session.assertCurrent();
      if (final) await cachePage({ ...final.view, createdEventPending: false }, authority);
      session.assertCurrent();
      await idbUpdate<LocalPage[]>(outboxKey(authority), (pages) => (pages ?? []).filter((p) => p.view.id !== latest.view.id
        || p.claim || !UPLOAD_STAGES.every(stage => p.effects[stage] === "applied")));
      changed();
    } catch {
      // Every potentially dispatched stage stays uncertain after failure.
      // Reload/reconnect does not retry it or move it into another account.
      return;
    }
  }
}

async function assertServerPage(session: PinnedOfflineSession, page: LocalPage): Promise<void> {
  const response = await session.request(`/api/views/${encodeURIComponent(page.view.id)}`);
  if (!response.ok) throw offlineWriteUnavailable();
  const server: unknown = await response.json();
  session.assertCurrent();
  if (!server || typeof server !== "object" || !("id" in server) || server.id !== page.view.id
    || !("workspaceId" in server) || server.workspaceId !== session.authority.workspaceId
    || !("createdBy" in server) || server.createdBy !== session.authority.viewerId) throw offlineWriteUnavailable();
}

/** The durable transaction is the cross-tab claim, before any stage effect. */
async function claimStage(authority: OfflineWriteAuthority, page: LocalPage, stage: UploadStage): Promise<LocalPage | null> {
  if (!current(authority)) throw offlineWriteUnavailable();
  const claim = { stage, id: crypto.randomUUID() };
  let claimed: LocalPage | null = null;
  await idbUpdate<LocalPage[]>(outboxKey(authority), (pages) => (pages ?? []).map(p => {
    if (p.view.id !== page.view.id || !sameOfflineWriteAuthority(p.authority, authority)
      || p.claim || p.effects[stage] !== "pending" || JSON.stringify(p.input) !== JSON.stringify(page.input)) return p;
    claimed = { ...p, effects: { ...p.effects, [stage]: "uncertain" }, claim };
    return claimed;
  }));
  if (!current(authority)) throw offlineWriteUnavailable();
  return claimed;
}

async function settleStage(authority: OfflineWriteAuthority, page: LocalPage, server?: ViewMetadata): Promise<LocalPage | null> {
  let settled: LocalPage | null = null;
  await idbUpdate<LocalPage[]>(outboxKey(authority), (pages) => (pages ?? []).map(p => {
    if (!page.claim || p.view.id !== page.view.id || p.claim?.id !== page.claim.id
      || !sameOfflineWriteAuthority(p.authority, authority) || p.effects[page.claim.stage] !== "uncertain") return p;
    settled = { ...p, claim: undefined, registered: p.registered || page.claim.stage === "registration",
      effects: { ...p.effects, [page.claim.stage]: "applied" },
      ...(server ? { view: { ...p.view, autoPruneAt: server.autoPruneAt ?? null,
        teamspaceId: server.teamspaceId !== undefined ? server.teamspaceId : p.view.teamspaceId,
        projectId: server.projectId !== undefined ? server.projectId : p.view.projectId,
        position: server.position ?? p.view.position } } : {}) };
    return settled;
  }));
  changed();
  return settled;
}
