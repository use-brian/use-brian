// REBRAND-CUTOVER: this file contains sidan.ai runtime values that must flip to usebrian.ai when DNS + Vercel domains + OAuth consoles + webhooks are cut over. Grep REBRAND-CUTOVER.
/**
 * `DocGateway` implementation — the API-side bridge that lets the
 * server-side AI page tools write to the *live* collaborative Y.Doc.
 *
 * The AI's `patchPage` ops are POSTed to `apps/doc-sync`'s secret-gated
 * `/internal/apply` endpoint; the sync service opens a direct connection to
 * the authoritative in-memory doc, applies the ops via
 * `@use-brian/doc-model` `applyOpsToYDoc`, broadcasts the update to every
 * connected human tab, and persists the debounced snapshot. This is what
 * keeps the AI and human writers on ONE document instead of the AI writing
 * a frozen `saved_views.page` the editor never reads.
 *
 * In production the sync URL defaults to the convention host
 * (`doc-sync.sidan.ai`), so `DOC_SYNC_SECRET` is the only env that must
 * be set there. Returns `undefined` when the secret is absent (or, outside
 * production, when no URL is configured), so `patchPage` falls back to the
 * legacy CAS path and local dev / tests / smoke keep working.
 *
 * [COMP:api/doc-model-gateway]
 */

import type { DocGateway, Page } from '@use-brian/core'

export type DocGatewayOptions = {
  /** ws(s):// sync URL; the internal HTTP endpoint is the http(s) twin. */
  syncUrl?: string
  syncSecret?: string
  /** Injectable for tests. */
  fetchImpl?: typeof fetch
  /** Per-request timeout (ms). */
  timeoutMs?: number
}

/** Resolved doc-sync internal HTTP transport, or `undefined` when off. */
export type ResolvedDocSync = {
  /** http(s) base for the internal endpoints (the ws(s) URL's twin). */
  httpBase: string
  syncSecret: string
  doFetch: typeof fetch
  timeoutMs: number
}

/**
 * Resolve the doc-sync internal HTTP base + secret, or `undefined` when the
 * live path is not configured (no secret, or — outside production — no URL).
 * Shared by `createDocGateway` (the `patchPage` apply path) and
 * `createDocRunClient` (assistant-run presence) so both gate identically and
 * never drift on the host-resolution rule.
 */
export function resolveDocSyncHttp(
  opts: DocGatewayOptions = {},
): ResolvedDocSync | undefined {
  // The sync host is a fixed convention (doc-sync.sidan.ai), so in
  // production we default the URL — DOC_SYNC_SECRET is then the only env
  // that must be configured for the live-doc write path to activate.
  // DOC_SYNC_URL stays an optional override (staging / local-against-prod).
  const syncUrl =
    opts.syncUrl ??
    process.env.DOC_SYNC_URL ??
    (process.env.NODE_ENV === 'production'
      ? 'wss://doc-sync.sidan.ai'
      : undefined)
  const syncSecret = opts.syncSecret ?? process.env.DOC_SYNC_SECRET
  if (!syncUrl || !syncSecret) return undefined
  return {
    // ws://host → http://host ; wss://host → https://host.
    httpBase: syncUrl.replace(/^ws/, 'http').replace(/\/+$/, ''),
    syncSecret,
    doFetch: opts.fetchImpl ?? fetch,
    timeoutMs: opts.timeoutMs ?? 15_000,
  }
}

export function createDocGateway(
  opts: DocGatewayOptions = {},
): DocGateway | undefined {
  const resolved = resolveDocSyncHttp(opts)
  if (!resolved) return undefined
  const { httpBase, syncSecret, doFetch, timeoutMs } = resolved

  return {
    async applyOps({ userId, pageId, ops }) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await doFetch(`${httpBase}/internal/apply`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-doc-sync-secret': syncSecret,
          },
          body: JSON.stringify({ pageId, ops, userId }),
          signal: controller.signal,
        })
        if (!res.ok) {
          return { error: `sync apply HTTP ${res.status}` }
        }
        const json = (await res.json()) as {
          idMap?: Record<string, string>
          skipped?: { opIndex: number; reason: string }[]
          seq?: number
          // Authoritative post-apply state from the live in-memory doc; absent
          // on an older doc-sync, in which case patchPage re-reads the snapshot.
          page?: { blocks: unknown[] }
          title?: string
        }
        return {
          idMap: json.idMap ?? {},
          skipped: json.skipped ?? [],
          version: typeof json.seq === 'number' ? json.seq : 0,
          ...(json.page ? { page: json.page as Page, title: json.title } : {}),
        }
      } catch (err) {
        return {
          error: `sync unreachable: ${err instanceof Error ? err.message : String(err)}`,
        }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
