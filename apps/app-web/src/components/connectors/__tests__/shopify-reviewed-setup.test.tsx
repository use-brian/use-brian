// @vitest-environment jsdom
import {act} from 'react';import {createRoot,type Root} from 'react-dom/client';import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {ShopifySetupResume,ShopifySetupGate} from '../shopify-reviewed-setup';
import {ConfirmDialogProvider} from '@/components/ui/confirm-dialog';
import {I18nProvider} from '@/lib/i18n/client';import {en} from '@/lib/i18n/dictionaries/en';
import {protectProjection} from '@/lib/use-protected-projection';import {invalidateSurfaceCache} from '@/lib/surface-cache';
const mocks=vi.hoisted(()=>({reconnect:vi.fn(),get:vi.fn(),review:vi.fn(),mutate:vi.fn(),stage:vi.fn(),confirm:vi.fn(),mode:{data:{setupState:'ready',policyRevision:'7',validForMs:30000,projectionDeadline:9999999999999,projectionMonotonicDeadline:9999999999999,canAdminister:true}}}));
vi.mock('@/lib/workspace-context',()=>({useWorkspaceContext:()=>({workspaceId:'w',me:{id:'u'}})}));
vi.mock('@/components/context/mode-aware-context',()=>({useWorkspaceAccessMode:()=>mocks.mode,useCreationContext:()=>({mode:mocks.mode,reviewNeeded:false,ready:true,fail:()=>{},isCurrent:()=>true,snapshot:()=>({contextGroupId:"default-team",contextProjectId:null,expectedPolicyRevision:"7"})}),ModeAwareCreationContext:()=>null}));
vi.mock('@/lib/api/connector-setups',async original=>({...await original<typeof import('@/lib/api/connector-setups')>(),getShopifyReconnect:mocks.reconnect,getSetup:mocks.get,reviewSetup:mocks.review,mutateSetup:mocks.mutate,stageShopify:mocks.stage}));
vi.mock('@/components/ui/confirm-dialog',async original=>({...await original<typeof import('@/components/ui/confirm-dialog')>(),confirmDialog:mocks.confirm}));
vi.mock('@/lib/surface-prefetch',()=>({connectorReconnectCacheKey:(w:string,u:string,id:string)=>`workspace-access:${w}:${u}:connector-reconnect:${id}`,connectorSetupCacheKey:(w:string,u:string,id:string)=>`workspace-access:${w}:${u}:connector-setup:${id}`}));
vi.mock('@/components/chrome/surface-skeleton',()=>({SurfaceSkeletonFor:()=> <div data-skeleton/>}));
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const id='11111111-1111-4111-8111-111111111111';const t=en.shopifySetup;let host:HTMLDivElement,root:Root;
const status=()=>({id,provider:'shopify',workspaceId:'w',status:'pending_review',version:'2',expiresAt:'2099-01-01T00:00:00.000Z',result:null});
const protect=<T extends object>(v:T)=>protectProjection({...v,validForMs:30000},performance.now());
async function render(node=<ShopifySetupResume/>){await act(async()=>root.render(<I18nProvider locale="en" dict={en}>{node}</I18nProvider>));}
async function click(label:string){const button=[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===label);expect(button).toBeDefined();await act(async()=>button!.click());}
beforeEach(()=>{vi.clearAllMocks();invalidateSurfaceCache('workspace-access:');window.history.replaceState(null,'',`/?shopifySetup=${id}`);mocks.mode.data.setupState='ready';mocks.mode.data.canAdminister=true;mocks.reconnect.mockImplementation(async()=>protect(reconnectMetadata()));mocks.stage.mockResolvedValue(status());mocks.get.mockImplementation(async()=>protect(status()));mocks.review.mockImplementation(async()=>protect({viewerUserId:'u',workspaceId:'w',policyRevision:'7',setup:status(),digest:'exact-digest',review:{account:{subject:'Verified shop',tenant:'Shop tenant',roots:['myshop.myshopify.com'],permissions:['read_products']},setup:{id,provider:'shopify',workspaceId:'w',policyRevision:'7',intent:{ownership:'personal',binding:{departments:[],projects:['project-1'],sensitivityFloor:'confidential'}}}}}));mocks.mutate.mockImplementation(async(_w,_id,action)=>({...status(),status:action==='consent'?'ready':action==='cancel'?'cancelled':'active',result:action==='activate'?{instanceId:'instance',grantIds:[],outboxIds:[]}:null}));mocks.confirm.mockResolvedValue(true);host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{vi.useRealTimers();await act(async()=>root.unmount());host.remove();invalidateSurfaceCache('workspace-access:');});
const reconnectMetadata=()=>({viewerUserId:'u',workspaceId:'w',policyRevision:'19',validForMs:30000,instanceId:'saved-instance',instanceVersion:'4',provider:'shopify',ownership:'workspace' as 'workspace'|'personal',sensitivity:'confidential',binding:{compartments:['saved-department'],projectIds:['private-project'],origin:'explicit'},eligibility:{eligible:true,reason:null}});
const reconnectGate=()=> <ShopifySetupGate reconnect instanceId="saved-instance" legacy={<p>Legacy form</p>}/>;
async function input(label:string,value:string){const field=[...host.querySelectorAll('label')].find(row=>row.textContent===label)!.querySelector('input')!;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(field,value);field.dispatchEvent(new Event('input',{bubbles:true}));});}
async function manualDraft(){await click(t.manual);await input(t.shop,'shop.myshopify.com');await input(t.token,'synthetic-token');}
describe('[COMP:app-web/shopify-setup] staged production review',()=>{
 it('stages manual credentials as personal without an implicit workspace destination or grant',async()=>{
   await render(<ShopifySetupGate legacy={<p>Legacy form</p>}/>);await click(t.manual);
   const fields=[t.shop,t.token].map(label=>[...host.querySelectorAll('label')].find(row=>row.textContent===label)!.querySelector('input')!);
   await act(async()=>{for(const [index,value] of ['shop.myshopify.com','private-token'].entries()){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(fields[index],value);fields[index].dispatchEvent(new Event('input',{bubbles:true}));}});
   await click(t.stage);expect(mocks.stage).toHaveBeenCalledWith({workspaceId:'w',operation:'create',ownership:'personal',sensitivity:'internal',expectedPolicyRevision:'7'},{shopDomain:'shop.myshopify.com',accessToken:'private-token'});expect(mocks.mutate).not.toHaveBeenCalled();expect(host.querySelector('input[type=password]')).toBeNull();
 });
 it('does not auto-consent, activate or share on callback landing',async()=>{await render();expect(host.textContent).toContain(t.pending_review);expect(mocks.mutate).not.toHaveBeenCalled();expect(mocks.review).not.toHaveBeenCalled();});
 it('shows exact verified account/root/permissions and sends the same digest through explicit consent/activation',async()=>{await render();await click(t.review);const content=renderToStaticMarkup(<I18nProvider locale="en" dict={en}>{mocks.confirm.mock.calls[0][0].content}</I18nProvider>);for(const text of ['Verified shop','myshop.myshopify.com','read_products','project-1',t.personal,t.boundary,'exact-digest'])expect(content).toContain(text);expect(mocks.mutate.mock.calls).toEqual([['w',id,'consent','exact-digest'],['w',id,'activate','exact-digest']]);});
 it('does not activate declined consent',async()=>{mocks.confirm.mockResolvedValue(false);await render();await click(t.review);expect(mocks.mutate).not.toHaveBeenCalled();});
 it('does not report stale activation response as success',async()=>{mocks.mutate.mockResolvedValue({...status(),status:'stale'});await render();await click(t.review);expect(host.textContent).toContain(t.error);expect(host.textContent).not.toContain(t.active);});
 it('retries an uncertain result with the original setup and digest, never re-exchanges credentials',async()=>{mocks.mutate.mockRejectedValueOnce(new Error('network'));await render();await click(t.review);await click(t.retry);expect(mocks.review).toHaveBeenCalledTimes(1);expect(mocks.confirm).toHaveBeenCalledTimes(1);expect(mocks.stage).not.toHaveBeenCalled();expect(mocks.mutate.mock.calls.every(call=>call[1]===id&&call[3]==='exact-digest')).toBe(true);});
 it('cancels only the pending setup, not the provider account',async()=>{await render();await click(en.workspaceAccess.cancel);expect(mocks.mutate).toHaveBeenCalledWith('w',id,'cancel');});
 it('leaves legacy form behavior unchanged and refuses to guess existing bindings',async()=>{mocks.mode.data.setupState='legacy';await render(<ShopifySetupGate legacy={<p>Legacy form</p>}/>);expect(host.textContent).toContain('Legacy form');mocks.mode.data.setupState='ready';await render(<ShopifySetupGate reconnect legacy={<p>Legacy form</p>}/>);expect(host.textContent).toContain(t.reconnect);expect(host.textContent).not.toContain('Legacy form');});
});

