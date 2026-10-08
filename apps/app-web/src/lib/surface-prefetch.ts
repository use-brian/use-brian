/**
 * Intent prefetch - start the work for a surface when the pointer lands on its
 * link, not when the click does.
 *
 * A surface switch costs two serial waits: the route's RSC payload plus its JS
 * chunk, and then the surface's own data fetch on mount. Hovering a sidebar
 * icon precedes the click by a few hundred milliseconds, which is enough to
 * cover most of both. This module spends that window:
 *
 *  - `router.prefetch(href)` warms the route.
 *  - `warmSurfaceData` warms the SAME cache key the destination surface reads
 *    on mount (`lib/surface-cache.ts`), so the fetch is already in flight - or
 *    already resolved - by the time the surface renders.
 *
 * The second half is the one that matters. The routes here are client
 * components with no server data, so their payloads are small; the list fetch
 * is the wait the user actually feels.
 *
 * **Cache keys live here, not in the surfaces**, so a warm and the mount that
 * consumes it cannot drift apart. A surface reads its data with
 * `useCachedResource(surfaceDataKey('tasks', workspaceId), ...)` and this module
 * warms the identical string.
 *
 * Everything degrades silently: a failed warm just means the surface fetches
 * normally, and `router.prefetch` is a no-op in the desktop SPA (the
 * `next/navigation` shim stubs it).
 *
 * Spec: docs/architecture/features/perceived-performance.md
 * [COMP:app-web/surface-prefetch]
 */

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import type { WorkspaceSurface } from "@/lib/doc-page-url";
import { surfaceFromPathname } from "@/lib/doc-page-url";
import { invalidateSurfaceCache, warmSurfaceCache } from "@/lib/surface-cache";
import { fetchCrmConfig } from "@/lib/api/crm";
import { fetchWorkspaceTasks } from "@/lib/api/tasks";
import { leaseSurfaceContent, surfaceContentRemaining } from "@/lib/offline/surface-content-cache";
import { getUserInfo } from "@/lib/user";
import { getView, listWorkspaceAssistants } from "@/lib/api/views";
import { listWorkflows } from "@/lib/api/workflow";
import { fetchConnectorsList } from "@/lib/api/connectors";
import { officeMetadataRemaining } from "@/lib/office/metadata";
import type { CacheLifecycle } from "@/lib/surface-cache";
import { listOfficeArtifacts } from "@/lib/office/api";
import { listTools as listShopifyTools } from "@/lib/api/shopify";
import { associationModuleRemaining } from "@/lib/api/association";
import { fetchLiveRoster, liveRosterRemaining } from "@/lib/api/live";

/**
 * Surfaces whose landing data is a single workspace-scoped list. `studio`
 * is here because the Studio root redirects to Connectors, so hovering the
 * Studio icon warms the connectors list that section reads on mount.
 */
export type WarmableSurface =
  | "projects"
  | "tasks"
  | "crm"
  | "association"
  | "workflow"
  | "studio"
  | "chat"
  | "feed"
  | "office"
  | "shopify"
  | "live";

/**
 * The signed-in viewer's id, appended to every workspace-scoped LIST key.
 * Rows depend on the caller's RLS visibility, so two accounts in one browser
 * tab (the multi-account switcher) must never share a slot - the same rule
 * the Brain's IndexedDB tier already keys on (`brain-content-cache.ts`).
 * Empty when no user cookie is readable (SSR; the cache is browser-only
 * anyway), in which case the key is workspace-only.
 */
function viewerSuffix(): string {
  const id = getUserInfo()?.id;
  return id ? `:${id}` : "";
}

/** Organization directory is permission-sensitive and additionally keys the explicit shell viewer. */
export function workspaceAccessCacheKey(workspaceId: string, userId: string): string {
  return `workspace-access:${workspaceId}:${userId}`;
}

export function scopeReviewCacheKey(workspaceId:string,userId:string,kind:string,after:string,reviewId:string,reviewAfter:string='',includeClassified=false):string {
  return `scope-review:${workspaceId}:${userId}:${kind}:${after}:${reviewId}:${reviewAfter}${includeClassified?':classified':''}`;
}

export function organizationCacheKey(workspaceId: string, userId: string): string {
  return `organization:${workspaceId}:${userId}`;
}

/**
 * The cache key for a surface's landing data. Both the prefetch and the
 * surface's own `useCachedResource` call go through here.
 *
 * Shape: `<resource>:<workspaceId>[:<viewerId>]` - workspace FIRST, so the
 * spine's prefix marks (`tasks:<wid>`, `crm:<wid>:`) and a mutation's
 * `invalidateSurfaceCache('tasks:' + wid)` keep matching every viewer-keyed
 * variant.
 *
 * `null` for surfaces with no single landing list (Brain's graph, Studio's
 * per-section fetches, the doc surface's per-page metadata). Those are not
 * un-warmable in principle, just not one key - they are left alone rather than
 * given a half-right key that would mask a miss.
 */
export function surfaceDataKey(
  surface: WorkspaceSurface | null,
  workspaceId: string | null | undefined,
): string | null {
  if (!workspaceId) return null;
  switch (surface) {
    case "projects":
      return `projects:${workspaceId}${viewerSuffix()}`;
    case "tasks":
      return `tasks:${workspaceId}${viewerSuffix()}`;
    case "crm":
      return `crm:${workspaceId}${viewerSuffix()}`;
    case "workflow":
      return `workflow:${workspaceId}${viewerSuffix()}`;
    default:
      return null;
  }
}

/**
 * The CRM surface reads several independently cached regions under its
 * `surfaceDataKey('crm')` root (`:config`, `:collection:...`, `:lookups`,
 * `:summary:...`). The CONFIG region is the first thing it needs to paint a
 * table header, so it is the one the rail hover warms. Built here, not in the
 * surface, because a warm and the mount that consumes it must be the same
 * string: the previous warm filled the bare `crm:<wid>` slot, which nothing
 * read, and every CRM entry cold-loaded while the hover looked optimised.
 */
export function crmConfigCacheKey(workspaceId: string): string {
  return `${surfaceDataKey("crm", workspaceId)}:config`;
}

