/** External-service consent on the shared OAuth protocol. [COMP:api/external-services] */
import { createHash } from 'node:crypto'
import { query } from '../db/client.js'
import { createDbOAuthAuthorizationStore } from '../db/oauth-authorization-store.js'
import { signOAuthState, verifyOAuthState } from '../oauth-state.js'
import type { OAuthRoutesOptions } from '../brain-mcp/oauth/routes.js'
import type { OAuthConsentRequest } from '../brain-mcp/oauth/codes.js'
import { loadExternalServiceAccessSystem } from './context.js'
export const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
export async function loadExternalServiceSystem(id:string) {
 return (await query<{id:string;workspaceId:string;clientId:string;revision:string;name:string;workspaceName:string;redirectUris:string[]}>(`SELECT s.id,s.workspace_id AS "workspaceId",s.oauth_client_id AS "clientId",s.revision::text,s.name,w.name AS "workspaceName",s.redirect_uris AS "redirectUris"
 FROM external_services s JOIN workspaces w ON w.id=s.workspace_id JOIN oauth_clients c ON c.client_id=s.oauth_client_id AND c.revoked_at IS NULL
 WHERE s.id=$1 AND s.status='active'`,[id])).rows[0]??null
}
export function createExternalServiceConsentAdapter(serviceId:string,secret:string):NonNullable<OAuthRoutesOptions['applicationConsent']> {
 async function matching(request:OAuthConsentRequest) {
  const service=await loadExternalServiceSystem(serviceId)
  return service&&request.audience==='service'&&request.applicationId===serviceId&&request.applicationRevision===service.revision&&request.clientId===service.clientId&&service.redirectUris.includes(request.redirectUri)?service:null
 }
 async function review(userId:string,request:OAuthConsentRequest) {
  const service=await matching(request);if(!service)return null
  const access=await loadExternalServiceAccessSystem(service.workspaceId,userId);if(!access)return null
  return {service,access,review:digest({userId,request,access})}
 }
 return {applicationId:serviceId,audience:'service',
  async authorize(clientId,redirectUri){const s=await loadExternalServiceSystem(serviceId);return s&&s.clientId===clientId&&s.redirectUris.includes(redirectUri)?{revision:s.revision}:null},
  async choices(userId,request){const current=await review(userId,request);if(!current)return null
   return {workspaces:[{id:current.service.workspaceId,name:current.service.workspaceName}],application:{id:serviceId,qualified:true,resources:[],review:signOAuthState(current.review,secret)},serviceAccess:current.access}
  },
  async issue(input){const current=await review(input.userId,input.request);if(!current||input.workspaceId!==current.service.workspaceId||verifyOAuthState(input.review,secret)!==current.review)return null
   return createDbOAuthAuthorizationStore({audience:'service',serviceId}).createGrantWithCode({clientId:current.service.clientId,userId:input.userId,workspaceId:input.workspaceId,
    scope:input.scope,codeChallenge:input.request.codeChallenge,redirectUri:input.request.redirectUri,externalServiceRevision:current.service.revision})
  },
 }
}