describe('[COMP:app-web/shopify-setup] protected saved reconnect',()=>{
 it.each(['workspace','personal'] as const)('uses saved %s scope, Project and sensitivity, not changed Simple defaults',async ownership=>{
  mocks.mode.data.canAdminister=ownership==='workspace';mocks.reconnect.mockImplementation(async()=>protect({...reconnectMetadata(),ownership}));
  await render(reconnectGate());expect(mocks.reconnect).toHaveBeenCalledWith('w','u','saved-instance');
  expect(host.textContent).toContain('saved-department');expect(host.textContent).toContain('private-project');expect(host.querySelector('[role=combobox]')).toBeNull();
  await manualDraft();await click(t.stage);
  expect(mocks.stage).toHaveBeenCalledWith({workspaceId:'w',operation:'reconnect',instanceId:'saved-instance',expectedInstanceVersion:'4',expectedPolicyRevision:'19',ownership,sensitivity:'confidential'},{shopDomain:'shop.myshopify.com',accessToken:'synthetic-token'});
  expect(mocks.stage.mock.calls[0][0]).not.toHaveProperty('destination');expect(mocks.mutate).not.toHaveBeenCalled();
 });
 it('fails closed on protected owner/admin denial without exposing saved scope',async()=>{
  mocks.reconnect.mockRejectedValue(new Error('404'));await render(reconnectGate());await manualDraft();await click(t.stage);
  expect(mocks.stage).not.toHaveBeenCalled();expect(host.textContent).not.toContain('private-project');
 });
 it('shows ineligibility instead of guessing account identity or bypassing restrictions',async()=>{
  mocks.reconnect.mockImplementation(async()=>protect({...reconnectMetadata(),eligibility:{eligible:false,reason:'account_review_required'}}));
  await render(reconnectGate());await manualDraft();await click(t.stage);expect(mocks.stage).not.toHaveBeenCalled();expect(host.textContent).toContain(t.account_review_required);
 });
 it('expires authority, clears credentials, keeps the shop draft and requires explicit refresh',async()=>{
  vi.useFakeTimers();await render(reconnectGate());await manualDraft();
  await act(async()=>{await vi.advanceTimersByTimeAsync(30001);});
  expect(host.querySelector<HTMLInputElement>('input[type=password]')?.value).toBe('');
  expect([...host.querySelectorAll<HTMLInputElement>('input')].some(field=>field.value==='shop.myshopify.com')).toBe(true);
  await input(t.token,'fresh-token');await click(t.stage);expect(mocks.stage).not.toHaveBeenCalled();
  await click(en.workspaceAccess.reload);await input(t.token,'fresh-token');await click(t.stage);expect(mocks.stage).toHaveBeenCalledTimes(1);
 });
 it('requires explicit refreshed version review after a stale-version rejection; never auto-resubmits',async()=>{
  await render(reconnectGate());await manualDraft();mocks.stage.mockRejectedValueOnce(new Error('connector_setup_target_changed'));await click(t.stage);
  expect(mocks.stage).toHaveBeenCalledTimes(1);expect(host.textContent).toContain(t.refreshReconnect);
  mocks.reconnect.mockImplementation(async()=>protect({...reconnectMetadata(),instanceVersion:'5',policyRevision:'20'}));
  await click(en.workspaceAccess.reload);expect(mocks.stage).toHaveBeenCalledTimes(1);
  await input(t.token,'fresh-token');await click(t.stage);expect(mocks.stage).toHaveBeenCalledTimes(2);expect(mocks.stage.mock.calls[1][0]).toMatchObject({expectedInstanceVersion:'5',expectedPolicyRevision:'20'});
 });
 it('does not restage credentials after an uncertain start response',async()=>{
  await render(reconnectGate());await manualDraft();mocks.stage.mockRejectedValueOnce(new Error('network'));await click(t.stage);
  await click(en.workspaceAccess.reload);await input(t.token,'fresh-token');await click(t.stage);
  expect(mocks.stage).toHaveBeenCalledTimes(1);expect(host.textContent).toContain(t.uncertainStage);
 });
 it('retries uncertain reconnect activation with the same setup and digest, never restaging',async()=>{
  await render(reconnectGate());await manualDraft();await click(t.stage);mocks.mutate.mockRejectedValueOnce(new Error('network'));
  await click(t.review);await click(t.retry);expect(mocks.stage).toHaveBeenCalledTimes(1);expect(mocks.review).toHaveBeenCalledTimes(1);expect(mocks.mutate.mock.calls.every(call=>call[1]===id&&call[3]==='exact-digest')).toBe(true);
 });
 it('stages OAuth reconnect with saved authority and refuses a foreign authorization redirect',async()=>{
  await render(reconnectGate());await input(t.shop,'shop.myshopify.com');await input(t.clientId,'fixture-client');await input(t.secret,'synthetic-secret');
  const state=`${id}.${'a'.repeat(43)}`;mocks.stage.mockResolvedValueOnce({...status(),status:'pending_auth',state,authorizeUrl:`https://foreign.myshopify.com/admin/oauth/authorize?state=${state}`});
  document.cookie='shopify_pending_setup=; Max-Age=0; Path=/';await click(t.stage);
  expect(mocks.stage.mock.calls[0][0]).toMatchObject({operation:'reconnect',instanceId:'saved-instance',expectedInstanceVersion:'4',expectedPolicyRevision:'19'});expect(mocks.stage.mock.calls[0][1]).toMatchObject({clientId:'fixture-client',clientSecret:'synthetic-secret'});
  expect(document.cookie).not.toContain('shopify_pending_setup=');expect(mocks.mutate).not.toHaveBeenCalled();
 });
});

