/**
 * Brain realtime stream client (app-web) — opens an EventSource against
 * `/api/brain/stream?workspaceId&access_token` and dispatches the existing
 * `BRAIN_REFRESH_EVENT` for every `brain-change` event. The brain page
 * already listens for that event and bumps its refresh tick, so the rest
 * of the wiring is unchanged from the same-tab path.
 *
 * Ported verbatim from `apps/web/src/lib/brain-stream.ts` as part of the
 * brain surface migration (docs/plans/doc-web-app-consolidation.md
 * §5a). app-web's `auth-fetch.ts` already exports `getAccessToken`, so
 * the EventSource `?access_token=` fallback works the same as in apps/web
 * (live cross-process brain updates are fully ported, not degraded).
 *
 * Spec: docs/architecture/brain/realtime-stream.md.
 *
 * [COMP:app-web/brain-stream]
 */

import { useEffect } from "react";

import { getAccessToken } from "@/lib/auth-fetch";
import {
  BRAIN_REFRESH_EVENT,
  type BrainRefreshDetail,
} from "@/lib/brain-events";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type BrainChangePayload = {
  workspaceId: string;
  primitive:
    | "memory"
    | "task"
    | "contact"
    | "company"
    | "deal"
    | "file"
    | "entity"
    | "edge"
    | "kb_chunk";
  rowId?: string;
  action: "create" | "update" | "delete";
};

export type BrainStreamHandle = {
  close: () => void;
};

export function openBrainStream(opts: {
  workspaceId: string;
  onChange?: (payload: BrainChangePayload) => void;
}): BrainStreamHandle {
  let closed = false;
  let source: EventSource | null = null;

  function connect() {
    if (closed) return;
    const url = new URL(`${API_URL}/api/brain/stream`, window.location.origin);
    url.searchParams.set("workspaceId", opts.workspaceId);
    // EventSource cannot set custom headers — the SSE route accepts both
    // `Authorization: Bearer` and `?access_token=`.
    const token = getAccessToken();
    if (token) url.searchParams.set("access_token", token);
    source = new EventSource(url.toString(), { withCredentials: true });

    source.addEventListener("brain-change", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as BrainChangePayload;
        opts.onChange?.(data);
        // Bridge to the existing same-tab refresh signal so /brain
        // (which already listens for it from chat-driven writes)
        // redraws without bespoke wiring per consumer.
        window.dispatchEvent(
          new CustomEvent<BrainRefreshDetail>(BRAIN_REFRESH_EVENT, {
            detail: { workspaceId: data.workspaceId },
          }),
        );
      } catch {
        // Malformed payload — skip silently. The next event will land.
      }
    });

    // EventSource auto-reconnects on transport error; trusting the
    // browser's backoff. A persistent auth failure (token expired
    // mid-stream) will manifest as ongoing 401s, which the user
    // resolves by reloading.
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
 * React hook — opens the brain stream for the given workspace and tears it
 * down on unmount or workspace switch. The on-change callback is optional;
 * the hook always dispatches `BRAIN_REFRESH_EVENT` so the brain page
 * picks it up via its existing listener.
 */
export function useBrainStream(
  workspaceId: string | null | undefined,
  onChange?: (payload: BrainChangePayload) => void,
): void {
  useEffect(() => {
    if (!workspaceId) return;
    const handle = openBrainStream({ workspaceId, onChange });
    return () => handle.close();
    // onChange intentionally excluded from deps — the hook treats it as a
    // ref-stable callback (consumers should memoize if needed). Including
    // it would tear down and rebuild EventSource every render in pages
    // that pass a fresh closure each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);
}