export function associationModuleCacheKey(workspaceId: string): string {
  return `association-module:${workspaceId}${viewerSuffix()}`;
}

export function associationPageCacheKey(workspaceId:string,resource:string,query:Record<string,unknown>={}):string {
  return `crm:${workspaceId}${viewerSuffix()}:association:${resource}:${JSON.stringify(query)}`;
}

/** Browser-tab request references contain no form content. */
export function associationIntentKey(workspaceId:string,operation:string,target:string):string {
  return `association-intent:${workspaceId}${viewerSuffix()}:${operation}:${target}`;
}

export function associationOrdersCacheKey(workspaceId: string, cursor: string | null, filters = ""): string {
  return `association-orders:${workspaceId}${viewerSuffix()}:${filters}:${cursor ?? "first"}`;
}

/**
 * The other CRM regions, under the same `crm:<wid>[:<viewer>]:` root the
 * spine marks stale (`surface-cache-invalidation.ts`). Each region is one
 * independently cached fetch of the CRM surface; the sidebar panel reads the
 * SAME strings (summary, lookups, email drafts) instead of fetching its own
 * copy, which is only safe because both sides build the key here (N2). The
 * discriminators are appended verbatim, so
 * `crmRegionCacheKey(wid, "summary", pipelineId)` is the exact key the surface
 * read when it built the string by hand.
 */
export type CrmCacheRegion =
  | "collection"
  | "lookups"
  | "summary"
  | "email-context"
  | "email-drafts"
  | "record";

export function crmRegionCacheKey(
  workspaceId: string,
  region: CrmCacheRegion,
  ...discriminators: string[]
): string {
  const base = `${surfaceDataKey("crm", workspaceId)}:${region}`;
  return discriminators.length > 0 ? `${base}:${discriminators.join(":")}` : base;
}

/**
 * The Feed surfaces' keys (`lib/feed-surface-cache.ts` holds the loaders).
 * All three are viewer-suffixed: the workspace record carries the viewer's
 * own role / draft permission, and the session and plan lists are RLS-scoped
 * reads. IndexedDB tier per the mobile-native plan's §6.4 (Feed is one of
 * the five disk-tier surfaces), through the `feed:cache:<viewer>:...`
 * namespace `lib/offline/feed-cache.ts` already owns.
 *
 *  - `feed-workspace:<wid>:<viewer>` the shell gate's record (workspace
 *    identity, profiles, distribution assistants, brand, cloud link) - the
 *    five requests every Feed entry used to block on.
 *  - `feed-sessions:<wid>:<viewer>:<platform>` one platform's draft sessions
 *    for EVERY distribution assistant, read by the sidebar post list and the
 *    per-platform posts list alike (one key, no second fetch).
 *  - `feed-plan:<wid>:<viewer>:<assistantId>:<month>` one month of the Plan
 *    surface (slots, brief, open ideas). The assistant is a discriminator
 *    because a workspace can hold several brand voices, each with its own
 *    calendar.
 */
export function feedPermissionsCacheKey(workspaceId: string, assistantId: string, connectorId?: string): string {
  return `feed-permissions:${workspaceId}${viewerSuffix()}:${assistantId}${connectorId ? `:${connectorId}` : ""}`;
}

export function feedWorkspaceCacheKey(workspaceId: string): string {
  return `feed-workspace:${workspaceId}${viewerSuffix()}`;
}

export function feedCollaborationCacheKey(workspaceId: string, assistantId: string, sessionId: string, threadId?: string): string {
  return `feed-collaboration:${workspaceId}${viewerSuffix()}:${assistantId}:${sessionId}${threadId ? `:thread:${threadId}` : ''}`;
}

export function feedSourcesCacheKey(workspaceId: string, assistantId: string, sessionId: string, kind: 'file' | 'memory'): string {
  return `${feedCollaborationCacheKey(workspaceId, assistantId, sessionId)}:sources:${kind}`;
}

export function feedLearningCacheKey(workspaceId: string, assistantId: string, sessionId: string): string {
  return `${feedCollaborationCacheKey(workspaceId, assistantId, sessionId)}:learning`;
}

export function feedSessionsCacheKey(workspaceId: string, platform: string): string {
  return `feed-sessions:${workspaceId}${viewerSuffix()}:${platform}`;
}

/**
 * The family prefix every `feed-sessions:*` key shares, for the local
 * "posts changed" signal (`lib/feed-posts-events.ts`), which fires from deep
 * inside the post editor with no workspace id in hand. Marking every
 * workspace's list stale is harmless: only a mounted reader refetches.
 */
export function feedSessionsCacheFamily(workspaceId?: string): string {
  return workspaceId ? `feed-sessions:${workspaceId}${viewerSuffix()}:` : "feed-sessions:";
}

export function feedPlanCacheKey(
  workspaceId: string,
  assistantId: string,
  month: string,
): string {
  return `feed-plan:${workspaceId}${viewerSuffix()}:${assistantId}:${month}`;
}

/**
 * Cache key for the Studio -> Connectors list (`fetchConnectorsList`).
 *
 * Studio has no `surfaceDataKey` entry because its sections fetch different
 * things; the CONNECTORS list is the one worth a key of its own: it is the
 * Studio root's redirect target, and the rail + detail paint entirely from
 * it. Viewer-suffixed like every RLS-scoped list (personal rows differ per
 * account). Memory tier only - the spec's "no persistent Studio cache" is
 * the IndexedDB tier (perceived-performance.md -> "What is deliberately not
 * done"), so a stale policy control can never outlive a reload.
 */
export function connectorsCacheKey(workspaceId: string): string {
  return `connectors:${workspaceId}${viewerSuffix()}`;
}