describe('[COMP:app-web/shopify-setup] reconnect lifecycle',()=>{
 it('keeps the exact pending setup mounted when consent invalidates the mode cache',async()=>{
  await render(reconnectGate());await manualDraft();await click(t.stage);
  const mode=mocks.mode as {data:typeof mocks.mode.data|undefined},saved=mode.data;
  try{mode.data=undefined;await render(reconnectGate());expect(host.textContent).toContain(t.pending_review);await click(t.review);expect(mocks.mutate.mock.calls.every(call=>call[1]===id)).toBe(true);expect(mocks.stage).toHaveBeenCalledTimes(1);}finally{mode.data=saved;}
 });
 it('purges saved scope on organization changes and does not submit a retained draft automatically',async()=>{
  await render(reconnectGate());await manualDraft();
  await act(async()=>window.dispatchEvent(new CustomEvent('brian:organization-changed',{detail:{workspaceId:'w'}})));
  expect(host.textContent).not.toContain('private-project');expect(host.querySelector<HTMLInputElement>('input[type=password]')?.value).toBe('');
  await input(t.token,'fresh-token');await click(t.stage);expect(mocks.stage).not.toHaveBeenCalled();
 });
 it('does not report a rejected changed provider account as active or create a replacement',async()=>{
  await render(reconnectGate());await manualDraft();await click(t.stage);
  mocks.mutate.mockImplementation(async(_w,_id,action)=>{if(action==='activate')throw new Error('connector_setup_account_review_required');return {...status(),status:'ready'};});
  await click(t.review);expect(host.textContent).toContain(t.error);expect(host.textContent).not.toContain(t.active);expect(mocks.stage).toHaveBeenCalledTimes(1);
 });
});

