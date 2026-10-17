/** Pre-auth credential metadata only; this owner lookup never reads business payloads. [COMP:api/application-auth] */
import { query } from '../db/client.js'
import type { ApplicationCredentialState } from './credentials.js'

export async function loadApplicationCredentialStateSystem(id:string):Promise<ApplicationCredentialState|null> {
  const result=await query<Omit<ApplicationCredentialState,'expiresAt'>&{expiresAt:Date}>(`SELECT
    k.id,k.app_id AS "appId",k.workspace_id AS "workspaceId",k.subject_user_id AS "subjectUserId",k.issued_by_user_id AS "issuerUserId",
    k.credential_kind AS "credentialKind",k.secret_hash AS "secretHash",k.version::text AS version,k.client_revision::text AS "clientRevision",k.expires_at AS "expiresAt",true AS admitted
    FROM application_api_credentials k
    JOIN application_clients a ON a.id=k.app_id AND a.workspace_id=k.workspace_id AND a.status='active' AND a.grant_revision=k.client_revision
    JOIN application_access_grants p ON p.id=k.parent_grant_id AND p.app_id=k.app_id AND p.workspace_id=k.workspace_id
      AND p.principal_kind='service' AND p.principal_user_id=k.subject_user_id AND p.status='active'
      AND p.starts_at<=now() AND (p.expires_at IS NULL OR p.expires_at>now())
    JOIN users service ON service.id=k.subject_user_id AND service.auth_provider='channel'
      AND service.auth_provider_id LIKE 'app-service:'||k.app_id::text||':%'
    JOIN workspace_members issuer ON issuer.workspace_id=k.workspace_id AND issuer.user_id=k.issued_by_user_id AND issuer.role IN('owner','admin')
    JOIN workspace_members grant_issuer ON grant_issuer.workspace_id=p.workspace_id AND grant_issuer.user_id=p.issued_by_user_id AND grant_issuer.role IN('owner','admin')
    WHERE k.id=$1 AND k.audience='application_data' AND k.status='active' AND k.expires_at>now()`,[id])
  const row=result.rows[0]
  return row?{...row,expiresAt:row.expiresAt.toISOString()}:null
}
