// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {useCreationContext,ModeAwareCreationContext,type CreationContext,type CreationIntent} from '../mode-aware-context';
import {visibleOrganizationSections} from '@/lib/organization-navigation';
import {protectProjection} from '@/lib/use-protected-projection';
import {invalidateSurfaceCache} from '@/lib/surface-cache';
import {I18nProvider} from '@/lib/i18n/client';
import {en} from '@/lib/i18n/dictionaries/en';
const mocks=vi.hoisted(()=>({mode:vi.fn(),choices:vi.fn(),viewer:{workspaceId:'w',me:{id:'u'}}}));
vi.mock('@/lib/workspace-context',()=>({useWorkspaceContext:()=>mocks.viewer}));
vi.mock('@/lib/api/workspace-access',()=>({fetchWorkspaceAccessMode:mocks.mode,fetchWorkspaceCreationContext:mocks.choices,ORGANIZATION_CHANGED_EVENT:'brian:organization-changed'}));
vi.mock('@/lib/surface-prefetch',()=>({workspaceAccessModeCacheKey:(w:string,u:string)=>`workspace-access:${w}:${u}:mode`,workspaceCreationContextCacheKey:(w:string,u:string)=>`workspace-access:${w}:${u}:creation-context`}));
vi.mock('@/components/chrome/surface-skeleton',()=>({SurfaceSkeletonFor:()=> <div data-skeleton/>}));
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let host:HTMLDivElement,root:Root,context:CreationContext;
let mode={mode:'simple',setupState:'ready',policyRevision:'1',defaultDepartmentId:'team',canAdminister:false};
const projection=<T extends object>(value:T)=>protectProjection({...value,validForMs:30000},performance.now());
function Probe({intent,compact}:{intent:CreationIntent;compact?:boolean}){context=useCreationContext(intent);return <ModeAwareCreationContext context={context} compact={compact}/>;}
async function render(intent:CreationIntent='new-shared',compact=false){await act(async()=>root.render(<I18nProvider locale="en" dict={en}><Probe intent={intent} compact={compact}/></I18nProvider>));}
beforeEach(()=>{mode={mode:'simple',setupState:'ready',policyRevision:'1',defaultDepartmentId:'team',canAdminister:false};mocks.viewer.me.id='u';mocks.mode.mockImplementation(async()=>projection(mode));mocks.choices.mockImplementation(async()=>projection({policyRevision:mode.policyRevision,teams:[{id:'team',name:'Shared',status:'active'}],projects:[{id:'project',name:'Project A',status:'active'}]}));invalidateSurfaceCache('workspace-access:');host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();invalidateSurfaceCache('workspace-access:');vi.clearAllMocks();});
describe('[COMP:app-web/mode-aware-context] explicit creation intent',()=>{
 it.each([false,true])('keeps a pending creation read quiet (compact=%s) without admitting a send',async(compact)=>{
  let resolveChoices!:(value:ReturnType<typeof projection>)=>void;
  mocks.choices.mockImplementation(()=>new Promise(resolve=>{resolveChoices=resolve;}));
  await render('private',compact);
  expect(host.querySelector('[data-skeleton]')).toBeNull();
  expect(host.querySelector('button')).toBeNull();
  expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
  expect(context.ready).toBe(false);
  expect(context.snapshot()).toBeNull();
  await act(async()=>resolveChoices(projection({policyRevision:'1',teams:[],projects:[]})));
  expect(context.ready).toBe(true);
  expect(host.querySelector(`[aria-label="${en.contextScope.project}"]`)).not.toBeNull();
 });
 it('shows recovery only after a failed context read and restores admission after retry',async()=>{
  mocks.choices.mockRejectedValueOnce(new Error('context_unavailable'));
  await render('private',true);
  expect(context.ready).toBe(false);
  expect(context.snapshot()).toBeNull();
  expect(host.querySelector('[data-skeleton]')).toBeNull();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(en.modeContext.stale);
  const retry=host.querySelector('button')!;
  expect(retry.textContent).toBe(en.workspaceAccess.reload);
  await act(async()=>retry.click());
  expect(context.ready).toBe(true);
  expect(host.querySelector('[role="alert"]')).toBeNull();
 });
 it('admits a fresh shared Simple default, hides only department selection and keeps Project control',async()=>{await render();expect(context.ready).toBe(true);expect(context.snapshot()).toEqual({contextGroupId:'team',contextProjectId:null,expectedPolicyRevision:'1'});expect(host.textContent).toContain(en.modeContext.shared);expect(host.querySelector(`[aria-label="${en.contextScope.team}"]`)).toBeNull();expect(host.querySelector(`[aria-label="${en.contextScope.project}"]`)).not.toBeNull();});
 it('does not default or rebind existing intent',async()=>{await render('existing');expect(context.snapshot()).toBeNull();expect(mocks.choices).not.toHaveBeenCalled();expect(host.textContent).not.toContain(en.modeContext.shared);});
 it('binds a new personal chat from the same projection with no forced choice (chat-parity T5)',async()=>{await render('private');expect(mocks.choices).toHaveBeenCalled();expect(context.ready).toBe(true);expect(context.snapshot()).toEqual({contextGroupId:null,contextProjectId:null,expectedPolicyRevision:'1'});expect(host.textContent).toContain(en.modeContext.private);expect(host.textContent).not.toContain(en.modeContext.shared);expect(host.querySelector(`[aria-label="${en.contextScope.team}"]`)).not.toBeNull();await act(async()=>context.selectProject('project'));expect(context.snapshot()?.contextProjectId).toBe('project');});
 it('requires an explicit Departments choice, including explicit General',async()=>{mode.mode='departments';await render();expect(context.ready).toBe(false);await act(async()=>context.selectTeam(null));expect(context.snapshot()?.contextGroupId).toBeNull();expect(context.ready).toBe(true);});
 it('preserves legacy no-selection behavior without guessing an assignment',async()=>{mode.setupState='legacy';mode.mode='departments';await render();expect(context.ready).toBe(true);expect(context.snapshot()?.contextGroupId).toBeNull();});
 it('blocks changed authority until user reviews current context and retains no old selection',async()=>{await render();await act(async()=>context.selectProject('project'));mode={...mode,policyRevision:'2'};await act(async()=>window.dispatchEvent(new CustomEvent('brian:organization-changed',{detail:{workspaceId:'w'}})));expect(context.ready).toBe(false);expect(context.projectId).toBeNull();await act(async()=>context.review());expect(context.snapshot()?.expectedPolicyRevision).toBe('2');});
 it('ignores the catch-up refresh burst and keeps the selection',async()=>{await render();await act(async()=>context.selectProject('project'));await act(async()=>window.dispatchEvent(new CustomEvent('sidan:workspace-identity-refresh',{detail:{workspaceId:'w',catchUp:true}})));expect(context.reviewNeeded).toBe(false);expect(context.projectId).toBe('project');expect(context.ready).toBe(true);});
 it('does not ask for review when a change finds no explicit selection to drop',async()=>{await render();await act(async()=>window.dispatchEvent(new CustomEvent('brian:organization-changed',{detail:{workspaceId:'w'}})));expect(context.reviewNeeded).toBe(false);expect(host.textContent).not.toContain(en.modeContext.stale);});
 it('treats a fresh explicit pick as the review',async()=>{mode.mode='departments';await render();await act(async()=>context.selectTeam('team'));await act(async()=>window.dispatchEvent(new CustomEvent('brian:organization-changed',{detail:{workspaceId:'w'}})));expect(context.reviewNeeded).toBe(true);await act(async()=>context.selectTeam(null));expect(context.reviewNeeded).toBe(false);expect(context.ready).toBe(true);});
 it('compact host renders the pickers without explanatory copy',async()=>{mode.mode='departments';await render('new-shared',true);expect(host.querySelector(`[aria-label="${en.contextScope.project}"]`)).not.toBeNull();expect(host.textContent).not.toContain(en.modeContext.boundaries);expect(host.textContent).not.toContain(en.modeContext.choose);expect(host.textContent).not.toContain(en.contextScope.projectAccessHint);});
 it('never reuses another viewer selection',async()=>{mode.mode='departments';await render();await act(async()=>context.selectTeam('team'));mocks.viewer.me.id='other';await render();expect(context.ready).toBe(false);expect(context.teamId).toBeNull();});
 it('keeps admin routes while suppressing only ready Simple member routine access navigation',()=>{expect(visibleOrganizationSections(mode)).toEqual(['structure','people']);expect(visibleOrganizationSections({...mode,canAdminister:true})).toContain('access');expect(visibleOrganizationSections({...mode,setupState:'legacy'})).toContain('access');});
});
