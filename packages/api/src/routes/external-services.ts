/** Native-managed, independently deployed workspace services. [COMP:api/external-services] */
import express,{Router,type Request,type Response,type NextFunction} from 'express'
import {z} from 'zod'
import {query,queryWithRLS} from '../db/client.js'
import {createDbOAuthAuthorizationStore,parseOAuthBearerToken} from '../db/oauth-authorization-store.js'
import {verifySecret} from '../db/api-key-store.js'
import {oauthRoutes,type OAuthRoutesOptions} from '../brain-mcp/oauth/routes.js'
import {authenticateExternalService} from '../external-services/context.js'
import {createExternalServiceConsentAdapter} from '../external-services/consent.js'
import {serveStatelessMcp} from '../brain-mcp/stateless.js'
import type {BrainTool} from '../brain-mcp/tools.js'
import {externalServiceCanonicalRoutes} from '../external-services/canonical.js'

type Options=Pick<OAuthRoutesOptions,'clientStore'|'workspaceStore'|'requireAuth'|'signingSecret'|'webAppUrl'>&{origins:readonly string[]}
const uuid=z.string().uuid()
const redirect=z.string().url().refine(raw=>{const u=new URL(raw);return !u.username&&!u.password&&!u.hash&&(u.protocol==='https:'||u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname))})
const registration=z.object({name:z.string().trim().min(1).max(200),redirectUris:z.array(redirect).min(1).max(10)}).strict()
export function externalServicesRoutes(options:Options):Router {
 const router=Router();router.use(express.json({limit:'64kb'}));router.use((_req,res,next)=>{res.set('Cache-Control','no-store');res.set('Pragma','no-cache');next()})
 router.use('/workspaces/:workspaceId',(req,res,next)=>{
  if(req.headers.origin&&!options.origins.includes(req.headers.origin)){res.status(403).json({error:'access_unavailable'});return}next()
 },options.requireAuth)
 const managementCommand=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('list')}).strict(),
  z.object({kind:z.literal('register'),input:registration}).strict(),
  z.object({kind:z.literal('revoke'),serviceId:uuid}).strict(),
 ])
 async function manage(actor:string|undefined,workspaceId:string,raw:unknown){
  if(!actor||!uuid.safeParse(workspaceId).success)throw Object.assign(Error('invalid_request'),{status:400})
  if(!['owner','admin'].includes(await options.workspaceStore.getRole(actor,workspaceId)??''))throw Object.assign(Error('workspace_admin_required'),{status:403})
  const command=managementCommand.parse(raw)
  if(command.kind==='list')return {services:(await queryWithRLS(actor,`SELECT id,name,oauth_client_id AS "clientId",redirect_uris AS "redirectUris",status FROM external_services WHERE workspace_id=$1 ORDER BY created_at,id`,[workspaceId])).rows}
  if(command.kind==='revoke'){
   const updated=await queryWithRLS(actor,`UPDATE external_services SET status='revoked',revision=revision+1 WHERE id=$1 AND workspace_id=$2 RETURNING id`,[command.serviceId,workspaceId])
   if(!updated.rows.length)throw Object.assign(Error('access_unavailable'),{status:403})
   return {revoked:true}
  }
  const client=await options.clientStore.register({clientName:command.input.name,clientUri:new URL(command.input.redirectUris[0]).origin,redirectUris:command.input.redirectUris,tokenEndpointAuthMethod:'none'})
  try {
   const result=await queryWithRLS<{id:string}>(actor,`INSERT INTO external_services(workspace_id,oauth_client_id,name,redirect_uris,created_by_user_id)
    VALUES($1,$2,$3,$4,$5) RETURNING id`,[workspaceId,client.clientId,command.input.name,command.input.redirectUris,actor])
   return {id:result.rows[0].id,clientId:client.clientId}
  }catch(error){
   // A lost acknowledgement may mean registration committed; retain any linked client.
   await query(`DELETE FROM oauth_clients c WHERE c.client_id=$1 AND NOT EXISTS(SELECT 1 FROM external_services s WHERE s.oauth_client_id=c.client_id)`,[client.clientId]).catch(()=>{})
   throw error
  }
 }
 router.post('/workspaces/:workspaceId',async(req,res)=>{const result=await manage(req.userId,String(req.params.workspaceId),{kind:'register',input:req.body});res.status(201).json(result)})
 router.get('/workspaces/:workspaceId',async(req,res)=>{res.json(await manage(req.userId,String(req.params.workspaceId),{kind:'list'}))})
 router.delete('/workspaces/:workspaceId/:serviceId',async(req,res)=>{await manage(req.userId,String(req.params.workspaceId),{kind:'revoke',serviceId:req.params.serviceId});res.sendStatus(204)})
 router.post('/workspaces/:workspaceId/mcp',async(req,res)=>{
  const tool:BrainTool={name:'externalServiceManagement',description:'List, register or revoke independently deployed services for this workspace. Requires current native owner/admin authorization.',
   inputSchema:{kind:z.enum(['list','register','revoke']),serviceId:uuid.optional(),input:registration.optional()},
   handler:async input=>{try{const value=await manage(req.userId,String(req.params.workspaceId),input);return {content:[{type:'text',text:JSON.stringify(value)}]}}catch(error){return {isError:true,content:[{type:'text',text:JSON.stringify({error:error instanceof z.ZodError?'invalid_request':'access_unavailable'})}]}}}}

  await serveStatelessMcp(req,res,[tool],'use-brian-external-services-management')
 })
 router.use('/:serviceId',(req,res,next)=>{if(!uuid.safeParse(req.params.serviceId).success){res.status(404).json({error:'access_unavailable'});return}next()})
 router.get('/:serviceId/context',async(req,res)=>{
  const header=req.headers.authorization,context=header?.startsWith('Bearer ')?await authenticateExternalService(header.slice(7),String(req.params.serviceId)):null
  if(!context){res.status(401).json({error:'invalid_token'});return}res.json(context)
 })
 router.post('/:serviceId/oauth/revoke',express.urlencoded({extended:false}),async(req,res)=>{
  // Possession of the exact service's access OR refresh token authorizes disconnect.
  const token=req.body?.token,serviceId=String(req.params.serviceId),parsed=typeof token==='string'&&token.length<=128?(parseOAuthBearerToken(token,'oat')??parseOAuthBearerToken(token,'ort')):null
  if(parsed){const row=await createDbOAuthAuthorizationStore({audience:'service',serviceId}).getByIdSystem(parsed.id)
   const hash=token.startsWith('oat_')?row?.accessTokenHash:row?.refreshTokenHash
   if(row&&hash&&await verifySecret(parsed.secret,hash))await query(`UPDATE oauth_authorizations SET revoked_at=now(),code_hash=NULL,access_token_hash=NULL,refresh_token_hash=NULL WHERE id=$1 AND audience='service' AND external_service_id=$2`,[parsed.id,serviceId])
  }res.sendStatus(200)
 })
 router.use('/:serviceId/oauth',(req,res,next)=>{const serviceId=String(req.params.serviceId);return oauthRoutes({...options,
  authorizationStore:createDbOAuthAuthorizationStore({audience:'service',serviceId}),applicationConsent:createExternalServiceConsentAdapter(serviceId,options.signingSecret)})(req,res,next)})
 router.use('/:serviceId',externalServiceCanonicalRoutes())
 router.use((error:unknown,_req:Request,res:Response,_next:NextFunction)=>{
  const status=error instanceof z.ZodError?400:typeof error==='object'&&error!==null&&'status' in error&&typeof error.status==='number'?error.status:503
  res.status(status).json({error:status===400?'invalid_request':status===403?'workspace_admin_required':'access_unavailable'})
 })
 return router
}