describe('[COMP:app-web/shopify-setup] private review expiry',()=>{
 async function shortReview(){
  vi.useFakeTimers();const response=await mocks.review();
  mocks.review.mockClear();mocks.review.mockImplementation(async()=>protectProjection({...response,validForMs:1000},performance.now()));
 }
 it('removes private account/root evidence from the real dialog at original-session expiry, without auto-confirming',async()=>{
  await shortReview();
  const actual=await vi.importActual<typeof import('@/components/ui/confirm-dialog')>('@/components/ui/confirm-dialog');mocks.confirm.mockImplementation(actual.confirmDialog);
  await render(<><ShopifySetupResume/><ConfirmDialogProvider/></>);await click(t.review);
  expect(mocks.review).toHaveBeenCalledWith('w',id,'u');
  expect(document.body.textContent).toContain('Verified shop');expect(document.body.textContent).toContain('myshop.myshopify.com');
  expect(document.body.textContent).not.toContain('2099-01-01');
  await act(async()=>{await vi.advanceTimersByTimeAsync(1001);});
  expect(document.body.textContent).not.toContain('Verified shop');expect(document.body.textContent).not.toContain('myshop.myshopify.com');
  expect(mocks.mutate).not.toHaveBeenCalled();expect(mocks.review).toHaveBeenCalledTimes(1);
 });
 it('rejects confirmation after deadline even if the abort timer has not run yet',async()=>{
  await shortReview();mocks.confirm.mockImplementationOnce(async()=>{vi.setSystemTime(Date.now()+1001);return true;});
  await render();await click(t.review);expect(mocks.mutate).not.toHaveBeenCalled();
 });
 it('does not consent when the post-confirmation status request consumes the remaining lifetime',async()=>{
  await shortReview();await render();
  mocks.get.mockImplementationOnce(async()=>{vi.setSystemTime(Date.now()+1001);return protect(status());});
  await click(t.review);expect(mocks.mutate).not.toHaveBeenCalled();expect(host.textContent).toContain(t.error);
 });
 it('never opens a confirmation for stale/null or already expired evidence',async()=>{
  await render();mocks.review.mockResolvedValueOnce(protect({...await mocks.review(),review:null}));
  await click(t.review);expect(mocks.confirm).not.toHaveBeenCalled();expect(mocks.mutate).not.toHaveBeenCalled();
  mocks.review.mockResolvedValueOnce({...await mocks.review(),projectionDeadline:Date.now()-1});
  await click(t.review);expect(mocks.confirm).not.toHaveBeenCalled();expect(mocks.mutate).not.toHaveBeenCalled();
 });
});

it('[COMP:app-web/shopify-setup] requests fresh review after a status failure before consent was ever attempted',async()=>{
 await render();mocks.get.mockRejectedValueOnce(new Error('network'));await click(t.review);
 expect(mocks.mutate).not.toHaveBeenCalled();expect(host.textContent).not.toContain(t.retry);
 await click(t.review);expect(mocks.review).toHaveBeenCalledTimes(2);expect(mocks.confirm).toHaveBeenCalledTimes(2);
});
