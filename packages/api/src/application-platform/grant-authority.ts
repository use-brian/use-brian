/** Live consent/parent metadata, never a business-data owner read. [COMP:api/application-auth] */
import { createHash } from 'node:crypto'
import { applicationGrantMaximumSchema, applicationGrantSchema, ApplicationPlatformError,
  type ApplicationAccessGrant, type ApplicationGrantMaximum, type ApplicationPrincipal } from '@use-brian/shared'
import type { ApplicationAuthorityLayers, ApplicationGrantPath } from '@use-brian/core'
import { query } from '../db/client.js'
import { getAuthenticatedApplicationCredentialCurrent, type AuthenticatedApplicationCredential } from './credentials.js'
import { getAuthenticatedApplicationOAuthCurrent, type AuthenticatedApplicationOAuth } from './oauth-auth.js'
import { getAuthenticatedApplicationHomeCurrent, type AuthenticatedApplicationHome } from './home-auth.js'

export type ApplicationAuthentication = { credential?: AuthenticatedApplicationCredential; user?: AuthenticatedApplicationOAuth; home?: AuthenticatedApplicationHome }
export interface ApplicationAuthorityState {
  appId: string
  workspaceId: string
  moduleKey: string
  assistantId: string
  principal: ApplicationPrincipal
  credentialId: string
  issuerUserId: string
  readOnly: boolean
  serviceUserId?: string
  layers: ApplicationAuthorityLayers
  fingerprint: string
  clearanceCap?: import('@use-brian/core').Sensitivity
}
function denied(): never { throw new ApplicationPlatformError('grant_revoked', 'Application access is unavailable.') }

