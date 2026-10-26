/** In-memory application consent and existing Home bridge adapters. [COMP:shared/brian-app-sdk] */
import { ApplicationSdkError, apiOrigin, appIdentifier, appOAuthToken, httpTransport,
  type ApplicationTransport, type HttpTransportOptions } from './transport.js'

export interface ApplicationSignInOptions extends HttpTransportOptions {
  appId: string; clientId: string; redirectUri: string; scope?: 'read' | 'read_write'; crypto?: Crypto
}
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function createApplicationSignIn(options: ApplicationSignInOptions) {
  const origin = apiOrigin(options.apiOrigin), app = appIdentifier(options.appId)
  let redirect: URL
  try { redirect = new URL(options.redirectUri) } catch { throw new ApplicationSdkError('invalid_value') }
  apiOrigin(redirect.origin)
  if (redirect.username || redirect.password || redirect.hash || redirect.search || !options.clientId
    || options.scope !== undefined && !['read','read_write'].includes(options.scope)) throw new ApplicationSdkError('invalid_value')
  const crypto = options.crypto ?? globalThis.crypto, fetcher = options.fetch ?? globalThis.fetch
  let generation = 0
  let pending: { verifier: string; state: string; expires: number; popup?: Window; generation: number } | undefined
  return {
    async begin(call: { popup?: Window } = {}): Promise<{ authorizationUrl: string }> {
      const current = ++generation
      pending = undefined
      const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
      const state = base64url(crypto.getRandomValues(new Uint8Array(32)))
      const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
      if (current !== generation) throw new ApplicationSdkError('cancelled', 'none', false, undefined, true)
      pending = { verifier, state, expires: Date.now() + 5 * 60_000, popup: call.popup, generation: current }
      const url = new URL(`/api/applications/${app}/authorize`, origin)
      url.search = new URLSearchParams({ response_type: 'code', client_id: options.clientId, redirect_uri: options.redirectUri,
        code_challenge: challenge, code_challenge_method: 'S256', scope: options.scope ?? 'read', state }).toString()
      return { authorizationUrl: url.toString() }
    },
    cancel() { generation++; pending = undefined },
    async completeFromMessage(event: MessageEvent, call: { signal?: AbortSignal } = {}) {
      const data = event.data as Record<string, unknown> | null
      if (!pending?.popup || event.source !== pending.popup || event.origin !== redirect.origin || !data
        || data.type !== 'ub:application:callback' || data.appId !== app || typeof data.url !== 'string') throw new ApplicationSdkError('invalid_callback')
      return this.complete(data.url, call)
    },
    async complete(callbackUrl: string, call: { signal?: AbortSignal } = {}): Promise<{ accessToken: string; refreshToken?: string; expiresIn: number }> {
      const proof = pending; pending = undefined
      if (call.signal?.aborted) throw new ApplicationSdkError('cancelled', 'none', false, undefined, true)
      let callback: URL
      try { callback = new URL(callbackUrl) } catch { throw new ApplicationSdkError('invalid_callback') }
      if (!proof || proof.expires <= Date.now() || callback.origin !== redirect.origin || callback.pathname !== redirect.pathname
        || callback.hash || callback.username || callback.password || callback.searchParams.getAll('state').length !== 1
        || callback.searchParams.get('state') !== proof.state || callback.searchParams.getAll('code').length > 1) throw new ApplicationSdkError('invalid_callback')
      if (callback.searchParams.has('error')) throw new ApplicationSdkError('oauth_denied')
      const code = callback.searchParams.get('code')
      if (!code) throw new ApplicationSdkError('invalid_callback')
      let response: Response
      try {
        response = await fetcher(new URL(`/api/applications/${app}/token`, origin), { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
          signal: call.signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code',
            code, code_verifier: proof.verifier, redirect_uri: options.redirectUri, client_id: options.clientId }).toString() })
      } catch {
        const cancelled = call.signal?.aborted === true || proof.generation !== generation
        throw new ApplicationSdkError(cancelled ? 'cancelled' : 'transport_unavailable', 'none', false, undefined, cancelled)
      }
      if (call.signal?.aborted || proof.generation !== generation) throw new ApplicationSdkError('cancelled', 'none', false, response.status, true)
      if (!response.ok) throw new ApplicationSdkError('oauth_denied', 'none', false, response.status)
      let body: Record<string, unknown>
      try { body = await response.json() as Record<string, unknown> } catch {
        if (call.signal?.aborted || proof.generation !== generation) throw new ApplicationSdkError('cancelled', 'none', false, response.status, true)
        throw new ApplicationSdkError('invalid_response')
      }
      if (call.signal?.aborted || proof.generation !== generation) throw new ApplicationSdkError('cancelled', 'none', false, response.status, true)
      if (!body || body.token_type !== 'Bearer' || !Number.isFinite(body.expires_in) || Number(body.expires_in) <= 0
        || body.refresh_token !== undefined && (typeof body.refresh_token !== 'string' || !/^ort_[A-Za-z0-9_-]+$/.test(body.refresh_token))) throw new ApplicationSdkError('invalid_response')
      return { accessToken: appOAuthToken(body.access_token), expiresIn: Number(body.expires_in),
        ...(body.refresh_token === undefined ? {} : { refreshToken: body.refresh_token as string }) }
    },
  }
}

