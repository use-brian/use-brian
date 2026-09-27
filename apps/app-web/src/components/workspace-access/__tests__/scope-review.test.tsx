// @vitest-environment jsdom
import { act } from 'react';
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
const mocks=vi.hoisted(()=>({fetch:vi.fn(),save:vi.fn(),confirm:vi.fn(),close:vi.fn()}));
const viewer=vi.hoisted(()=>({workspaceId:'review-workspace',me:{id:'admin'}}));
vi.mock('@/lib/workspace-context',()=>({useWorkspaceContext:()=>viewer}));
vi.mock('@/lib/surface-prefetch',()=>({scopeReviewCacheKey:(...parts:string[])=>`scope-review:${parts.join(':')}`}));
vi.mock('@/lib/api/workspace-access',()=>({fetchScopeReview:mocks.fetch,saveScopeReview:mocks.save,ORGANIZATION_CHANGED_EVENT:'brian:organization-changed'}));
vi.mock('@/components/ui/confirm-dialog',()=>({confirmDialog:mocks.confirm}));
vi.mock('@/components/chrome/surface-skeleton',()=>({SurfaceSkeletonFor:()=> <div data-skeleton/>}));
// Exercise form decisions, not the shared combobox's own keyboard suite.
vi.mock('@/components/ui/searchable-select',()=>({SearchableSelect:({items,onValueChange,disabled,'aria-label':label}:{items:Array<{value:string;label:string}>;onValueChange:(v:string)=>void;disabled:boolean;'aria-label':string})=><div aria-label={label}>{items.map(item=><button type="button" disabled={disabled} key={item.value} data-value={item.value} onClick={()=>onValueChange(item.value)}>{item.label}</button>)}</div>}));
const t=en.scopeReview;
let root:Root,host:HTMLDivElement;
const protectedData=<T extends object>(data:T)=>({...data,projectionDeadline:Date.now()+30_000,projectionMonotonicDeadline:performance.now()+30_000});
function fixture():ScopeReviewInventory{return{validForMs:30_000,resourceKind:'memory',total:'2',nextCursor:'next-page',supportedKinds:['memory','task'],completeCoverage:false,uncovered:['office'],recentReviews:[],nextReviewCursor:null,selectedReview:null,items:[{id:'record-one',version:'1',held:false,sensitivity:'confidential',compartments:[],projectIds:['project'],userId:'person',assistantId:null,canClassify:true},{id:'held-record',version:'3',held:true,sensitivity:'internal',compartments:['research'],projectIds:[],userId:null,assistantId:null,canClassify:false}]};}
function job():ScopeReview{return{id:'saved-review',workspaceId:'review-workspace',resourceKind:'memory',action:'assign_team',targetTeamId:'research',targetCompartment:'research',reason:'Explicit review',payloadHash:'a'.repeat(64),selectionRevision:'2',policyRevision:'2',version:'1',status:'preview',validForMs:30_000,completeCoverage:false,items:[{resourceId:'record-one',resourceVersion:'1',impact:{version:1,descendants:[]},source:{workspaceId:'review-workspace',resourceKind:'memory',resourceId:'record-one',version:'1',userId:'person',assistantId:null,sensitivity:'confidential',compartments:[],projectIds:['project'],held:false,validTo:null,retractedAt:null},status:'pending',resultVersion:null,errorCode:null}]};}
async function render(){await act(async()=>root.render(<I18nProvider locale="en" dict={en}><ScopeReviewPanel teams={[{id:'research',name:'Research'}]} close={mocks.close}/></I18nProvider>));}
async function click(label:string){const button=[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.trim()===label);expect(button).toBeDefined();await act(async()=>button!.click());}
async function select(id:string){await act(async()=>host.querySelector<HTMLButtonElement>(`[role="checkbox"][aria-label="${t.select} ${id}"]`)!.click());}
async function reason(){await act(async()=>{const input=host.querySelector('textarea')!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,'Classify selected source');input.dispatchEvent(new Event('input',{bubbles:true}));});}
beforeEach(()=>{viewer.workspaceId='review-workspace';viewer.me={id:'admin'};invalidateSurfaceCache('scope-review:');mocks.fetch.mockReset().mockImplementation(async()=>protectedData(fixture()));mocks.save.mockReset().mockResolvedValue(protectedData(job()));mocks.confirm.mockReset().mockResolvedValue(true);mocks.close.mockReset();host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();invalidateSurfaceCache('scope-review:');vi.useRealTimers();});

describe('[COMP:app-web/scope-review] explicit administrator review path',()=>{
  it('shows coverage and retained protections and previews only explicitly selected records',async()=>{
    await render();expect(host.textContent).toContain(t.coverage);expect(host.textContent).toContain(t.generalHint)
    expect(host.querySelector('select')).toBeNull();await select('record-one');await reason()
    await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))
    expect(mocks.save).toHaveBeenCalledWith('review-workspace',{type:'scope.review.preview',resourceKind:'memory',resourceIds:['record-one'],action:'confirm_general',targetTeamId:null,reason:'Classify selected source'})
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(mocks.fetch).toHaveBeenLastCalledWith('review-workspace','memory',undefined,'saved-review',undefined)
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
    expect(mocks.fetch).toHaveBeenLastCalledWith('review-workspace','memory',undefined,'saved-review',undefined);
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
    expect(mocks.fetch).toHaveBeenLastCalledWith('review-workspace','memory','next-page',undefined,undefined)
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)
  })
  it('pages saved history independently and retains the selected review outside its page',async()=>{
    const saved=job(),older={...saved,id:'older-review'};
    mocks.fetch.mockImplementation(async(_w,_kind,_after,id,reviewAfter)=>protectedData({...fixture(),
      recentReviews:reviewAfter?[older]:[saved],nextReviewCursor:reviewAfter?null:'history-anchor',
      selectedReview:id?saved:null}));
    await render();await click(`${t.memory} · ${t.assign_team} · ${t.preview} · saved-review`);
    await click(t.olderReviews);
    expect(mocks.fetch).toHaveBeenLastCalledWith('review-workspace','memory',undefined,'saved-review','history-anchor');
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
  it('keeps all locales complete and free of em dashes',()=>{
    for(const dict of [en,ja,zh,zhCN]){expect(Object.keys(dict.scopeReview).sort()).toEqual(Object.keys(t).sort());expect(JSON.stringify(dict.scopeReview)).not.toContain('—')}
  })
})
