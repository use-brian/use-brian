import {beforeEach,describe,expect,it,vi} from 'vitest';
const fetch=vi.hoisted(()=>vi.fn());vi.mock('@/lib/auth-fetch',()=>({getAccessToken:()=> 'fictional-native-token'}));vi.mock('@/lib/runtime-public-config',()=>({publicRuntimeConfig:()=>({apiUrl:'http://localhost:4100',primaryAuthUrl:'http://localhost:3005'})}));
import {fetchApplicationConsent,decideApplicationConsent,applicationConsentSignInUrl} from '../application-consent';
const appId='11111111-1111-4111-8111-111111111111',workspace='22222222-2222-4222-8222-222222222222';
const review={clientName:'Fictional app',clientUri:null,scope:'read_write' as const,workspaces:[{id:workspace,name:'Fictional workspace'}],application:{id:appId,qualified:true as const,review:'signed-current-review',resources:[{typeKey:'record.type',selector:{kind:'self' as const},actions:['read'],readFields:['title'],writeFields:[]}]}};
describe('[COMP:app-web/application-consent] canonical native application consent client',()=>{
 beforeEach(()=>{fetch.mockReset();vi.stubGlobal('fetch',fetch);});
 it('uses current native session without automatic owner recovery and submits the exact app-bound signed review and server workspace',async()=>{
  fetch.mockResolvedValueOnce(new Response(JSON.stringify(review))).mockResolvedValueOnce(new Response(JSON.stringify({redirectUrl:'https://frontend.example/callback?code=fictional'})));
  const current=await fetchApplicationConsent(appId,'signed-request');expect(fetch.mock.calls[0][0]).toBe(`http://localhost:4100/api/applications/${appId}/consent?req=signed-request`);
  expect(await decideApplicationConsent(appId,'signed-request',current,'allow')).toContain('https://frontend.example/');
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({req:'signed-request',workspaceId:workspace,decision:'allow',review:'signed-current-review',grantedScope:'read_write'});
 });
 it('refuses foreign app metadata, held qualification and unsafe redirect rather than inventing authority',async()=>{
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({...review,application:{...review.application,id:workspace}})));await expect(fetchApplicationConsent(appId,'signed')).rejects.toThrow();
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({...review,application:{...review.application,qualified:false}})));await expect(fetchApplicationConsent(appId,'signed')).rejects.toThrow();
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({redirectUrl:'javascript:alert(1)'})));await expect(decideApplicationConsent(appId,'signed',review,'allow')).rejects.toThrow();
 });
 it('preserves exact deny and does not retry a failed consent write',async()=>{
  fetch.mockRejectedValueOnce(Error('lost response'));await expect(decideApplicationConsent(appId,'signed',review,'deny')).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(1);expect(JSON.parse(fetch.mock.calls[0][1].body).decision).toBe('deny');
 });
 it('builds only the exact same-origin signed application continuation and never local-owner login',()=>{
  const url=new URL(applicationConsentSignInUrl(appId,'signed?request','http://localhost:3003/oauth/authorize?next=https://outside.example'));
  expect(url.origin).toBe('http://localhost:3005');expect(url.pathname).toBe('/login');const next=new URL(url.searchParams.get('next')!);
  expect(next.origin).toBe('http://localhost:3003');expect(next.pathname).toBe('/oauth/authorize');expect(next.searchParams.get('application')).toBe(appId);expect(next.searchParams.get('req')).toBe('signed?request');expect(next.searchParams.has('next')).toBe(false);
 });
 it('an expired native identity requests real sign-in without reissuing consent or owner substitution',async()=>{
  fetch.mockResolvedValueOnce(new Response(null,{status:401}));await expect(fetchApplicationConsent(appId,'signed')).rejects.toThrow('application_signin_required');expect(fetch).toHaveBeenCalledTimes(1);expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer fictional-native-token');
 });

});