/**
 * Studio section lists (Phase 3 adoption, memory tier only - same
 * "no persistent Studio cache" rule as the connectors key above). One
 * builder per list the section paints from; every list is RLS-scoped, so
 * every key carries the viewer.
 *
 *  - `channels:<wid>`   Studio -> Channels: `listChannels` folded with the
 *                        per-channel routing rows, so the rail and the
 *                        selected panel paint from ONE key with no second
 *                        round (N7).
 *  - `assistants:<wid>` `listAssistants` - read by Studio -> Assistants AND
 *                        Studio -> Channels (its attach picker), so the two
 *                        share one slot. Already on the spine map under
 *                        `ASSISTANT_REFRESH_EVENT`.
 *  - `assistant:<wid>:<aid>` one assistant's header (the detail pane), so
 *                        selecting a rail row never blanks: the page seeds
 *                        it from the list row while this loads.
 *  - `workspace-membership:<wid>` the caller's clearance + role on the
 *                        workspace (gates the rename affordance and the
 *                        clearance picker on Channels).
 *  - `kb-sources:<wid>` / `kb-instances:<wid>` Studio -> Knowledge.
 *  - `ingest-sources:<wid>` / `whatsapp-ingest:<wid>` Studio -> Ingest rules.
 *  - `brain-keys:<wid>`  Studio -> Programmatic access (keys, OAuth
 *                        authorizations, context scopes, capture profiles
 *                        in one parallel fetch).
 *  - `brand:<wid>`       Studio -> Brand (default record + its versions).
 */
export function channelsCacheKey(workspaceId: string): string {
  return `channels:${workspaceId}${viewerSuffix()}`;
}

export function assistantsCacheKey(workspaceId: string): string {
  return `assistants:${workspaceId}${viewerSuffix()}`;
}

export function assistantDetailCacheKey(workspaceId: string, assistantId: string): string {
  return `assistant:${workspaceId}${viewerSuffix()}:${assistantId}`;
}

/**
 * One assistant's Settings tab read (charter, default tier, playbook). Lives
 * under the `assistant:<wid>:` family so `ASSISTANT_REFRESH_EVENT` marks it
 * stale with the header.
 */
export function assistantSettingsCacheKey(workspaceId: string, assistantId: string): string {
  return `${assistantDetailCacheKey(workspaceId, assistantId)}:settings`;
}

export function workspaceMembershipCacheKey(workspaceId: string): string {
  return `workspace-membership:${workspaceId}${viewerSuffix()}`;
}

/**
 * Cache key for the workspace detail row (`GET /api/workspaces/:id`: name,
 * purpose, role, icon, preferences and the member roster) that Settings ->
 * Workspace General and Members both read. ONE slot for the two sections, so
 * a role change made in Members is what General paints next, and reopening
 * Settings paints the roster on the first frame (N1). Viewer-suffixed: the
 * caller's `role` is in the row. Memory tier only.
 */
export function workspaceDetailCacheKey(workspaceId: string): string {
  return `workspace-detail:${workspaceId}${viewerSuffix()}`;
}

export function kbSourcesCacheKey(workspaceId: string): string {
  return `kb-sources:${workspaceId}${viewerSuffix()}`;
}

export function kbInstancesCacheKey(workspaceId: string): string {
  return `kb-instances:${workspaceId}${viewerSuffix()}`;
}

export function ingestSourcesCacheKey(workspaceId: string): string {
  return `ingest-sources:${workspaceId}${viewerSuffix()}`;
}

export function ingestApplicationsCacheKey(workspaceId: string): string {
  return `ingest-applications:${workspaceId}${viewerSuffix()}`;
}

export function whatsappIngestCacheKey(workspaceId: string): string {
  return `whatsapp-ingest:${workspaceId}${viewerSuffix()}`;
}

export function brainKeysCacheKey(workspaceId: string): string {
  return `brain-keys:${workspaceId}${viewerSuffix()}`;
}

export function brandCacheKey(workspaceId: string): string {
  return `brand:${workspaceId}${viewerSuffix()}`;
}

/**
 * Chat keys (`lib/chat-surface-data.ts` reads all four; the Chat sidebar
 * panel and the Chat surface both go through that hook). The roster is what
 * the Chat icon's hover warms: it is the first thing the surface needs (the
 * new-chat hero paints the primary assistant) and the fan-out the personal
 * list depends on. Viewer-suffixed because every list is RLS-scoped; the
 * spine's `chat-roster:<wid>` / `chat-sessions:<wid>` / `chat-shared:<wid>`
 * marks stay workspace-first so they match every viewer variant.
 */
export function chatRosterCacheKey(workspaceId: string): string {
  return `chat-roster:${workspaceId}${viewerSuffix()}`;
}

export function chatSessionsCacheKey(workspaceId: string): string {
  return `chat-sessions:${workspaceId}${viewerSuffix()}`;
}

export function chatSharedSessionsCacheKey(workspaceId: string): string {
  return `chat-shared:${workspaceId}${viewerSuffix()}`;
}

/**
 * A session's transcript, keyed per SESSION (session ids are global): a
 * thread switch paints the last transcript of the same session and never the
 * previous thread's. Not viewer-suffixed - a transcript is one conversation,
 * and the rows a viewer may read are gated server-side per request. Not on
 * the spine map; the Chat surface drives it explicitly (a settle refetch, the
 * write-through of streamed rows).
 */
export function chatTranscriptCacheKey(sessionId: string): string {
  return `chat-transcript:${sessionId}`;
}

/**
 * Workflow keys (Phase 3 adoption, memory tier only). The LIST is
 * `surfaceDataKey("workflow", wid)` above (the rail hover warms it, the list
 * page and the workflow sidebar panel both read it); these two are the
 * per-row surfaces under it.
 *
 *  - `workflow-detail:<wid>:<viewer>:<id>` one workflow's full row
 *    (`getWorkflowFull`): the detail page AND the run drill-down read it, so
 *    detail -> run paints the workflow header from the same slot. The spine
 *    marks the `workflow-detail:<wid>:` family stale on
 *    `WORKFLOW_REFRESH_EVENT` and never invalidates it: the detail page holds
 *    an editable draft and dirty-checks before adopting a revalidated value
 *    (realtime-sync.md -> editable-draft rule).
 *  - `workflow-run:<wid>:<viewer>:<runId>` one run's detail
 *    (`getWorkflowRun`); the same event marks the `workflow-run:<wid>:`
 *    family, so the run page carries no listener of its own.
 *
 * Both viewer-suffixed: a workflow row and its runs are RLS-scoped reads.
 */
