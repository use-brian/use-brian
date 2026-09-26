/** Push a committed Office snapshot into doc-sync's authoritative in-memory
 * Y.Doc so connected editors and immutable history cannot diverge.
 * [COMP:api/office-live-sync] */
import { OfficeUuidSchema, type OfficeArtifactSnapshot, type OfficeCommand } from '@use-brian/office-model'
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

/** Apply one stored suggestion inside doc-sync's authoritative Y.Doc. */
export async function applyLiveOfficeSuggestion(
  artifactId: string,
  suggestionId: string,
  command: OfficeCommand,
  options: DocGatewayOptions = {},
): Promise<'applied' | 'conflict' | 'disabled'> {
  const resolved = resolveDocSyncHttp(options)
  if (!resolved) return 'disabled'
  const { httpBase, syncSecret, doFetch, timeoutMs } = resolved
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await doFetch(`${httpBase}/internal/office/suggestion`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-doc-sync-secret': syncSecret },
      body: JSON.stringify({ artifactId, suggestionId, command }),
      signal: controller.signal,
    })
    if (response.ok) return 'applied'
    if (response.status === 409) return 'conflict'
    throw new Error(`Office suggestion application failed: HTTP ${response.status}`)
  } finally {
    clearTimeout(timer)
  }
}

/** Read-only retry repair: failure/disabled never authorizes an acceptance. */
export async function officeSuggestionApplied(
  artifactId: string,
  suggestionId: string,
  options: DocGatewayOptions = {},
): Promise<boolean> {
  if (!OfficeUuidSchema.safeParse(artifactId).success || !OfficeUuidSchema.safeParse(suggestionId).success) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const resolved = resolveDocSyncHttp(options)
    if (!resolved) return false
    const { httpBase, syncSecret, doFetch, timeoutMs } = resolved
    const controller = new AbortController()
    timer = setTimeout(() => controller.abort(), timeoutMs)
    const response = await doFetch(`${httpBase}/internal/office/suggestion-status`, {
      method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', 'x-doc-sync-secret': syncSecret },
      body: JSON.stringify({ artifactId, suggestionId }), signal: controller.signal,
    })
    if (!response.ok) return false
    const result: unknown = await response.json()
    return typeof result === 'object' && result !== null && !Array.isArray(result) &&
      Object.keys(result).length === 1 && 'applied' in result && result.applied === true
  } catch { return false } finally { if (timer) clearTimeout(timer) }
}
