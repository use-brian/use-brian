// @vitest-environment jsdom
import { act } from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopeReviewInventory, ScopeReview } from '@use-brian/shared';
import { ScopeReviewPanel } from '../scope-review';
import { I18nProvider } from '@/lib/i18n/client';
import { en } from '@/lib/i18n/dictionaries/en';
import { ja } from '@/lib/i18n/dictionaries/ja';
import { zh } from '@/lib/i18n/dictionaries/zh';
import { zhCN } from '@/lib/i18n/dictionaries/zh-cn';
import { invalidateSurfaceCache, SurfaceCacheEvictionError } from '@/lib/surface-cache';
import { WORKSPACE_IDENTITY_REFRESH_EVENT } from '@/lib/workspace-identity-events';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const mocks=vi.hoisted(()=>({authFetch:vi.fn(),fetch:vi.fn(),mode:vi.fn(),save:vi.fn(),prepareAccess:vi.fn(),applyAccess:vi.fn(),confirm:vi.fn(),close:vi.fn()}));
const viewer=vi.hoisted(()=>({workspaceId:'review-workspace',me:{id:'admin'}}));
vi.mock('@/lib/auth-fetch',()=>({authFetch:mocks.authFetch}));
vi.mock('@/lib/runtime-public-config',()=>({publicRuntimeConfig:()=>({apiUrl:'https://api.example.test'})}));
vi.mock('@/lib/workspace-context',()=>({useWorkspaceContext:()=>viewer}));
vi.mock('@/lib/surface-prefetch',()=>({workspaceAccessModeCacheKey:(w:string,u:string)=>`workspace-access:${w}:${u}:mode`,scopeReviewCacheKey:(w:string,u:string,k:string,a:string,r:string,ra='',include=false)=>`scope-review:${w}:${u}:${k}:${a}:${r}:${ra}${include?':classified':''}`}));
vi.mock('@/lib/api/workspace-access',()=>({fetchScopeReview:mocks.fetch,fetchWorkspaceAccessMode:mocks.mode,saveScopeReview:mocks.save,prepareWorkspaceAccessCommand:mocks.prepareAccess,saveWorkspaceAccessCommand:mocks.applyAccess,ORGANIZATION_CHANGED_EVENT:'brian:organization-changed'}));
vi.mock('@/components/ui/confirm-dialog',()=>({confirmDialog:mocks.confirm}));
vi.mock('@/components/chrome/surface-skeleton',()=>({SurfaceSkeletonFor:()=> <div data-skeleton/>}));
// Exercise form decisions, not the shared combobox's own keyboard suite.
vi.mock('@/components/ui/searchable-select',()=>({SearchableSelect:({items,onValueChange,disabled,'aria-label':label}:{items:Array<{value:string;label:string}>;onValueChange:(v:string)=>void;disabled:boolean;'aria-label':string})=><div aria-label={label}>{items.map(item=><button type="button" disabled={disabled} key={item.value} data-value={item.value} onClick={()=>onValueChange(item.value)}>{item.label}</button>)}</div>}));
const t=en.scopeReview;
let root:Root,host:HTMLDivElement;
const protectedData=<T extends object>(data:T)=>({...data,projectionDeadline:Date.now()+30_000,projectionMonotonicDeadline:performance.now()+30_000});
function fixture():ScopeReviewInventory{return{validForMs:30_000,resourceKind:'memory',total:'2',nextCursor:'next-page',supportedKinds:['memory','task'],completeCoverage:false,uncovered:['readiness_v2_acceptance'],registryRevision:'1',reviewedInventoryRevision:null,policyRevision:'2',classificationMode:'review',readiness:{ready:false,enforcementVersion:2,requiredEnforcementVersion:2,missingCapabilities:['scope_review']},canActivateStrict:false,coverage:{registryRevision:'1',unresolved:'2',families:[]},recentReviews:[],nextReviewCursor:null,selectedReview:null,items:[{id:'record-one',version:'1',held:false,sensitivity:'confidential',compartments:[],projectIds:['project'],userId:'person',assistantId:null,canClassify:true,allowedActions:['confirm_general','assign_team','hold'],content:{title:'Quarterly plan',text:'Bounded content excerpt'}},{id:'held-record',version:'3',held:true,sensitivity:'internal',compartments:['research'],projectIds:[],userId:null,assistantId:null,canClassify:false,allowedActions:['confirm_general','assign_team','hold'],content:{title:'Held note',text:'Held content excerpt'}}]};}
function job():ScopeReview{return{id:'saved-review',workspaceId:'review-workspace',resourceKind:'memory',action:'assign_team',targetTeamId:'research',targetCompartment:'research',reason:'Explicit review',payloadHash:'a'.repeat(64),selectionRevision:'2',policyRevision:'2',version:'1',status:'preview',validForMs:30_000,completeCoverage:false,items:[{resourceId:'record-one',resourceVersion:'1',content:{title:'Quarterly plan',text:'Bounded content excerpt'},impact:{version:2,descendants:[],dependents:{}},source:{workspaceId:'review-workspace',resourceKind:'memory',resourceId:'record-one',version:'1',userId:'person',assistantId:null,sensitivity:'confidential',compartments:[],projectIds:['project'],held:false,validTo:null,retractedAt:null},status:'pending',resultVersion:null,errorCode:null}]};}
async function render(){await act(async()=>root.render(<I18nProvider locale="en" dict={en}><ScopeReviewPanel teams={[{id:'research',name:'Research'}]} close={mocks.close}/></I18nProvider>));}
async function click(label:string){const button=[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.trim()===label);expect(button).toBeDefined();await act(async()=>button!.click());}
async function select(id:string){await act(async()=>host.querySelector<HTMLButtonElement>(`[role="checkbox"][aria-label="${t.select} ${id}"]`)!.click());}
async function reason(){await act(async()=>{const input=host.querySelector('textarea')!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,'Classify selected source');input.dispatchEvent(new Event('input',{bubbles:true}));});}
beforeEach(()=>{viewer.workspaceId='review-workspace';viewer.me={id:'admin'};invalidateSurfaceCache('scope-review:');invalidateSurfaceCache('workspace-access:');mocks.mode.mockReset().mockImplementation(async()=>protectedData({workspaceId:viewer.workspaceId,mode:'departments',setupState:'ready',policyRevision:'2',defaultDepartmentId:'default-id',defaultDepartmentName:'Default department',canAdminister:true,validForMs:30_000}));mocks.fetch.mockReset().mockImplementation(async()=>protectedData(fixture()));mocks.save.mockReset().mockResolvedValue(protectedData(job()));mocks.prepareAccess.mockReset().mockResolvedValue({id:'activation-review',payloadHash:'b'.repeat(64),policyRevision:'2',expiresAt:new Date(Date.now()+30_000).toISOString(),validForMs:30_000,command:{type:'workspace.classification.set',mode:'strict',expectedPolicyRevision:'2',expectedInventoryRevision:'1'},changes:[{field:'classification_mode',before:[{kind:'code',value:'review'}],after:[{kind:'code',value:'strict'}]}]});mocks.applyAccess.mockReset().mockResolvedValue({validForMs:30_000,workspaceId:'review-workspace',policyRevision:'3',classificationMode:'strict',canAdminister:true,readiness:{ready:true,enforcementVersion:2,requiredEnforcementVersion:2,missingCapabilities:[]},teams:[],people:[],requests:[],grants:[]});mocks.confirm.mockReset().mockResolvedValue(true);mocks.close.mockReset();host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();invalidateSurfaceCache('scope-review:');invalidateSurfaceCache('workspace-access:');vi.useRealTimers();});