export function workflowPublicationConsentCacheKey(workspaceId: string, workflowId: string): string {
  return `workflow-publication-consent:${workspaceId}${viewerSuffix()}:${workflowId}`;
}

export function workflowDetailCacheKey(workspaceId: string, workflowId: string): string {
  return `workflow-detail:${workspaceId}${viewerSuffix()}:${workflowId}`;
}

export function workflowRunCacheKey(workspaceId: string, runId: string): string {
  return `workflow-run:${workspaceId}${viewerSuffix()}:${runId}`;
}

/**
 * Cache key for an assistant's Knowledge tab (its sources + root entries).
 *
 * Keyed per ASSISTANT like `docPageCacheKey` is keyed per page: the endpoint
 * is `/api/assistants/:id/knowledge/*`, assistant ids are global, and the tab
 * renders for assistants with no workspace too. Viewer-suffixed because the
 * entries a caller sees depend on clearance. Not on the spine map (its
 * prefixes are workspace-first by contract); mount revalidation and the
 * tab's own Sync action refresh it.
 */
export function kbTabCacheKey(assistantId: string): string {
  return `kb-tab:${assistantId}${viewerSuffix()}`;
}

/**
 * Cache key for a single doc page's metadata (`getView`).
 *
 * Doc pages are keyed per page rather than per surface: the doc shell persists
 * across `/p/<pageId>` swaps and re-fetches only the centre pane's metadata, so
 * the unit worth caching is one page, not the surface. Hovering a sidebar row
 * warms it; opening the page paints the cached copy and revalidates.
 */
export function docPageCacheKey(pageId: string): string {
  return `page:${pageId}`;
}

/**
 * Warm one doc page's metadata - called from sidebar row hover. Skips when the
 * copy in cache is still fresh, so running the pointer down a long page list
 * does not fire a request per row it passes over.
 */
export function warmDocPage(pageId: string | null | undefined): void {
  if (!pageId) return;
  warmSurfaceCache(docPageCacheKey(pageId), () => getView(pageId));
}

/** Drop a doc page's cached metadata after a rename / move / delete. */
export function invalidateDocPage(pageId: string | null | undefined): void {
  if (!pageId) return;
  invalidateSurfaceCache(docPageCacheKey(pageId));
}

/**
 * Cache key for the Brain workspace graph overview.
 *
 * Brain gets no `surfaceDataKey` entry because its landing is several fetches
 * driven by filter state, not one list. The GRAPH is the exception worth
 * caching on its own: it is the default view, its key depends only on the
 * workspace + viewpoint (so it is identical on every visit), and it is the
 * slowest thing the surface asks for. Drill-down scopes use the component-local
 * semantic-zoom cache instead of this persistent overview key.
 */
export function brainGraphCacheKey(
  workspaceId: string,
  viewpointAssistantId: string | null | undefined,
): string {
  return `brain-graph:${workspaceId}:${viewpointAssistantId ?? ""}`;
}

// ── Doc-shell panels: Approvals, Autopilot, Triage, Recordings ──────────────
// These open as tabs at `/p?panel=<id>` (`doc-page-url.ts` -> "Doc-shell panel
// tabs"), so `surfaceFromPathname` classifies them as the doc surface and the
// rail / app-bar hover cannot warm them by panel id; they are keyed here so
// the panel's mount and the spine map agree on the string, and so a warm can
// be added the day the intent-prefetch reads the panel query. Every one is
// viewer-suffixed: the rows are RLS-scoped per member. Memory tier only
// (plan mobile-native-app-and-instant-navigation.md section 6.4).

/**
 * The approvals queue (`listApprovals`). Family prefix `approvals:<wid>` is
 * what `APPROVALS_REFRESH_EVENT` marks, so the skill-details sibling below
 * goes stale with it.
 */
export function approvalsCacheKey(workspaceId: string): string {
  return `approvals:${workspaceId}${viewerSuffix()}`;
}

/**
 * The target-skill / target-workflow snapshots behind the queue's
 * `staged_skill_*` / `workflow_refinement` cards (`listSkillApprovalDetails`).
 * Its own slot so the panel fetches it IN PARALLEL with the queue (N7) instead
 * of after the queue answers, which is how the cards used to wait two round
 * trips before they could diff.
 */
export function approvalSkillDetailsCacheKey(workspaceId: string): string {
  return `${approvalsCacheKey(workspaceId)}:skills`;
}

/**
 * The Autopilot board (`listGoals(..., { confirmed: true })`), one slot per
 * status filter (`all` is the non-terminal working set). Family prefix
 * `goals:<wid>` is what `GOAL_REFRESH_EVENT` marks.
 */
export function goalsCacheKey(workspaceId: string, status: string): string {
  return `goals:${workspaceId}${viewerSuffix()}:${status}`;
}

/** The Triage panel's drafts (`listGoals(..., { confirmed: false })`). */
export function triageCacheKey(workspaceId: string): string {
  return `triage:${workspaceId}${viewerSuffix()}`;
}

/**
 * One goal's detail (`getGoalDetail`): the panels' detail pane and the full
 * `/goals/[goalId]` page share it. Family prefix `goal:<wid>:` is what
 * `GOAL_REFRESH_EVENT` marks - distinct from `goals:<wid>` (the board).
 */
export function goalDetailCacheKey(workspaceId: string, goalId: string): string {
  return `goal:${workspaceId}${viewerSuffix()}:${goalId}`;
}

/**
 * The recordings board (`listRecordings`), one slot per status filter + search
 * needle. No spine primitive covers recordings today; the board's in-flight
 * poll calls `refresh()` on this key instead of holding rows of its own.
 */
export function recordingsCacheKey(
  workspaceId: string,
  status: string,
  query: string,
): string {
  return `recordings:${workspaceId}${viewerSuffix()}:${status}:${query.trim()}`;
}

/**
 * One recording's metadata, shared by the brief-page chrome and the standalone
 * detail route. The recording id is globally unique, but the workspace and
 * viewer stay in the key so an account switch can never paint a row that was
 * visible under another caller's clearance.
 */
