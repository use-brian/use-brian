/** App sign-in reuses verified native accounts without staff enrollment. [COMP:api/application-auth] */
import { verifyConsentRequest } from '../brain-mcp/oauth/codes.js'
import { loadApplicationOAuthClientSystem } from './oauth-consent.js'

export async function applicationOnboardingRequestValid(signed: unknown, secret: string): Promise<boolean> {
  if (typeof signed !== 'string' || signed.length > 8192) return false
  const request = verifyConsentRequest(signed, secret)
  if (!request || request.audience !== 'application' || !request.applicationId) return false
  const client = await loadApplicationOAuthClientSystem(request.applicationId)
  return !!client && client.clientId === request.clientId && client.revision === request.applicationRevision
    && client.redirectUris.includes(request.redirectUri) && client.origins.includes(new URL(request.redirectUri).origin)
}

/** The email store binds this next path to the single-use identity proof. */
export async function applicationOnboardingFromNextPath(next: string | null, secret: string): Promise<'workspace' | 'application' | 'invalid'> {
  if (!next) return 'workspace'
  if (next.length > 8192) return 'invalid'
  let url: URL
  try { url = new URL(next, 'https://auth.example') } catch { return 'workspace' }
  if (url.pathname !== '/oauth/authorize') return 'workspace'
  const signed = url.searchParams.get('req')
  const request = signed ? verifyConsentRequest(signed, secret) : null
  if (!url.searchParams.has('application') && request?.audience !== 'application') return 'workspace'
  if (url.searchParams.has('application') && url.searchParams.get('application') !== request?.applicationId) return 'invalid'
  return await applicationOnboardingRequestValid(signed, secret) ? 'application' : 'invalid'
}
