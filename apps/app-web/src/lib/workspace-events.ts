/**
 * Workspace realtime events client — ONE EventSource per workspace tab.
 *
 * Generalizes the brain-page-scoped `useBrainStream` (now retired) to the
 * whole authenticated shell: `WorkspaceChrome` mounts `useWorkspaceEvents`
 * once per workspace, and every `brain-change` payload from
 * `GET /api/brain/stream` (the wire path is unchanged — see
 * docs/architecture/platform/realtime-sync.md) is routed BY PRIMITIVE to a
 * per-domain window CustomEvent. Surfaces keep their existing idiom: listen
 * for their domain event, refetch through their authed loader. Payloads are
 * signals, never data.
 *
 * Routing table:
 *   memory/task/contact/company/deal/file/entity/edge/kb_chunk
 *     → BRAIN_REFRESH_EVENT   (unchanged — the brain page + sidebar panel
 *                              already listen; they never see non-brain noise)
 *   approval        → APPROVALS_REFRESH_EVENT (the same-tab bus gains a server leg)
 *   workflow, workflow_run → WORKFLOW_REFRESH_EVENT (detail carries primitive + rowId)
 *   skill           → SKILL_REFRESH_EVENT
 *   scheduled_job   → SCHEDULED_JOB_REFRESH_EVENT (no consumer yet — P2 surfaces)
 *   assistant       → ASSISTANT_REFRESH_EVENT (the roster surfaces in chrome:
 *                     WorkspaceChrome's default interlocutor + the FloatingChat
 *                     switcher, both of which live in the never-unmounting
 *                     workspace layout and so cannot self-heal on navigation)
 *   workspace_config → HOME_APPS_REFRESH_EVENT +
 *                     WORKSPACE_IDENTITY_REFRESH_EVENT (Home app-bar plus the
 *                     workspace name/icon in persistent chrome)
 *   inbox           → INBOX_REFRESH_EVENT (InboxPanel + the sidebar unread
 *                     badge, same never-unmounting-layout reasoning as
 *                     `assistant` above — docs/plans/room-human-mentions.md T-H8)
 *
 * Catch-up without replay: on every EventSource `open` (first connect AND
 * each auto-reconnect) and on `visibilitychange → visible`, all domain
 * events fire once so surfaces refetch anything missed while the stream was
 * down or the tab was asleep. A leading+trailing fold (CLIENT_FOLD_MS per
 * event name) keeps bursts and catch-up collisions to one refetch per
 * domain; the server already coalesces per (workspace, primitive) at 2s.
 *
 * Absolute URLs from NEXT_PUBLIC_API_URL when it is set (prod, desktop —
 * so the desktop bundle's file:// origin can't produce an unfetchable URL,
 * same footgun feed-sse.ts documents). `window.location.origin` serves ONLY
 * as the `new URL` base for next-dev, where next.config deliberately blanks
 * NEXT_PUBLIC_API_URL to "" so requests ride the /api rewrite — without the
 * base, `new URL("/api/…")` throws in dev. Auth rides `?access_token=`
 * because EventSource cannot set headers.
 *
 * The routing + fold cores are IO-free (no DOM) so app-web's vitest can
 * exercise them directly, mirroring build-events.ts.
 *
 * [COMP:app-web/workspace-events]
 */

import { useEffect } from "react";

import { getValidAccessToken } from "@/lib/auth-fetch";
import { usesGatewayCredentials } from "@/lib/desktop-auth-source";
import {
  BRAIN_REFRESH_EVENT,
  type BrainRefreshDetail,
} from "@/lib/brain-events";
import {
  APPROVALS_REFRESH_EVENT,
  type ApprovalsRefreshDetail,
} from "@/lib/approvals-events";
import {
  WORKFLOW_REFRESH_EVENT,
  type WorkflowRefreshDetail,
} from "@/lib/workflow-events";
import {
  ASSISTANT_REFRESH_EVENT,
  type AssistantRefreshDetail,
} from "@/lib/assistant-events";
import {
  HOME_APPS_REFRESH_EVENT,
  type HomeAppsRefreshDetail,
} from "@/lib/home-apps-events";
import {
  WORKSPACE_IDENTITY_REFRESH_EVENT,
  type WorkspaceIdentityRefreshDetail,
} from "@/lib/workspace-identity-events";
import {
  INBOX_REFRESH_EVENT,
  type InboxRefreshDetail,
} from "@/lib/inbox-refresh-events";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/** Mirrors the server's WorkspacePrimitive union (brain-stream/sse-fanout.ts). */
type WorkspacePrimitive =
  | "memory"
  | "task"
  | "contact"
  | "company"
  | "deal"
  | "file"
  | "entity"
  | "edge"
  | "kb_chunk"
  | "workflow"
  | "workflow_run"
  | "approval"
  | "skill"
  | "scheduled_job"
  | "assistant"
  | "workspace_config"
  | "inbox"
  | "session";