export function recordingDetailCacheKey(
  workspaceId: string,
  recordingId: string,
): string {
  return `recording:${workspaceId}${viewerSuffix()}:${recordingId}`;
}

// ── Brain detail routes ───────────────────────────────────────────────────────
// `/brain/[entityId]`, `/brain/entry/[kind]/[id]`, `/brain/skills/[rowId]`,
// `/brain/blueprints/[templateId]`. Memory tier over the row each route fetches
// on mount; the Brain's IndexedDB tier (`lib/offline/brain-content-cache.ts`)
// stays the cold seed for rows the detail drawer already opened, keyed by
// viewer + workspace + viewpoint - these keys carry the viewer for the same
// reason (a row's clearance is per viewer). Family prefixes `brain-entity:`,
// `brain-entry:`, `brain-blueprint:` ride `BRAIN_REFRESH_EVENT`;
// `brain-skill:` rides `SKILL_REFRESH_EVENT` (mark-stale only - the skill
// editor is an editable draft).

export function brainEntityCacheKey(workspaceId: string, entityId: string): string {
  return `brain-entity:${workspaceId}${viewerSuffix()}:${entityId}`;
}

export function brainEntryCacheKey(
  workspaceId: string,
  kind: string,
  id: string,
): string {
  return `brain-entry:${workspaceId}${viewerSuffix()}:${kind}:${id}`;
}

export function brainSkillCacheKey(workspaceId: string, skillRowId: string): string {
  return `brain-skill:${workspaceId}${viewerSuffix()}:${skillRowId}`;
}

export function brainBlueprintCacheKey(workspaceId: string, templateId: string): string {
  return `brain-blueprint:${workspaceId}${viewerSuffix()}:${templateId}`;
}

/**
 * Cache key for the workspace's resolved home dock (`fetchHomeDock`).
 *
 * ONE slot shared by the sidebar-data provider (the Suggested badge and the
 * Home pane read `dock` from it) and the workspace root, which used to render
 * NOTHING until the dock resolved purely to decide whether to land on
 * Suggested. Sharing the key means a warm dock decides the landing
 * synchronously and the provider keeps revalidating behind it. Viewer-suffixed:
 * the dock's "needs you" counts are per caller. Memory tier only (plan
 * mobile-native-app-and-instant-navigation.md section 6.4).
 */
export function homeDockCacheKey(workspaceId: string): string {
  return `home-dock:${workspaceId}${viewerSuffix()}`;
}

/**
 * In-memory key for the sidebar page tree (`saved` + `drafts` + teamspaces,
 * fetched in parallel by `doc-sidebar-data.tsx`).
 *
 * The disk tier for the same data is the viewer-scoped `sidebar:*` IndexedDB
 * family (`lib/offline/offline-pages.ts` -> `sidebarCacheKey`), which seeds
 * the first paint after a full reload; this slot is what makes a workspace
 * switch back and forth paint the tree on the first frame without touching
 * IndexedDB. Both carry the viewer id: a shared device with two accounts in
 * one workspace must never paint rows the second viewer's clearance does not
 * permit.
 */
export function sidebarTreeCacheKey(workspaceId: string): string {
  return `sidebar:${workspaceId}${viewerSuffix()}`;
}

/** The lifecycle views Office home lists; each is its own cached list. */
export type OfficeListView = "active" | "archived" | "trash" | "retained";

/** Permission-filtered template registry, memory-only like Office files. */
export function officeTemplateListCacheKey(workspaceId: string, viewerId = getUserInfo()?.id): string {
  return `office-templates:${workspaceId}:${viewerId ?? ""}`;
}

/**
 * Cache key for one Office home list (`listOfficeArtifacts(workspaceId, view)`).
 *
 * `office:<wid>:<viewer>:<view>` - workspace first so `invalidateOfficeList`
 * drops every view of one workspace with a single prefix, viewer-suffixed
 * because the rows are the caller's permission-filtered set (an artifact
 * shared with one teammate must never paint for another on a shared device).
 * Memory tier only (plan section 6.4: Office lists stay off IndexedDB).
 */
export function officeListCacheKey(workspaceId: string, view: OfficeListView, viewerId = getUserInfo()?.id): string {
  return `office:${workspaceId}:${viewerId ?? ""}:${view}`;
}

/** Every list key of one workspace: the prefix `invalidateOfficeList` drops. */
export function officeListCacheFamily(workspaceId: string): string {
  return `office:${workspaceId}:`;
}

/**
 * Drop every cached Office list of a workspace after the USER created,
 * trashed, restored or purged an artifact. Office has no workspace-event
 * spine primitive, so this is the only signal the home has; mount and
 * tab-visible revalidation cover everyone else's changes.
 */
export function invalidateOfficeList(workspaceId: string | null | undefined): void {
  if (!workspaceId) return;
  invalidateSurfaceCache(officeListCacheFamily(workspaceId));
}

/**
 * Cache keys for one open Office artifact: the row (`getOfficeArtifact`) and
 * the live snapshot (`getOfficeSnapshot`). Keyed per artifact, not per
 * workspace: the editor is one artifact at a time, and the two are separate
 * keys so the shell fetches them in PARALLEL (N7) instead of the old
 * row-then-snapshot waterfall, and can paint the chrome from the row (or
 * the home's list row) while the snapshot is still in flight.
 */
export function officeArtifactCacheKey(workspaceId: string, artifactId: string, viewerId = getUserInfo()?.id ?? ""): string {
  return `office-artifact:${workspaceId}:${viewerId}:${artifactId}`;
}

export function officeSnapshotCacheKey(workspaceId: string, artifactId: string, viewerId = getUserInfo()?.id ?? ""): string {
  return `office-snapshot:${workspaceId}:${viewerId}:${artifactId}`;
}

