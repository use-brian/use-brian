// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {WorkspaceAccessOverview,WorkspaceAccessExplanation,WorkspaceAccessEvents} from '@use-brian/shared';
import {AccessExplanationPanel,AccessEventsPanel} from '../access-inspection';
import {I18nProvider} from '@/lib/i18n/client';
import type {Dictionary} from '@/lib/i18n/dictionaries';
import type {Locale} from '@/lib/i18n/config';
import {en} from '@/lib/i18n/dictionaries/en';
import {ja} from '@/lib/i18n/dictionaries/ja';
import {zh} from '@/lib/i18n/dictionaries/zh';
import {zhCN} from '@/lib/i18n/dictionaries/zh-cn';
import {invalidateSurfaceCache,SurfaceCacheEvictionError} from '@/lib/surface-cache';
import {protectProjection} from '@/lib/use-protected-projection';
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const mocks=vi.hoisted(()=>({explain:vi.fn(),events:vi.fn(),viewer:{workspaceId:'fixture-workspace',me:{id:'fixture-member'}},close:vi.fn()}));
vi.mock('@/lib/workspace-context',()=>({useWorkspaceContext:()=>mocks.viewer}));
vi.mock('@/lib/api/workspace-access',()=>({fetchWorkspaceAccessExplanation:mocks.explain,fetchWorkspaceAccessEvents:mocks.events}));
vi.mock('@/lib/surface-prefetch',()=>({workspaceAccessInspectionCacheKey:(w:string,u:string,k:string,r:string,s:string)=>`workspace-access:${w}:${u}:${k}:${r}:${s}`}));
vi.mock('@/components/chrome/surface-skeleton',()=>({SurfaceSkeletonFor:()=> <div data-skeleton/>}));
vi.mock('@/components/ui/searchable-select',()=>({SearchableSelect:(props:{'aria-label':string;items:Array<{value:string;label:string}>;onValueChange:(value:string)=>void})=><div>{props.items.map(item=><button key={item.value} aria-label={`${props['aria-label']}: ${item.label}`} onClick={()=>props.onValueChange(item.value)}>{item.label}</button>)}</div>}));
const data={workspaceId:'fixture-workspace',policyRevision:'5',teams:[{id:'research',name:'Research'}]} as WorkspaceAccessOverview;
function explanation():WorkspaceAccessExplanation{return{workspaceId:data.workspaceId,policyRevision:'5',validForMs:30000,memberId:'fixture-member',assistantId:null,contextTeamId:null,contextProjectId:null,clearance:'internal',readTeamIds:['research'],mutationTeamIds:[],projectIds:null,choices:{assistants:[{id:'assistant',name:'Research assistant'}],projects:[]},paths:[{kind:'read_grant',grantId:'grant-one',sourceTeamId:null,targetTeamIds:['research'],expiresAt:'2030-01-01T00:00:00Z'},{kind:'read_grant',grantId:'grant-two',sourceTeamId:null,targetTeamIds:['research'],expiresAt:null}],management:[],example:{targetTeamId:null,action:'read',sensitivity:'internal',matchesScope:true,resourceAuthorizationRequired:true}};}
function events():WorkspaceAccessEvents{return{workspaceId:data.workspaceId,policyRevision:'5',validForMs:30000,nextCursor:'older-anchor',events:[{id:'event-one',kind:'access.grant.revoke',createdAt:'2026-01-01T00:00:00Z',policyRevision:'5',actor:{id:'fixture-member',name:'Riley'},subjectId:'grant-one'}]};}
let root:Root,host:HTMLDivElement;
const t=en.workspaceAccess;
async function render(kind:'explain'|'events'='explain',dict:Dictionary=en,locale:Locale='en'){
  await act(async()=>root.render(<I18nProvider dict={dict} locale={locale}>{kind==='explain'?<AccessExplanationPanel data={data} memberId={mocks.viewer.me.id} close={mocks.close}/>:<AccessEventsPanel data={data} close={mocks.close}/>}</I18nProvider>));
}
async function click(label:string){const button=[...host.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.getAttribute('aria-label')===label||node.textContent===label);expect(button).toBeDefined();await act(async()=>button!.click());}
beforeEach(()=>{vi.clearAllMocks();mocks.viewer.me.id='fixture-member';mocks.explain.mockReset().mockImplementation(async()=>protectProjection(explanation(),performance.now()));mocks.events.mockReset().mockImplementation(async()=>protectProjection(events(),performance.now()));invalidateSurfaceCache('workspace-access:');host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();invalidateSurfaceCache('workspace-access:');});
describe('[COMP:app-web/workspace-access] explanation and audit projections',()=>{
  it('shows independent paths and scope limitations without interpreting read access as edit authority',async()=>{
    await render();expect(mocks.explain).toHaveBeenCalledWith('fixture-workspace',{memberId:'fixture-member',expectedPolicyRevision:'5'});
    expect(host.textContent).toContain(t.resourceCheckRequired);expect(host.textContent?.split(t.pathGrant)).toHaveLength(3);
    expect(host.textContent).toContain(`${t.editReach}: ${t.generalOnly}`);
    let finish!:(value:unknown)=>void;mocks.explain.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}));
    await click(`${t.exampleAction}: ${t.editAction}`);
    expect(mocks.explain).toHaveBeenLastCalledWith('fixture-workspace',expect.objectContaining({action:'edit'}));
    expect(host.textContent).not.toContain(t.scopeMatches);
    await act(async()=>finish(protectProjection({...explanation(),example:{...explanation().example,action:'edit',matchesScope:false}},performance.now())));
    expect(host.textContent).toContain(t.scopeDenied);
  });
  it('keeps management eligibility separate from read and edit reach',async()=>{
    mocks.explain.mockImplementation(async()=>protectProjection({...explanation(),management:[{teamId:'research',canManageMembers:true,canApprove:false}]},performance.now()));
    await render();expect(host.textContent).toContain(t.managementHint);expect(host.textContent).toContain(t.manageMembers);
    expect(host.textContent).not.toContain(t.approveRequests);expect(host.textContent).toContain(`${t.editReach}: ${t.generalOnly}`);
  });
  it('does not restore a late privileged response after viewer changes',async()=>{
    let finish!:(value:unknown)=>void;mocks.explain.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}));
    await render();mocks.viewer.me.id='new-member';mocks.explain.mockRejectedValue(new SurfaceCacheEvictionError(new Error('not_found')));await render();
    await act(async()=>finish(protectProjection({...explanation(),paths:[{...explanation().paths[0],kind:'trusted_role',targetTeamIds:null}]},performance.now())));
    expect(host.textContent).not.toContain(t.pathTrusted);expect(host.textContent).toContain(t.loadError);
    expect(mocks.explain).toHaveBeenLastCalledWith('fixture-workspace',expect.objectContaining({memberId:'new-member'}));
  });
  it('withdraws old metadata on cache invalidation and offers a safe reset after an unavailable selection',async()=>{
    await render();mocks.explain.mockRejectedValue(new SurfaceCacheEvictionError(new Error('not_found')));
    await click(`${t.assistantCeiling}: Research assistant`);
    expect(host.textContent).toContain(t.loadError);expect(host.textContent).not.toContain(t.pathGrant);
    mocks.explain.mockImplementation(async()=>protectProjection(explanation(),performance.now()));await click(t.resetExample);
    expect(host.textContent).toContain(t.pathGrant);
    mocks.explain.mockRejectedValue(new SurfaceCacheEvictionError(new Error('not_found')));
    await act(async()=>invalidateSurfaceCache('workspace-access:'));
    expect(host.textContent).not.toContain(t.pathGrant);
  });
  it('pages audit independently, rejects changed policy and can return to newest',async()=>{
    await render('events');expect(host.textContent).toContain(t.auditGrant);
    mocks.events.mockImplementationOnce(async()=>protectProjection({...events(),nextCursor:null,events:[{...events().events[0],id:'event-two',kind:'department.create'}]},performance.now()));
    await click(t.olderEvents);expect(mocks.events).toHaveBeenLastCalledWith('fixture-workspace','older-anchor','5');expect(host.textContent).toContain(t.auditDepartment);expect(host.textContent).not.toContain(t.auditGrant);
    await click(t.newestHistory);expect(host.textContent).toContain(t.auditGrant);
    mocks.events.mockImplementation(async()=>protectProjection({...events(),policyRevision:'6'},performance.now()));
    await act(async()=>invalidateSurfaceCache('workspace-access:'));
    expect(host.textContent).not.toContain(t.auditGrant);expect(host.textContent).toContain(t.historyChanged);
  });
  it.each([{dict:en,locale:'en'},{dict:ja,locale:'ja'},{dict:zh,locale:'zh'},{dict:zhCN,locale:'zh-CN'}] as const)('renders inspection labels in $locale',async({dict,locale})=>{
    await render('explain',dict,locale);expect(host.textContent).toContain(dict.workspaceAccess.resourceCheckRequired);expect(host.textContent).toContain(dict.workspaceAccess.accessPaths);
  });
});