export type WorkspaceChangePayload = {
  workspaceId: string;
  primitive: WorkspacePrimitive;
  rowId?: string;
  action: "create" | "update" | "delete";
};

export const SKILL_REFRESH_EVENT = "sidan:skill-refresh";
export const SCHEDULED_JOB_REFRESH_EVENT = "sidan:scheduled-job-refresh";
/**
 * The `session` primitive's domain event (Live roster —
 * docs/architecture/features/live-work.md §4). The Live page refetches its
 * tiered roster on it; the signal carries the session rowId and nothing
 * else, so it can never leak content past a tier.
 */
export const LIVE_REFRESH_EVENT = "sidan:live-refresh";

export type SkillRefreshDetail = {
  workspaceId: string | null;
  rowId?: string;
};

export type LiveRefreshDetail = {
  workspaceId: string;
  rowId?: string;
};

const BRAIN_PRIMITIVES: ReadonlySet<WorkspacePrimitive> = new Set([
  "memory",
  "task",
  "contact",
  "company",
  "deal",
  "file",
  "entity",
  "edge",
  "kb_chunk",
]);

export type DomainDispatch = {
  event: string;
  detail: Record<string, unknown>;
};

/**
 * Pure routing core: payload → the domain CustomEvent(s) to dispatch.
 * Unknown primitives return [] — a NEWER server vocabulary must never break
 * an older client (additive-widening contract).
 */
export function routeWorkspaceChange(
  payload: WorkspaceChangePayload,
): DomainDispatch[] {
  if (BRAIN_PRIMITIVES.has(payload.primitive)) {
    return [
      {
        event: BRAIN_REFRESH_EVENT,
        detail: { workspaceId: payload.workspaceId } satisfies BrainRefreshDetail,
      },
    ];
  }
  switch (payload.primitive) {
    case "approval":
      return [
        {
          event: APPROVALS_REFRESH_EVENT,
          detail: {
            workspaceId: payload.workspaceId,
          } satisfies ApprovalsRefreshDetail,
        },
      ];
    case "workflow":
    case "workflow_run":
      return [
        {
          event: WORKFLOW_REFRESH_EVENT,
          detail: {
            workspaceId: payload.workspaceId,
            primitive: payload.primitive,
            rowId: payload.rowId,
          } satisfies WorkflowRefreshDetail,
        },
      ];
    case "skill":
      return [
        {
          event: SKILL_REFRESH_EVENT,
          detail: {
            workspaceId: payload.workspaceId,
            rowId: payload.rowId,
          } satisfies SkillRefreshDetail,
        },
      ];
    case "scheduled_job":
      return [
        {
          event: SCHEDULED_JOB_REFRESH_EVENT,
          detail: { workspaceId: payload.workspaceId, rowId: payload.rowId },
        },
      ];
    case "assistant":
      return [
        {
          event: ASSISTANT_REFRESH_EVENT,
          detail: {
            workspaceId: payload.workspaceId,
            rowId: payload.rowId,
          } satisfies AssistantRefreshDetail,
        },
      ];
    case "workspace_config":
      return [
        {
          event: HOME_APPS_REFRESH_EVENT,
          detail: {
            workspaceId: payload.workspaceId,
          } satisfies HomeAppsRefreshDetail,
        },
        {
          event: WORKSPACE_IDENTITY_REFRESH_EVENT,
          detail: {
            workspaceId: payload.workspaceId,
          } satisfies WorkspaceIdentityRefreshDetail,
        },
      ];
    case "inbox":
      return [
        {
          event: INBOX_REFRESH_EVENT,
          detail: {
            workspaceId: payload.workspaceId,
          } satisfies InboxRefreshDetail,
        },
      ];
    case "session":
      return [
        {
          event: LIVE_REFRESH_EVENT,
          detail: {
            workspaceId: payload.workspaceId,
            rowId: payload.rowId,
          } satisfies LiveRefreshDetail,
        },
      ];
    default:
      return [];
  }
}

