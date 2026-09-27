/**
 * The ONE spine-to-cache map (instant-navigation contract N3).
 *
 * The workspace event spine (`lib/workspace-events.ts`, mounted once in
 * `WorkspaceChrome`) routes server change signals to per-domain window
 * CustomEvents. Before this map every surface that wanted to react carried its
 * own listener and refetched through its own loader - and the two cached
 * surfaces that never got one (Tasks, CRM) painted a task or deal an assistant
 * wrote from chat into the sidebar counts but not into the open list until
 * the 30s stale window elapsed. This hook subscribes ONCE, beside
 * `useWorkspaceEvents`, and translates each domain event into
 * `markSurfaceCacheStale` calls on the cache-key prefixes that domain feeds.
 *
 * Mark stale, never invalidate: a spine signal is "something changed
 * somewhere", so the open list keeps painting and revalidates behind the
 * paint (`useCachedResource` already refetches a stale entry). Only a user
 * action that changed the row invalidates. The catch-up burst the spine fires
 * on every stream `open` and tab-visible therefore becomes a mark-stale burst
 * instead of a refetch burst: nothing refetches until a mounted surface
 * actually reads the key.
 *
 * `staleMarksFor` is the pure routing table so the map is unit-tested without
 * a window; the hook is the thin listener over it. Keys are workspace-first
 * (`<resource>:<workspaceId>...`), so every prefix below scopes to the one
 * workspace the chrome is showing; events that name another workspace are
 * ignored.
 *
 * Spec: docs/architecture/features/perceived-performance.md ->
 * "Instant-navigation contract"; docs/architecture/platform/realtime-sync.md
 * -> "Web client".
 * [COMP:app-web/surface-cache-invalidation]
 */

import { useEffect } from "react";
import { BRAIN_REFRESH_EVENT } from "@/lib/brain-events";
import { APPROVALS_REFRESH_EVENT } from "@/lib/approvals-events";
import { WORKFLOW_REFRESH_EVENT } from "@/lib/workflow-events";
import { ASSISTANT_REFRESH_EVENT } from "@/lib/assistant-events";
import { HOME_APPS_REFRESH_EVENT } from "@/lib/home-apps-events";
import { INBOX_REFRESH_EVENT } from "@/lib/inbox-refresh-events";
import { GOAL_REFRESH_EVENT } from "@/lib/goal-events";
import { WORKSPACE_IDENTITY_REFRESH_EVENT } from "@/lib/workspace-identity-events";
import {
  LIVE_REFRESH_EVENT,
  SCHEDULED_JOB_REFRESH_EVENT,
  SKILL_REFRESH_EVENT,
} from "@/lib/workspace-events";
import { invalidateSurfaceCache, markSurfaceCacheStale } from "@/lib/surface-cache";

/**
 * Domain event -> the cache-key prefixes it makes stale, for one workspace.
 * A prefix ending in `:` is a family; a bare `<resource>:<wid>` is the family
 * of every viewer-keyed variant of that list (`tasks:<wid>:<viewer>`).
 *
 * Prefixes for surfaces that have not adopted the cache yet (`approvals:`,
 * `skills:`, `home-apps:`, `chat-roster:`) are listed now so adoption is a
 * one-line change on the surface, never a second map. `live:` (the roster
 * hook, `components/live/use-live-roster.ts`) and `inbox:` (the Inbox
 * flyout, `components/doc/inbox-panel.tsx`) read the cache and carry no
 * listener of their own.
 */
