import { describe, expect, it, vi } from 'vitest'
import type { Request } from 'express'
import { authenticateBrainRequest } from '../../brain-mcp/auth.js'
import { authenticateApplicationCredential, getAuthenticatedApplicationCredentialCurrent, mintApplicationCredentialSecret,
  parseApplicationCredential, type ApplicationCredentialState } from '../credentials.js'
import { signConsentRequest, verifyConsentRequest } from '../../brain-mcp/oauth/codes.js'

const appId='10000000-0000-4000-8000-000000000001',workspaceId='10000000-0000-4000-8000-000000000002',userId='10000000-0000-4000-8000-000000000003'
describe('[COMP:api/application-auth] credential audiences and host proof',()=>{
  it('never interprets chat, Brain, OAuth, bundle or claimed user metadata as an app-data credential',()=>{
    for(const token of ['sk_live_fixture','sk_brain_fixture','oat_fixture','home-app.fixture','{"userId":"owner"}','sk_app_bad_secret'])expect(parseApplicationCredential(token)).toBeNull()
  })
  it('authenticates the named service and retains a live, non-serializable proof',async()=>{
    const material=await mintApplicationCredentialSecret()
    let state:ApplicationCredentialState={id:material.id,appId,workspaceId,subjectUserId:userId,issuerUserId:workspaceId,
      credentialKind:'service',secretHash:material.secretHash,version:'1',clientRevision:'1',expiresAt:'2099-01-01T00:00:00Z',admitted:true}
    const load=async()=>state
    const auth=await authenticateApplicationCredential(material.token,appId,load)
    expect(auth).toMatchObject({serviceUserId:userId,appId,workspaceId})
    expect(JSON.stringify(auth)).not.toContain(material.secretHash)
    expect(JSON.stringify(auth)).not.toContain(material.token)
    expect(getAuthenticatedApplicationCredentialCurrent({...auth!})).toBeUndefined()
    const proof=getAuthenticatedApplicationCredentialCurrent(auth!)!
    expect(await proof()).toMatchObject({id:material.id})
    expect(JSON.stringify(await proof())).not.toContain(material.secretHash)
    state={...state,admitted:false}
    expect(await proof()).toBeNull()
  })
  it('rechecks revocation after the asynchronous secret verification and rejects cross-app keys',async()=>{
    const material=await mintApplicationCredentialSecret()
    const state:ApplicationCredentialState={id:material.id,appId,workspaceId,subjectUserId:userId,issuerUserId:workspaceId,
      credentialKind:'delegated',secretHash:material.secretHash,version:'1',clientRevision:'1',expiresAt:'2099-01-01T00:00:00Z',admitted:true}
    const load=vi.fn().mockResolvedValueOnce(state).mockResolvedValueOnce({...state,admitted:false})
    expect(await authenticateApplicationCredential(material.token,appId,load)).toBeNull()
    expect(await authenticateApplicationCredential(material.token,userId,async()=>state)).toBeNull()
  })
  it('rejects application-audience OAuth even if a custom Brain store returns its valid row',async()=>{
    const req={headers:{authorization:`Bearer oat_${userId}_fixture-secret`}} as Request
    const getByIdSystem=vi.fn().mockResolvedValue({id:userId,audience:'application',applicationClientId:appId,revokedAt:null})
    expect(await authenticateBrainRequest(req,{brainKeyStore:{} as never,authorizationStore:{getByIdSystem} as never})).toBeNull()
  })
  it('preserves the application audience in signed requests and rejects malformed or disguised app bindings',()=>{
    const base={clientId:'fixture-client',redirectUri:'https://client.example/callback',codeChallenge:'fixture',codeChallengeMethod:'S256' as const,
      scope:'read' as const,state:null,exp:Math.floor(Date.now()/1000)+600}
    const secret='fictional-request-signing-secret'
    const application={...base,audience:'application' as const,applicationId:appId,applicationRevision:'2'}
    expect(verifyConsentRequest(signConsentRequest(application,secret),secret)).toEqual(application)
    expect(verifyConsentRequest(signConsentRequest(base,secret),secret)).toEqual(base)
    for(const invalid of [{...application,applicationId:'not-an-id'},{...application,applicationRevision:''},{...application,audience:'brain' as const}]) {
      expect(verifyConsentRequest(signConsentRequest(invalid,secret),secret)).toBeNull()
    }
  })
})
