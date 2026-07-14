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

import { getAccessToken } from "@/lib/auth-fetch";
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
import { DECK_REFRESH_EVENT, type DeckRefreshDetail } from "@/lib/deck-events";

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
  | "deck";

export type WorkspaceChangePayload = {
  workspaceId: string;
  primitive: WorkspacePrimitive;
  rowId?: string;
  action: "create" | "update" | "delete";
};

export const SKILL_REFRESH_EVENT = "sidan:skill-refresh";
export const SCHEDULED_JOB_REFRESH_EVENT = "sidan:scheduled-job-refresh";

type SkillRefreshDetail = {
  workspaceId: string | null;
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
    case "deck":
      return [
        {
          event: DECK_REFRESH_EVENT,
          detail: {
            workspaceId: payload.workspaceId,
            rowId: payload.rowId,
          } satisfies DeckRefreshDetail,
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
    { event: DECK_REFRESH_EVENT, detail: { workspaceId } },
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
 * Open the workspace stream and route every change to its domain event.
 * EventSource auto-reconnects on transport errors; each `open` fires the
 * catch-up dispatches. Module-local: the hook below is the only consumer
 * (re-export it if a non-React shell ever needs to drive it directly).
 */
function openWorkspaceStream(opts: {
  workspaceId: string;
  onDispatch: (dispatch: DomainDispatch) => void;
}): WorkspaceStreamHandle {
  let closed = false;
  let source: EventSource | null = null;

  function connect() {
    if (closed) return;
    // Base is only consulted when API_URL is dev's blanked "" (next.config
    // inlines "" so fetches ride the /api rewrite); an absolute API_URL
    // (prod, desktop bundle) ignores it, so file:// can't leak in.
    const url = new URL(`${API_URL}/api/brain/stream`, window.location.origin);
    url.searchParams.set("workspaceId", opts.workspaceId);
    // EventSource cannot set custom headers — the SSE route accepts both
    // `Authorization: Bearer` and `?access_token=`.
    const token = getAccessToken();
    if (token) url.searchParams.set("access_token", token);
    source = new EventSource(url.toString(), { withCredentials: true });

    source.addEventListener("open", () => {
      // First connect AND every auto-reconnect: refetch what we missed.
      for (const d of allDomainDispatches(opts.workspaceId)) opts.onDispatch(d);
    });

    source.addEventListener("brain-change", (ev) => {
      try {
        const data = JSON.parse(
          (ev as MessageEvent).data,
        ) as WorkspaceChangePayload;
        for (const d of routeWorkspaceChange(data)) opts.onDispatch(d);
      } catch {
        // Malformed payload — skip silently. The next event will land.
      }
    });
    // Transport errors: trust the browser's reconnect + backoff; the next
    // `open` runs catch-up, so nothing is permanently missed.
  }

  connect();

  return {
    close: () => {
      closed = true;
      source?.close();
      source = null;
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