/**
 * Shopify keys (memory tier only). The store is EXTERNAL - no workspace-event
 * spine primitive ever fires for it - so neither family is on the spine map;
 * both rely on mount revalidation (the 30s stale window) and the surface's
 * own Retry control.
 *
 *  - `shopify:<wid>`        `listTools` - the reachability answer
 *                            (`connected` + the callable tool set). Read by
 *                            the surface AND the sidebar panel, so the two
 *                            share one request and one paint. The Shopify
 *                            icon's hover warms this one.
 *  - `shopify-drafts:<wid>` the sidebar panel's "Recent drafts" group: the
 *                            shop identity plus the `status:draft` products,
 *                            fetched in PARALLEL inside one fetcher (N7).
 *
 * Viewer-suffixed: which tools the caller can reach follows the connector
 * grant, which is per account. The two families are distinct prefixes
 * (`shopify:` never matches `shopify-drafts:`), so a mark on one leaves the
 * other alone.
 */
export function shopifyToolsCacheKey(workspaceId: string): string {
  return `shopify:${workspaceId}${viewerSuffix()}`;
}

export function shopifyDraftsCacheKey(workspaceId: string): string {
  return `shopify-drafts:${workspaceId}${viewerSuffix()}`;
}

/**
 * Cache key for the Live roster (`fetchLiveRoster`, memory tier only).
 *
 * ONE slot read by both mounts of `useLiveRoster` - the persistent sidebar
 * (`doc-sidebar.tsx`, which owns the Live icon's active count) and the Live
 * surface itself - so entering `/live` no longer fires a second copy of the
 * same request, and a revisit paints the roster on its first frame. Viewer-
 * suffixed: the roster is server-side tiered per caller (`live-work.md`
 * section 6), so two accounts in one tab must never share rows. On the spine
 * map under `LIVE_REFRESH_EVENT`, `WORKFLOW_REFRESH_EVENT` and
 * `SCHEDULED_JOB_REFRESH_EVENT` (all mark `live:<wid>`). The Live icon's
 * hover warms it.
 */
export function liveRosterCacheKey(workspaceId: string): string {
  return `live:${workspaceId}${viewerSuffix()}`;
}

/**
 * Cache key for the Inbox flyout's payload (`fetchInbox`, memory tier only).
 *
 * The flyout used to refetch on every open and paint three pulsing rows each
 * time; now an open paints the cached rows and revalidates behind them.
 * Viewer-suffixed because the payload IS the caller's inbox (their pending
 * replies, their mentions). On the spine map under `INBOX_REFRESH_EVENT`
 * (`inbox:<wid>`). Not hover-warmed: the Inbox row is a toggle, not a route.
 */
export function inboxCacheKey(workspaceId: string): string {
  return `inbox:${workspaceId}${viewerSuffix()}`;
}

/**
 * The long tail of class C surfaces (plan mobile-native-app-and-instant-
 * navigation.md section 5 Phase 3 step 2, last clause): Computer, Projects,
 * custom Home apps and the Settings sections. Memory tier only. None of
 * these has a spine primitive today (a browser task, a project row, a
 * billing subscription and a model route all change without a domain event
 * reaching the client), so every key below relies on mount + visibility
 * revalidation (N3) and on the surface's own `refresh()` after the user's
 * mutation; the one exception is `home-app-session:`, which rides
 * `HOME_APPS_REFRESH_EVENT` because a re-sync changes whether the app is
 * renderable.
 *
 *  - `browser-profiles:<wid>:<viewer>` the profile roster (`listBrowserProfiles`),
 *                        read by Computer -> Browser profiles AND the Browsers
 *                        sidebar panel in profiles mode (one slot, no second
 *                        request). Viewer-suffixed: `canManage` and the
 *                        owner-only rows depend on the caller.
 *  - `computer-tasks:<wid>:<viewer>` the live-session roster the Browsers
 *                        sidebar panel polls (`listActiveComputerTasks`); the
 *                        poll is the key's `refresh()`.
 *  - `computer-task:<wid>:<sessionId>` one task's header (`getComputerTask`),
 *                        so the Take-Over chrome paints on re-entry while the
 *                        live stream reconnects (the frame's "Connecting" is
 *                        by design; the chrome around it must not blank).
 *  - `project:<wid>:<viewer>:<projectId>` a Project page (`getContextProject`
 *                        + the workspace member roster, in parallel);
 *                        assistants ride the shared `assistants:<wid>` slot.
 *  - `home-app-session:<wid>:<viewer>:<appId>` a custom Home app's session
 *                        (`fetchHomeAppSession`): the entry URL AND the
 *                        caller's bridge token, hence viewer-suffixed.
 *  - `settings-models:<wid>:<viewer>` Settings -> Models (menu + custom
 *                        configuration + metered estimates); viewer-suffixed
 *                        because the served menu is per caller.
 *  - `settings-billing:<wid>` / `settings-usage:<wid>` Settings -> Plan &
 *                        usage (subscription + invoices; credits).
 *  - `llm-key:<wid>` / `codex-provider:<wid>` / `custom-llm-endpoints:<wid>`
 *                        the three provider blocks under Models -> Providers.
 */
export function browserProfilesCacheKey(workspaceId: string): string {
  return `browser-profiles:${workspaceId}${viewerSuffix()}`;
}

export function browserProfileDestinationsCacheKey(workspaceId: string): string {
  return `workspace-access:${workspaceId}:browser-destinations${viewerSuffix()}`;
}

export function computerTasksCacheKey(workspaceId: string): string {
  return `computer-tasks:${workspaceId}${viewerSuffix()}`;
}

export function computerTaskCacheKey(workspaceId: string, sessionId: string): string {
  return `computer-task:${workspaceId}:${sessionId}`;
}

export function projectDetailCacheKey(workspaceId: string, projectId: string): string {
  return `project:${workspaceId}${viewerSuffix()}:${projectId}`;
}

export function homeAppSessionCacheKey(workspaceId: string, appId: string): string {
  return `home-app-session:${workspaceId}${viewerSuffix()}:${appId}`;
}

export function settingsModelsCacheKey(workspaceId: string): string {
  return `settings-models:${workspaceId}${viewerSuffix()}`;
}

export function settingsBillingCacheKey(workspaceId: string): string {
  return `settings-billing:${workspaceId}`;
}

export function settingsUsageCacheKey(workspaceId: string): string {
  return `settings-usage:${workspaceId}`;
}

