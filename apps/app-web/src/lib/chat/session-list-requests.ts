/**
 * One in-flight session-list request per distinct query in this renderer.
 *
 * Every `GET /api/sessions` list response waits on server-side title
 * admission, so overlapping copies of one query (the page, the sidebar panel,
 * each dock instance, a cache key that changed with the viewer id) multiply
 * that work (M5Q-10). Callers of the same URL share one request and one parsed
 * body. A caller's abort detaches only that caller; the request itself is
 * aborted once no caller is still waiting, so an unmounted host or a changed
 * query stops costing the server.
 *
 * Contract: docs/architecture/features/chat-app.md → "Listing" (one list
 * request per distinct query). [COMP:app-web/session-list-requests]
 */
import { authFetch, getAccessToken } from "@/lib/auth-fetch";
import { captureChatListRead, type ChatListRead } from "@/lib/offline/chat-history-cache";

export type SessionListResponse = {
  ok: boolean;
  status: number;
  /** Parsed JSON body of a successful response; `undefined` otherwise. */
  data: unknown;
  /** The actual shared transport start, rather than a later joining caller. */
  authorityRead?: ChatListRead | null;
};

type Fetcher = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

type Shared = {
  promise: Promise<SessionListResponse>;
  controller: AbortController;
  waiting: number;
};

const inflight = new Map<string, Shared>();
/** Per URL: callers that asked, and requests actually sent (diagnostics). */
const stats = new Map<string, { callers: number; requests: number }>();
const count = (url: string, field: "callers" | "requests") => {
  const row = stats.get(url) ?? { callers: 0, requests: 0 };
  row[field]++;
  stats.delete(url);
  stats.set(url, row);
  if (stats.size > 200) stats.delete(stats.keys().next().value!);
};
let fetcher: Fetcher = (url, init) => authFetch(url, init);

function abortError(): Error {
  return typeof DOMException === "function"
    ? new DOMException("The session list request was aborted.", "AbortError")
    : Object.assign(new Error("The session list request was aborted."), { name: "AbortError" });
}

/** Join (or start) the request for `url`; `signal` detaches this caller only. */
export function requestSessionList(url: string, signal?: AbortSignal): Promise<SessionListResponse> {
  if (signal?.aborted) return Promise.reject(abortError());
  count(url, "callers");
  // An account switch must never join the previous account's authenticated
  // request. The key remains private; diagnostics expose URLs only.
  let authentication = "";
  try { authentication = getAccessToken() ?? ""; } catch { /* unavailable auth source */ }
  const requestKey = `${url}\0${authentication}`;
  let entry = inflight.get(requestKey);
  if (!entry) {
    count(url, "requests");
    const controller = new AbortController();
    const workspaceId = new URL(url, "http://localhost").searchParams.get("workspaceId");
    const promise = (async () => {
      const authorityRead = workspaceId ? await captureChatListRead(workspaceId) : null;
      if (controller.signal.aborted) throw abortError();
      const response = await fetcher(url, { signal: controller.signal });
      return { ok: response.ok, status: response.status,
        data: response.ok ? await response.json().catch(() => undefined) : undefined,
        ...(authorityRead ? { authorityRead } : {}) };
    })();
    const created: Shared = { promise, controller, waiting: 0 };
    const clear = () => { if (inflight.get(requestKey) === created) inflight.delete(requestKey); };
    promise.then(clear, clear);
    inflight.set(requestKey, created);
    entry = created;
  }
  const shared = entry;
  shared.waiting++;
  return new Promise<SessionListResponse>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      settled = true;
      shared.waiting--;
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      finish();
      // The last waiting caller left: stop the request instead of letting the
      // server finish title admission for nobody.
      if (shared.waiting === 0 && inflight.get(requestKey) === shared) {
        inflight.delete(requestKey);
        shared.controller.abort();
      }
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    shared.promise.then(
      (value) => { if (settled) return; finish(); resolve(value); },
      (error: unknown) => { if (settled) return; finish(); reject(error); },
    );
  });
}

/** Callers and sent requests per URL since the last reset (tests and diagnostics). */
export function sessionListRequestStats(): ReadonlyMap<string, { callers: number; requests: number }> {
  return new Map([...stats].map(([url, row]) => [url, { ...row }]));
}

/** Requests currently in flight (tests and diagnostics). */
export function sessionListRequestsInFlight(): number {
  return inflight.size;
}

/** Test seam: route requests through a fake transport; returns the restore. */
export function setSessionListFetcherForTest(next: Fetcher): () => void {
  const previous = fetcher;
  fetcher = next;
  inflight.clear();
  stats.clear();
  return () => { fetcher = previous; inflight.clear(); stats.clear(); };
}
