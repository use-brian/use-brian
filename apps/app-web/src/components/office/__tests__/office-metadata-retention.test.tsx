// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import type {OfficeTemplateRoutingDraft} from '@use-brian/office-model';
import {TemplateRoutingInspector} from '../template-routing-inspector';
import {OfficeCreate,OfficeCreateDialog} from '../office-create';
import {documentFixture,presentationFixture,uid} from './editor-fixtures';
import {reconcileTokenRouting} from '../token-template-routing';
import {I18nProvider} from '@/lib/i18n/client';
import {en} from '@/lib/i18n/dictionaries/en';
import {readSurfaceCache,resetSurfaceCache} from '@/lib/surface-cache';
import {officeRoutingCacheKey,officeTemplateListCacheKey} from '@/lib/surface-prefetch';
import {applySpineEventToSurfaceCache} from '@/lib/surface-cache-invalidation';
import {WORKSPACE_IDENTITY_REFRESH_EVENT} from '@/lib/workspace-identity-events';

const state=vi.hoisted(()=>({viewer:'viewer-a',workspace:'workspace-a',fetch:vi.fn(),push:vi.fn(),params:'templateId=template-a&templateVersionId=version-a'}));
vi.mock('@/lib/user',()=>({getUserInfo:()=>({id:state.viewer})}));
vi.mock('@/lib/auth-fetch',()=>({authFetch:(...args:unknown[])=>state.fetch(...args)}));
vi.mock('@/lib/workspace-context',()=>({useOptionalWorkspaceContext:()=>({workspaceId:state.workspace,me:{id:state.viewer}})}));
vi.mock('next/navigation',()=>({useRouter:()=>({push:state.push,replace:vi.fn(),back:vi.fn()}),useSearchParams:()=>new URLSearchParams(state.params)}));
vi.mock('../office-topbar',()=>({OfficeTopbar:()=>null}));
vi.mock('../office-card-preview',()=>({OfficeCardPreview:()=>null}));
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root,host:HTMLDivElement;
const onState=vi.fn();
const response=(body:unknown,ttl='6000',status=200)=>new Response(JSON.stringify(body),{status,headers:{'X-Brian-Projection-Valid-For-Ms':ttl}});
const empty:OfficeTemplateRoutingDraft={source:'upload',fields:[],slideRecipes:[]};
const template={id:'template-a',currentVersionId:'version-a',lifecycleState:'admitted',family:'document',name:'Department contract',description:'Protected template guidance'};
function tokenFixture(){const snapshot=documentFixture();snapshot.sections[0]!.header[0]!.text='{{NAME}}';return snapshot;}
function tokenRouting(){const value=reconcileTokenRouting(empty,tokenFixture(),'Protected field instruction');value.fields[0]!.label='Protected label';return value;}
function presentationRouting():OfficeTemplateRoutingDraft{return {source:'upload',fields:[],slideRecipes:[{id:uid(91),slideId:uid(63),name:presentationFixture().slides[0]!.title,role:'cover',whenToUse:'Protected routing guidance',whenNotToUse:'Private exception',enabled:true,repeatable:false,minUses:0,maxUses:1,fieldIds:[],confidence:0.8,inference:'Protected inference',reviewed:true}]};}
async function renderRouting(family:'document'|'presentation'='document',seed?:OfficeTemplateRoutingDraft){await act(async()=>root.render(<I18nProvider locale="en" dict={en}><TemplateRoutingInspector templateId="template-a" snapshot={family==='document'?tokenFixture():presentationFixture()} selectedTargetIds={[]} initialRouting={seed} onStateChange={onState}/></I18nProvider>));}
async function renderCreate(dialog=false){await act(async()=>root.render(<I18nProvider locale="en" dict={en}>{dialog?<OfficeCreateDialog workspaceId={state.workspace}/>:<OfficeCreate workspaceId={state.workspace}/>}</I18nProvider>));}
const pending=()=>new Promise<Response>(()=>{});
function change(input:HTMLInputElement|HTMLTextAreaElement,value:string){act(()=>{Object.getOwnPropertyDescriptor(input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});}
function field(){return host.querySelector('input')!;}
function saveButton(){return [...host.querySelectorAll('button')].find(x=>x.textContent===en.office.routingSave)!;}
async function expire(){state.fetch.mockImplementation(pending);await act(async()=>vi.advanceTimersByTime(801));}
beforeEach(()=>{vi.useFakeTimers();resetSurfaceCache();vi.clearAllMocks();state.viewer='viewer-a';state.workspace='workspace-a';state.params='templateId=template-a&templateVersionId=version-a';host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();resetSurfaceCache();vi.useRealTimers();});

describe('[COMP:app-web/office-template-routing] bounded routing drafts',()=>{
  it.each(['document','presentation'] as const)('expires the actual %s inspector and does not resurrect its dirty draft',async family=>{
    const draft=family==='document'?tokenRouting():presentationRouting();state.fetch.mockImplementation(async()=>response({routing:draft},'800'));
    await renderRouting(family);expect(host.querySelector('[data-template-routing="ready"]')).not.toBeNull();
    if(family==='document') change(field(),'Unsaved protected edit');
    await expire();expect(host.querySelector('[data-template-routing="ready"]')).toBeNull();expect(host.textContent).not.toContain('Protected');
    expect(onState).toHaveBeenLastCalledWith({ready:false,dirty:false,saving:false});
    state.fetch.mockImplementation(async()=>response({routing:draft},'800'));await act(async()=>window.dispatchEvent(new Event('focus')));
    expect(host.querySelector('[data-template-routing="ready"]')).not.toBeNull();if(family==='document')expect(field().value).toBe('Protected label');
  });
  it('preserves a dirty draft across identical authorized renewal but replaces it when the server content changes',async()=>{
    const original=tokenRouting();state.fetch.mockImplementation(async()=>response({routing:original}));await renderRouting();change(field(),'Local edit');
    await act(async()=>vi.advanceTimersByTime(3001));expect(field().value).toBe('Local edit');
    const replacement=tokenRouting();replacement.fields[0]!.label='Fresh label';state.fetch.mockImplementation(async()=>response({routing:replacement}));
    await act(async()=>vi.advanceTimersByTime(3001));expect(field().value).toBe('Fresh label');
  });
  it.each([401,403,404,409])('discards a draft after authoritative %s during renewal',async status=>{
    state.fetch.mockImplementation(async()=>response({routing:tokenRouting()}));await renderRouting();change(field(),'Sensitive draft');
    state.fetch.mockImplementation(async()=>response({error:status===409?'office_projection_changed':'denied'},'0',status));
    await act(async()=>vi.advanceTimersByTime(3001));expect(host.querySelector('input')).toBeNull();expect(host.textContent).not.toContain('Sensitive draft');
  });
  it('keeps edits through a transient failure only until the original deadline',async()=>{
    state.fetch.mockImplementation(async()=>response({routing:tokenRouting()}));await renderRouting();change(field(),'Unsaved draft');
    state.fetch.mockRejectedValue(new Error('network unavailable'));await act(async()=>vi.advanceTimersByTime(3001));expect(field().value).toBe('Unsaved draft');
    await act(async()=>vi.advanceTimersByTime(3000));expect(host.querySelector('input')).toBeNull();
  });
  it('rejects an unbounded initial prop and clears on authority events, including pending save completion',async()=>{
    state.fetch.mockImplementation(pending);await renderRouting('document',tokenRouting());expect(host.querySelector('input')).toBeNull();
    state.fetch.mockImplementation(async()=>response({routing:tokenRouting()}));await act(async()=>window.dispatchEvent(new Event('focus')));change(field(),'Draft before revocation');
    let finish!:(value:Response)=>void;state.fetch.mockImplementation((_url:string,init:RequestInit)=>init?.method==='PUT'?new Promise(resolve=>{finish=resolve;}):pending());
    await act(async()=>saveButton().click());await act(async()=>{applySpineEventToSurfaceCache(WORKSPACE_IDENTITY_REFRESH_EVENT,{workspaceId:state.workspace},state.workspace);});
    expect(host.querySelector('input')).toBeNull();await act(async()=>finish(response({routing:tokenRouting()})));expect(host.querySelector('input')).toBeNull();
    expect(readSurfaceCache(officeRoutingCacheKey(state.workspace,state.viewer,'template-a')).data).toBeUndefined();
  });
  it.each(['viewer','workspace'] as const)('drops old %s ownership and a late GET cannot reappear',async identity=>{
    let finish!:(value:Response)=>void;state.fetch.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));await renderRouting();
    const oldKey=officeRoutingCacheKey(state.workspace,state.viewer,'template-a');state[identity]=`${identity}-b`;state.fetch.mockImplementation(pending);await renderRouting();
    await act(async()=>finish(response({routing:tokenRouting()})));expect(host.querySelector('input')).toBeNull();expect(readSurfaceCache(oldKey).data).toBeUndefined();
  });
  it('does not mistake a pre-save renewal for post-save readback',async()=>{
    const original=tokenRouting();state.fetch.mockImplementation(async()=>response({routing:original}));await renderRouting();change(field(),'Saved after renewal');
    let finish!:(value:Response)=>void;let fresh=original;let reads=0;
    state.fetch.mockImplementation((_url:string,init:RequestInit)=>{
      if(init?.method==='PUT'){fresh=JSON.parse(String(init.body)).routing;return Promise.resolve(response({routing:fresh}));}
      reads++;return reads===1?new Promise(resolve=>{finish=resolve;}):Promise.resolve(response({routing:fresh}));
    });
    await act(async()=>vi.advanceTimersByTime(3001));await act(async()=>saveButton().click());
    await act(async()=>finish(response({routing:original})));expect(reads).toBe(2);expect(field().value).toBe('Saved after renewal');
    expect(host.textContent).toContain(en.office.routingSaved);
  });
  it('refuses saving after the wall deadline even before the expiry timer runs',async()=>{
    state.fetch.mockImplementation(async()=>response({routing:tokenRouting()},'800'));await renderRouting();change(field(),'Late edit');
    state.fetch.mockClear();vi.setSystemTime(Date.now()+801);await act(async()=>saveButton().click());
    expect(state.fetch.mock.calls.some(call=>call[1]?.method==='PUT')).toBe(false);
  });
  it('reads a save back through GET and never treats PUT JSON as permission to display it',async()=>{
    let fresh=tokenRouting();state.fetch.mockImplementation(async(_url:string,init:RequestInit)=>{
      if(init?.method==='PUT'){fresh=JSON.parse(String(init.body)).routing;return response({routing:{...fresh,fields:[{...fresh.fields[0],label:'Unverified acknowledgement'}]}});}
      return response({routing:fresh});
    });await renderRouting();change(field(),'Verified save');await act(async()=>saveButton().click());
    expect(field().value).toBe('Verified save');expect(host.textContent).toContain(en.office.routingSaved);expect(host.innerHTML).not.toContain('Unverified acknowledgement');
  });
});

