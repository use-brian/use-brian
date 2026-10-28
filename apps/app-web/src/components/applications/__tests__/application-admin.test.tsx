// @vitest-environment jsdom
import { act } from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ApplicationManagement} from '../application-admin';
import ApplicationManagementPage from '@/app/w/[workspaceId]/studio/programmatic-access/applications/page';
import {I18nProvider} from '@/lib/i18n/client';
import {en} from '@/lib/i18n/dictionaries/en';
import {ja} from '@/lib/i18n/dictionaries/ja';
import {zh} from '@/lib/i18n/dictionaries/zh';
import {zhCN} from '@/lib/i18n/dictionaries/zh-cn';
import {invalidateSurfaceCache} from '@/lib/surface-cache';
import {WORKSPACE_IDENTITY_REFRESH_EVENT} from '@/lib/workspace-identity-events';
import {ConfirmDialogProvider} from '@/components/ui/confirm-dialog';
import type {ApplicationManagementOverview} from '@use-brian/shared';
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const mocks=vi.hoisted(()=>({fetch:vi.fn(),viewer:{workspaceId:'workspace-fixture',me:{id:'viewer-fixture'}}}));
vi.mock('@/lib/auth-fetch',()=>({authFetch:mocks.fetch}));
vi.mock('@/lib/workspace-context',()=>({useWorkspaceContext:()=>mocks.viewer}));
let host:HTMLDivElement,root:Root;
function fixture():ApplicationManagementOverview{return {workspaceId:'workspace-fixture',actor:{userId:'viewer-fixture',assistantId:'assistant-fixture'},validForMs:30_000,readiness:{qualified:false,reason:'consumer_qualification_incomplete',canActivate:false},modules:['records'],clients:[{id:'application-fixture',workspaceId:'workspace-fixture',moduleKey:'records',name:'Fictional app',mode:'api_client',origins:[],redirectUris:[],homeAppId:null,executingAssistantId:'assistant-fixture',status:'active',revision:'1'}],selectedAppId:'application-fixture',grants:[],credentials:[],schemas:{state:'available',items:[]},sources:{state:'unavailable',items:[]},links:{miniApps:'/mini-apps',connectors:'/connectors',programmaticAccess:'/programmatic-access',access:'/access'}};}
const response=(body:unknown,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body});
async function render(locale:'en'|'ja'|'zh'|'zh-CN'='en',dict:any=en,surface:'apps'|'credentials'|'access'='apps'){await act(async()=>{root.render(<I18nProvider locale={locale} dict={dict}><ConfirmDialogProvider/><ApplicationManagement surface={surface}/></I18nProvider>);});}
async function click(label:string){const button=[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.trim()===label);expect(button).toBeDefined();await act(async()=>button!.click());}
beforeEach(()=>{mocks.viewer={workspaceId:'workspace-fixture',me:{id:'viewer-fixture'}};mocks.fetch.mockReset().mockImplementation(async()=>response(fixture()));invalidateSurfaceCache('application-management:');host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();invalidateSurfaceCache('application-management:');});
describe('[COMP:app-web/application-admin] canonical management panels',()=>{
 for(const [locale,dict] of [['en',en],['ja',ja],['zh',zh],['zh-CN',zhCN]] as const){
  it(`M04/M05/M07 shows application controls without technical notices in ${locale}`,async()=>{await render(locale,dict);expect(host.querySelector('details')).toBeNull();expect(host.querySelector('[role="status"]')).toBeNull();expect(host.textContent).not.toContain('viewer-fixture');expect(host.querySelector('select')).toBeNull();expect([...host.querySelectorAll('button')].some(button=>button.textContent===dict.applicationManagement.reviewActivation)).toBe(true);});
  it(`M05 localizes denied recovery in ${locale}`,async()=>{mocks.fetch.mockResolvedValue(response({error:'access_unavailable'},403));await render(locale,dict);expect(host.textContent).toContain(dict.applicationManagement.unavailable);expect(host.textContent).not.toContain('Fictional app');expect(host.textContent).toContain(dict.applicationManagement.retry);});
  it(`M05 localizes cold loading in ${locale}`,async()=>{mocks.fetch.mockReturnValue(new Promise(()=>{}));await render(locale,dict);expect(host.textContent).toContain(dict.applicationManagement.loading);expect(host.textContent).not.toContain('Fictional app');});
 }
 it('M06 never caches another viewer response',async()=>{const other=fixture();other.actor.userId='other-viewer';mocks.fetch.mockResolvedValue(response(other));await render();expect(host.textContent).not.toContain('Fictional app');expect(host.textContent).toContain(en.applicationManagement.unavailable);});
 it('M06 clears protected metadata immediately on live authority loss',async()=>{await render();expect(host.textContent).toContain('Fictional app');mocks.fetch.mockReturnValue(new Promise(()=>{}));await act(async()=>window.dispatchEvent(new CustomEvent(WORKSPACE_IDENTITY_REFRESH_EVENT,{detail:{workspaceId:'workspace-fixture'}})));expect(host.textContent).not.toContain('Fictional app');expect(host.querySelector('form')).toBeNull();});
 it('M06 ignores a late former account response',async()=>{let resolve!:(value:unknown)=>void;mocks.fetch.mockReturnValueOnce(new Promise(done=>{resolve=done;}));await render();mocks.viewer={workspaceId:'different-workspace',me:{id:'other-viewer'}};mocks.fetch.mockReturnValue(new Promise(()=>{}));await render();await act(async()=>resolve(response(fixture())));expect(host.textContent).not.toContain('Fictional app');expect(host.textContent).not.toContain('viewer-fixture');});
 it('M02 preserves the exact saved review and refuses unqualified issuance',async()=>{mocks.fetch.mockImplementation(async(_url:string,init?:RequestInit)=>init?.method==='POST'?response({id:'review-fixture',canIssue:false,proposal:{readFields:['title'],selector:{kind:'ids',ids:['record-fixture']}}}):response(fixture()));await render('en',en,'credentials');const form=host.querySelector('form')!;await act(async()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));expect(host.textContent).toContain('record-fixture');expect(host.textContent).toContain('title');const apply=[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===en.applicationManagement.apply)!;expect(apply.disabled).toBe(true);expect(mocks.fetch.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);});
 it('M05/M06 confirms with the project dialog and reconciles an uncertain write without retrying',async()=>{mocks.fetch.mockImplementation(async(_url:string,init?:RequestInit)=>{if(init?.method==='POST')throw new Error('connection_lost');return response(fixture());});await render();await click(en.applicationManagement.suspend);expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();const apply=[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===en.applicationManagement.apply)!;await act(async()=>{apply.focus();apply.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));apply.click();});expect(host.textContent).toContain(en.applicationManagement.uncertain);await click(en.applicationManagement.reconcile);expect(mocks.fetch.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);expect(mocks.fetch.mock.calls.some(([url])=>String(url).endsWith('/management'))).toBe(true);});
 it.each([401,403,404,'malformed403'] as const)('M06 evicts the private view on an authoritative write denial (%s) even without a live event',async status=>{
  let denied=false;let reads=0;
  mocks.fetch.mockImplementation(async(_url:string,init?:RequestInit)=>{if(init?.method==='POST'){denied=true;return status==='malformed403'?new Response('denied',{status:403}):response({error:'access_unavailable'},status);}reads++;return denied?new Promise(()=>{}):response(fixture());});
  await render();expect(host.textContent).toContain('Fictional app');await click(en.applicationManagement.suspend);
  const apply=[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent===en.applicationManagement.apply)!;
  await act(async()=>apply.click());expect(host.textContent).not.toContain('Fictional app');expect(host.querySelector('form')).toBeNull();expect(mocks.fetch.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);expect(reads).toBeGreaterThan(1);
 });
 it('M06 cancels an open confirmation when authority changes',async()=>{await render();await click(en.applicationManagement.revoke);mocks.fetch.mockReturnValue(new Promise(()=>{}));await act(async()=>window.dispatchEvent(new CustomEvent(WORKSPACE_IDENTITY_REFRESH_EVENT,{detail:{workspaceId:'workspace-fixture'}})));expect(document.querySelector('[role="alertdialog"]')).toBeNull();expect(mocks.fetch.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(0);});
 it('M06 keeps mutation controls locked after failed reconciliation and unlocks only after a fresh read',async()=>{
  let attempted=false,allowRead=false;
  mocks.fetch.mockImplementation(async(_url:string,init?:RequestInit)=>{
   if(init?.method==='POST'){attempted=true;throw new Error('connection_lost');}
   return attempted&&!allowRead?response({error:'unavailable'},503):response(fixture());
  });
  await render();await click(en.applicationManagement.suspend);await click(en.applicationManagement.apply);
  await click(en.applicationManagement.reconcile);
  expect(host.textContent).toContain(en.applicationManagement.uncertain);
  const suspend=[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===en.applicationManagement.suspend)!;
  expect(suspend.disabled).toBe(true);
  expect(mocks.fetch.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
  allowRead=true;await click(en.applicationManagement.reconcile);
  expect(host.textContent).not.toContain(en.applicationManagement.uncertain);
  expect(suspend.disabled).toBe(false);
 });
 it('M01/M06 reads and renews the governance catalog only through the protected overview',async()=>{
  const overview=fixture();overview.governance={state:'available',moduleKey:'records',catalog:{moduleKey:'records',revision:'a'.repeat(64),roleKeys:['fictional-editor'],operations:['assign_role'],nativeResourceTypes:[],ownedNativeResourceTypes:[],configurationRevision:null,configurationOperations:[],roleAssignments:[],nextCursor:null}};
  mocks.fetch.mockImplementation(async(_url:string,init?:RequestInit)=>init?.method==='POST'?response({id:'review-fixture',canApply:true,proposal:JSON.parse(String(init.body)).input.operation}):response(overview));
  await render('en',en,'access');expect(host.textContent).toContain('fictional-editor');
  expect(mocks.fetch.mock.calls.every(([,init])=>init?.method!=='POST')).toBe(true);
  const initial=JSON.parse(host.querySelector('textarea')!.value);expect(Number.isFinite(Date.parse(initial.startsAt))).toBe(true);
  await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  expect(host.textContent).toContain('review-fixture');
  overview.governance={...overview.governance,catalog:{...overview.governance.catalog!,revision:'b'.repeat(64),roleKeys:['fictional-reviewer']}};
  await act(async()=>window.dispatchEvent(new Event('focus')));
  expect(host.textContent).not.toContain('review-fixture');
  expect(host.querySelector('textarea')!.value).toContain('fictional-reviewer');
  expect(mocks.fetch.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
 });
 it('M06 drops role metadata with an expired overview while a refresh is unavailable',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date','performance']});
  try {
   const overview=fixture();overview.validForMs=100;overview.governance={state:'available',moduleKey:'records',catalog:{moduleKey:'records',revision:'a'.repeat(64),roleKeys:['fictional-expiring-role'],operations:[],nativeResourceTypes:[],ownedNativeResourceTypes:[],configurationRevision:null,configurationOperations:[],roleAssignments:[],nextCursor:null}};
   mocks.fetch.mockResolvedValueOnce(response(overview)).mockReturnValue(new Promise(()=>{}));
   await render('en',en,'access');expect(host.textContent).toContain('fictional-expiring-role');
   await act(async()=>vi.advanceTimersByTime(150));expect(host.textContent).not.toContain('fictional-expiring-role');expect(host.querySelector('form')).toBeNull();
  } finally {vi.useRealTimers();}
 });

 it('keeps a successful receipt and holds later writes until Close refreshes changed current metadata',async()=>{
  let saved=false,reads=0;
  mocks.fetch.mockImplementation(async(_url:string,init?:RequestInit)=>{if(init?.method==='POST'){saved=true;return response({id:'registered-fixture',name:'Fictional registered app'});}reads++;const overview=fixture();if(saved)overview.clients[0].revision='2';return response(overview);});
  await render();const before=reads,form=host.querySelector('form')!;await act(async()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  expect(host.textContent).toContain('registered-fixture');expect(host.textContent).toContain(en.applicationManagement.saved);expect(reads).toBe(before);
  expect([...host.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent===en.applicationManagement.suspend)?.disabled).toBe(true);
  await act(async()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));expect(mocks.fetch.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
  await click(en.applicationManagement.close);expect(reads).toBeGreaterThan(before);expect(host.textContent).not.toContain('registered-fixture');
  expect([...host.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent===en.applicationManagement.suspend)?.disabled).toBe(false);
 });
 it.each(['close','authority','expiry','workspace','app','unmount'] as const)('keeps one-time credential material outside its own refresh and clears it on %s',async recovery=>{
  const fakeClock=recovery==='expiry';if(fakeClock)vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date','performance']});
  try{
  let delivered=false,reads=0;
  mocks.fetch.mockImplementation(async(_url:string,init?:RequestInit)=>{
   if(init?.method==='POST'){const command=JSON.parse(String(init.body));if(command.kind==='credential.review')return response({id:'credential-review-fixture',canIssue:true});delivered=true;return response({credentialId:'credential-fixture',secret:'fictional-one-time-material'});}
   reads++;const overview=fixture();if(fakeClock)overview.validForMs=1000;overview.clients.push({...overview.clients[0],id:'second-application-fixture',name:'Fictional second app'});if(delivered)overview.credentials=[{id:'credential-fixture',name:'Fictional delivered credential',status:'active'} as never];return response(overview);
  });
  await render('en',en,'credentials');const before=reads;
  await act(async()=>host.querySelectorAll('form')[2].dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  await click(en.applicationManagement.apply);await act(async()=>document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button').forEach(button=>{if(button.textContent===en.applicationManagement.apply)button.click();}));
  expect(delivered).toBe(true);expect(reads).toBe(before);expect(host.querySelector('code')?.textContent).toBe('fictional-one-time-material');
  if(recovery==='close'){await click(en.applicationManagement.close);expect(reads).toBeGreaterThan(before);}
  else if(recovery==='authority')await act(async()=>window.dispatchEvent(new CustomEvent(WORKSPACE_IDENTITY_REFRESH_EVENT,{detail:{workspaceId:'workspace-fixture'}})));
  else if(recovery==='expiry')await act(async()=>vi.advanceTimersByTimeAsync(1100));
  else if(recovery==='workspace'){mocks.viewer={workspaceId:'different-workspace',me:{id:'viewer-fixture'}};mocks.fetch.mockReturnValue(new Promise(()=>{}));await render('en',en,'credentials');}
  else if(recovery==='app'){await act(async()=>host.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Application"]')!.click());await act(async()=>{const option=[...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item=>item.textContent?.includes('Fictional second app'));expect(option).toBeDefined();option!.click();});}
  else {await act(async()=>root.unmount());root=createRoot(host);}
  expect(host.querySelector('code')).toBeNull();
  }finally{if(fakeClock)vi.useRealTimers();}
 });
 it('reviews exact scoped activation before apply and uses the canonical revoke command',async()=>{
  const overview=fixture();overview.clients[0].qualified=true;
  mocks.fetch.mockImplementation(async(_url:string,init?:RequestInit)=>{
   if(init?.method==='POST'){const command=JSON.parse(String(init.body));return response(command.kind==='activation.review'?{id:'activation-review-fixture',canApply:true,profile:'canonical_records_service_v1',scope:{principal:'service',resources:['generic']}}:{appId:'application-fixture'});}
   return response(overview);
  });
  await render();await click(en.applicationManagement.reviewActivation);
  expect(host.textContent).toContain('canonical_records_service_v1');expect(host.textContent).toContain('activation-review-fixture');
  expect(mocks.fetch.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
  await click(en.applicationManagement.apply);await act(async()=>{const button=[...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(item=>item.textContent===en.applicationManagement.apply);expect(button).toBeDefined();button!.click();});
  const commands=mocks.fetch.mock.calls.filter(([,init])=>init?.method==='POST').map(([,init])=>JSON.parse(String(init?.body)));
  expect(commands).toEqual([{kind:'activation.review',appId:'application-fixture'},{kind:'activation.apply',appId:'application-fixture',reviewId:'activation-review-fixture'}]);
  await click(en.applicationManagement.close);await click(en.applicationManagement.revokeActivation);await click(en.applicationManagement.apply);
  expect(JSON.parse(String(mocks.fetch.mock.calls.filter(([,init])=>init?.method==='POST').at(-1)![1]?.body))).toEqual({kind:'activation.revoke',appId:'application-fixture'});
 });

});

describe('[COMP:app-web/studio-application-management] dedicated administration location',()=>{
 for(const [locale,dict] of [['en',en],['ja',ja],['zh',zh],['zh-CN',zhCN]] as const){
  it(`shows management controls without a technical explanation panel in ${locale}`,async()=>{
   await act(async()=>root.render(<I18nProvider locale={locale} dict={dict}><ConfirmDialogProvider/><ApplicationManagementPage/></I18nProvider>));
   const copy=dict.applicationManagement;
   expect(host.querySelector('details')).toBeNull();
   expect(host.textContent).not.toContain(copy.unqualified);
   expect(host.querySelector('a[href="/access"]')).toBeNull();
   expect(host.querySelector('a[href="/connectors"]')).toBeNull();
   expect(host.querySelector('a[href="/w/workspace-fixture/studio/programmatic-access"]')).not.toBeNull();
   for(const text of [copy.register,copy.grants,copy.credentials,copy.governance]){
    const heading=[...host.querySelectorAll('h3')].find(item=>item.textContent===text);
    expect(heading).toBeDefined();expect(heading!.closest('details')).toBeNull();
   }
   const button=[...host.querySelectorAll('button')].find(item=>item.textContent===copy.reviewActivation)!;
   expect(button.closest('details')).toBeNull();
  });
 }
 it('keeps an actionable refusal beside its controls without technical explanations',async()=>{
  mocks.fetch.mockImplementation(async(_url:string,init?:RequestInit)=>init?.method==='POST'?response({id:'review-fixture',canIssue:false,proposal:{readFields:['title']}}):response(fixture()));
  await act(async()=>root.render(<I18nProvider locale="en" dict={en}><ConfirmDialogProvider/><ApplicationManagementPage/></I18nProvider>));
  const form=[...host.querySelectorAll('form')].find(item=>item.querySelector('h3')?.textContent===en.applicationManagement.grants)!;
  await act(async()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  expect(host.querySelector('details')).toBeNull();
  const apply=[...host.querySelectorAll<HTMLButtonElement>('button')].find(item=>item.textContent===en.applicationManagement.apply)!;
  expect(apply.disabled).toBe(true);
  expect(apply.closest('details')).toBeNull();
  expect(apply.parentElement!.textContent).toContain(en.applicationManagement.unqualified);
 });
});
