/**
 * `DocRunClient` — the API-side bridge that tells `apps/doc-sync` an
 * assistant run opened/closed on a page, so the sync service can broadcast
 * "someone is working on this page" to every connected tab over Yjs awareness.
 *
 * Called from `routes/chat.ts` at the turn boundary: `start` after the session
 * flips to running (when the turn is anchored to a `docViewId`), `end` in the
 * turn's `finally`. Progress is NOT driven from here — `apps/doc-sync` derives
 * it inside `/internal/apply` (where the `patchPage` ops already are), so it
 * stays perfectly in sync with the blocks landing in the doc.
 *
 * Presence is **best-effort**: a slow or failed run-state POST must never block
 * or fail the chat turn, so every call is fire-and-forget with a short timeout
 * and swallowed (logged) errors. Mirrors `createDocGateway`'s env gating
 * via the shared `resolveDocSyncHttp`, so without `DOC_SYNC_SECRET` (or,
 * outside production, no `DOC_SYNC_URL`) the client is `undefined` and the
 * chat route's run calls no-op exactly like `applyOps` does.
 *
 * [COMP:api/doc-run-client]
 */

import type { AssistantRunChannel, AssistantRunStep } from '@sidanclaw/doc-model'
import {
  resolveDocSyncHttp,
  type DocGatewayOptions,
} from './doc-gateway.js'

export type DocRunActor = { id: string; name: string; color?: string }

export type DocRunClient = {
  start(input: {
    pageId: string
    actor: DocRunActor
    channel: AssistantRunChannel
  }): Promise<void>
  progress(input: {
    pageId: string
    step?: AssistantRunStep
    toolName?: string
    blockId?: string
  }): Promise<void>
  end(pageId: string): Promise<void>
}

export function createDocRunClient(
  opts: DocGatewayOptions = {},
): DocRunClient | undefined {
  const resolved = resolveDocSyncHttp(opts)
  if (!resolved) return undefined
  const { httpBase, syncSecret, doFetch, timeoutMs } = resolved

  async function post(action: string, body: unknown): Promise<void> {
    const controller = new AbortController()
    // Cap well under the apply timeout — presence must not hold the turn.
    const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 5_000))
    try {
      await doFetch(`${httpBase}/internal/run/${action}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-doc-sync-secret': syncSecret,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err) {
      console.warn(
        `[doc-run] ${action} failed:`,
        err instanceof Error ? err.message : String(err),
      )
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    start: (input) => post('start', input),
    progress: (input) => post('progress', input),
    end: (pageId) => post('end', { pageId }),
  }
}