export interface HomeApplicationOptions extends HttpTransportOptions {
  appId: string; homeAppId: string; workspaceId: string; hostOrigin: string; window: Window; timeoutMs?: number
}
/** Authenticated ub:token handoff; no native-session token, persistent cache or invented parent verb. */
export function createHomeApplicationTransport(options: HomeApplicationOptions): { transport: ApplicationTransport; dispose(): void } {
  const origin = apiOrigin(options.apiOrigin), host = apiOrigin(options.hostOrigin)
  const app = appIdentifier(options.appId), home = appIdentifier(options.homeAppId), workspace = appIdentifier(options.workspaceId)
  const frame = options.window, parent = frame.parent, timeout = options.timeoutMs ?? 5000
  if (parent === frame || !Number.isFinite(timeout) || timeout <= 0 || timeout > 60_000) throw new ApplicationSdkError('invalid_value')
  let disposed = false
  const cancellations = new Set<() => void>()
  const token = (signal?: AbortSignal): Promise<string> => new Promise((resolve, reject) => {
    if (disposed || signal?.aborted) { reject(new ApplicationSdkError('cancelled', 'none', false, undefined, true)); return }
    const cleanup = () => { clearTimeout(timer); frame.removeEventListener('message', onMessage); signal?.removeEventListener('abort', cancel); cancellations.delete(cancel) }
    const cancel = () => { cleanup(); reject(new ApplicationSdkError('cancelled', 'none', false, undefined, true)) }
    const onMessage = (event: MessageEvent) => {
      if (event.source !== parent || event.origin !== host) return
      const data = event.data as Record<string, unknown> | null
      if (!data || data.type !== 'ub:token' || data.appId !== home || data.workspaceId !== workspace || data.apiOrigin !== origin) return
      cleanup()
      if (typeof data.token !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(data.token)) reject(new ApplicationSdkError('authentication_required'))
      else resolve(data.token)
    }
    const timer = setTimeout(() => { cleanup(); reject(new ApplicationSdkError('authentication_required')) }, timeout)
    cancellations.add(cancel); frame.addEventListener('message', onMessage); signal?.addEventListener('abort', cancel, { once: true })
    try { parent.postMessage({ type: 'ub:ready' }, host) } catch { cleanup(); reject(new ApplicationSdkError('authentication_required')) }
  })
  const transport = httpTransport(options, async request => {
    if (request.appId !== app) throw new ApplicationSdkError('authentication_required')
    return { Authorization: `Bearer ${await token(request.signal)}` }
  })
  return { transport, dispose() { disposed = true; for (const cancel of [...cancellations]) cancel() } }
}
