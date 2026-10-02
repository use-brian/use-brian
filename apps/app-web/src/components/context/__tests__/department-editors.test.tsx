// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import {protectProjection} from '@/lib/use-protected-projection';
import {resetSurfaceCache,SurfaceCacheEvictionError} from '@/lib/surface-cache';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeamsContextSection } from '@/components/settings-modal/sections/context-scopes-section';
import { AssistantContextSettings } from '../assistant-context-settings';
import { I18nProvider } from '@/lib/i18n/client';
import { en } from '@/lib/i18n/dictionaries/en';
import { WORKSPACE_IDENTITY_REFRESH_EVENT } from '@/lib/workspace-identity-events';
import { DepartmentChangeFeedback, useDepartmentChange } from '@/components/workspace-access/use-department-change';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const mocks=vi.hoisted(()=>({registry:vi.fn(),fetch:vi.fn(),prepare:vi.fn(),save:vi.fn(),confirm:vi.fn(),detail:vi.fn(),config:vi.fn(),viewer:{workspaceId:'workspace',me:{id:'owner'},role:'owner'}}));
vi.mock('@/lib/workspace-context',()=>({useWorkspaceContext:()=>mocks.viewer}));
vi.mock('@/lib/api/workspace-access',()=>({fetchWorkspaceAccess:mocks.fetch,fetchWorkspaceDepartmentRegistry:mocks.registry,prepareWorkspaceAccessCommand:mocks.prepare,saveWorkspaceAccessCommand:mocks.save,ORGANIZATION_CHANGED_EVENT:'brian:organization-changed'}));
vi.mock('@/components/ui/confirm-dialog',()=>({confirmDialog:mocks.confirm}));
vi.mock('@/components/organization/department-access-panel',()=>({AssistantHomeDepartment:({assistantId}:{assistantId:string})=><p>home-picker:{assistantId}</p>}));
vi.mock('@/lib/auth-fetch',()=>({authFetch:vi.fn(async(url:string)=>({ok:true,json:async()=>url.includes('/assistants?')?{assistants:[{id:'assistant',name:'Research assistant'}]}:{members:[{userId:'person',userName:'Riley'}]}}))}));
const team={id:'team',name:'Research',key:'research',description:null,color:null,status:'active',readAll:false,readGrantGroupIds:[],memberCount:0,members:[],assistantIds:[]};
vi.mock('@/lib/api/context-scopes',()=>({
  listContextTeams:vi.fn(async()=>[team]),getContextTeam:mocks.detail,
  listContextProjects:vi.fn(async()=>[]),getAssistantContext:mocks.config,
  getContextExplanation:vi.fn(async()=>null),
}));
function registry(validForMs=30000){return protectProjection({workspaceId:'workspace',policyRevision:'15',directoryRevision:'1',validForMs,canAdminister:true,teams:[{...team,memberIds:[],orgUnits:[{id:'unit',name:'Published unit'}]}],people:[{id:'person',name:'Riley'}],assistants:[{id:'assistant',name:'Research assistant'}],requestPolicy:{defaultDays:30,maxDays:90,ongoingAdminOnly:true}},performance.now());}
let root:Root,host:HTMLDivElement;
const t=en.contextScope,a=en.workspaceAccess;
async function render(node:ReactNode){await act(async()=>root.render(<I18nProvider locale="en" dict={en}>{node}</I18nProvider>));}
function button(label:string){const node=[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.trim()===label);expect(node).toBeDefined();return node!;}
async function click(label:string){await act(async()=>button(label).click());}
async function input(node:HTMLInputElement,value:string){await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));});}
async function checkbox(label:string){const row=[...host.querySelectorAll('label')].find(n=>n.textContent?.trim()===label);expect(row).toBeDefined();await act(async()=>row!.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());}
beforeEach(()=>{
  resetSurfaceCache();mocks.registry.mockReset().mockImplementation(async()=>registry());
  mocks.viewer.me.id='owner';mocks.viewer.role='owner';mocks.fetch.mockReset().mockResolvedValue({policyRevision:'15'});
  mocks.prepare.mockReset().mockImplementation(async(_w,command)=>({id:'review',payloadHash:'a'.repeat(64),command,changes:[],expiresAt:'2030-01-01T00:00:00Z',validForMs:30000,policyRevision:'15'}));
  mocks.save.mockReset().mockResolvedValue({appliedCommand:{subjectId:'new-team'}});mocks.confirm.mockReset().mockResolvedValue(true);
  mocks.detail.mockReset().mockResolvedValue(team);mocks.config.mockReset().mockResolvedValue({teamMode:'all',teamIds:[],defaultGroupId:null,projectMode:'all',projectIds:[],defaultProjectId:null});
  host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.useRealTimers();});
