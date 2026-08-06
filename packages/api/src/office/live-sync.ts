/** Push a committed Office snapshot into doc-sync's authoritative in-memory
 * Y.Doc so connected editors and immutable history cannot diverge.
 * [COMP:api/office-live-sync] */
import type { OfficeArtifactSnapshot } from '@use-brian/office-model'
import { resolveDocSyncHttp, type DocGatewayOptions } from '../doc/doc-gateway.js'

export async function replaceLiveOfficeSnapshot(
  snapshot: OfficeArtifactSnapshot,
  options: DocGatewayOptions = {},
): Promise<'disabled' | 'replaced'> {
  const resolved = resolveDocSyncHttp(options)
  if (!resolved) return 'disabled'
  const { httpBase, syncSecret, doFetch, timeoutMs } = resolved
  let lastError = 'unknown error'
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await doFetch(`${httpBase}/internal/office/replace`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-doc-sync-secret': syncSecret,
        },
        body: JSON.stringify({ artifactId: snapshot.artifactId, snapshot }),
        signal: controller.signal,
      })
      if (response.ok) return 'replaced'
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error(`Office live snapshot replacement failed: ${lastError}`)
}
