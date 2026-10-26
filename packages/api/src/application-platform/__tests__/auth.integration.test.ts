import { createHash,randomBytes,randomUUID } from 'node:crypto'
import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest'
import express, { type Request } from 'express'
import request from 'supertest'
import { getAppPool,getPool,queryWithRLS } from '../../db/client.js'
import { hashSecret } from '../../db/api-key-store.js'
import { createDbOAuthAuthorizationStore,parseOAuthBearerToken } from '../../db/oauth-authorization-store.js'
import { createDbOAuthClientStore } from '../../db/oauth-client-store.js'
import { authenticateBrainRequest } from '../../brain-mcp/auth.js'
import { requireAuth } from '../../auth/middleware.js'
import { findOrCreateUser, findUserById } from '../../db/users.js'
import { createDbMagicLinkStore } from '../../db/magic-link-store.js'
import { authRoutes } from '../../routes/auth.js'
import { authenticateApplicationCredential,getAuthenticatedApplicationCredentialCurrent,mintApplicationCredentialSecret } from '../credentials.js'
import { loadApplicationCredentialStateSystem } from '../auth-store.js'
import { applicationPlatformRoutes } from '../../routes/application-platform.js'
import { ApplicationPlatformService } from '../service.js'
import { createCanonicalNativeApplicationModule } from '../native-adapters.js'
import { createWorkspaceStore } from '../../db/workspace-store.js'
import { authSessionStore } from '../../db/auth-session-store.js'
import { createTokens } from '../../auth/jwt.js'
import { oauthRoutes } from '../../brain-mcp/oauth/routes.js'
import { signConsentRequest } from '../../brain-mcp/oauth/codes.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()