function expectApplied(){expect(mocks.save).toHaveBeenCalledWith('workspace',{type:'access.command.apply',reviewId:'review',payloadHash:'a'.repeat(64)});}
function Harness(){const change=useDepartmentChange('workspace');return <><button onClick={()=>void change.save({type:'department.archive',teamId:'team'},'Research')}>Change</button><button onClick={()=>void change.save({type:'department.archive',teamId:'other'},'Other')}>Other</button><DepartmentChangeFeedback change={change}/></>;}

describe('[COMP:app-web/context-scope] reviewed Team and assistant editors',()=>{
  it('separates department identity and lifecycle, and leaves who reads it to the department panel',async()=>{
    await render(<TeamsContextSection renderAccessSettings={id=><p>roster:{id}</p>}/>);
    for(const heading of [t.departmentPickerLabel,t.createTeamTitle,t.departmentDetailsTitle,t.departmentLifecycleTitle])expect(host.textContent).toContain(heading);
    expect(host.textContent).toContain('roster:team');
    // Membership checkboxes and Team-to-Team read packages are retired (D26): one roster.
    for(const retired of [t.membershipTitle,t.readAccessTitle,t.readAllTeams,t.saveAccess])expect(host.textContent).not.toContain(retired);
    expect(host.querySelector('[role="checkbox"]')).toBeNull();
  });
  it('uses current registry capabilities and shows only the authorized related units',async()=>{
    mocks.registry.mockImplementation(async()=>({...registry(),canAdminister:false}));await render(<TeamsContextSection/>);
    expect(host.textContent).toContain('Published unit');expect(host.textContent).toContain('90');expect(host.textContent).not.toContain(t.createTeam);
    expect([...host.querySelectorAll('button')].some(node=>node.textContent?.trim()===t.saveAccess)).toBe(false);
  });
  it('purges on authority changes and rejects a late registry response',async()=>{
    await render(<TeamsContextSection/>);expect(host.textContent).toContain('Research');
    let finish!:(value:ReturnType<typeof registry>)=>void;mocks.registry.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}));
    await act(async()=>window.dispatchEvent(new CustomEvent(WORKSPACE_IDENTITY_REFRESH_EVENT,{detail:{workspaceId:'workspace'}})));
    expect(host.textContent).not.toContain('Research');
    mocks.registry.mockRejectedValue(new SurfaceCacheEvictionError(new Error('not_found')));
    await act(async()=>window.dispatchEvent(new CustomEvent(WORKSPACE_IDENTITY_REFRESH_EVENT,{detail:{workspaceId:'workspace'}})));
    await act(async()=>finish(registry()));expect(host.textContent).not.toContain('Research');expect(host.textContent).not.toContain('Riley');
  });
  it('hides expired metadata when its refresh remains pending',async()=>{
    vi.useFakeTimers();mocks.registry.mockResolvedValueOnce(registry(20)).mockImplementation(()=>new Promise(()=>{}));
    await render(<TeamsContextSection/>);expect(host.textContent).toContain('Research');
    await act(async()=>vi.advanceTimersByTimeAsync(25));expect(host.textContent).not.toContain('Research');expect(host.textContent).not.toContain('Riley');
  });
  it('preserves an unfinished draft across renewal of identical metadata',async()=>{
    vi.useFakeTimers();await render(<TeamsContextSection/>);
    const edit=[...host.querySelectorAll<HTMLInputElement>('input')].find(node=>node.value==='Research')!;
    await input(edit,'Unfinished edit');await act(async()=>vi.advanceTimersByTimeAsync(26000));
    expect([...host.querySelectorAll<HTMLInputElement>('input')].some(node=>node.value==='Unfinished edit')).toBe(true);
    expect(mocks.registry.mock.calls.length).toBeGreaterThan(1);
  });
  it('prepares creation and cancellation never changes a Team',async()=>{
    mocks.confirm.mockResolvedValue(false);await render(<TeamsContextSection/>);
    await input(host.querySelector<HTMLInputElement>(`input[placeholder="${t.teamNamePlaceholder}"]`)!,'Design');await click(t.createTeam);
    expect(mocks.prepare).toHaveBeenCalledWith('workspace',{type:'department.create',name:'Design',key:'design'},'15',expect.any(String));
    expect(mocks.save).not.toHaveBeenCalled();expect(host.textContent).toContain('Research');
  });
  it('archives with one confirmation',async()=>{
    await render(<TeamsContextSection/>);
    await click(t.archiveTeam);expect(mocks.confirm).toHaveBeenCalledTimes(1);expect(mocks.prepare.mock.calls[0][1]).toEqual({type:'department.archive',teamId:'team'});expectApplied();
  });
  it('saves full assistant audience and defaults only after review',async()=>{
    await render(<AssistantContextSettings workspaceId="workspace" assistantId="assistant" canManage/>);
    // Departments are set in Organization > Departments; the home picker replaces the default Team.
    expect(host.textContent).toContain(t.assistantDepartmentsNote);expect(host.textContent).toContain('home-picker:assistant');
    expect(host.textContent).not.toContain(t.teamAccessMode);
    await click(t.saveContext);
    expect(mocks.prepare.mock.calls[0][1]).toEqual({type:'assistant.audience.set',assistantId:'assistant',teamMode:'all',teamIds:[],defaultGroupId:null,projectMode:'all',projectIds:[],defaultProjectId:null});expectApplied();expect(host.textContent).toContain(t.saved);
  });
  it('exposes retry in the assistant editor and refreshes after the same receipt succeeds',async()=>{
    mocks.save.mockRejectedValueOnce(new TypeError('lost response'));
    await render(<AssistantContextSettings workspaceId="workspace" assistantId="assistant" canManage/>);await click(t.saveContext);await click(a.retryChange);
    expect(mocks.prepare).toHaveBeenCalledTimes(1);expect(mocks.confirm).toHaveBeenCalledTimes(1);expect(mocks.save).toHaveBeenCalledTimes(2);expectApplied();expect(host.textContent).toContain(t.saved);
  });
});

