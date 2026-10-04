// @vitest-environment node
// Transport and backend-schema checks require no DOM. Node preserves filesystem
// import.meta URLs rather than Vite's jsdom/browser asset URL rewriting.
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {getShopifyReconnect,reconnectIntent,type ReconnectProjection,stageShopify,getSetup,reviewSetup,mutateSetup} from '@/lib/api/connector-setups';
import {SurfaceCacheEvictionError} from '@/lib/surface-cache';
const mocks=vi.hoisted(()=>({fetch:vi.fn(),invalidate:vi.fn()}));
vi.mock('@/lib/auth-fetch',()=>({authFetch:mocks.fetch}));
vi.mock('@/lib/runtime-public-config',()=>({publicRuntimeConfig:()=>({apiUrl:'https://api.test'})}));
vi.mock('@/lib/surface-cache',async original=>({...await original<typeof import('@/lib/surface-cache')>(),invalidateSurfaceCache:mocks.invalidate}));
const status={id:'id',provider:'shopify',workspaceId:'w',status:'pending_review',expiresAt:'2099-01-01T00:00:00.000Z',result:null};
beforeEach(()=>{vi.clearAllMocks();mocks.fetch.mockResolvedValue({ok:true,json:async()=>status});});
describe('[COMP:app-web/shopify-setup] authenticated staging transport',()=>{
 it('validates emitted setup intents against the actual backend strict schema, not a copied client schema',async()=>{
  const {connectorSetupStartSchema}=await import(new URL('../../../../../packages/api/src/connectors/setup-routes.ts',import.meta.url).href);
  const workspaceId='11111111-1111-4111-8111-111111111111',departmentId='22222222-2222-4222-8222-222222222222';
  const selection=connectorSetupStartSchema.omit({provider:true});
  for(const destination of [undefined,{kind:'general' as const},{kind:'department' as const,departmentId}]){
   const setup={workspaceId,operation:'create' as const,ownership:'workspace' as const,sensitivity:'internal' as const,expectedPolicyRevision:'9',...(destination?{destination}:{})};
   mocks.fetch.mockResolvedValueOnce({ok:true,json:async()=>({...status,workspaceId})});
   await stageShopify(setup,{shopDomain:'shop.myshopify.com',accessToken:'synthetic-credential'});
   const body=JSON.parse(mocks.fetch.mock.calls.at(-1)![1].body);
   expect(selection.parse(body.setup)).toEqual(setup);
   expect(Object.keys(body).sort()).toEqual(['setup','shopifyTokens']);
   expect(selection.safeParse({...body.setup,destination:null}).success).toBe(false);
   expect(selection.safeParse({...body.setup,destination:{kind:'general',projectId:null}}).success).toBe(false);
   expect(selection.safeParse({...body.setup,expectedPolicyRevision:9}).success).toBe(false);
   expect(selection.safeParse({...body.setup,actorId:workspaceId}).success).toBe(false);
  }
 });
 it('transmits the same schema-valid 64-hex consent digest without deriving or adding fields',async()=>{
  const digest='a'.repeat(64);
  await mutateSetup('w','id','consent',digest);await mutateSetup('w','id','activate',digest);
  expect(mocks.fetch.mock.calls.map(call=>JSON.parse(call[1].body))).toEqual([{digest},{digest}]);
  expect(mocks.fetch.mock.calls[0][0]).toMatch(/\/setups\/id\/consent$/);
  expect(mocks.fetch.mock.calls[1][0]).toMatch(/\/setups\/id\/activate$/);
 });
 it('sends explicit ready Simple department plus revision, never a legacy email/auto-share contract',async()=>{
 const setup={workspaceId:'w',operation:'create' as const,ownership:'workspace' as const,sensitivity:'internal' as const,expectedPolicyRevision:'9',destination:{kind:'department' as const,departmentId:'default'}};
 await stageShopify(setup,{shopDomain:'shop.myshopify.com',accessToken:'credential'});
 expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toEqual({setup,shopifyTokens:{shopDomain:'shop.myshopify.com',accessToken:'credential'}});expect(mocks.fetch.mock.calls[0][1].cache).toBe('no-store');
 });
 it('preserves explicit General separately from omission for personal setup',async()=>{
 const setup={workspaceId:'w',operation:'create' as const,ownership:'workspace' as const,sensitivity:'internal' as const,expectedPolicyRevision:'9',destination:{kind:'general' as const}};
 await stageShopify(setup,{shopDomain:'shop.myshopify.com',accessToken:'credential'});expect(JSON.parse(mocks.fetch.mock.calls[0][1].body).setup.destination).toEqual({kind:'general'});
 });
 it('bounds setup identity and refuses expired review evidence',async()=>{
 await expect(getSetup('another','id')).rejects.toBeInstanceOf(SurfaceCacheEvictionError);
 mocks.fetch.mockResolvedValue({ok:true,json:async()=>({setup:{...status,expiresAt:'2000-01-01'},review:null})});await expect(reviewSetup('w','id','u')).rejects.toBeInstanceOf(SurfaceCacheEvictionError);
 });
 it('keeps exact setup/digest and invalidates all viewer projections after an uncertain activation',async()=>{
 mocks.fetch.mockRejectedValue(new Error('network'));await expect(mutateSetup('w','id','activate','exact-digest')).rejects.toThrow('network');expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toEqual({digest:'exact-digest'});expect(mocks.invalidate).toHaveBeenCalledWith('workspace-access:w:');expect(mocks.invalidate).toHaveBeenCalledWith('connectors:w');
 });
});

