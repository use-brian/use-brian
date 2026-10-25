/** Application audience on the shared OAuth lifecycle. [COMP:api/application-auth] */
import { verifySecret } from '../db/api-key-store.js'
import { createDbOAuthAuthorizationStore, parseOAuthBearerToken } from '../db/oauth-authorization-store.js'
import { query } from '../db/client.js'

export interface ApplicationOAuthState {
  authorizationId: string
  appId: string
  workspaceId: string
  userId: string
  principalKind: 'member' | 'external_user'
  scope: 'read' | 'read_write'
  applicationRevision: string
  expiresAt: string
  secretHash: string
}
export type AuthenticatedApplicationOAuth = Readonly<Omit<ApplicationOAuthState, 'secretHash' | 'expiresAt'>>
type Load = (id: string, appId: string) => Promise<ApplicationOAuthState | null>
const proofs = new WeakMap<AuthenticatedApplicationOAuth, () => Promise<Omit<ApplicationOAuthState,'secretHash'> | null>>()

/** Authentication metadata only; no business payload or owner authorization. */
export async function loadApplicationOAuthStateSystem(id: string, appId: string): Promise<ApplicationOAuthState | null> {
  const store = createDbOAuthAuthorizationStore({ audience: 'application', applicationClientId: appId })
  const row = await store.getByIdSystem(id)
  if (!row?.accessTokenHash || !row.accessTokenExpiresAt || row.revokedAt) return null
  const bound = await query<{ principalKind: 'member' | 'external_user'; revision: string }>(`SELECT g.principal_kind AS "principalKind",a.grant_revision::text AS revision
    FROM application_oauth_bindings b
    JOIN application_clients a ON a.id=b.app_id AND a.workspace_id=b.workspace_id AND a.status='active' AND a.grant_revision=b.client_revision
    JOIN application_access_grants g ON g.id=b.parent_grant_id AND g.app_id=b.app_id AND g.workspace_id=b.workspace_id
      AND g.principal_user_id=b.principal_user_id AND g.principal_kind IN('member','external_user')
      AND g.status='active' AND g.starts_at<=now() AND (g.expires_at IS NULL OR g.expires_at>now())
    JOIN users u ON u.id=b.principal_user_id AND u.auth_provider<>'channel'
    JOIN workspace_members issuer ON issuer.workspace_id=b.workspace_id AND issuer.user_id=g.issued_by_user_id AND issuer.role IN('owner','admin')
    WHERE b.authorization_id=$1 AND b.app_id=$2 AND b.principal_user_id=$3 AND b.workspace_id=$4
      AND application_oauth_binding_current(b.authorization_id,b.app_id) AND (g.principal_kind='external_user' OR EXISTS(SELECT 1 FROM workspace_members m WHERE m.user_id=b.principal_user_id AND m.workspace_id=b.workspace_id))`,
  [id, appId, row.userId, row.workspaceId])
  const binding = bound.rows[0]
  return binding ? { authorizationId: id, appId, workspaceId: row.workspaceId, userId: row.userId,
    principalKind: binding.principalKind, applicationRevision: binding.revision,
    scope: row.scope, expiresAt: row.accessTokenExpiresAt.toISOString(), secretHash: row.accessTokenHash } : null
}

export async function authenticateApplicationOAuth(token: string, appId: string,
  load: Load = loadApplicationOAuthStateSystem, now = () => Date.now()): Promise<AuthenticatedApplicationOAuth | null> {
  if (token.length > 128) return null
  const parsed = parseOAuthBearerToken(token, 'oat')
  if (!parsed || !/^[A-Za-z0-9_-]{43}$/.test(parsed.secret)) return null
  const stored = await load(parsed.id, appId)
  const live = (state: ApplicationOAuthState | null): state is ApplicationOAuthState => state !== null
    && state.authorizationId === parsed.id && state.appId === appId && Date.parse(state.expiresAt) > now()
  if (!live(stored)) return null
  const snapshot = structuredClone(stored)
  try { if (!await verifySecret(parsed.secret, snapshot.secretHash)) return null } catch { return null }
  const same = (state: ApplicationOAuthState | null) => live(state) && Object.keys(snapshot).every(key =>
    state[key as keyof ApplicationOAuthState] === snapshot[key as keyof ApplicationOAuthState])
  if (!same(await load(parsed.id, appId))) return null
  const auth = Object.freeze({ authorizationId: snapshot.authorizationId, appId, workspaceId: snapshot.workspaceId,
    userId: snapshot.userId, principalKind: snapshot.principalKind, scope: snapshot.scope, applicationRevision: snapshot.applicationRevision })
  proofs.set(auth, async () => {
    const fresh = await load(parsed.id, appId)
    if (!fresh || !same(fresh)) return null
    const { secretHash: _secretHash, ...metadata } = fresh
    return metadata
  })
  return auth
}

/** Exact host object only; neither JSON nor a copied descriptor constitutes consent. */
export function getAuthenticatedApplicationOAuthCurrent(auth: AuthenticatedApplicationOAuth) { return proofs.get(auth) }