export async function loadApplicationAuthority(auth: ApplicationAuthentication): Promise<ApplicationAuthorityState> {
  const credentialCurrent = auth.credential && getAuthenticatedApplicationCredentialCurrent(auth.credential)
  const userCurrent = auth.user && getAuthenticatedApplicationOAuthCurrent(auth.user)
  const homeCurrent = auth.home && getAuthenticatedApplicationHomeCurrent(auth.home)
  if (!credentialCurrent && !userCurrent && !homeCurrent || auth.credential && !credentialCurrent || auth.user && !userCurrent
    || auth.home && (!homeCurrent || auth.credential || auth.user)) denied()
  const credential = credentialCurrent ? await credentialCurrent() : null
  const user = userCurrent ? await userCurrent() : null
  const home = homeCurrent ? await homeCurrent() : null
  if (auth.credential && !credential || auth.user && !user || auth.home && !home) denied()
  if (credential && user && (credential.credentialKind !== 'delegated' || credential.appId !== user.appId
    || credential.workspaceId !== user.workspaceId)) denied()
  // A delegated key has no implicit human context and cannot fall back to service-only execution.
  if (credential?.credentialKind === 'delegated' && !user) denied()
  const appId = credential?.appId ?? user?.appId ?? home!.appId, workspaceId = credential?.workspaceId ?? user?.workspaceId ?? home!.workspaceId
  const appResult = await query<{ moduleKey: string; createdBy: string; revision: string; assistantId: string | null }>(`SELECT module_key AS "moduleKey",created_by_user_id AS "createdBy",grant_revision::text AS revision,executing_assistant_id AS "assistantId"
    FROM application_clients WHERE id=$1 AND workspace_id=$2 AND status='active'`, [appId, workspaceId])
  const app = appResult.rows[0]
  if (!app?.assistantId || credential && app.revision !== credential.clientRevision || user && app.revision !== user.applicationRevision
    || home && app.revision !== home.clientRevision) denied()
  const maxima: ApplicationGrantMaximum[][] = []
  if (credential) {
    const result = await query<{ maximum: unknown }>(`SELECT maximum_grant AS maximum FROM application_credential_grants
      WHERE credential_id=$1 AND app_id=$2 AND workspace_id=$3 ORDER BY grant_id`, [credential.id, appId, workspaceId])
    maxima.push(result.rows.map(row => applicationGrantMaximumSchema.parse(row.maximum)))
  }
  if (user) {
    const result = await query<{ maximum: unknown }>(`SELECT maximum_grants AS maximum FROM application_oauth_bindings
      WHERE authorization_id=$1 AND app_id=$2 AND workspace_id=$3 AND principal_user_id=$4`,
    [user.authorizationId, appId, workspaceId, user.userId])
    if (!result.rows[0] || !Array.isArray(result.rows[0].maximum)) denied()
    maxima.push(result.rows[0].maximum.map(value => applicationGrantMaximumSchema.parse(value)))
  }
  if (home) {
    const result = await query<{ maximum: unknown }>(`SELECT maximum_grants AS maximum FROM application_home_bindings
      WHERE id=$1 AND app_id=$2 AND workspace_id=$3 AND principal_user_id=$4`, [home.bindingId, appId, workspaceId, home.userId])
    if (!Array.isArray(result.rows[0]?.maximum)) denied()
    maxima.push(result.rows[0].maximum.map(value => applicationGrantMaximumSchema.parse(value)))
  }
  if (maxima.some(layer => !layer.length) || !maxima.length) denied()
  const ids = [...new Set(maxima.flat(2).flatMap(maximum => maximum.grants.map(grant => grant.id)))]
  const rows = await query<{ grant: unknown }>(`SELECT jsonb_build_object(
    'id',g.id,'appId',g.app_id,'workspaceId',g.workspace_id,'principal',jsonb_build_object('kind',g.principal_kind,'userId',g.principal_user_id),
    'origin',g.resource_origin,'typeKey',g.resource_type,'actions',g.actions,'readFields',g.read_fields,'writeFields',g.write_fields,
    'selector',g.selector,'version',g.version,'status',g.status,'startsAt',g.starts_at,'expiresAt',g.expires_at,'parentGrantId',g.parent_grant_id,
    'compartments',g.compartments,'projectIds',g.project_ids,'clearance',g.clearance) AS grant
    FROM application_access_grants g JOIN workspace_members issuer ON issuer.workspace_id=g.workspace_id
      AND issuer.user_id=g.issued_by_user_id AND issuer.role IN('owner','admin')
    WHERE g.id=ANY($1::uuid[]) AND g.app_id=$2 AND g.workspace_id=$3 ORDER BY g.id`, [ids, appId, workspaceId])
  const grants = new Map<string, ApplicationAccessGrant>()
  for (const row of rows.rows) { const grant = applicationGrantSchema.parse(row.grant); grants.set(grant.id, grant) }
  const layers: ApplicationGrantPath[][] = maxima.map((alternatives, index) => alternatives.flatMap(maximum => {
    const current = maximum.grants.map(grant => grants.get(grant.id))
    const subjectId = credential && index === 0 ? credential.subjectUserId : user?.userId ?? home!.userId
    const subjectKind = credential && index === 0 ? 'service' : user?.principalKind ?? 'member'
    if (current.some(grant => !grant) || maximum.grants[0].principal.userId !== subjectId
      || maximum.grants[0].principal.kind !== subjectKind) return []
    return [{ maximum, current: current as ApplicationAccessGrant[] }]
  }))
  if (layers.some(layer => !layer.length)) denied()
  const principal: ApplicationPrincipal = user ? { kind: user.principalKind, userId: user.userId }
    : home ? { kind: 'member', userId: home.userId } : { kind: 'service', userId: credential!.subjectUserId }
  const fingerprint = createHash('sha256').update(JSON.stringify({ appId, workspaceId, revision: app.revision, principal, layers })).digest('hex')
  return { appId, workspaceId, moduleKey: app.moduleKey, assistantId: app.assistantId, principal, layers, fingerprint,
    credentialId: credential?.id ?? user?.authorizationId ?? home!.bindingId, issuerUserId: credential?.issuerUserId ?? app.createdBy,
    readOnly: user?.scope === 'read' || home?.readOnly === true,
    ...(home?.maxClearance ? { clearanceCap: home.maxClearance } : {}),
    ...(credential ? { serviceUserId: credential.subjectUserId } : {}) }
}
