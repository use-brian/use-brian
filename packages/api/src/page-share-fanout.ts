/**
 * In-memory per-page fanout for doc page-share changes (Phase 3 SSE).
 *
 * The grant routes publish on create/update/revoke; the anonymous
 * `/public/pages/:token/stream` SSE endpoint subscribes and pushes a signal
 * so a shared page reacts live (e.g. a revoke removes access without waiting
 * for a poll). Signals are contentless — the client re-fetches the page.
 *
 * NOTE (§13 D7): this is **instance-local** — it only fans out within one
 * process. The user API is autoscaling, and page *content* edits land in the
 * separate doc-sync process, so the SSE endpoint also emits a periodic
 * "tick" the client treats as "re-fetch" (SSE-driven refresh). Multi-instance
 * grant-change fanout would need a Redis backplane (a later scaling item).
 *
 * [COMP:api/page-share-fanout]
 */

type Handler = () => void

const subscribers = new Map<string, Set<Handler>>()

/** Notify every live subscriber of a page that its grants changed. */
export function publishPageShareChange(pageId: string): void {
  const subs = subscribers.get(pageId)
  if (!subs) return
  for (const h of subs) {
    try {
      h()
    } catch {
      // a slow/broken subscriber must never break the publish loop
    }
  }
}

/** Subscribe to a page's grant changes. Returns an unsubscribe fn. */
export function subscribeToPageShareChanges(pageId: string, handler: Handler): () => void {
  let set = subscribers.get(pageId)
  if (!set) {
    set = new Set()
    subscribers.set(pageId, set)
  }
  set.add(handler)
  return () => {
    const s = subscribers.get(pageId)
    if (!s) return
    s.delete(handler)
    if (s.size === 0) subscribers.delete(pageId)
  }
}