export function llmKeyCacheKey(workspaceId: string): string {
  return `llm-key:${workspaceId}`;
}

export function codexProviderCacheKey(workspaceId: string): string {
  return `codex-provider:${workspaceId}`;
}

export function customLlmEndpointsCacheKey(workspaceId: string): string {
  return `custom-llm-endpoints:${workspaceId}`;
}

/** Settings -> Domains: domain rows + saved pages + the email-domain probe, one parallel fetch. */
export function settingsDomainsCacheKey(workspaceId: string): string {
  return `settings-domains:${workspaceId}`;
}

export type WarmTarget = {
  /** The exact key the destination surface reads on mount. */
  key: string;
  fetch: () => Promise<unknown>;
  lifecycle?: CacheLifecycle<unknown>;
};

/**
 * The warm target per surface: the KEY its landing hook reads and the fetcher
 * that fills it. Keeping key + fetcher in one record is what the
 * `[COMP:app-web/surface-prefetch]` test checks against each surface's source:
 * a warm that fills a key nobody reads is the failure mode this module
 * exists to prevent.
 */
export function warmTargetFor(
  surface: WarmableSurface,
  workspaceId: string,
): WarmTarget {
  switch (surface) {
    case "projects":
      return {
        key: surfaceDataKey("projects", workspaceId) as string,
        fetch: () => import("@/lib/api/context-scopes").then(m => m.listContextProjects(workspaceId, true)),
      };
    case "tasks":
      return {
        key: surfaceDataKey("tasks", workspaceId) as string,
        fetch: () => leaseSurfaceContent(() => fetchWorkspaceTasks(workspaceId)),
        lifecycle: { expiresInMs: surfaceContentRemaining },
      };
    case "association":
      return {
        key: associationModuleCacheKey(workspaceId),
        fetch: () => import("@/lib/api/association").then(m => m.getAssociationModuleSnapshot(workspaceId)),
        lifecycle: { expiresInMs: associationModuleRemaining },
      };
    case "crm":
      return {
        key: crmConfigCacheKey(workspaceId),
        fetch: () => fetchCrmConfig(workspaceId),
      };
    case "workflow":
      return {
        key: surfaceDataKey("workflow", workspaceId) as string,
        fetch: () => leaseSurfaceContent(() => listWorkflows(workspaceId, { includeArchived: true })),
        lifecycle: { expiresInMs: surfaceContentRemaining },
      };
    case "studio":
      // The Studio root redirects to Connectors (`studio/page.tsx`), so the
      // Studio icon warms the connectors list the landing section reads.
      return {
        key: connectorsCacheKey(workspaceId),
        fetch: () => leaseSurfaceContent(() => fetchConnectorsList(workspaceId)),
        lifecycle: { expiresInMs: surfaceContentRemaining },
      };
    case "chat":
      // The roster is the first thing the Chat surface needs (the new-chat
      // hero) and the fan-out its personal list depends on; the session
      // lists fetch in parallel with it once the surface mounts.
      return {
        key: chatRosterCacheKey(workspaceId),
        fetch: () => leaseSurfaceContent(() => listWorkspaceAssistants(workspaceId)),
        lifecycle: { expiresInMs: surfaceContentRemaining },
      };
    case "feed": {
      // The shell gate's record - the five requests every Feed route mounts
      // behind. Loaded through a dynamic import: the loader module reaches
      // the feed SDK, whose local-change signal imports THIS module for the
      // sessions family prefix, and a static edge here would close a cycle.
      const key = feedWorkspaceCacheKey(workspaceId);
      return {
        key,
        fetch: () =>
          import("@/lib/feed-surface-cache").then((m) =>
            m.loadFeedWorkspaceRecord(workspaceId, key),
          ),
      };
    }
    case "office":
      // Office home lands on the active files list; the other lifecycle
      // views are reached from the sidebar and fetch on their own key.
      return {
        key: officeListCacheKey(workspaceId, "active"),
        fetch: () => listOfficeArtifacts(workspaceId, "active"),
        lifecycle: {expiresInMs: officeMetadataRemaining},
      };
    case "shopify":
      // The reachability answer gates everything the surface renders (the
      // section strip, the not-connected note, the tabs), so it is the one
      // request worth starting on hover.
      return {
        key: shopifyToolsCacheKey(workspaceId),
        fetch: () => leaseSurfaceContent(() => listShopifyTools(workspaceId)),
        lifecycle: { expiresInMs: surfaceContentRemaining },
      };
    case "live":
      // The roster is the whole surface (overview zones, the focused row,
      // the sidebar groups); the sidebar mount usually holds it already, so
      // this warm mostly refreshes a stale copy before the click lands.
      return {
        key: liveRosterCacheKey(workspaceId),
        fetch: () => fetchLiveRoster(workspaceId),
        lifecycle: { expiresInMs: liveRosterRemaining },
      };
  }
}

const WARMABLE: ReadonlySet<string> = new Set<WarmableSurface>([
  "projects",
  "tasks",
  "crm",
  "association",
  "workflow",
  "studio",
  "chat",
  "feed",
  "office",
  "shopify",
  "live",
]);

/**
 * Kick off the destination surface's landing fetch. No-op when the surface has
 * no single landing list, or when the cache is already fresh - hovering the
 * same icon repeatedly costs nothing.
 */
function warmSurfaceData(
  surface: WorkspaceSurface | null,
  workspaceId: string | null | undefined,
): void {
  if (!surface || !workspaceId || !WARMABLE.has(surface)) return;
  const target = warmTargetFor(surface as WarmableSurface, workspaceId);
  warmSurfaceCache(target.key, target.fetch, undefined, target.lifecycle);
}

