/** Genuine independently issued credentials and PKCE consent, with no seeded application authority. */
import {createHash,randomBytes,randomUUID} from 'node:crypto'
import {once} from 'node:events'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import express from 'express'
import request from 'supertest'
import {createApplicationClient} from '@use-brian/brian-app/application'
import {createServiceTransport} from '@use-brian/brian-app/module'
import {getPool,getAppPool} from '../../db/client.js'
import {createDbDocEntityStore} from '../../db/doc-entity-store.js'
import {createDbOAuthAuthorizationStore,parseOAuthBearerToken} from '../../db/oauth-authorization-store.js'
import {createDbOAuthClientStore} from '../../db/oauth-client-store.js'
import {createWorkspaceStore} from '../../db/workspace-store.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {createTokens} from '../../auth/jwt.js'
import {requireAuth} from '../../auth/middleware.js'
import {applicationPlatformRoutes} from '../../routes/application-platform.js'
import {ApplicationPlatformService} from '../service.js'
import {ApplicationManagementService} from '../management.js'
import {createCanonicalGenericApplicationModule} from '../generic-adapter.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
describe.sequential('[COMP:api/application-auth] reviewed application delegation',()=>{
 const pool=getPool(),workspaceId=randomUUID(),ownerId=randomUUID(),memberId=randomUUID(),assistantId=randomUUID(),secret='fictional-delegated-native-session'
 const service=new ApplicationPlatformService([createCanonicalGenericApplicationModule()]),management=new ApplicationManagementService(service),http=express(),tokens=new Map<string,string>(),serviceIds:string[]=[]
 const redirectUri='https://portal.example/callback',origin='https://portal.example',store=createDbDocEntityStore({actorUserId:ownerId})
 http.use(express.json());http.use('/api/applications',applicationPlatformRoutes({service,management:{service:management,requireAuth:requireAuth(secret),origins:['https://host.example']},oauth:{clientStore:createDbOAuthClientStore(),workspaceStore:createWorkspaceStore(),signingSecret:secret,webAppUrl:'https://host.example',requireAuth:requireAuth(secret)}}))
 const server=http.listen(0,'127.0.0.1');let apiOrigin:string,appId:string,clientId:string,typeId:string,typeKey:string,recordId:string,serviceUserId:string,userToken:string,userGrant:string
 const base=()=>`/api/applications/${appId}`,manageBase=`/api/applications/workspaces/${workspaceId}/management/commands`
 beforeAll(async()=>{
  if(!server.listening)await once(server,'listening');apiOrigin=`http://127.0.0.1:${(server.address() as {port:number}).port}`
  for(const id of [ownerId,memberId])await pool.query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'email',$1::text)",[id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional delegated workspace',$2)",[workspaceId,ownerId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential'),($1,$3,'member','internal')",[workspaceId,ownerId,memberId])
  await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Fictional delegated assistant',$2,$3,'primary','confidential')",[assistantId,ownerId,workspaceId])
  for(const id of [ownerId,memberId]){const session=await authSessionStore.create(id,{deviceLabel:'Fictional browser',userAgent:'Fixture',ipAddress:'127.0.0.1'});tokens.set(id,createTokens(id,secret,session!).accessToken)}
  const schema=await store.createEntityType({workspaceId,name:'Fictional delegated requests',createdBy:ownerId,properties:[{name:'description',config:{kind:'text'}},{name:'status',config:{kind:'text'}},{name:'privateCost',config:{kind:'text'}}]});typeId=schema.id;typeKey='record.'+typeId
  recordId=(await store.createEntity({workspaceId,entityTypeId:typeId,data:{description:{kind:'text',value:'Permitted request'},status:{kind:'text',value:'open'},privateCost:{kind:'text',value:'hidden'}},sourceApp:'api',createdBy:ownerId,lastEditedBy:ownerId})).id
  const app=await checked({kind:'register',input:{moduleKey:'records',name:'Fictional delegated application',mode:'external_frontend',origins:[origin],redirectUris:[redirectUri]}});appId=app.id;clientId=app.oauthClientId
  serviceUserId=(await checked({kind:'service.prepare',appId,input:{name:'Fictional delegated service',idempotencyKey:randomUUID()}})).serviceUserId;serviceIds.push(serviceUserId)
 })
 afterAll(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.query('DELETE FROM workspaces WHERE id=$1',[workspaceId]);if(clientId)await pool.query('DELETE FROM oauth_clients WHERE client_id=$1',[clientId]);await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[ownerId,memberId,...serviceIds]]);await getAppPool().end();await pool.end()})
 async function checked(value:Record<string,unknown>){const result=await request(http).post(manageBase).set('Authorization','Bearer '+tokens.get(ownerId)).set('Origin','https://host.example').send(value);expect(result.status,JSON.stringify({kind:value.kind,result:result.body})).toBe(200);return result.body}
 function proposal(kind:'service'|'member',userId:string,parentGrantId:string|null=null){return{principal:{kind,userId},origin:{kind:'generic',entityTypeId:typeId},typeKey,actions:['read','query','patch','command:record_patch'],readFields:kind==='service'?['description']:['description','status'],writeFields:['description'],selector:{kind:'ids',ids:[recordId]},parentGrantId,expiresAt:null,compartments:[],projectIds:[],clearance:'internal'}}
 async function grant(kind:'service'|'member',userId:string,parentGrantId:string|null=null){const review=await checked({kind:'grant.review',appId,input:proposal(kind,userId,parentGrantId)});expect(review.canIssue).toBe(true);return(await checked({kind:'grant.apply',appId,reviewId:review.id})).grantId as string}
 async function issue(kind:'service'|'delegated'='delegated'){
  const parent=await grant('service',serviceUserId),leaf=await grant('service',serviceUserId,parent)
  const review=await checked({kind:'credential.review',appId,input:{name:'Fictional delegated key',kind,serviceUserId,grantIds:[leaf],expiresAt:new Date(Date.now()+3600_000).toISOString()}});expect(review.canIssue).toBe(true)
  return{parent,leaf,...await checked({kind:'credential.deliver',appId,reviewId:review.id})}
 }
 async function oauth(){
  const verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url')
  const authorize=await request(http).get(base()+'/authorize').query({client_id:clientId,redirect_uri:redirectUri,response_type:'code',code_challenge:challenge,code_challenge_method:'S256',scope:'read_write',state:'fictional-state'});expect(authorize.status).toBe(302)
  const req=new URL(authorize.headers.location).searchParams.get('req')!,headers={Authorization:'Bearer '+tokens.get(memberId),Origin:'https://host.example'}
  const review=await request(http).get(base()+'/consent').set(headers).query({req});expect(review.status,JSON.stringify(review.body)).toBe(200)
  const consent=await request(http).post(base()+'/consent').set(headers).send({req,workspaceId,decision:'allow',review:review.body.application.review});expect(consent.status,JSON.stringify(consent.body)).toBe(200)
  const code=new URL(consent.body.redirectUrl).searchParams.get('code'),token=await request(http).post(base()+'/token').set('Origin',origin).type('form').send({grant_type:'authorization_code',client_id:clientId,redirect_uri:redirectUri,code,code_verifier:verifier});expect(token.status,JSON.stringify(token.body)).toBe(200)
  return token.body.access_token as string
 }
 const sdk=(token:string,oauthToken=userToken)=>createApplicationClient({appId,transport:createServiceTransport({apiOrigin,credential:async()=>({kind:'delegated',token,userAuthorization:oauthToken})})})
 it('requires explicit reviewed activation and intersects genuinely issued service and application-user authority',async()=>{
  const ordinary=await checked({kind:'activation.review',appId});expect(ordinary.profile).toBe('canonical_records_frontend_v1');await checked({kind:'activation.apply',appId,reviewId:ordinary.id})
  const refused=await checked({kind:'grant.review',appId,input:proposal('service',serviceUserId)});expect(refused.canIssue).toBe(false)
  const reviewed=await checked({kind:'activation.review',appId,profile:'canonical_app_delegation_v1'});expect(reviewed.profile).toBe('canonical_app_delegation_v1');await checked({kind:'activation.apply',appId,reviewId:reviewed.id})
  userGrant=await grant('member',memberId);userToken=await oauth();const delegated=await issue()
  const projection=await sdk(delegated.secret).get(typeKey,recordId);expect(projection.values).toEqual({description:{kind:'text',value:'Permitted request'}})
  const noOAuth=await request(http).get(base()+'/records/'+typeKey+'/'+recordId).set('Authorization','Bearer '+delegated.secret);expect(noOAuth.status).toBe(401)
  await expect(sdk(delegated.secret,tokens.get(memberId)!).get(typeKey,recordId)).rejects.toBeDefined()
  const forged=await request(http).post(base()+'/commands/record_patch').set('Authorization','Bearer '+delegated.secret).set('X-UseBrian-User-Authorization','Bearer '+userToken).send({idempotencyKey:randomUUID(),actorUserId:ownerId,input:{operation:'patch',type:typeKey,id:recordId,data:{description:{kind:'text',value:'forged'}}}});expect(forged.status).toBe(400)
  const standalone=await issue('service'),serviceSdk=createApplicationClient({appId,transport:createServiceTransport({apiOrigin,credential:async()=>({kind:'service',token:standalone.secret})})});expect((await serviceSdk.get(typeKey,recordId)).values).toHaveProperty('description')
  await checked({kind:'grant.revoke',appId,grantId:delegated.leaf});await expect(sdk(delegated.secret).get(typeKey,recordId)).rejects.toBeDefined()
 })
 it('refuses parent, OAuth, issuer and activation revocation under the same issued pair',async()=>{
  const parentPair=await issue();expect(await sdk(parentPair.secret).get(typeKey,recordId)).toBeDefined();await checked({kind:'grant.revoke',appId,grantId:parentPair.parent});await expect(sdk(parentPair.secret).get(typeKey,recordId)).rejects.toBeDefined()
  const pair=await issue();expect(await sdk(pair.secret).get(typeKey,recordId)).toBeDefined()
  await createDbOAuthAuthorizationStore({audience:'application',applicationClientId:appId}).revoke(memberId,parseOAuthBearerToken(userToken,'oat')!.id);await expect(sdk(pair.secret).get(typeKey,recordId)).rejects.toBeDefined()
  userToken=await oauth();expect(await sdk(pair.secret).get(typeKey,recordId)).toBeDefined()
  await checked({kind:'activation.revoke',appId});await expect(sdk(pair.secret).get(typeKey,recordId)).rejects.toBeDefined()
  const reviewed=await checked({kind:'activation.review',appId,profile:'canonical_app_delegation_v1'});await checked({kind:'activation.apply',appId,reviewId:reviewed.id});await expect(sdk(pair.secret).get(typeKey,recordId)).rejects.toBeDefined()
  userToken=await oauth();const current=await issue();expect(await sdk(current.secret).get(typeKey,recordId)).toBeDefined()
  await pool.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",[workspaceId,ownerId]);await expect(sdk(current.secret).get(typeKey,recordId)).rejects.toBeDefined()
 })
})