export function staleMarksFor(event: string, workspaceId: string): string[] {
  switch (event) {
    case BRAIN_REFRESH_EVENT:
      // Tasks, contacts / companies / deals and the graph are all brain
      // primitives on the server side. So is `kb_chunk`: a knowledge sync
      // lands chunks, which moves a source's entry count / last-synced line
      // on Studio -> Knowledge (`kb-sources:`). Ingest sources, channels,
      // brand and brain keys have NO spine primitive today, so their keys
      // stay off this map and rely on mount revalidation (N3); so do the
      // Shopify families (`shopify:`, `shopify-drafts:`), which read an
      // EXTERNAL store no workspace event ever describes.
      return [
        `tasks:${workspaceId}`,
        `crm:${workspaceId}:`,
        `brain-graph:${workspaceId}:`,
        `kb-sources:${workspaceId}`,
        // The Brain detail routes (entity rollup, knowledge / memory entry
        // reader, blueprint editor) are memory-tier keys over brain rows and
        // page templates; the blueprint editor fires `requestBrainRefresh`
        // after its own writes, so its key rides the same event. Mark-stale
        // only: the blueprint contract is an editable draft, and the page
        // dirty-checks before adopting a revalidated row.
        `brain-entity:${workspaceId}:`,
        `brain-entry:${workspaceId}:`,
        `brain-blueprint:${workspaceId}:`,
        `feed-collaboration:${workspaceId}`,
      ];
    case APPROVALS_REFRESH_EVENT:
      // The home dock's "needs you" counts move with every approval created
      // or resolved, so the Suggested badge, the Home pane and the workspace
      // root (which lands on Suggested off the same dock) all revalidate here
      // instead of through a listener of the provider's own.
      return [`approvals:${workspaceId}`, `crm:${workspaceId}:`, `home-dock:${workspaceId}`];
    case WORKFLOW_REFRESH_EVENT:
      // The detail key is mark-stale only, never invalidate: an open editable
      // draft must not be clobbered (realtime-sync.md -> editable-draft rule).
      // `workflow-run:<wid>:` is the run drill-down: a `workflow_run` signal
      // (step / status transitions) arrives on this same event, so the run
      // page carries no listener of its own and its in-flight poll stays only
      // as the degraded-SSE fallback.
      return [
        `workflow:${workspaceId}`,
        `workflow-detail:${workspaceId}:`,
        `workflow-run:${workspaceId}:`,
        // A run starting or settling is a Live roster row appearing or
        // moving to "Just finished" (`live-work.md` section 3 interleaves
        // runs with sessions), so the roster rides the same signal.
        `live:${workspaceId}`,
      ];
    case SCHEDULED_JOB_REFRESH_EVENT:
      // A schedule edit changes what is ABOUT to fire, which the Live roster
      // shows as upcoming work; the roster hook used to carry its own
      // listener for exactly this event.
      return [`live:${workspaceId}`];
    case ASSISTANT_REFRESH_EVENT:
      // `assistants:<wid>` is the Studio rail (and the Channels attach
      // picker); `assistant:<wid>:` is the family of per-assistant detail
      // headers the Studio -> Assistants pane reads.
      return [
        `assistants:${workspaceId}`,
        `assistant:${workspaceId}:`,
        `chat-roster:${workspaceId}`,
        // The personal rail is a fan-out over the roster, so a new or
        // removed assistant changes which threads it merges.
        `chat-sessions:${workspaceId}`,
        // The Feed shell's record folds the distribution assistants in
        // (`/api/assistants` filtered to `appType='distribution'`), so a
        // brand voice created from chat reaches the Feed gate too.
        `feed-workspace:${workspaceId}`,
      ];
    case WORKSPACE_IDENTITY_REFRESH_EVENT:
      // `workspace_config`: the workspace's name / role projection, which the
      // Feed shell's record carries (name, role, canDraft) - report E's
      // "Feed gate" row names this as its one stale trigger. The Settings
      // detail row (name, icon, purpose, roster) rides the same signal.
      return [`feed-workspace:${workspaceId}`, `workspace-detail:${workspaceId}`, `feed-collaboration:${workspaceId}`];
    case SKILL_REFRESH_EVENT:
      // `brain-skill:<wid>:` is the skill editor's row. Mark-stale only: the
      // editor body is an editable draft, and the page adopts a revalidated
      // row only while its drafts are clean (realtime-sync.md -> editable-
      // draft rule) - it used to carry its own listener for exactly this.
      return [`skills:${workspaceId}`, `brain-skill:${workspaceId}:`];
    case LIVE_REFRESH_EVENT:
      // The `session` primitive is the session-lifecycle signal (a thread
      // created, retitled, or settled anywhere in the workspace), so it feeds
      // the Chat rail's two lists as well as the Live roster - the spine gap
      // report E named ("a `session` fan-out to chat").
      return [
        `live:${workspaceId}`,
        `chat-sessions:${workspaceId}`,
        `chat-shared:${workspaceId}`,
        `feed-collaboration:${workspaceId}`,
      ];
    case INBOX_REFRESH_EVENT:
      return [`inbox:${workspaceId}`];
    case HOME_APPS_REFRESH_EVENT:
      // `home-app-session:<wid>:` is the family of per-app sessions the
      // custom-app frame paints from (entry URL, renderable state, bridge
      // token). A re-sync or a status change moves `renderable`, so the open
      // frame revalidates behind its paint instead of showing a stale
      // "needs consent" or a dead entry URL until its token timer fires.
      return [`home-apps:${workspaceId}`, `home-app-session:${workspaceId}:`, `association-module:${workspaceId}`];
    case GOAL_REFRESH_EVENT:
      // The `goal` primitive: the goals board (`goals:<wid>:<viewer>:<status>`),
      // the Triage panel (`triage:<wid>:<viewer>`) and every goal detail
      // (`goal:<wid>:<viewer>:<goalId>`, the panels' detail panes and the
      // full page). The panels used to rely on a local refetch tick only
      // the acting tab could bump; the same-tab `requestGoalRefresh` now
      // lands here too, so one path serves both legs.
      return [`goals:${workspaceId}`, `triage:${workspaceId}`, `goal:${workspaceId}:`, `feed-collaboration:${workspaceId}`];
    default:
      return [];
  }
}