describe('[COMP:app-web/scope-review] explicit administrator review path',()=>{
  it('keeps strict activation visibly blocked until coverage and readiness qualify',async()=>{
    await render();
    expect(host.textContent).toContain(t.activationBlocked);expect(host.textContent).toContain('readiness_v2_acceptance');expect(host.textContent).toContain('scope_review');
    expect([...host.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent===t.activateStrict)?.disabled).toBe(true);
    expect(mocks.prepareAccess).not.toHaveBeenCalled();
  })
  it('activates strict mode only through the confirmed saved command bound to both revisions',async()=>{
    mocks.fetch.mockResolvedValue(protectedData({...fixture(),completeCoverage:true,uncovered:[],reviewedInventoryRevision:'1',readiness:{ready:true,enforcementVersion:2,requiredEnforcementVersion:2,missingCapabilities:[]},canActivateStrict:true}));
    await render();await click(t.activateStrict);
    expect(mocks.prepareAccess).toHaveBeenCalledWith('review-workspace',{type:'workspace.classification.set',mode:'strict',expectedPolicyRevision:'2',expectedInventoryRevision:'1'},'2',expect.any(String));
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({description:expect.stringContaining(t.activationConfirm)}));
    const effects=renderToStaticMarkup(<I18nProvider locale="en" dict={en}>{mocks.confirm.mock.calls[0][0].content}</I18nProvider>);
    expect(effects).toContain(t.classificationMode);expect(effects).toContain(t.review);expect(effects).toContain(t.strict);expect(effects).not.toContain(en.workspaceAccess.unnamed);
    expect(mocks.applyAccess).toHaveBeenCalledWith('review-workspace',{type:'access.command.apply',reviewId:'activation-review',payloadHash:'b'.repeat(64)});
  })
  it('replaces the pre-activation coverage warning after strict mode is active',async()=>{
    mocks.fetch.mockResolvedValue(protectedData({...fixture(),classificationMode:'strict',completeCoverage:true,uncovered:[],reviewedInventoryRevision:'1',readiness:{ready:true,enforcementVersion:2,requiredEnforcementVersion:2,missingCapabilities:[]},canActivateStrict:false}));
    await render();expect(host.textContent).toContain(t.activationActive);expect(host.textContent).not.toContain(t.coverage);
  })
  it('shows coverage and retained protections and previews only explicitly selected records',async()=>{
    await render();expect(host.textContent).toContain(t.coverage);expect(host.textContent).toContain(t.generalHint)
    expect(host.querySelector('select')).toBeNull();await select('record-one');await reason()
    await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))
    expect(mocks.save).toHaveBeenCalledWith('review-workspace',{type:'scope.review.preview',resourceKind:'memory',resourceIds:['record-one'],action:'confirm_general',targetTeamId:null,reason:'Classify selected source'})
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(mocks.fetch).toHaveBeenLastCalledWith('review-workspace','memory',undefined,'saved-review',undefined,false)
  })
  it('prevents accidental release of held records and requires a department for assignment',async()=>{
    await render();await select('held-record');await reason()
    expect(host.textContent).toContain(t.releaseRequired)
    const submit=()=>host.querySelector<HTMLButtonElement>('button[type="submit"]')!
    expect(submit().disabled).toBe(true);await click(t.hold);expect(submit().disabled).toBe(false)
    await select('held-record');await select('record-one');await click(t.assign_team)
    expect(submit().disabled).toBe(true);await click('Research');expect(submit().disabled).toBe(false)
  })
  it('reopens persisted progress and binds apply to the reviewed version and hash',async()=>{
    const saved=job();mocks.fetch.mockImplementation(async(_w,_k,_after,id)=>protectedData({...fixture(),recentReviews:[saved],selectedReview:id?saved:null}))
    await render();await click(`${t.memory} · ${t.assign_team} · ${t.preview} · saved-review`)
    expect(host.textContent).toContain('Explicit review');expect(host.textContent).toContain(t.private)
    await click(t.apply)
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({description:expect.stringContaining(t.applyHint)}))
    expect(mocks.save).toHaveBeenCalledWith('review-workspace',{type:'scope.review.apply',reviewId:saved.id,expectedVersion:'1',payloadHash:saved.payloadHash})
  })
  it('does not apply when confirmation is cancelled',async()=>{
    const saved=job();mocks.fetch.mockResolvedValue(protectedData({...fixture(),selectedReview:saved}));mocks.confirm.mockResolvedValue(false)
    await render();await click(t.apply);expect(mocks.save).not.toHaveBeenCalled()
  })
  it('opens one confirmation and submits once for same-tick repeated apply',async()=>{
    mocks.fetch.mockResolvedValue(protectedData({...fixture(),selectedReview:job()}));
    let confirm!:(answer:boolean)=>void;
    mocks.confirm.mockImplementation(()=>new Promise<boolean>(resolve=>{confirm=resolve;}));
    await render();
    const apply=[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===t.apply)!;
    await act(async()=>{apply.click();apply.click();});
    expect(mocks.confirm).toHaveBeenCalledTimes(1);expect(mocks.save).not.toHaveBeenCalled();
    await act(async()=>confirm(true));
    expect(mocks.save).toHaveBeenCalledTimes(1);
  })
  it.each(['permission','focus','organization','viewer','workspace','unmount'] as const)('cancels a pending confirmation on %s and refuses a late answer',async change=>{
    mocks.fetch.mockResolvedValue(protectedData({...fixture(),selectedReview:job()}));
    let confirm!:(answer:boolean)=>void;
    mocks.confirm.mockImplementation(()=>new Promise<boolean>(resolve=>{confirm=resolve;}));
    await render();await click(t.apply);
    const signal=mocks.confirm.mock.calls[0][0].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    if(change==='viewer'){viewer.me={id:'another-viewer'};await render();}
    else if(change==='workspace'){viewer.workspaceId='another-workspace';await render();}
    else if(change==='unmount')await act(async()=>root.render(null));
    else await act(async()=>window.dispatchEvent(change==='focus'?new Event('focus'):new CustomEvent(change==='permission'?WORKSPACE_IDENTITY_REFRESH_EVENT:'brian:organization-changed',{detail:{workspaceId:'review-workspace'}})));
    expect(signal.aborted).toBe(true);
    await act(async()=>confirm(true));
    expect(mocks.save).not.toHaveBeenCalled();
  })
  it('expires confirmation on the original projection deadline even if its answer arrives late',async()=>{
    vi.useFakeTimers();
    mocks.fetch.mockResolvedValue({...protectedData({...fixture(),selectedReview:job()}),projectionDeadline:Date.now()+100,projectionMonotonicDeadline:performance.now()+100});
    let confirm!:(answer:boolean)=>void;
    mocks.confirm.mockImplementation(()=>new Promise<boolean>(resolve=>{confirm=resolve;}));
    await render();await click(t.apply);
    mocks.fetch.mockImplementation(()=>new Promise(()=>{}));
    await act(async()=>{vi.advanceTimersByTime(101);});
    expect(mocks.confirm.mock.calls[0][0].signal.aborted).toBe(true);
    await act(async()=>confirm(true));
    expect(mocks.save).not.toHaveBeenCalled();
  })
  it('does not select an old mutation result after the viewer changes',async()=>{
    mocks.fetch.mockResolvedValue(protectedData({...fixture(),selectedReview:job()}));
    let complete!:(value:ReturnType<typeof protectedData<ScopeReview>>)=>void;
    mocks.save.mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
    await render();await click(t.apply);
    viewer.me={id:'another-viewer'};mocks.fetch.mockResolvedValue(protectedData(fixture()));await render();
    mocks.fetch.mockClear();
    await act(async()=>complete(protectedData({...job(),id:'old-viewer-review'})));
    expect(mocks.fetch.mock.calls.some(call=>call[3]==='old-viewer-review')).toBe(false);
    expect(host.textContent).not.toContain('Explicit review');
  })
  it('opens its saved preview after the successful API change notification',async()=>{
    mocks.save.mockImplementation(async()=>{window.dispatchEvent(new CustomEvent('brian:organization-changed',{detail:{workspaceId:'review-workspace'}}));return protectedData(job());});
    await render();await select('record-one');await reason();
    await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    expect(mocks.fetch).toHaveBeenLastCalledWith('review-workspace','memory',undefined,'saved-review',undefined,false);
  })
  it('shows a unique impact count and includes it in the concrete confirmation',async()=>{
    const saved=job();saved.items[0].impact={version:1,descendants:[{resourceId:'derived-one',version:'1',held:false},{resourceId:'derived-two',version:'2',held:true}]};
    saved.items.push({...saved.items[0],resourceId:'record-two'});
    mocks.fetch.mockResolvedValue(protectedData({...fixture(),selectedReview:saved}));await render();
    expect(host.textContent).toContain(`${t.impactCount}: 2`);expect(host.textContent).toContain(`${t.alreadyHeld}: 1`);
    expect(host.textContent).toContain(t.impactHint);expect(host.querySelector('details summary')?.textContent).toBe(t.impactRecords);
    expect(host.querySelectorAll('details li')).toHaveLength(2);
    await click(t.apply);
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({description:expect.stringContaining(`${t.impactCount}: 2`)}));
  })
  it('requires a new preview for older jobs without impact, but permits cancellation',async()=>{
    const saved=job();saved.items[0].impact=null;mocks.fetch.mockResolvedValue(protectedData({...fixture(),selectedReview:saved}));await render();
    expect(host.textContent).toContain(t.impactMissing);
    expect([...host.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent===t.apply)?.disabled).toBe(true);
    await click(t.apply);expect(mocks.save).not.toHaveBeenCalled();
    await click(t.cancelReview);expect(mocks.save).toHaveBeenCalledWith('review-workspace',expect.objectContaining({type:'scope.review.cancel'}));
  })
  it('offers smaller-batch recovery when the selected impact exceeds the bound',async()=>{
    mocks.save.mockRejectedValue(new Error('scope_review_impact_too_large'));
    await render();await select('record-one');await reason();
    await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    expect(host.textContent).toContain(t.impactTooLarge);
    expect(mocks.save).toHaveBeenCalledTimes(1);
  })
  it('explains stale batches and exposes no apply action for terminal jobs',async()=>{
    const saved=job();saved.status='stale';saved.items[0].status='stale';mocks.fetch.mockResolvedValue(protectedData({...fixture(),selectedReview:saved}))
    await render();expect(host.textContent).toContain(t.staleHint)
    expect([...host.querySelectorAll('button')].some(b=>b.textContent===t.apply)).toBe(false)
  })
  it('cancels remaining work through the same confirmed versioned command',async()=>{
    const saved=job();saved.status='running';mocks.fetch.mockResolvedValue(protectedData({...fixture(),selectedReview:saved}))
    await render();await click(t.cancelReview)
    expect(mocks.save).toHaveBeenCalledWith('review-workspace',{type:'scope.review.cancel',reviewId:saved.id,expectedVersion:'1',payloadHash:saved.payloadHash})
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({description:expect.stringContaining(t.cancelHint)}))
  })
  it('clears selections when paging and refuses to submit unseen records',async()=>{
    await render();await select('record-one');await reason();await click(t.next)
    expect(mocks.fetch).toHaveBeenLastCalledWith('review-workspace','memory','next-page',undefined,undefined,false)
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)
  })
  it('pages saved history independently and retains the selected review outside its page',async()=>{
    const saved=job(),older={...saved,id:'older-review'};
    mocks.fetch.mockImplementation(async(_w,_kind,_after,id,reviewAfter)=>protectedData({...fixture(),
      recentReviews:reviewAfter?[older]:[saved],nextReviewCursor:reviewAfter?null:'history-anchor',
      selectedReview:id?saved:null}));
    await render();await click(`${t.memory} · ${t.assign_team} · ${t.preview} · saved-review`);
    await click(t.olderReviews);
    expect(mocks.fetch).toHaveBeenLastCalledWith('review-workspace','memory',undefined,'saved-review','history-anchor',false);
    expect(host.querySelector('[data-value="saved-review"]')).not.toBeNull();
    expect(host.querySelector('[data-value="older-review"]')).not.toBeNull();
    expect(host.textContent).toContain('Explicit review');
    const olderButton=[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===t.olderReviews)!;
    expect(olderButton.disabled).toBe(true);
    await click(t.latestReviews);
    // Returning to a still-valid protected page may reuse its cached response.
    expect(host.querySelector('[data-value="older-review"]')).toBeNull();
    expect(host.querySelector('[data-value="saved-review"]')).not.toBeNull();
  })
  it('purges saved metadata when administrator access is lost',async()=>{
    const saved=job();mocks.fetch.mockResolvedValue(protectedData({...fixture(),selectedReview:saved}));await render()
    mocks.fetch.mockRejectedValue(new SurfaceCacheEvictionError(new Error('admin_required')))
    await act(async()=>window.dispatchEvent(new CustomEvent(WORKSPACE_IDENTITY_REFRESH_EVENT,{detail:{workspaceId:'review-workspace'}})))
    expect(host.textContent).not.toContain('Explicit review');expect(host.textContent).toContain(t.loadError)
  })
  it('consolidates labelled unheld rows only into the configured default, without a target picker',async()=>{
    const inventory=fixture();inventory.items[0].canClassify=false;inventory.items[0].compartments=['research'];inventory.items[0].allowedActions.push('consolidate_default');
    mocks.fetch.mockResolvedValue(protectedData(inventory));await render();await select('record-one');await reason();await click(t.consolidate_default);
    expect(host.textContent).toContain('Default department');expect(host.querySelector('[aria-label="'+en.workspaceAccess.team+'"]')).toBeNull();
    await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    expect(mocks.save).toHaveBeenCalledWith('review-workspace',expect.objectContaining({action:'consolidate_default',targetTeamId:'default-id',resourceIds:['record-one']}));
  })
  it.each(['held','unsupported','mode denied'] as const)('denies consolidation for %s',async failure=>{
    const inventory=fixture();inventory.items[0].allowedActions.push('consolidate_default');
    if(failure==='held')inventory.items[0].held=true;
    if(failure==='unsupported')inventory.items[0].allowedActions=['hold'];
    if(failure==='mode denied')mocks.mode.mockRejectedValue(new SurfaceCacheEvictionError(new Error('denied')));
    mocks.fetch.mockResolvedValue(protectedData(inventory));await render();await select('record-one');await reason();await click(t.consolidate_default);
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));expect(mocks.save).not.toHaveBeenCalled();
  })
  it('renders frozen consolidation audience evidence and expires apply while keeping cancellation',async()=>{
    vi.useFakeTimers();const saved=job();saved.action='consolidate_default';saved.expiresAt=new Date(Date.now()+100).toISOString();
    saved.items[0].impact={version:2,descendants:[],dependents:{},consolidation:{version:1,before:{...saved.items[0].source,compartments:['old-scope']},after:{...saved.items[0].source,compartments:['frozen-default']},visibility:{visibility:'private'},audiences:[{userId:'frozen-user',assistantId:'frozen-assistant',readBefore:false,readAfter:true,editBefore:false,editAfter:false}],futureDefaultMembersWarning:'server warning'}};
    mocks.fetch.mockResolvedValue(protectedData({...fixture(),selectedReview:saved}));await render();
    for(const text of ['old-scope','frozen-default','frozen-user','frozen-assistant',t.scopeOnly,t.futureMembers,t.readScope,t.editScope,saved.expiresAt])expect(host.textContent).toContain(text);
    let answer!:(v:boolean)=>void;mocks.confirm.mockImplementationOnce(()=>new Promise<boolean>(resolve=>{answer=resolve;}));await click(t.apply);
    await act(async()=>{vi.advanceTimersByTime(101);});expect(mocks.confirm.mock.calls[0][0].signal.aborted).toBe(true);await act(async()=>answer(true));expect(mocks.save).not.toHaveBeenCalled();
    expect(host.textContent).toContain(t.expired);await click(t.cancelReview);expect(mocks.save).toHaveBeenCalledWith('review-workspace',expect.objectContaining({type:'scope.review.cancel'}));
  })
  it('purges the configured default on organization changes and refuses late mode metadata',async()=>{
    await render();await click(t.consolidate_default);expect(host.textContent).toContain('Default department');
    mocks.mode.mockRejectedValue(new SurfaceCacheEvictionError(new Error('denied')));
    await act(async()=>window.dispatchEvent(new CustomEvent('brian:organization-changed',{detail:{workspaceId:viewer.workspaceId}})));
    expect(host.textContent).not.toContain('Default department');expect(host.textContent).toContain(t.defaultUnavailable);expect(mocks.mode).toHaveBeenCalledTimes(2);
  })
  it.each(['assign_team','hold'] as const)('preserves the %s preview body',async action=>{
    await render();await select('record-one');await reason();await click(t[action]);if(action==='assign_team')await click('Research');
    await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    expect(mocks.save).toHaveBeenCalledWith('review-workspace',expect.objectContaining({action,targetTeamId:action==='assign_team'?'research':null}));
  })
  it('hides expired mode projections immediately and refetches rather than reusing a mount-only default',async()=>{
    vi.useFakeTimers();mocks.mode.mockResolvedValue({...protectedData({canAdminister:true,defaultDepartmentId:'expired-default',defaultDepartmentName:'Expiring default'}),projectionDeadline:Date.now()+100,projectionMonotonicDeadline:performance.now()+100});
    await render();await click(t.consolidate_default);expect(host.textContent).toContain('Expiring default');
    mocks.mode.mockImplementation(()=>new Promise(()=>{}));await act(async()=>{vi.advanceTimersByTime(101);});
    expect(host.textContent).not.toContain('Expiring default');expect(host.textContent).toContain(t.defaultUnavailable);expect(mocks.mode).toHaveBeenCalledTimes(2);
  })
  it('switches classified inventory views, resets paging and clears old selections in both directions',async()=>{
    mocks.fetch.mockImplementation(async(_w,_kind,_after,_review,_reviewAfter,include)=>{
      const data=fixture();if(include){data.items[0].id='labelled-source';data.items[0].canClassify=false;data.items[0].compartments=['research'];data.items[0].allowedActions.push('consolidate_default');}
      return protectedData(data);
    });
    const toggle=async()=>act(async()=>host.querySelector<HTMLButtonElement>(`[role="checkbox"][aria-label="${t.includeClassified}"]`)!.click());
    await render();await click(t.next);await select('record-one');await reason();await toggle();
    expect(mocks.fetch).toHaveBeenLastCalledWith('review-workspace','memory',undefined,undefined,undefined,true);
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    expect(host.querySelector('[aria-label="'+t.select+' record-one"]')).toBeNull();
    await select('labelled-source');await click(t.consolidate_default);
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
    await toggle();expect(mocks.fetch).toHaveBeenLastCalledWith('review-workspace','memory',undefined,undefined,undefined,false);
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));expect(mocks.save).not.toHaveBeenCalled();
  })
  it('preserves ordinary canonical keys while separating classified inventory',async()=>{
    const {scopeReviewCacheKey}=await vi.importActual<typeof import('@/lib/surface-prefetch')>('@/lib/surface-prefetch');
    const ordinary=scopeReviewCacheKey('w','u','memory','','','');
    expect(ordinary).toBe('scope-review:w:u:memory:::');
    expect(scopeReviewCacheKey('w','u','memory','','','',false)).toBe(ordinary);
    expect(scopeReviewCacheKey('w','u','memory','','','',true)).toBe(`${ordinary}:classified`);
  })
  it('adds the classified query parameter only for an explicit included view',async()=>{
    const api=await vi.importActual<typeof import('@/lib/api/workspace-access')>('@/lib/api/workspace-access');
    mocks.authFetch.mockImplementation(async()=>({ok:true,json:async()=>fixture()}));
    await api.fetchScopeReview('workspace/id','memory');
    expect(new URL(mocks.authFetch.mock.calls.at(-1)![0]).searchParams.has('includeClassified')).toBe(false);
    await api.fetchScopeReview('workspace/id','memory',undefined,undefined,undefined,false);
    expect(new URL(mocks.authFetch.mock.calls.at(-1)![0]).searchParams.has('includeClassified')).toBe(false);
    await api.fetchScopeReview('workspace/id','memory',undefined,undefined,undefined,true);
    expect(new URL(mocks.authFetch.mock.calls.at(-1)![0]).searchParams.get('includeClassified')).toBe('true');
  })
  it('uses frozen visibility rather than source authorship in before and after scope',async()=>{
    const saved=job();saved.action='consolidate_default';saved.expiresAt=new Date(Date.now()+30_000).toISOString();
    saved.items[0].impact={version:2,descendants:[],dependents:{},consolidation:{version:1,before:saved.items[0].source,after:saved.items[0].source,visibility:{visibility:'workspace'},audiences:[],futureDefaultMembersWarning:'warning'}};
    mocks.fetch.mockResolvedValue(protectedData({...fixture(),selectedReview:saved}));await render();
    for(const label of [t.before,t.after]){
      const paragraph=[...host.querySelectorAll('p')].find(p=>p.textContent?.startsWith(label+':'))!;
      expect(paragraph.textContent).toContain(`${t.visibility}: ${t.workspace}`);expect(paragraph.textContent).not.toContain(t.private);
    }
  })
  it('keeps all locales complete and free of em dashes',()=>{
    for(const dict of [en,ja,zh,zhCN]){expect(Object.keys(dict.scopeReview).sort()).toEqual(Object.keys(t).sort());expect(JSON.stringify(dict.scopeReview)).not.toContain('—')}
  })
})
