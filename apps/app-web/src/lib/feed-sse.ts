/**
 * Browser-side EventSource wrapper for the feed inbox SSE stream
 * (`GET /api/distribution/t/:workspaceId/events` — mounted public server-side
 * because EventSource can't send auth headers; auth rides `?access_token=`).
 *
 * Ported from `apps/feed-web/src/lib/feed-sse.ts`
 * (docs/plans/feed-web-consolidation.md §4). Two extras over bare EventSource:
 *   1. `lastEventId` tracking so a reconnect resumes from the last processed
 *      row instead of replaying the whole initial window.
 *   2. Absolute URL building against `NEXT_PUBLIC_API_URL` when set (prod,
 *      desktop — so the desktop bundle's `file://` origin can't produce an
 *      unfetchable URL). `window.location.origin` is passed ONLY as the
 *      `new URL` base for next-dev, where the env is deliberately blanked
 *      to "" so the stream rides the /api rewrite; an absolute API_URL
 *      ignores the base.
 *
 * [COMP:app-web/feed-sse]
 */

import { getAccessToken } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type FeedEventRow = {
  id: string;
  assistantId: string;
  workspaceId: string | null;
  platform: string;
  platformPostId: string | null;
  platformReplyId: string | null;
  entityId: string | null;
  eventType: string;
  layer: string | null;
  decision: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

export type FeedSseHandle = {
  close: () => void;
};

export function openFeedStream(opts: {
  workspaceId: string;
  onEvent: (event: FeedEventRow) => void;
  onError?: (err: Event) => void;
  /** Optional bookmark to resume from. Defaults to "last 1h" on the server. */
  initialLastEventId?: string;
}): FeedSseHandle {
  let closed = false;
  let lastEventId: string | undefined = opts.initialLastEventId;
  let source: EventSource | null = null;

  function connect() {
    if (closed) return;
    // Base is only consulted when API_URL is dev's blanked "" (next.config
    // inlines "" so fetches ride the /api rewrite); an absolute API_URL
    // (prod, desktop bundle) ignores it, so file:// can't leak in. Guard the
    // `window` read so the module is safe under SSR / node (tests) where an
    // absolute API_URL makes the base irrelevant anyway.
    const base =
      typeof window !== "undefined" ? window.location.origin : undefined;
    const url = new URL(
      `${API_URL}/api/distribution/t/${opts.workspaceId}/events`,
      base,
    );
    if (lastEventId) url.searchParams.set("lastEventId", lastEventId);
    // EventSource can't set headers — pass the access_token as a query
    // param. The SSE route accepts both Bearer and `?access_token=`. Auth
    // rides the URL token, NOT cookies, so this MUST NOT set
    // `withCredentials: true`: a credentialed cross-origin EventSource needs
    // the server to answer `Access-Control-Allow-Credentials: true` (the API
    // does not), and without it the browser rejects every connection before
    // `open` and retries forever — a reconnect storm that silently kills the
    // stream. See workspace-events.ts for the same fix + rationale.
    const token = getAccessToken();
    if (token) url.searchParams.set("access_token", token);
    source = new EventSource(url.toString());

    source.addEventListener("feed-event", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as FeedEventRow;
        lastEventId = data.id;
        opts.onEvent(data);
      } catch {
        // Malformed payload — skip silently. The next event will land.
      }
    });

    source.onerror = (err) => {
      // EventSource auto-reconnects; we just surface the error so the UI
      // can reflect a degraded state. We do NOT manually close+reopen
      // unless the server returned 401/403/404 — but EventSource hides
      // the status, so we trust the browser's reconnect with backoff.
      opts.onError?.(err);
    };
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