const reconnectProjection:ReconnectProjection={viewerUserId:'u',workspaceId:'w',policyRevision:'19',validForMs:30000,instanceId:'existing',instanceVersion:'4',provider:'shopify',ownership:'personal',sensitivity:'confidential',binding:{compartments:['saved-department'],projectIds:['saved-project'],origin:'explicit'},eligibility:{eligible:true,reason:null}};
describe('[COMP:app-web/shopify-setup] reconnect projection transport',()=>{
 it('GETs protected metadata with no-store and binds canonical viewer/workspace/instance',async()=>{
  mocks.fetch.mockResolvedValueOnce({ok:true,json:async()=>reconnectProjection});
  const value=await getShopifyReconnect('w','u','existing');expect(value.binding).toEqual(reconnectProjection.binding);expect(value.projectionDeadline).toBeGreaterThan(Date.now());
  expect(mocks.fetch).toHaveBeenCalledWith('https://api.test/api/connectors/setups/reconnect/existing?workspaceId=w',{method:'GET',cache:'no-store'});
 });
 it.each([{viewerUserId:'other'},{workspaceId:'other'},{instanceId:'other'},{provider:'other'},{validForMs:0}])('evicts mismatched or expired projection %j',async patch=>{
  mocks.fetch.mockResolvedValueOnce({ok:true,json:async()=>({...reconnectProjection,...patch})});await expect(getShopifyReconnect('w','u','existing')).rejects.toBeInstanceOf(SurfaceCacheEvictionError);
 });
 it('does not expose denial details for owner/admin-protected metadata',async()=>{mocks.fetch.mockResolvedValueOnce({ok:false,status:404});await expect(getShopifyReconnect('w','u','existing')).rejects.toBeInstanceOf(SurfaceCacheEvictionError);});
 it('passes the actual backend schema and omits destination and grants for both ownerships',async()=>{
  const {connectorSetupStartSchema}=await import(new URL('../../../../../packages/api/src/connectors/setup-routes.ts',import.meta.url).href);
  for(const ownership of ['personal','workspace'] as const){
   const intent=reconnectIntent({...reconnectProjection,workspaceId:'11111111-1111-4111-8111-111111111111',instanceId:'22222222-2222-4222-8222-222222222222',ownership});
   expect(connectorSetupStartSchema.omit({provider:true}).parse(intent)).toEqual(intent);expect(intent).not.toHaveProperty('destination');expect(intent).not.toHaveProperty('binding');expect(intent).not.toHaveProperty('grants');expect(intent).toMatchObject({expectedInstanceVersion:'4',expectedPolicyRevision:'19',sensitivity:'confidential',ownership});
  }
 });
});

const reviewResponse=()=>({setup:status,viewerUserId:'u',workspaceId:'w',policyRevision:'19',validForMs:1000,digest:'a'.repeat(64),review:{account:{subject:'private-account',tenant:null,roots:['private-root'],permissions:['read_products']},setup:{id:'id',workspaceId:'w',provider:'shopify',policyRevision:'19',intent:{ownership:'personal',operation:'reconnect',binding:{departments:[],projects:['private-project'],sensitivityFloor:'confidential'},ingestionOptIn:false,boundaryProposal:'no-catalog-exception'}}}});
describe('[COMP:app-web/shopify-setup] server-bound private review lifetime',()=>{
 afterEach(()=>vi.restoreAllMocks());
 it('uses the shorter original-session TTL and subtracts response/JSON latency rather than manufacturing a setup TTL',async()=>{
  const clock=vi.spyOn(performance,'now').mockReturnValue(100);
  mocks.fetch.mockResolvedValueOnce({ok:true,json:async()=>{clock.mockReturnValue(350);return reviewResponse();}});
  const value=await reviewSetup('w','id','u');
  expect(value.validForMs).toBe(1000);expect(value.projectionMonotonicDeadline).toBe(1100);
  expect(value.projectionDeadline-Date.now()).toBeLessThanOrEqual(750);
  expect(mocks.fetch).toHaveBeenCalledWith('https://api.test/api/connectors/setups/id/review',expect.objectContaining({cache:'no-store',method:'POST'}));
 });
 it('rejects evidence whose original-session lifetime elapsed before the response arrived',async()=>{
  const clock=vi.spyOn(performance,'now').mockReturnValue(100);
  mocks.fetch.mockResolvedValueOnce({ok:true,json:async()=>{clock.mockReturnValue(1101);return reviewResponse();}});
  await expect(reviewSetup('w','id','u')).rejects.toBeInstanceOf(SurfaceCacheEvictionError);
 });
 it.each([{validForMs:0},{review:null},{review:null,validForMs:0,policyRevision:undefined},{viewerUserId:'other'},{workspaceId:'other'},{policyRevision:'20'},{validForMs:undefined},{validForMs:Infinity}])('refuses stale/revoked/mismatched private review %j',async patch=>{
  mocks.fetch.mockResolvedValueOnce({ok:true,json:async()=>({...reviewResponse(),...patch})});
  await expect(reviewSetup('w','id','u')).rejects.toBeInstanceOf(SurfaceCacheEvictionError);
 });
});