/** Every domain event, for catch-up after a reconnect / tab wake. */
export function allDomainDispatches(workspaceId: string): DomainDispatch[] {
  return [
    { event: BRAIN_REFRESH_EVENT, detail: { workspaceId } },
    { event: APPROVALS_REFRESH_EVENT, detail: { workspaceId } },
    { event: WORKFLOW_REFRESH_EVENT, detail: { workspaceId, primitive: null } },
    { event: SKILL_REFRESH_EVENT, detail: { workspaceId } },
    { event: SCHEDULED_JOB_REFRESH_EVENT, detail: { workspaceId } },
    { event: ASSISTANT_REFRESH_EVENT, detail: { workspaceId } },
    { event: HOME_APPS_REFRESH_EVENT, detail: { workspaceId } },
    { event: WORKSPACE_IDENTITY_REFRESH_EVENT, detail: { workspaceId } },
    { event: INBOX_REFRESH_EVENT, detail: { workspaceId } },
    { event: LIVE_REFRESH_EVENT, detail: { workspaceId } },
  ];
}

const CLIENT_FOLD_MS = 300;

/**
 * Leading+trailing fold, keyed by string: the first fire for a key emits
 * immediately; further fires inside the window collapse into one trailing
 * emit. IO-free — the caller supplies the emit + clock hooks so tests can
 * drive it deterministically.
 */
