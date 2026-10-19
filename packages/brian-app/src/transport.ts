/** Browser transport primitives; never a permission evaluator. [COMP:shared/brian-app-sdk] */
import type { ApplicationErrorCode, ApplicationEffectStatus } from '@use-brian/shared'

export type ApplicationSdkCode = ApplicationErrorCode | 'cancelled' | 'transport_unavailable' | 'invalid_response' | 'invalid_callback' | 'oauth_denied'
export class ApplicationSdkError extends Error {
  constructor(readonly code: ApplicationSdkCode, readonly effect: ApplicationEffectStatus = 'none',
    readonly retrySafe = false, readonly status?: number, readonly cancelled = false) {
    super(code); this.name = 'ApplicationSdkError'
  }
}
export interface ApplicationRequest {
  appId: string; method: 'GET' | 'POST'; path: string; body?: unknown; effectful: boolean; signal?: AbortSignal
}
export type ApplicationTransport = (request: ApplicationRequest) => Promise<unknown>
export type ApplicationFetch = typeof fetch
export interface HttpTransportOptions { apiOrigin: string; fetch?: ApplicationFetch }
export function apiOrigin(raw: string): string {
  let url: URL
  try { url = new URL(raw) } catch { throw new ApplicationSdkError('invalid_value') }
  if (url.origin !== raw || url.username || url.password || (url.protocol !== 'https:'
    && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) throw new ApplicationSdkError('invalid_value')
  return url.origin
}
export function appIdentifier(value: string): string {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) throw new ApplicationSdkError('invalid_value')
  return value
}
export function appOAuthToken(token: unknown): string {
  if (typeof token !== 'string' || !/^oat_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/i.test(token)) throw new ApplicationSdkError('authentication_required')
  return token
}
const safeCodes = new Set(['invalid_schema','invalid_value','schema_version_conflict','record_version_conflict',
  'operation_not_available','access_unavailable','authentication_required','grant_revoked','source_unavailable','outcome_uncertain'])
async function readResponse(response: Response, effectful: boolean, signal?: AbortSignal): Promise<unknown> {
  let body: unknown
  try { body = await response.json() } catch { throw new ApplicationSdkError(signal?.aborted ? 'cancelled' : 'invalid_response', effectful ? 'uncertain' : 'none', false, response.status, !!signal?.aborted) }
  if (!response.ok) {
    const value = body && typeof body === 'object' ? body as Record<string, unknown> : {}
    const code = typeof value.error === 'string' && safeCodes.has(value.error) ? value.error as ApplicationErrorCode : 'access_unavailable'
    const effect = value.effect === 'none' || value.effect === 'committed' || value.effect === 'uncertain' ? value.effect : effectful ? 'uncertain' : 'none'
    throw new ApplicationSdkError(code, effect, effect === 'none' && value.retrySafe === true, response.status)
  }
  return body
}
/** Internal shared implementation; browser exports expose only app-bound credentials. */
export function httpTransport(options: HttpTransportOptions,
  headers: (request: ApplicationRequest) => Promise<Record<string, string>>): ApplicationTransport {
  const origin = apiOrigin(options.apiOrigin), fetcher = options.fetch ?? globalThis.fetch
  return async request => {
    appIdentifier(request.appId)
    if (request.signal?.aborted) throw new ApplicationSdkError('cancelled', 'none', false, undefined, true)
    let authorization: Record<string,string>, body: string | undefined
    try { authorization = await headers(request) }
    catch (error) { if (error instanceof ApplicationSdkError) throw error; throw new ApplicationSdkError('authentication_required') }
    try { body = request.body === undefined ? undefined : JSON.stringify(request.body) } catch { throw new ApplicationSdkError('invalid_value') }
    if (request.signal?.aborted) throw new ApplicationSdkError('cancelled', 'none', false, undefined, true)
    const prefix = `/api/applications/${request.appId}/`
    if (!request.path.startsWith(prefix) || /[\r\n#]/.test(request.path)
      || new URL(request.path, origin).pathname.indexOf(prefix) !== 0) throw new ApplicationSdkError('invalid_value')
    let response: Response
    try {
      response = await fetcher(new URL(request.path, origin), { method: request.method, headers: { ...authorization, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body, signal: request.signal, cache: 'no-store', credentials: 'same-origin', redirect: 'error' })
    } catch {
      const cancelled = request.signal?.aborted === true
      throw new ApplicationSdkError(cancelled ? 'cancelled' : 'transport_unavailable', request.effectful ? 'uncertain' : 'none', false, undefined, cancelled)
    }
    const result = await readResponse(response, request.effectful, request.signal)
    if (request.signal?.aborted) throw new ApplicationSdkError('cancelled', request.effectful ? 'uncertain' : 'none', false, response.status, true)
    return result
  }
}