describe('[COMP:app-web/workspace-access] shared command confirmation lifetime',()=>{
  it('guards rapid clicks and a permission event prevents late confirmation',async()=>{
    let finish:(value:boolean)=>void=()=>{};mocks.confirm.mockImplementation(()=>new Promise<boolean>(resolve=>{finish=resolve}));
    await render(<Harness/>);await act(async()=>{button('Change').click();button('Change').click();});expect(mocks.prepare).toHaveBeenCalledTimes(1);
    const signal=mocks.confirm.mock.calls[0][0].signal as AbortSignal;
    await act(async()=>window.dispatchEvent(new CustomEvent(WORKSPACE_IDENTITY_REFRESH_EVENT,{detail:{workspaceId:'workspace'}})));expect(signal.aborted).toBe(true);
    await act(async()=>finish(true));expect(mocks.save).not.toHaveBeenCalled();
  });
  it('blocks another intent while a confirmed result is uncertain, then retries the saved receipt',async()=>{
    mocks.save.mockRejectedValueOnce(new TypeError('lost response'));await render(<Harness/>);await click('Change');await click('Other');
    expect(host.textContent).toContain(a.pendingChange);expect(mocks.prepare).toHaveBeenCalledTimes(1);await click(a.retryChange);expect(mocks.save).toHaveBeenCalledTimes(2);expect(mocks.confirm).toHaveBeenCalledTimes(1);
  });
  it('expires unconfirmed metadata and never applies a late confirmation',async()=>{
    vi.useFakeTimers();let finish:(value:boolean)=>void=()=>{};mocks.confirm.mockImplementation(()=>new Promise<boolean>(resolve=>{finish=resolve}));
    await render(<Harness/>);await click('Change');await act(async()=>vi.advanceTimersByTime(30001));expect(mocks.confirm.mock.calls[0][0].signal.aborted).toBe(true);expect(host.textContent).toContain(a.reviewExpired);
    await act(async()=>finish(true));expect(mocks.save).not.toHaveBeenCalled();
  });
  it('never transfers a late review into another signed-in identity',async()=>{
    let finish:(value:boolean)=>void=()=>{};mocks.confirm.mockImplementation(()=>new Promise<boolean>(resolve=>{finish=resolve}));
    await render(<Harness/>);await click('Change');mocks.viewer.me.id='different-person';await render(<Harness/>);await act(async()=>finish(true));expect(mocks.save).not.toHaveBeenCalled();
  });
  it('discards a saved editor refresh that arrives after switching assistants',async()=>{
    await render(<AssistantContextSettings workspaceId="workspace" assistantId="assistant" canManage/>);
    let finish:(value:unknown)=>void=()=>{};
    mocks.config.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}));
    await click(t.saveContext);
    await render(<AssistantContextSettings workspaceId="workspace" assistantId="other-assistant" canManage/>);
    await act(async()=>finish({teamMode:'assigned',teamIds:['team'],defaultGroupId:'team',projectMode:'assigned',projectIds:[],defaultProjectId:null}));
    expect(host.querySelector(`[aria-label="${t.projectAccessMode}"]`)?.textContent).toContain(t.allProjects);
    expect(host.textContent).not.toContain(t.saved);
  });
  it('cancels an assistant review when switching to another assistant',async()=>{
    let finish:(value:boolean)=>void=()=>{};mocks.confirm.mockImplementation(()=>new Promise<boolean>(resolve=>{finish=resolve}));
    await render(<AssistantContextSettings workspaceId="workspace" assistantId="assistant" canManage/>);await click(t.saveContext);
    await render(<AssistantContextSettings workspaceId="workspace" assistantId="other-assistant" canManage/>);await act(async()=>finish(true));expect(mocks.save).not.toHaveBeenCalled();
  });
});