describe('[COMP:app-web/office-navigation] bounded template creation',()=>{
  function available(ttl='800'){state.fetch.mockImplementation(async(url:string)=>url.endsWith('/capabilities')?response({generationAvailable:true,generationFamilies:['document']}):response({templates:[template]},ttl));}
  it.each([false,true])('removes protected selected template and pending inputs on expiry (dialog=%s)',async dialog=>{
    available();await renderCreate(dialog);expect(document.body.textContent).toContain(template.name);
    const input=document.querySelector<HTMLInputElement>('#office-create-audience')!;change(input,'Private audience');await expire();
    expect(document.body.textContent).not.toContain(template.name);expect(document.querySelector('#office-create-audience')).toBeNull();
  });
  it.each([['expiry',false],['viewer',false],['workspace',false],['expiry',true],['viewer',true],['workspace',true]] as const)('does not navigate from creation completing after %s (dialog=%s)',async(reason,dialog)=>{
    available();await renderCreate(dialog);change(document.querySelector<HTMLTextAreaElement>('#office-create-outcome')!,'Draft agreement');change(document.querySelector<HTMLInputElement>('#office-create-audience')!,'Team');
    let finish!:(value:Response)=>void;state.fetch.mockImplementation((_url:string,init:RequestInit)=>init?.method==='POST'?new Promise(resolve=>{finish=resolve;}):pending());
    await act(async()=>document.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    if(reason==='expiry')await act(async()=>vi.advanceTimersByTime(801));else {state[reason]=`${reason}-b`;await renderCreate(dialog);}
    await act(async()=>finish(response({artifactId:'created'})));expect(state.push).not.toHaveBeenCalled();
  });
  it('keeps an unchanged active form during renewal and navigates after an authorized creation',async()=>{
    available('6000');await renderCreate();change(document.querySelector<HTMLTextAreaElement>('#office-create-outcome')!,'Draft agreement');change(document.querySelector<HTMLInputElement>('#office-create-audience')!,'Team');
    await act(async()=>vi.advanceTimersByTime(3001));expect(document.querySelector<HTMLInputElement>('#office-create-audience')!.value).toBe('Team');
    state.fetch.mockImplementation(async()=>response({artifactId:'created'}));await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    expect(state.push).toHaveBeenCalledWith('/w/workspace-a/office/created');expect(readSurfaceCache(officeTemplateListCacheKey('workspace-a','viewer-a')).data).toBeDefined();
  });
});
