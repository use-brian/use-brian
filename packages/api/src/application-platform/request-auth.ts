/** Reserved-header adapter; request JSON is never an identity source. [COMP:api/application-auth] */
import type { Request } from 'express'
import type { ExecutionContext } from '@use-brian/core'
import { ApplicationPlatformError } from '@use-brian/shared'
import { authenticateApplicationCredential } from './credentials.js'
import { loadApplicationCredentialStateSystem } from './auth-store.js'
import { authenticateApplicationOAuth } from './oauth-auth.js'
import { resolveApplicationExecutionContext } from './execution-context.js'
import { authenticateApplicationHome } from './home-auth.js'

export interface ApplicationHomeAuthenticationOptions {
  signingSecret: string
  consumeBudget(homeAppId: string): Promise<{ allowed: boolean }>
}
export class ApplicationHomeBudgetExceeded extends ApplicationPlatformError {
  constructor() { super('access_unavailable', 'This app has used its daily budget.', 'none', false) }
}

function bearer(value: unknown): string | null {
  if (typeof value !== 'string' || !/^Bearer [A-Za-z0-9_-]+$/.test(value) || value.length > 140) return null
  return value.slice(7)
}

export async function authenticateApplicationRequest(req: Request, appId: string, home?: ApplicationHomeAuthenticationOptions): Promise<ExecutionContext> {
  const bridgeHeader = req.headers.authorization
  if (home && typeof bridgeHeader === 'string' && /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(bridgeHeader) && bridgeHeader.length <= 8192) {
    if (req.headers['x-usebrian-user-authorization'] !== undefined) throw new ApplicationPlatformError('authentication_required', 'Application authentication is required.')
    const proof = await authenticateApplicationHome(bridgeHeader.slice(7), appId, home.signingSecret)
    if (!proof) throw new ApplicationPlatformError('authentication_required', 'Application authentication is required.')
    if (!(await home.consumeBudget(proof.homeAppId)).allowed) throw new ApplicationHomeBudgetExceeded()
    const signal = new AbortController(); req.once('aborted', () => signal.abort())
    return resolveApplicationExecutionContext({ home: proof }, { abortSignal: signal.signal })
  }
  const token = bearer(req.headers.authorization)
  const delegatedHeader = req.headers['x-usebrian-user-authorization']
  if (!token) throw new ApplicationPlatformError('authentication_required', 'Application authentication is required.')
  const signal = new AbortController()
  req.once('aborted', () => signal.abort())
  if (token.startsWith('sk_app_')) {
    const credential = await authenticateApplicationCredential(token, appId, loadApplicationCredentialStateSystem)
    if (!credential) throw new ApplicationPlatformError('authentication_required', 'Application authentication is required.')
    if (credential.credentialKind === 'service' && delegatedHeader !== undefined) {
      throw new ApplicationPlatformError('authentication_required', 'An explicitly delegated application credential is required.')
    }
    const userToken = delegatedHeader === undefined ? null : bearer(delegatedHeader)
    if (credential.credentialKind === 'delegated' && !userToken) throw new ApplicationPlatformError('authentication_required', 'Application user authorization is required.')
    const user = userToken ? await authenticateApplicationOAuth(userToken, appId) : null
    if (userToken && !user) throw new ApplicationPlatformError('authentication_required', 'Application user authorization is required.')
    return resolveApplicationExecutionContext({ credential, ...(user ? { user } : {}) }, { abortSignal: signal.signal })
  }
  if (delegatedHeader !== undefined) throw new ApplicationPlatformError('authentication_required', 'Application authentication is required.')
  const user = await authenticateApplicationOAuth(token, appId)
  if (!user) throw new ApplicationPlatformError('authentication_required', 'Application authentication is required.')
  return resolveApplicationExecutionContext({ user }, { abortSignal: signal.signal })
}