describe('[COMP:api/application-auth] real credential and OAuth audience boundaries',()=>{
  const pool=getPool(),workspaceId=randomUUID(),ownerId=randomUUID(),externalId=randomUUID(),appId=randomUUID()
  let clientId:string,clientRowId:string
  const redirectUri='https://client.example/callback'
  const createdUsers: string[] = [], signInEmails: string[] = []
  beforeAll(async()=>{
    for(const id of [ownerId,externalId])await pool.query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'email',$1::text)",[id])
    await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Application auth fixture',$2)",[workspaceId,ownerId])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')",[workspaceId,ownerId])
    const client=await createDbOAuthClientStore().register({clientName:'Example frontend',clientUri:'https://client.example',redirectUris:[redirectUri],tokenEndpointAuthMethod:'none'})
    clientId=client.clientId;clientRowId=client.id
    await pool.query(`INSERT INTO application_clients(id,workspace_id,module_key,name,client_mode,origins,redirect_uris,oauth_client_id,created_by_user_id)
      VALUES($1,$2,'native','Example frontend','external_frontend',ARRAY['https://client.example'],$3,$4,$5)`,[appId,workspaceId,[redirectUri],clientId,ownerId])
  })
  afterAll(async()=>{
    await pool.query('DELETE FROM workspaces WHERE id=$1',[workspaceId])
    await pool.query('DELETE FROM oauth_clients WHERE id=$1',[clientRowId])
    await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[ownerId,externalId]])
    if(createdUsers.length)await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[createdUsers])
    if(signInEmails.length)await pool.query('DELETE FROM magic_link_tokens WHERE email=ANY($1::text[])',[signInEmails])
    await getAppPool().end();await pool.end()
  })
  async function appCode() {
    const id=randomUUID(),parentId=randomUUID(),secret=randomBytes(32).toString('base64url'),verifier=randomBytes(32).toString('base64url')
    const challenge=createHash('sha256').update(verifier).digest('base64url')
    // Direct synthetic provisioning is confined to this marker-guarded test fixture.
    await pool.query(`INSERT INTO application_access_grants(id,app_id,workspace_id,principal_kind,principal_user_id,issued_by_user_id,
      resource_origin,resource_type,actions,read_fields,write_fields,selector,compartments,project_ids,clearance)
      VALUES($1,$2,$3,'external_user',$4,$5,'{"kind":"native","moduleKey":"native"}','company',ARRAY['read','query'],ARRAY['name'],'{}',
        '{"kind":"ids","ids":["fixture-record"]}','{}','{}','internal')`,[parentId,appId,workspaceId,externalId,ownerId])
    await pool.query(`INSERT INTO oauth_authorizations(id,client_id,user_id,workspace_id,scope,audience,application_client_id,
      code_hash,code_expires_at,code_challenge,code_redirect_uri) VALUES($1,$2,$3,$4,'read_write','application',$5,$6,now()+interval '10 minutes',$7,$8)`,
    [id,clientId,externalId,workspaceId,appId,await hashSecret(secret),challenge,redirectUri])
    await pool.query(`INSERT INTO application_oauth_bindings(authorization_id,app_id,workspace_id,principal_user_id,parent_grant_id,maximum_grants)
      VALUES($1,$2,$3,$4,$5,$6)`,[id,appId,workspaceId,externalId,parentId,JSON.stringify([{version:1,grants:[{id:parentId}]}])])
    return {id,parentId,secret,verifier,challenge}
  }
  function applicationRequest(secret: string) {
    return signConsentRequest({clientId,redirectUri,codeChallenge:randomBytes(32).toString('base64url'),codeChallengeMethod:'S256',scope:'read',state:null,
      audience:'application',applicationId:appId,applicationRevision:'1',exp:Math.floor(Date.now()/1000)+600},secret)
  }
  it('reuses real native Google/email/OIDC sessions without creating a personal workspace or staff enrollment',async()=>{
    const secret='fictional-application-onboarding-secret',signed=applicationRequest(secret),magicLinkStore=createDbMagicLinkStore()
    const nextPath=`/oauth/authorize?application=${appId}&req=${encodeURIComponent(signed)}`
    const enroll=vi.fn(),bind=vi.fn(),send=vi.fn().mockResolvedValue(undefined),googleEmail=`portal-google-${randomUUID()}@example.com`,email=`portal-email-${randomUUID()}@example.com`,oidcEmail=`portal-oidc-${randomUUID()}@example.com`
    signInEmails.push(email)
    const http=express();http.use(express.json());http.use('/auth',authRoutes(secret,'fixture-google-client',undefined,undefined,
      {magicLinkStore,smtpClient:{sendMagicLink:send} as never,appUrl:'https://host.example',canSignInEmail:async()=>false},undefined,
      {config:{issuer:'https://identity.example',bridgeSecret:'fictional-local-oidc-bridge',subjectIdentityEnabled:true,
        enrollment:{mode:'mapped',additionalScopes:[],rules:[{emailDomain:'example.com',workspaceId}]}},
      canSignInEmail:async()=>false,findUserBySubject:async id=>{
        const row=(await pool.query("SELECT id FROM users WHERE auth_provider='oidc' AND auth_provider_id=$1",[id])).rows[0]
        return row?findUserById(row.id):null
      },bindUserSubject:bind,ensureWorkspaceMembership:enroll},authSessionStore))
    http.get('/native',requireAuth(secret),(req,res)=>res.json({userId:req.userId}))
    const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({sub:`fixture-${randomUUID()}`,email:googleEmail,email_verified:true,aud:'fixture-google-client'}),{status:200}))
    try {
      const google=await request(http).post('/auth/google').send({idToken:'fictional-provider-proof',applicationRequest:signed})
      expect(google.status).toBe(200);createdUsers.push(google.body.user.id)
      const sent=await request(http).post('/auth/email/request-link').send({email,nextPath})
      expect(sent.status).toBe(200);expect(send).toHaveBeenCalledTimes(1)
      const emailed=new URL(send.mock.calls[0][1])
      expect(emailed.searchParams.get('next')).toBe(nextPath)
      const verified=await request(http).post('/auth/email/verify').send({token:emailed.searchParams.get('token')})
      expect(verified.status).toBe(200);createdUsers.push(verified.body.user.id)
      const again=await magicLinkStore.create({email,nextPath})
      const code=await request(http).post('/auth/email/verify-code').send({email,code:again.code})
      expect(code.status).toBe(200);expect(code.body.user.id).toBe(verified.body.user.id);expect(code.body.isNew).toBe(false)
      const oidc=await request(http).post('/auth/oidc/session').set('X-Outpost-Auth-Bridge','fictional-local-oidc-bridge')
        .set('X-UseBrian-Application-Request',signed).send({issuer:'https://identity.example',subject:`fixture-${randomUUID()}`,email:oidcEmail,emailVerified:true})
      expect(oidc.status).toBe(200);createdUsers.push(oidc.body.user.id)
      expect(enroll).not.toHaveBeenCalled();expect(bind).not.toHaveBeenCalled()
      for(const result of [google,verified,code,oidc]) {
        expect((await request(http).get('/native').set('Authorization',`Bearer ${result.body.accessToken}`)).body).toEqual({userId:result.body.user.id})
        expect((await pool.query('SELECT id FROM workspaces WHERE owner_user_id=$1',[result.body.user.id])).rows).toEqual([])
        expect((await pool.query('SELECT workspace_id FROM workspace_members WHERE user_id=$1',[result.body.user.id])).rows).toEqual([])
        expect((await pool.query('SELECT id FROM assistants WHERE owner_user_id=$1',[result.body.user.id])).rows).toEqual([])
      }
      const bad=await request(http).post('/auth/google').send({idToken:'fictional-provider-proof',applicationRequest:signed+'tampered'})
      expect(bad.status).toBe(400);expect(fetch).toHaveBeenCalledTimes(1)
      fetch.mockResolvedValueOnce(new Response(JSON.stringify({sub:`fixture-${randomUUID()}`,email:`unverified-${randomUUID()}@example.com`,email_verified:false,aud:'fixture-google-client'}),{status:200}))
      expect((await request(http).post('/auth/google').send({idToken:'fictional-unverified-proof',applicationRequest:signed})).status).toBe(401)
      await pool.query("UPDATE application_clients SET name='Changed frontend' WHERE id=$1",[appId])
      expect((await request(http).post('/auth/google').send({idToken:'fictional-provider-proof',applicationRequest:signed})).status).toBe(400)
    } finally {
      fetch.mockRestore()
      await pool.query("UPDATE application_clients SET name='Example frontend' WHERE id=$1",[appId])
    }
  })
  it('keeps all application issuance denied before actual runtime qualification',async()=>{
    const store=createDbOAuthAuthorizationStore({audience:'application',applicationClientId:appId})
    await expect(store.createGrantWithCode({clientId,userId:externalId,workspaceId,scope:'read',codeChallenge:'fixture',redirectUri})).rejects.toThrow('not qualified')
    await expect(queryWithRLS(ownerId,`INSERT INTO application_access_grants(app_id,workspace_id,principal_kind,principal_user_id,issued_by_user_id,
      resource_origin,resource_type,actions,read_fields,write_fields,selector,compartments,project_ids,clearance)
      VALUES($1,$2,'external_user',$3,$4,'{"kind":"native","moduleKey":"native"}','company',ARRAY['read'],ARRAY['name'],'{}',
        '{"kind":"ids","ids":["fixture-record"]}','{}','{}','internal')`,[appId,workspaceId,externalId,ownerId])).rejects.toMatchObject({code:'42501'})
  })
  it('uses the shared PKCE/single-use lifecycle while refusing Brain/member audience crossover',async()=>{
    const code=await appCode(),brain=createDbOAuthAuthorizationStore(),appStore=createDbOAuthAuthorizationStore({audience:'application',applicationClientId:appId})
    const input={codeId:code.id,codeSecret:code.secret,codeVerifier:code.verifier,redirectUri,clientId}
    expect(await brain.exchangeCodeForTokens(input)).toBeNull()
    expect(await appStore.exchangeCodeForTokens({...input,codeVerifier:'wrong-verifier'})).toBeNull()
    const issued=await appStore.exchangeCodeForTokens(input)
    expect(issued?.row).toMatchObject({audience:'application',applicationClientId:appId,userId:externalId})
    expect(issued?.tokens.expiresIn).toBe(600)
    expect(await appStore.exchangeCodeForTokens(input)).toBeNull()
    expect(await brain.getByIdSystem(code.id)).toBeNull()
    const token=issued!.tokens.accessToken
    expect(await authenticateBrainRequest({headers:{authorization:`Bearer ${token}`}} as Request,
      {brainKeyStore:{} as never,authorizationStore:appStore})).toBeNull()
    const http=express();http.get('/native',requireAuth('fixture-native-jwt-secret'),(_req,res)=>res.json({unexpected:true}))
    expect((await request(http).get('/native').set('Authorization',`Bearer ${token}`)).status).toBe(401)
    const refresh=parseOAuthBearerToken(issued!.tokens.refreshToken,'ort')!
    const rotated=await Promise.all([appStore.rotateOnRefresh({refreshId:refresh.id,refreshSecret:refresh.secret,clientId}),appStore.rotateOnRefresh({refreshId:refresh.id,refreshSecret:refresh.secret,clientId})])
    expect(rotated.filter(Boolean)).toHaveLength(1)
    const stored=await pool.query('SELECT access_token_hash,refresh_token_hash FROM oauth_authorizations WHERE id=$1',[code.id])
    expect(JSON.stringify(stored.rows[0])).not.toContain(token)
    await expect(pool.query("UPDATE oauth_authorizations SET audience='brain',application_client_id=NULL WHERE id=$1",[code.id])).rejects.toMatchObject({code:'22023'})
  })
  it('retains the legacy Brain audience and native caller identity by default',async()=>{
    const store=createDbOAuthAuthorizationStore(),verifier=randomBytes(32).toString('base64url')
    const grant=await store.createGrantWithCode({clientId,userId:ownerId,workspaceId,scope:'read',codeChallenge:createHash('sha256').update(verifier).digest('base64url'),redirectUri})
    const parts=parseOAuthBearerToken(grant.codePlaintext,'oac')!
    const issued=await store.exchangeCodeForTokens({codeId:parts.id,codeSecret:parts.secret,codeVerifier:verifier,redirectUri,clientId})
    expect(issued?.row.audience).toBe('brain')
    const auth=await authenticateBrainRequest({headers:{authorization:`Bearer ${issued!.tokens.accessToken}`}} as Request,
      {brainKeyStore:{} as never,authorizationStore:store})
    expect(auth).toMatchObject({actingUserId:ownerId,workspaceId,scope:'read'})
  })
  it('refuses code exchange and refresh after current parent revocation',async()=>{
    const store=createDbOAuthAuthorizationStore({audience:'application',applicationClientId:appId}),code=await appCode()
    const issued=await store.exchangeCodeForTokens({codeId:code.id,codeSecret:code.secret,codeVerifier:code.verifier,redirectUri,clientId})
    expect(issued).not.toBeNull()
    await pool.query("UPDATE application_access_grants SET status='revoked' WHERE id=$1",[code.parentId])
    const refresh=parseOAuthBearerToken(issued!.tokens.refreshToken,'ort')!
    expect(await store.rotateOnRefresh({refreshId:refresh.id,refreshSecret:refresh.secret,clientId})).toBeNull()
    expect(await store.getByIdSystem(code.id)).toBeNull()
    const unexchanged=await appCode()
    await pool.query("UPDATE application_access_grants SET status='revoked' WHERE id=$1",[unexchanged.parentId])
    expect(await store.exchangeCodeForTokens({codeId:unexchanged.id,codeSecret:unexchanged.secret,codeVerifier:unexchanged.verifier,redirectUri,clientId})).toBeNull()
  })
  it('routes application PKCE, native-session consent reviews and Brain audience rejection through the shared HTTP protocol',async()=>{
    const secret='fictional-consent-session-secret',code=await appCode(),clientStore=createDbOAuthClientStore(),workspaceStore=createWorkspaceStore()
    const nativeSession=await authSessionStore.create(externalId,{deviceLabel:'Fixture browser',userAgent:'Fixture browser',ipAddress:'127.0.0.1'})
    const nativeToken=createTokens(externalId,secret,nativeSession!).accessToken
    const shared={clientStore,workspaceStore,signingSecret:secret,webAppUrl:'https://host.example',requireAuth:requireAuth(secret)}
    const http=express();http.use(express.json())
    http.use('/api/applications',applicationPlatformRoutes({service:new ApplicationPlatformService([createCanonicalNativeApplicationModule()]),oauth:shared}))
    http.use('/api/brain/oauth',oauthRoutes({...shared,authorizationStore:createDbOAuthAuthorizationStore()}))
    const base=`/api/applications/${appId}`
    const authorize=await request(http).get(`${base}/authorize`).query({client_id:clientId,redirect_uri:redirectUri,response_type:'code',
      code_challenge:code.challenge,code_challenge_method:'S256',scope:'read',state:'fixture-state'})
    expect(authorize.status).toBe(302)
    const destination=new URL(authorize.headers.location),signed=destination.searchParams.get('req')!
    expect(destination.origin).toBe('https://host.example');expect(destination.searchParams.get('application')).toBe(appId)
    const review=await request(http).get(`${base}/consent`).query({req:signed}).set('Authorization',`Bearer ${nativeToken}`).set('Origin','https://host.example')
    expect(review.status).toBe(200);expect(review.body.application).toMatchObject({id:appId,qualified:false})
    expect(review.body.workspaces).toEqual([{id:workspaceId,name:'Example frontend'}])
    expect(review.body.application.resources.every((resource:{readFields:string[]})=>resource.readFields.includes('name'))).toBe(true)
    expect((await request(http).get('/api/brain/oauth/consent').query({req:signed}).set('Authorization',`Bearer ${nativeToken}`)).status).toBe(400)
    const brainRequest=signConsentRequest({clientId,redirectUri,codeChallenge:code.challenge,codeChallengeMethod:'S256',scope:'read',state:null,exp:Math.floor(Date.now()/1000)+600},secret)
    expect((await request(http).get(`${base}/consent`).query({req:brainRequest}).set('Authorization',`Bearer ${nativeToken}`)).status).toBe(400)
    const before=(await pool.query('SELECT count(*)::int AS n FROM oauth_authorizations WHERE application_client_id=$1',[appId])).rows[0].n
    const decision={req:signed,workspaceId,decision:'allow',review:review.body.application.review}
    const held=await request(http).post(`${base}/consent`).set('Authorization',`Bearer ${nativeToken}`).send(decision)
    expect(held.status).toBe(403);expect(held.body.error).toBe('application_not_qualified')
    await pool.query("UPDATE application_access_grants SET read_fields=ARRAY['name','domain'] WHERE id=$1",[code.parentId])
    const stale=await request(http).post(`${base}/consent`).set('Authorization',`Bearer ${nativeToken}`).send(decision)
    expect(stale.status).toBe(409);expect(stale.body.error).toBe('application_review_changed')
    expect((await pool.query('SELECT count(*)::int AS n FROM oauth_authorizations WHERE application_client_id=$1',[appId])).rows[0].n).toBe(before)
    const tokenBody={grant_type:'authorization_code',client_id:clientId,redirect_uri:redirectUri,code:`oac_${code.id}_${code.secret}`,code_verifier:code.verifier}
    expect((await request(http).post('/api/brain/oauth/token').type('form').send(tokenBody)).status).toBe(400)
    const issued=await request(http).post(`${base}/token`).set('Origin','https://client.example').type('form').send(tokenBody)
    expect(issued.status).toBe(200);expect(issued.body.expires_in).toBe(600);expect(issued.headers['cache-control']).toBe('no-store')
    expect((await request(http).post(`${base}/token`).type('form').send(tokenBody)).status).toBe(400)
    await pool.query("UPDATE application_access_grants SET status='revoked' WHERE id=$1",[code.parentId])
    expect((await request(http).post(`${base}/token`).type('form').send({grant_type:'refresh_token',client_id:clientId,refresh_token:issued.body.refresh_token})).status).toBe(400)
  })
  it('resolves a hashed named service without membership or owner fallback and observes parent revocation',async()=>{
    const service=await findOrCreateUser({authProvider:'channel',authProviderId:`app-service:${appId}:${randomUUID()}`,name:'Example service'})
    const serviceId=service.user.id,parentId=randomUUID(),material=await mintApplicationCredentialSecret()
    try {
      await pool.query(`INSERT INTO application_access_grants(id,app_id,workspace_id,principal_kind,principal_user_id,issued_by_user_id,
        resource_origin,resource_type,actions,read_fields,write_fields,selector,compartments,project_ids,clearance)
        VALUES($1,$2,$3,'service',$4,$5,'{"kind":"native","moduleKey":"native"}','company',ARRAY['read'],ARRAY['name'],'{}',
          '{"kind":"ids","ids":["fixture-record"]}','{}','{}','internal')`,[parentId,appId,workspaceId,serviceId,ownerId])
      await pool.query(`INSERT INTO application_api_credentials(id,app_id,workspace_id,issued_by_user_id,subject_user_id,name,credential_kind,secret_hash,parent_grant_id,expires_at)
        VALUES($1,$2,$3,$4,$5,'Example service','service',$6,$7,now()+interval '1 hour')`,[material.id,appId,workspaceId,ownerId,serviceId,material.secretHash,parentId])
      const auth=await authenticateApplicationCredential(material.token,appId,loadApplicationCredentialStateSystem)
      expect(auth).toMatchObject({serviceUserId:serviceId,issuerUserId:ownerId,workspaceId})
      expect((await pool.query('SELECT workspace_id FROM workspace_members WHERE user_id=$1',[serviceId])).rows).toEqual([])
      expect((await pool.query('SELECT id FROM workspaces WHERE owner_user_id=$1',[serviceId])).rows).toEqual([])
      await pool.query("UPDATE application_access_grants SET status='revoked' WHERE id=$1",[parentId])
      expect(await getAuthenticatedApplicationCredentialCurrent(auth!)!()).toBeNull()
      expect(await authenticateApplicationCredential(material.token,appId,loadApplicationCredentialStateSystem)).toBeNull()
    } finally {await pool.query('DELETE FROM application_api_credentials WHERE id=$1',[material.id]);await pool.query('DELETE FROM application_access_grants WHERE id=$1',[parentId]);await pool.query('DELETE FROM users WHERE id=$1',[serviceId])}
  })
})