export function createRefreshFolder(opts: {
  windowMs?: number;
  emit: (dispatch: DomainDispatch) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): { fold: (dispatch: DomainDispatch) => void; dispose: () => void } {
  const windowMs = opts.windowMs ?? CLIENT_FOLD_MS;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const slots = new Map<string, { handle: unknown; pending: DomainDispatch | null }>();

  return {
    fold(dispatch: DomainDispatch) {
      const slot = slots.get(dispatch.event);
      if (slot) {
        slot.pending = dispatch;
        return;
      }
      const handle = setTimer(() => {
        const s = slots.get(dispatch.event);
        slots.delete(dispatch.event);
        if (s?.pending) opts.emit(s.pending);
      }, windowMs);
      slots.set(dispatch.event, { handle, pending: null });
      opts.emit(dispatch);
    },
    dispose() {
      for (const slot of slots.values()) clearTimer(slot.handle);
      slots.clear();
    },
  };
}

type WorkspaceStreamHandle = {
  close: () => void;
};

/**
 * How long a tab stays hidden before its stream is released. Long enough
 * that flipping between tabs never drops the connection; short enough that
 * a backgrounded tab stops holding a server slot within a minute.
 */
const HIDDEN_RELEASE_MS = 60_000;

/**
 * Visibility-driven connect/release gate for the workspace stream. IO-free —
 * the caller supplies connect/disconnect + timer hooks (mirroring
 * `createRefreshFolder`) so tests can drive it deterministically.
 *
 * Why release at all: every open EventSource holds one of the API's
 * per-instance request slots for as long as it lives, and a hidden tab needs
 * no realtime signal — the reconnect catch-up on `open` (and the
 * visibilitychange catch-up in the hook) makes release lossless. Restored
 * browser sessions were holding one stream per background tab and saturated
 * the instance's slot budget (2026-08-27 outage).
 */
export function createVisibilityGate(opts: {
  graceMs?: number;
  connect: () => void;
  disconnect: () => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): { onVisibility: (state: "visible" | "hidden") => void; dispose: () => void } {
  const graceMs = opts.graceMs ?? HIDDEN_RELEASE_MS;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let pending: unknown = null;

  return {
    onVisibility(state) {
      if (state === "hidden") {
        pending ??= setTimer(() => {
          pending = null;
          opts.disconnect();
        }, graceMs);
      } else {
        if (pending !== null) {
          clearTimer(pending);
          pending = null;
        }
        opts.connect();
      }
    },
    dispose() {
      if (pending !== null) {
        clearTimer(pending);
        pending = null;
      }
    },
  };
}

/**
 * Delay before a manual reconnect after a FATAL EventSource close (non-200
 * reconnect response: expired token, 429 shed, 5xx mid-deploy). Exponential
 * 1s→30s with full jitter so a fleet of tabs stranded by the same outage
 * does not retry in lockstep. Exported for the unit test only.
 */
export function reconnectDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const base = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
  return Math.round(base / 2 + random() * (base / 2));
}

/**
 * Open the workspace stream and route every change to its domain event.
 * Transient transport errors ride the browser's own reconnect; a FATAL
 * close (non-200 on reconnect — per spec the browser gives up: readyState
 * CLOSED, no retry) is healed by the `error` listener with a backoff
 * reconnect, or the tab would silently lose realtime until a full reload.
 * Each `open` fires the catch-up dispatches. Module-local: the hook below
 * is the only consumer (re-export it if a non-React shell ever needs to
 * drive it directly).
 */
function openWorkspaceStream(opts: {
  workspaceId: string;
  onDispatch: (dispatch: DomainDispatch) => void;
}): WorkspaceStreamHandle {
  let closed = false;
  let source: EventSource | null = null;
  let connecting = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryAttempt = 0;

  async function connect() {
    if (closed || source || connecting) return;
    // Long-lived non-fetch consumer: refresh BEFORE each (re)connect, same
    // rule as the collab WebSocket (auth-fetch.ts → getValidAccessToken) —
    // a tab older than the 1h access token would otherwise present a dead
    // token on every cycle reconnect and fatally 401. The latch resets in
    // `finally`: a throw here must not wedge connect() forever.
    connecting = true;
    let token: string | null;
    try {
      token = await getValidAccessToken();
    } catch {
      // Transient refresh failure — retry with backoff rather than wedging
      // (callers are fire-and-forget, so a throw would be unhandled).
      scheduleReconnect();
      return;
    } finally {
      connecting = false;
    }
    if (closed || source) return;
    if (document.visibilityState === "hidden") return; // released mid-await; the gate reconnects on visible
    // Base is only consulted when API_URL is dev's blanked "" (next.config
    // inlines "" so fetches ride the /api rewrite); an absolute API_URL
    // (prod, desktop bundle) ignores it, so file:// can't leak in.
    const url = new URL(`${API_URL}/api/brain/stream`, window.location.origin);
    url.searchParams.set("workspaceId", opts.workspaceId);
    // Brian auth rides the URL token. A local Electron target additionally
    // includes credentials so a separately hosted API receives its deployment-
    // gateway cookie; the API permits credentials only for allowlisted origins.
    if (token) url.searchParams.set("access_token", token);
    const es = new EventSource(url.toString(), {
      withCredentials: usesGatewayCredentials(),
    });
    source = es;

    es.addEventListener("open", () => {
      retryAttempt = 0;
      // First connect AND every auto-reconnect: refetch what we missed.
      for (const d of allDomainDispatches(opts.workspaceId)) opts.onDispatch(d);
    });

    es.addEventListener("brain-change", (ev) => {
      try {
        const data = JSON.parse(
          (ev as MessageEvent).data,
        ) as WorkspaceChangePayload;
        for (const d of routeWorkspaceChange(data)) opts.onDispatch(d);
      } catch {
        // Malformed payload — skip silently. The next event will land.
      }
    });

    es.addEventListener("error", () => {
      // Transient drops (and the server's `: cycle` lifetime end) leave
      // readyState CONNECTING and the browser retries by itself. A non-200
      // reconnect response is FATAL per spec — readyState CLOSED, no
      // retry — so without this handler the tab silently stops updating
      // until a full reload.
      if (closed || source !== es || es.readyState !== EventSource.CLOSED)
        return;
      disconnect();
      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    if (closed || retryTimer !== null) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      // Hidden: stay released; the visibility gate reconnects on visible.
      if (document.visibilityState !== "hidden") void connect();
    }, reconnectDelayMs(retryAttempt++));
  }

  function disconnect() {
    source?.close();
    source = null;
  }

  const gate = createVisibilityGate({ connect: () => void connect(), disconnect });
  const onVisibilityChange = () => {
    if (closed) return;
    gate.onVisibility(document.visibilityState === "hidden" ? "hidden" : "visible");
  };
  document.addEventListener("visibilitychange", onVisibilityChange);

  // Connect only when visible. A restored session's background tabs must
  // not each hold a server request slot even for the grace window — they
  // connect on first focus, and the reconnect `open` catch-up (plus the
  // hook's own visibility catch-up) repaints them.
  if (document.visibilityState !== "hidden") void connect();

  return {
    close: () => {
      closed = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      gate.dispose();
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      disconnect();
    },
  };
}

/**
 * React hook — mounted ONCE in `WorkspaceChrome` (the persistent shell), so
 * there is exactly one workspace EventSource per tab regardless of which
 * surface is open. Tears down on unmount or workspace switch.
 */
export function useWorkspaceEvents(
  workspaceId: string | null | undefined,
): void {
  useEffect(() => {
    if (!workspaceId || typeof window === "undefined") return;

    const folder = createRefreshFolder({
      emit: (d) => window.dispatchEvent(new CustomEvent(d.event, { detail: d.detail })),
    });
    const handle = openWorkspaceStream({
      workspaceId,
      onDispatch: folder.fold,
    });

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      for (const d of allDomainDispatches(workspaceId)) folder.fold(d);
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      handle.close();
      folder.dispose();
    };
  }, [workspaceId]);
}
