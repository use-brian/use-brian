/** Application consent policy on the shared OAuth protocol. [COMP:api/application-auth] */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { applicationGrantMaximumSchema } from '@use-brian/shared'
import { query } from '../db/client.js'
import { createDbOAuthAuthorizationStore } from '../db/oauth-authorization-store.js'
import { signOAuthState, verifyOAuthState } from '../oauth-state.js'
import type { OAuthConsentRequest } from '../brain-mcp/oauth/codes.js'
import type { OAuthRoutesOptions } from '../brain-mcp/oauth/routes.js'

const snapshotSchema = z.object({ appId: z.string().uuid(), workspaceId: z.string().uuid(), clientId: z.string(), revision: z.string().regex(/^[1-9][0-9]*$/),
  activationVersion:z.string().uuid().nullable(), grantIds: z.array(z.string().uuid()).min(1).max(128), parentGrantId: z.string().uuid(),
  maxima: z.array(applicationGrantMaximumSchema).min(1).max(128), maximumHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict()
const reviewSchema = z.object({ kind: z.literal('application-consent-review'), appId: z.string().uuid(), userId: z.string().uuid(),
  workspaceId: z.string().uuid(), activationVersion:z.string().uuid().nullable(), revision: z.string(), grantIds: z.array(z.string().uuid()).min(1).max(128), maximumHash: z.string().regex(/^[0-9a-f]{64}$/),
  requestHash: z.string().regex(/^[0-9a-f]{64}$/), exp: z.number().int() }).strict()
const requestHash = (request: OAuthConsentRequest) => createHash('sha256').update(JSON.stringify(request)).digest('hex')
const intersection = (first: string[], next: string[]) => first.filter(value => next.includes(value))

/** Read authentication/consent metadata only; never read a record on an owner connection. */
export async function loadApplicationOAuthClientSystem(appId: string) {
  const result = await query<{ id: string; workspaceId: string; clientId: string; revision: string; name: string; redirectUris: string[]; origins: string[]; qualified: boolean }>(`SELECT
    id,workspace_id AS "workspaceId",oauth_client_id AS "clientId",grant_revision::text AS revision,name,redirect_uris AS "redirectUris",origins,
    (application_runtime_qualified(workspace_id,'application_data') OR application_scoped_qualified(workspace_id,id)) AS qualified FROM application_clients
    WHERE id=$1 AND status='active' AND client_mode='external_frontend' AND oauth_client_id IS NOT NULL`, [appId])
  return result.rows[0] ?? null
}

export function createApplicationConsentAdapter(appId: string, signingSecret: string): NonNullable<OAuthRoutesOptions['applicationConsent']> {
  async function matchingClient(request: OAuthConsentRequest) {
    const client = await loadApplicationOAuthClientSystem(appId)
    if (!client || request.audience !== 'application' || request.applicationId !== appId || request.applicationRevision !== client.revision
      || request.clientId !== client.clientId || !client.redirectUris.includes(request.redirectUri)
      || !client.origins.includes(new URL(request.redirectUri).origin)) return null
    return client
  }
  async function snapshot(userId: string, grantIds?: string[]) {
    let ids = grantIds
    if (!ids) {
      const grants = await query<{ id: string }>(`SELECT id FROM application_access_grants WHERE app_id=$1 AND principal_user_id=$2
        AND principal_kind IN('member','external_user') AND status='active' AND starts_at<=now() AND (expires_at IS NULL OR expires_at>now()) ORDER BY id LIMIT 129`, [appId, userId])
      if (!grants.rows.length || grants.rows.length > 128) return null
      ids = grants.rows.map(grant => grant.id)
    }
    const result = await query<{ snapshot: unknown }>('SELECT application_oauth_consent_snapshot($1,$2,$3) AS snapshot', [appId, userId, ids])
    const parsed = snapshotSchema.safeParse(result.rows[0]?.snapshot)
    return parsed.success ? parsed.data : null
  }
  return {
    applicationId: appId,
    async authorize(clientId, redirectUri) {
      const client = await loadApplicationOAuthClientSystem(appId)
      return client && client.clientId === clientId && client.redirectUris.includes(redirectUri) && client.origins.includes(new URL(redirectUri).origin)
        ? { revision: client.revision } : null
    },
    async choices(userId, request) {
      const client = await matchingClient(request)
      if (!client) return null
      const maximum = await snapshot(userId)
      if (!maximum || maximum.revision !== client.revision) return null
      const review = signOAuthState(JSON.stringify({ kind: 'application-consent-review', appId, userId, workspaceId: maximum.workspaceId,
        activationVersion:maximum.activationVersion,revision: maximum.revision, grantIds: maximum.grantIds, maximumHash: maximum.maximumHash, requestHash: requestHash(request),
        exp: Math.min(request.exp, Math.floor(Date.now() / 1000) + 300) }), signingSecret)
      return { workspaces: [{ id: maximum.workspaceId, name: client.name }], application: { id: appId, qualified: client.qualified, review,
        resources: maximum.maxima.map(path => ({ origin: path.grants[0].origin, typeKey: path.grants[0].typeKey, selector: path.grants[0].selector,
          actions: path.grants.reduce((keys, grant) => intersection(keys, grant.actions), path.grants[0].actions),
          readFields: path.grants.reduce((keys, grant) => intersection(keys, grant.readFields), path.grants[0].readFields),
          writeFields: path.grants.reduce((keys, grant) => intersection(keys, grant.writeFields), path.grants[0].writeFields) })) } }
    },
    async issue(input) {
      const raw = verifyOAuthState(input.review, signingSecret)
      if (!raw) return null
      let value: unknown
      try { value = JSON.parse(raw) } catch { return null }
      const parsed = reviewSchema.safeParse(value)
      if (!parsed.success) return null
      const review = parsed.data
      if (review.appId !== appId || review.userId !== input.userId || review.workspaceId !== input.workspaceId
        || review.requestHash !== requestHash(input.request) || review.exp <= Math.floor(Date.now() / 1000)) return null
      const client = await matchingClient(input.request)
      if (!client || review.revision !== client.revision) return null
      const current = await snapshot(input.userId, review.grantIds)
      if (!current || current.activationVersion!==review.activationVersion || current.maximumHash !== review.maximumHash || current.revision !== review.revision) return null
      if (!client.qualified) return { error: 'application_not_qualified' }
      return createDbOAuthAuthorizationStore({ audience: 'application', applicationClientId: appId }).createGrantWithCode({
        userId: input.userId, workspaceId: input.workspaceId, clientId: input.request.clientId, scope: input.scope,
        codeChallenge: input.request.codeChallenge, redirectUri: input.request.redirectUri,
        applicationConsent: { grantIds: review.grantIds, maximumHash: review.maximumHash, clientRevision: review.revision,activationVersion:review.activationVersion },
      })
    },
  }
}