/** Every domain event the map listens to. */
export const SURFACE_CACHE_SPINE_EVENTS: readonly string[] = [
  BRAIN_REFRESH_EVENT,
  APPROVALS_REFRESH_EVENT,
  WORKFLOW_REFRESH_EVENT,
  ASSISTANT_REFRESH_EVENT,
  SKILL_REFRESH_EVENT,
  LIVE_REFRESH_EVENT,
  SCHEDULED_JOB_REFRESH_EVENT,
  INBOX_REFRESH_EVENT,
  HOME_APPS_REFRESH_EVENT,
  GOAL_REFRESH_EVENT,
  WORKSPACE_IDENTITY_REFRESH_EVENT,
];

/**
 * Apply one domain event to the cache: mark every prefix the event feeds.
 * Exported for the listener and for tests; an event whose detail names a
 * DIFFERENT workspace is ignored (a `null` / absent workspace id is the
 * catch-up shape and applies).
 */
export function applySpineEventToSurfaceCache(
  event: string,
  detail: { workspaceId?: string | null } | null | undefined,
  workspaceId: string,
): void {
  if (detail?.workspaceId && detail.workspaceId !== workspaceId) return;
  if (event === BRAIN_REFRESH_EVENT) invalidateSurfaceCache(`doc-media:${workspaceId}:`);
  if (event === WORKSPACE_IDENTITY_REFRESH_EVENT) {
    // Authority changes purge even an unmounted directory/access surface.
    invalidateSurfaceCache(`organization:${workspaceId}:`);
    invalidateSurfaceCache(`workspace-access:${workspaceId}:`);
    invalidateSurfaceCache(`scope-review:${workspaceId}:`);
    invalidateSurfaceCache(`approvals:${workspaceId}`);
    invalidateSurfaceCache(`doc-media:${workspaceId}:`);
  }
  for (const prefix of staleMarksFor(event, workspaceId)) {
    markSurfaceCacheStale(prefix);
  }
}

/**
 * React hook - mounted ONCE in `WorkspaceChrome` beside `useWorkspaceEvents`.
 * Surfaces need no listener of their own to stay live: they read the cache,
 * and the cache goes stale here.
 */
export function useSurfaceCacheInvalidation(
  workspaceId: string | null | undefined,
): void {
  useEffect(() => {
    if (!workspaceId || typeof window === "undefined") return;
    const handlers = SURFACE_CACHE_SPINE_EVENTS.map((event) => {
      const handler = (e: Event) => {
        applySpineEventToSurfaceCache(
          event,
          (e as CustomEvent<{ workspaceId?: string | null }>).detail,
          workspaceId,
        );
      };
      window.addEventListener(event, handler);
      return [event, handler] as const;
    });
    return () => {
      for (const [event, handler] of handlers) {
        window.removeEventListener(event, handler);
      }
    };
  }, [workspaceId]);
}
