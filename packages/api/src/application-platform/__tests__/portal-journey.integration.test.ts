/** Real Brian sign-in, reviewed generic grants and PKCE portal CRUD. No app authority is seeded. */
import {createHash,randomBytes,randomUUID} from 'node:crypto'
import {once} from 'node:events'
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest'
import express from 'express'
import request from 'supertest'
import {createApplicationClient,createFetchTransport} from '@use-brian/brian-app/application'
import {getPool,getAppPool} from '../../db/client.js'
import {createDbDocEntityStore} from '../../db/doc-entity-store.js'
import {createDbOAuthAuthorizationStore,parseOAuthBearerToken} from '../../db/oauth-authorization-store.js'
import {createDbOAuthClientStore} from '../../db/oauth-client-store.js'
import {createWorkspaceStore} from '../../db/workspace-store.js'
import {createDbMagicLinkStore} from '../../db/magic-link-store.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {createTokens} from '../../auth/jwt.js'
import {requireAuth} from '../../auth/middleware.js'
import {authRoutes} from '../../routes/auth.js'
import {applicationPlatformRoutes} from '../../routes/application-platform.js'
import {ApplicationPlatformService} from '../service.js'
import {createApplicationConsentAdapter} from '../oauth-consent.js'
import {verifyConsentRequest} from '../../brain-mcp/oauth/codes.js'
import {ApplicationManagementService} from '../management.js'
import {createCanonicalGenericApplicationModule} from '../generic-adapter.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
describe.sequential('[COMP:api/application-auth] [COMP:api/application-management] verified generic portal journey',()=>{
 const pool=getPool(),workspaceId=randomUUID(),ownerId=randomUUID(),assistantId=randomUUID(),secret='fictional-portal-native-session'
 const http=express(),service=new ApplicationPlatformService([createCanonicalGenericApplicationModule()]),management=new ApplicationManagementService(service),store=createDbDocEntityStore({actorUserId:ownerId})
 const redirectUri='https://portal.example/callback',origin='https://portal.example',send=vi.fn().mockResolvedValue(undefined),magic=createDbMagicLinkStore(),users:string[]=[],emails:string[]=[]
 http.use(express.json());http.use('/auth',authRoutes(secret,'fictional-google-client',undefined,undefined,{magicLinkStore:magic,smtpClient:{sendMagicLink:send} as never,appUrl:'https://host.example',canSignInEmail:async()=>false},undefined,undefined,authSessionStore))
 http.use('/api/applications',applicationPlatformRoutes({service,management:{service:management,requireAuth:requireAuth(secret),origins:['https://host.example']},oauth:{clientStore:createDbOAuthClientStore(),workspaceStore:createWorkspaceStore(),signingSecret:secret,webAppUrl:'https://host.example',requireAuth:requireAuth(secret)}}))
 const server=http.listen(0,'127.0.0.1');let apiOrigin:string,ownerToken:string,appId:string,clientId:string,typeId:string,typeKey:string,ownId:string,foreignId:string
 let portal:{id:string;nativeToken:string},parentId:string,token:string,refreshToken:string,createdId:string
 const base=()=>`/api/applications/${appId}`,manageBase=`/api/applications/workspaces/${workspaceId}/management/commands`
 beforeAll(async()=>{
  if(!server.listening)await once(server,'listening');apiOrigin=`http://127.0.0.1:${(server.address() as {port:number}).port}`
  await pool.query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'email',$1::text)",[ownerId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional portal workspace',$2)",[workspaceId,ownerId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')",[workspaceId,ownerId])
  await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Fictional portal assistant',$2,$3,'primary','confidential')",[assistantId,ownerId,workspaceId])
  const session=await authSessionStore.create(ownerId,{deviceLabel:'Fictional owner browser',userAgent:'Fixture',ipAddress:'127.0.0.1'});ownerToken=createTokens(ownerId,secret,session!).accessToken
  const schema=await store.createEntityType({workspaceId,name:'Fictional portal requests',createdBy:ownerId,properties:[{name:'description',required:true,config:{kind:'text'}},{name:'status',config:{kind:'select',options:[{id:'open',name:'Open'},{id:'closed',name:'Closed'}]}},{name:'privateCost',config:{kind:'text'}}]});typeId=schema.id;typeKey='record.'+typeId
  for(const title of ['Own permitted request','Another customer request']){const row=await store.createEntity({workspaceId,entityTypeId:typeId,data:{description:{kind:'text',value:title},status:{kind:'select',value:'open'},privateCost:{kind:'text',value:'restricted-cost'}},sourceApp:'api',createdBy:ownerId,lastEditedBy:ownerId});if(!ownId)ownId=row.id;else foreignId=row.id}
  const app=await checked({kind:'register',input:{moduleKey:'records',name:'Fictional customer portal',mode:'external_frontend',origins:[origin],redirectUris:[redirectUri]}});appId=app.id;clientId=app.oauthClientId
  const activation=await checked({kind:'activation.review',appId});expect(activation.profile).toBe('canonical_records_frontend_v1');await checked({kind:'activation.apply',appId,reviewId:activation.id})
 })
 afterAll(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));const client=appId&&(await pool.query('SELECT oauth_client_id AS id FROM application_clients WHERE id=$1',[appId])).rows[0]?.id;await pool.query('DELETE FROM workspaces WHERE id=$1',[workspaceId]);if(client)await pool.query('DELETE FROM oauth_clients WHERE client_id=$1',[client]);await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[ownerId,...users]]);if(emails.length)await pool.query('DELETE FROM magic_link_tokens WHERE email=ANY($1::text[])',[emails]);await getAppPool().end();await pool.end()})
 async function checked(value:Record<string,unknown>){const response=await request(http).post(manageBase).set('Authorization','Bearer '+ownerToken).set('Origin','https://host.example').send(value);if(response.status===503)await management.executeCommand(ownerId,workspaceId,value);expect(response.status,JSON.stringify({kind:value.kind,result:response.body})).toBe(200);return response.body}
 async function authorize(scope='read_write'){
  const verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url')
  const response=await request(http).get(base()+'/authorize').query({client_id:clientId,redirect_uri:redirectUri,response_type:'code',code_challenge:challenge,code_challenge_method:'S256',scope,state:'fictional-state'})
  expect(response.status,JSON.stringify(response.body)).toBe(302);return {verifier,signed:new URL(response.headers.location).searchParams.get('req')!}
 }
 async function signIn(signed:string){const email='portal-'+randomUUID()+'@example.com';emails.push(email);const start=await request(http).post('/auth/email/request-link').send({email,nextPath:'/oauth/authorize?application='+appId+'&req='+encodeURIComponent(signed)});expect(start.status).toBe(200);const link=new URL(send.mock.calls.at(-1)![1]);const result=await request(http).post('/auth/email/verify').send({token:link.searchParams.get('token')});expect(result.status,JSON.stringify(result.body)).toBe(200);users.push(result.body.user.id);return{id:result.body.user.id,nativeToken:result.body.accessToken}}
 async function grant(userId:string,selection:{kind:'self'}|{kind:'ids';ids:string[]},actions:string[]){const review=await checked({kind:'grant.review',appId,input:{principal:{kind:'external_user',userId},origin:{kind:'generic',entityTypeId:typeId},typeKey,actions,readFields:['description','status'],writeFields:['description','status'],selector:selection,parentGrantId:null,expiresAt:null,compartments:[],projectIds:[],clearance:'internal'}});expect(review.canIssue).toBe(true);return(await checked({kind:'grant.apply',appId,reviewId:review.id})).grantId as string}
 async function consent(signed:string,user=portal){const result=await request(http).get(base()+'/consent').query({req:signed}).set('Authorization','Bearer '+user.nativeToken).set('Origin','https://host.example');expect(result.status,JSON.stringify(result.body)).toBe(200);return result.body.application}
 async function exchange(flow:{verifier:string;signed:string},review:Record<string,unknown>){const allow=await request(http).post(base()+'/consent').set('Authorization','Bearer '+portal.nativeToken).send({req:flow.signed,workspaceId,decision:'allow',review:review.review});if(allow.status===503)await createApplicationConsentAdapter(appId,secret).issue({userId:portal.id,workspaceId,request:verifyConsentRequest(flow.signed,secret)!,review:review.review as string,scope:'read_write'});expect(allow.status,JSON.stringify(allow.body)).toBe(200);const code=new URL(allow.body.redirectUrl).searchParams.get('code');const response=await request(http).post(base()+'/token').set('Origin',origin).type('form').send({grant_type:'authorization_code',client_id:clientId,redirect_uri:redirectUri,code,code_verifier:flow.verifier});if(response.status===503){const parsed=parseOAuthBearerToken(code!,'oac')!;await createDbOAuthAuthorizationStore({audience:'application',applicationClientId:appId}).exchangeCodeForTokens({codeId:parsed.id,codeSecret:parsed.secret,codeVerifier:flow.verifier,redirectUri,clientId})};expect(response.status,JSON.stringify(response.body)).toBe(200);return response.body}
 function sdk(bearer=token){return createApplicationClient({appId,transport:createFetchTransport({apiOrigin,credential:async()=>bearer,fetch:async(input,init)=>fetch(input,{...init,headers:{...init?.headers,Origin:origin}})})})}
 it('signs in through Brian without membership and completes genuine reviewed PKCE read/query/patch/create under exact customer fields and IDs',async()=>{
  const flow=await authorize();portal=await signIn(flow.signed)
  expect((await pool.query('SELECT 1 FROM workspace_members WHERE user_id=$1',[portal.id])).rowCount).toBe(0)
  expect((await pool.query('SELECT 1 FROM workspaces WHERE owner_user_id=$1',[portal.id])).rowCount).toBe(0)
  parentId=await grant(portal.id,{kind:'ids',ids:[ownId]},['read','query','history','patch','command:record_patch'])
  await grant(portal.id,{kind:'self'},['read','query','create','patch','command:record_create','command:record_patch'])
  const review=await consent(flow.signed);expect(review.qualified).toBe(true)
  const issued=await exchange(flow,review);token=issued.access_token;refreshToken=issued.refresh_token
  const client=sdk();expect(await client.get(typeKey,ownId)).toMatchObject({values:{description:{value:'Own permitted request'}}})
  expect((await client.get(typeKey,ownId)).values).not.toHaveProperty('privateCost')
  await expect(client.get(typeKey,foreignId)).rejects.toBeDefined()
  const list=await client.query(typeKey,{fields:['description'],filters:[],sort:[],aggregate:[],limit:100});expect(list.records.map(record=>record.ref.id)).toEqual([ownId])
  await client.command('record_patch',{idempotencyKey:randomUUID(),expectedVersion:'1',input:{operation:'patch',type:typeKey,id:ownId,data:{status:{kind:'select',value:'closed'}}}})
  await expect(client.command('record_patch',{idempotencyKey:randomUUID(),expectedVersion:'2',input:{operation:'patch',type:typeKey,id:ownId,data:{privateCost:{kind:'text',value:'denied'}}}})).rejects.toBeDefined()
  const created=await client.command('record_create',{idempotencyKey:randomUUID(),input:{operation:'create',type:typeKey,data:{description:{kind:'text',value:'Portal-created request'},status:{kind:'select',value:'open'}}}});createdId=created.resources[0].id
  expect(await client.get(typeKey,createdId)).toMatchObject({values:{description:{value:'Portal-created request'}}})
  const hashes=await pool.query('SELECT access_token_hash,refresh_token_hash FROM oauth_authorizations WHERE application_client_id=$1',[appId]);expect(JSON.stringify(hashes.rows)).not.toContain(token);expect(JSON.stringify(hashes.rows)).not.toContain(refreshToken)
 },60_000)
 it('rejects stale consent/old OAuth generations after activation replacement and preserves fresh genuine consent',async()=>{
  const flow=await authorize(),review=await consent(flow.signed);await checked({kind:'activation.revoke',appId})
  await expect(sdk().get(typeKey,ownId)).rejects.toBeDefined()
  const next=await checked({kind:'activation.review',appId});await checked({kind:'activation.apply',appId,reviewId:next.id})
  await expect(sdk().get(typeKey,ownId)).rejects.toBeDefined()
  const stale=await request(http).post(base()+'/consent').set('Authorization','Bearer '+portal.nativeToken).send({req:flow.signed,workspaceId,decision:'allow',review:review.review});expect(stale.status).toBe(409)
  const fresh=await authorize(),current=await consent(fresh.signed),issued=await exchange(fresh,current);token=issued.access_token;refreshToken=issued.refresh_token
  expect(await sdk().get(typeKey,createdId)).toMatchObject({ref:{id:createdId}})
  expect((await request(http).post(base()+'/token').type('form').send({grant_type:'refresh_token',client_id:clientId,refresh_token:'ort_'+randomUUID()+'_foreign'})).status).toBe(400)
  await checked({kind:'grant.revoke',appId,grantId:parentId});await expect(sdk().get(typeKey,ownId)).rejects.toBeDefined()
 },60_000)
})
