/** Existing Home HMAC + exact live viewer binding; never an iframe session JWT. [COMP:api/application-auth] */
import type { AppManifest } from '@use-brian/brian-app'
import { parseManifest } from '@use-brian/brian-app'
import type { Sensitivity } from '@use-brian/core'
import { isSensitivity, minSensitivity } from '@use-brian/core'
import { query, queryWithRLS } from '../db/client.js'
import { parseBridgeToken } from '../home-apps/tokens.js'

export interface AuthenticatedApplicationHome {
  appId: string; workspaceId: string; homeAppId: string; bindingId: string; userId: string
}
interface HomeState extends AuthenticatedApplicationHome {
  clientRevision: string; maximumHash: string; homeStateHash: string; readOnly: boolean; maxClearance: Sensitivity | null
}
const proofs = new WeakMap<AuthenticatedApplicationHome, () => Promise<HomeState | null>>()
async function current(bindingId: string, appId: string, homeId: string, userId: string): Promise<HomeState | null> {
  const result = await query<HomeState & { manifest: AppManifest }>(`SELECT b.app_id AS "appId",b.workspace_id AS "workspaceId",b.home_app_id AS "homeAppId",
    b.id AS "bindingId",b.principal_user_id AS "userId",b.client_revision::text AS "clientRevision",b.maximum_hash AS "maximumHash",
    b.home_state_hash AS "homeStateHash",b.read_only AS "readOnly",h.max_clearance AS "maxClearance",h.manifest
    FROM application_home_bindings b JOIN workspace_home_apps h ON h.id=b.home_app_id
    WHERE b.id=$1 AND b.app_id=$2 AND b.home_app_id=$3 AND b.principal_user_id=$4 AND application_home_binding_current(b.id,b.app_id,b.principal_user_id)`,
  [bindingId, appId, homeId, userId])
  const row = result.rows[0]
  if (!row || !parseManifest(row.manifest).ok) return null
  const { manifest: _manifest, ...state } = row
  return state
}
export async function authenticateApplicationHome(token: string, appId: string, secret: string): Promise<AuthenticatedApplicationHome | null> {
  const verified = parseBridgeToken({ token, secret })
  if (!verified.ok || !verified.payload.applicationBindingId) return null
  if (verified.payload.maxClearance !== null && !isSensitivity(verified.payload.maxClearance)) return null
  const { applicationBindingId: bindingId, appId: homeId, userId, workspaceId } = verified.payload
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (![appId, homeId, userId, workspaceId].every(value => uuid.test(value))) return null
  const narrow = (state: HomeState): HomeState => ({ ...state, maxClearance: verified.payload.maxClearance === null ? state.maxClearance
    : state.maxClearance === null ? verified.payload.maxClearance : minSensitivity(state.maxClearance, verified.payload.maxClearance) })
  const stored = await current(bindingId, appId, homeId, userId), initial = stored ? narrow(stored) : null
  if (!initial || initial.workspaceId !== workspaceId) return null
  const proof: AuthenticatedApplicationHome = Object.freeze({ appId, workspaceId, homeAppId: homeId, bindingId, userId })
  proofs.set(proof, async () => {
    if (!parseBridgeToken({ token, secret }).ok) return null
    const fresh = await current(bindingId, appId, homeId, userId)
    return fresh && fresh.maximumHash === initial.maximumHash && fresh.homeStateHash === initial.homeStateHash
      && fresh.clientRevision === initial.clientRevision && fresh.readOnly === initial.readOnly ? narrow(fresh) : null
  })
  return proof
}
export function getAuthenticatedApplicationHomeCurrent(proof: AuthenticatedApplicationHome) { return proofs.get(proof) }

/** Native session callers only; SQL binds the actual viewer and qualification. */
export async function captureApplicationHomeBinding(actorId: string, homeAppId: string): Promise<string | null> {
  const result = await queryWithRLS<{ id: string | null }>(actorId, 'SELECT application_capture_home_binding($1) AS id', [homeAppId])
  return result.rows[0]?.id ?? null
}