/** The workspace id in a `/w/<id>/...` path, or null. */
export function workspaceIdFromPath(href: string): string | null {
  const match = /^\/w\/([^/?#]+)/.exec(href);
  return match ? match[1] : null;
}

/**
 * Props to spread onto any in-app navigation trigger (a `<Link>`, or a button
 * that `router.push`es):
 *
 *   <Link href={href} {...intentPrefetch(href)}>
 *
 * `onPointerEnter` covers mouse and pen. `onFocus` covers keyboard tabbing, so
 * a keyboard user gets the same head start. Touch is deliberately not wired:
 * there is no hover before a tap, and `onTouchStart` would fire a request for
 * every scroll that starts on a link.
 */
export function useIntentPrefetch(): (href: string) => {
  onPointerEnter: () => void;
  onFocus: () => void;
} {
  const router = useRouter();
  return useCallback(
    (href: string) => {
      const warm = () => {
        try {
          router.prefetch(href);
        } catch {
          // Prefetch is best-effort; a router that refuses must not break the
          // link it is attached to.
        }
        warmSurfaceData(surfaceFromPathname(href), workspaceIdFromPath(href));
      };
      return { onPointerEnter: warm, onFocus: warm };
    },
    [router],
  );
}

export function workspaceAccessHistoryCacheKey(workspaceId:string,userId:string,kind:'requests'|'grants',revision:string,after:string):string {
  return `${workspaceAccessCacheKey(workspaceId,userId)}:history:${kind}:${revision}:${after}`;
}


export function workspaceAccessInspectionCacheKey(workspaceId:string,userId:string,kind:'explain'|'events',revision:string,selection:string):string {
  return `${workspaceAccessCacheKey(workspaceId,userId)}:${kind}:${revision}:${selection}`;
}

/** Meeting tags share workspace/page cache identity across the doc panel. */
export const meetingTagsCacheKey = (workspaceId: string, pageId: string): string => `meeting-tags:${workspaceId}:${pageId}`;

/** Department directory + homes (v2), viewer-scoped like every access read. */
export function departmentDirectoryCacheKey(workspaceId:string,userId:string):string {
  return `departments:${workspaceId}:${userId}:directory`;
}

/** One department's reader edges; shares the department family prefix. */
export function departmentEdgesCacheKey(workspaceId:string,userId:string,departmentId:string):string {
  return `departments:${workspaceId}:${userId}:edges:${departmentId}`;
}

/** Every listed department's reader edges, for the department cards; same family prefix. */
export function departmentReadersCacheKey(workspaceId:string,userId:string,departmentIds:string[]):string {
  return `departments:${workspaceId}:${userId}:readers:${departmentIds.join(',')}`;
}

/** Registry snapshots share the access invalidation namespace and viewer scope. */
export function workspaceDepartmentRegistryCacheKey(workspaceId:string,userId:string):string {
  return `${workspaceAccessCacheKey(workspaceId,userId)}:registry`;
}

export function docMediaCacheKey(workspaceId:string,userId:string,fileId:string):string {
  return `doc-media:${workspaceId}:${userId}:${fileId}`;
}


/** Temporary uploads have independent original/PDF admission and disposal. */
export function fileCacheMediaCacheKey(workspaceId:string,userId:string,fileId:string,representation:'original'|'pdf'):string {
  return `file-cache-media:${workspaceId}:${userId}:${fileId}:${representation}`;
}

/** Office bytes are owned by one viewer, artifact and exact resource set. */
export function officeMediaCacheKey(workspaceId:string,userId:string,artifactId:string,resourceIds:readonly string[]):string {
  return `office-media:${workspaceId}:${userId}:${artifactId}:${JSON.stringify([...new Set(resourceIds)].sort())}`;
}

/** SQL metadata previews are partitioned by the authenticated shell viewer. */
export function officePreviewCacheKey(workspaceId: string, viewerId: string, artifactId: string, version: number): string {
  return `office-preview:${workspaceId}:${viewerId}:${artifactId}:${version}`;
}

/** Routing drafts never share read ownership across workspaces or viewers. */
export function officeRoutingCacheKey(workspaceId: string, viewerId: string, templateId: string): string {
  return `office-routing:${workspaceId}:${viewerId}:${templateId}`;
}

export function officePanelCachePrefix(workspaceId: string, viewerId: string): string {
  return `office-panel:${workspaceId}:${viewerId}:`;
}

export function officePanelCacheKey(prefix: string | null, kind: "job" | "job-events" | "versions" | "version-preview" | "classification" | "sharing" | "comments" | "suggestions", id: string | undefined): string | null {
  return prefix && id ? `${prefix}${kind}:${id}` : null;
}

/** Bounded human roster shared by mentions and person assignment controls. */
export function workspaceMemberDirectoryCacheKey(workspaceId: string, viewerId: string): string {
  return `workspace-member-directory:${workspaceId}:${viewerId}`;
}

/** Current-RLS page names used only by page-reference selection surfaces. */
export function pageDirectoryCacheKey(workspaceId: string, viewerId: string): string {
  return `page-directory:${workspaceId}:${viewerId}`;
}

/** Settings telemetry is isolated by workspace and signed-in viewer. */
export function tokenUsageCacheKey(workspaceId: string): string {
  return `token-usage:models:${workspaceId}${viewerSuffix()}`;
}

/** Shares the access authority invalidation family, scoped to the shell viewer. */
export function workspaceAccessModeCacheKey(workspaceId:string,userId:string):string {
  return `${workspaceAccessCacheKey(workspaceId,userId)}:mode`;
}

export function workspaceAccessMigrationCacheKey(workspaceId:string,userId:string,kind:'list'|'plan',cursor=''):string {
  return `${workspaceAccessCacheKey(workspaceId,userId)}:migration:${kind}:${cursor}`;
}

export function workspaceCreationContextCacheKey(workspaceId:string,userId:string):string {return `${workspaceAccessCacheKey(workspaceId,userId)}:creation-context`;}

export function connectorSetupCacheKey(workspaceId:string,userId:string,setupId:string):string{return `${workspaceAccessCacheKey(workspaceId,userId)}:connector-setup:${setupId}`;}

export function connectorReconnectCacheKey(workspaceId:string,userId:string,instanceId:string):string{return `${workspaceAccessCacheKey(workspaceId,userId)}:connector-reconnect:${instanceId}`;}

export function projectContentCacheKey(workspaceId: string, projectId: string, view: string, query: string, offset: number): string {
  return `${projectDetailCacheKey(workspaceId, projectId)}:content:${JSON.stringify([view, query, offset])}`;
}
