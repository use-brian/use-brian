// @vitest-environment jsdom
import type { ProtectedProjection } from '@/lib/use-protected-projection';
import { act } from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrganizationChart } from '@use-brian/shared';
import { OrganizationChartView } from '../organization-chart';
import { I18nProvider } from '@/lib/i18n/client';
import { en } from '@/lib/i18n/dictionaries/en';
import { ja } from '@/lib/i18n/dictionaries/ja';
import { zh } from '@/lib/i18n/dictionaries/zh';
import { zhCN } from '@/lib/i18n/dictionaries/zh-cn';
import { invalidateSurfaceCache, loadSurfaceCache, SurfaceCacheEvictionError } from '@/lib/surface-cache';
import { WORKSPACE_IDENTITY_REFRESH_EVENT } from '@/lib/workspace-identity-events';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const mocks=vi.hoisted(()=>({fetch:vi.fn(),prepare:vi.fn(),save:vi.fn(),confirm:vi.fn(),settings:vi.fn(),viewer:{workspaceId:'workspace-fixture',me:{id:'member-fixture'}}}));
vi.mock('@/lib/workspace-context',()=>({useWorkspaceContext:()=>mocks.viewer}));
vi.mock('@/lib/surface-prefetch',()=>({organizationCacheKey:(w:string,u:string)=>`organization:${w}:${u}`}));
vi.mock('@/lib/api/workspace-access',()=>({fetchOrganizationChart:mocks.fetch,prepareOrganizationCommand:mocks.prepare,saveOrganizationCommand:mocks.save,ORGANIZATION_CHANGED_EVENT:'brian:organization-changed'}));
vi.mock('@/lib/workspace-settings-events',()=>({openWorkspaceSettings:mocks.settings}));
vi.mock('@/components/ui/confirm-dialog',()=>({confirmDialog:mocks.confirm}));
vi.mock('@/components/chrome/surface-skeleton',()=>({SurfaceSkeletonFor:()=> <div data-skeleton/>}));
vi.mock('next/link',()=>({default:({children,...props}:React.AnchorHTMLAttributes<HTMLAnchorElement>)=><a {...props}>{children}</a>}));

let root:Root,host:HTMLDivElement;
function fixture():ProtectedProjection<OrganizationChart>{return{validForMs:30_000,projectionDeadline:Date.now()+30_000,projectionMonotonicDeadline:performance.now()+30_000,workspaceId:'workspace-fixture',revision:'1',canManage:true,initialization:{policyRevision:'8',candidates:[]},units:[{id:'unit-1',parentId:null,name:'Research',position:0,teamId:null,teamName:null,directoryVisibility:'workspace',version:'1'}],placements:[{id:'person-placement',unitId:'unit-1',userId:'member-fixture',assistantId:null,isPrimary:true,reportsToUserId:null,accountableUserId:null,version:'1'},{id:'assistant-placement',unitId:'unit-1',userId:null,assistantId:'assistant-fixture',isPrimary:true,reportsToUserId:null,accountableUserId:'member-fixture',version:'1'}],subjects:[{id:'member-fixture',kind:'member',name:'Riley'},{id:'assistant-fixture',kind:'assistant',name:'Research assistant'},{id:'unassigned-fixture',kind:'member',name:'Casey'}],teams:[]};}
async function render(){await act(async()=>{root.render(<I18nProvider locale="en" dict={en}><OrganizationChartView/></I18nProvider>);});}
function button(text:string){const result=[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.includes(text));expect(result).toBeDefined();return result!;}
async function click(text:string){await act(async()=>button(text).click());}
async function input(label:string,value:string){const el=host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)??[...host.querySelectorAll('label')].find(l=>l.textContent?.includes(label))?.querySelector('input');expect(el).toBeTruthy();await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(el,value);el!.dispatchEvent(new Event('input',{bubbles:true}));});}
beforeEach(()=>{mocks.viewer.me.id='member-fixture';mocks.fetch.mockReset().mockResolvedValue(fixture());mocks.save.mockReset().mockResolvedValue(fixture());mocks.prepare.mockReset().mockImplementation(async(_w,intent)=>({id:'review',payloadHash:'a'.repeat(64),command:intent.command,validForMs:30000,expiresAt:'2030-01-01T00:00:00Z',effects:[]}));mocks.confirm.mockReset().mockResolvedValue(true);mocks.settings.mockReset();invalidateSurfaceCache('organization:');host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();invalidateSurfaceCache('organization:');vi.useRealTimers();});

describe('[COMP:app-web/organization-chart] directory and configuration UX',()=>{
  it('requires an explicit primary department selection and confirms the exact initialization command',async()=>{
    const chart=fixture();chart.teams=[{id:'research-team',name:'Research department'},{id:'operations-team',name:'Operations department'}];
    chart.initialization={policyRevision:'8',candidates:[{subjectId:'unassigned-fixture',kind:'member',teamIds:['research-team','operations-team']}]};
    mocks.fetch.mockResolvedValue(chart);await render();await click(en.organization.initialize);
    const aside=host.querySelector('aside')!;
    await act(async()=>[...aside.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.includes('Casey'))!.click());
    expect(aside.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    expect(aside.querySelector('[aria-pressed="true"]')?.textContent).toContain('Casey');
    await click('Operations department');
    expect(aside.textContent).toContain(en.organization.initializeCreates.replace('{unit}','Operations department'));
    await act(async()=>aside.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({description:expect.stringContaining('Casey: Create a members-only root unit named Operations department')}));
    expect(mocks.prepare).toHaveBeenCalledWith('workspace-fixture',{command:{type:'org.initialize.subject',subjectId:'unassigned-fixture',kind:'member',teamId:'operations-team',expectedRevision:'1',expectedPolicyRevision:'8'},expectedRevision:'1',expectedPolicyRevision:'8',idempotencyKey:expect.any(String)});
    expect(mocks.save).toHaveBeenCalledWith('workspace-fixture',{type:'org.command.apply',reviewId:'review',payloadHash:'a'.repeat(64)});
  });
  it('cancelling setup confirmation writes nothing and members never receive the setup action',async()=>{
    const chart=fixture();chart.teams=[{id:'research-team',name:'Research department'}];chart.initialization={policyRevision:'8',candidates:[{subjectId:'unassigned-fixture',kind:'member',teamIds:['research-team']}]};
    mocks.fetch.mockResolvedValue(chart);mocks.confirm.mockResolvedValue(false);await render();await click(en.organization.initialize);
    const aside=host.querySelector('aside')!;
    await act(async()=>[...aside.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.includes('Casey'))!.click());
    expect(aside.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    await click('Research department');
    await act(async()=>aside.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    expect(mocks.save).not.toHaveBeenCalled();
    mocks.fetch.mockResolvedValue({...chart,canManage:false});
    await act(async()=>window.dispatchEvent(new CustomEvent(WORKSPACE_IDENTITY_REFRESH_EVENT,{detail:{workspaceId:'workspace-fixture'}})));
    expect(host.textContent).not.toContain(en.organization.initialize);
  });
  it('shows a keyboard-operable outline, nests an assistant under its accountable person and exposes Unassigned',async()=>{
    await render();
    expect(host.querySelector('details[open] summary')?.textContent).toBe('Research');
    expect(button('Riley').parentElement?.querySelector('ul')?.textContent).toContain('Research assistant');
    expect(host.textContent).toContain(en.organization.unassigned);
    expect(host.textContent).toContain(en.organization.adminHint);
    expect(host.querySelector('select')).toBeNull();
    await click('Research assistant');
    expect(document.activeElement?.textContent).toBe('Research assistant');
    expect(host.querySelector('aside a')?.getAttribute('href')).toBe('/w/workspace-fixture/studio/assistants?assistant=assistant-fixture');
    expect(host.querySelector('a')?.getAttribute('href')).toBe('/w/workspace-fixture/organization?section=departments');
  });
  it('nests a human direct report and their assistant under the manager within a unit',async()=>{
    const chart=fixture();chart.placements.push({id:'report-placement',unitId:'unit-1',userId:'unassigned-fixture',assistantId:null,isPrimary:true,reportsToUserId:'member-fixture',accountableUserId:null,version:'1'});
    chart.placements[1].accountableUserId='unassigned-fixture';mocks.fetch.mockResolvedValue(chart);await render();
    const manager=button('Riley').parentElement!,report=button('Casey').parentElement!;
    expect(manager.querySelector('ul')?.contains(report)).toBe(true);
    expect(report.querySelector('ul')?.textContent).toContain('Research assistant');
    await input(en.organization.search,'Casey');
    expect(host.textContent).toContain('Casey');expect(host.textContent).not.toContain('Research assistant');
  });
  it('creates a restricted unit through the shared command, with a concrete confirmation and no membership mutation',async()=>{
    await render();await click(en.organization.addUnit);await input(en.organization.unitName,'New division');
    await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({description:en.organization.confirmHint}));
    expect(mocks.prepare).toHaveBeenCalledWith('workspace-fixture',expect.objectContaining({command:{type:'org.unit.save',name:'New division',parentId:null,teamId:null,directoryVisibility:'members',position:0}}));
    expect(mocks.save).toHaveBeenCalledWith('workspace-fixture',{type:'org.command.apply',reviewId:'review',payloadHash:'a'.repeat(64)});
  });
  it('shows canonical effects and retains a confirmed retry after closing its editor',async()=>{
    mocks.prepare.mockResolvedValue({id:'review',payloadHash:'a'.repeat(64),validForMs:30000,expiresAt:'2030-01-01T00:00:00Z',effects:[{kind:'placement',name:'Research assistant',changes:[{field:'accountableUserId',before:[{kind:'code',value:'none'}],after:[{kind:'text',value:'Riley'}]}]}]});
    mocks.save.mockRejectedValueOnce(new TypeError('lost response'));
    await render();await click(en.organization.addUnit);await input(en.organization.unitName,'Division');
    await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    const html=renderToStaticMarkup(<I18nProvider locale="en" dict={en}>{mocks.confirm.mock.calls[0][0].content}</I18nProvider>);
    expect(html).toContain('Research assistant');expect(html).toContain(en.organization.accountable);expect(html).toContain('Riley');
    await click(en.organization.close);expect(host.querySelector('aside')).toBeNull();await click(en.workspaceAccess.retryChange);
    expect(mocks.prepare).toHaveBeenCalledTimes(1);expect(mocks.confirm).toHaveBeenCalledTimes(1);expect(mocks.save).toHaveBeenCalledTimes(2);
    for(const call of mocks.save.mock.calls)expect(call).toEqual(['workspace-fixture',{type:'org.command.apply',reviewId:'review',payloadHash:'a'.repeat(64)}]);
  });
  it('does not apply a late confirmation after directory authority is invalidated',async()=>{
    let finish:(confirmed:boolean)=>void=()=>{};mocks.confirm.mockImplementation(()=>new Promise<boolean>(resolve=>{finish=resolve}));
    await render();await click(en.organization.addUnit);await input(en.organization.unitName,'Division');
    await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    const signal=mocks.confirm.mock.calls[0][0].signal as AbortSignal;
    mocks.fetch.mockRejectedValue(new SurfaceCacheEvictionError(new Error('not_found')));
    await act(async()=>window.dispatchEvent(new CustomEvent(WORKSPACE_IDENTITY_REFRESH_EVENT,{detail:{workspaceId:'workspace-fixture'}})));
    expect(signal.aborted).toBe(true);await act(async()=>finish(true));expect(mocks.save).not.toHaveBeenCalled();
  });
  it('shows safe read-only details and never offers members edit controls',async()=>{
    const chart=fixture();chart.canManage=false;mocks.fetch.mockResolvedValue(chart);await render();
    expect(host.textContent).not.toContain(en.organization.adminHint);
    expect(host.textContent).not.toContain(en.organization.addUnit);
    await click('Riley');expect(host.textContent).not.toContain(en.organization.save);
    expect(host.querySelector('aside a')?.getAttribute('href')).toBe('/w/workspace-fixture/organization?section=people&member=member-fixture');
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('searches only projected data and supports clearing the search',async()=>{
    await render();await input(en.organization.search,'No such person');
    expect(host.textContent).toContain(en.organization.noResults);
    expect(host.textContent).not.toContain('Riley');
    await input(en.organization.search,'Research assistant');
    expect(host.textContent).toContain('Research assistant');
    await input(en.organization.search,'');expect(host.textContent).toContain('Casey');
  });
  it('purges directory and selected details on an access signal before a denied refresh',async()=>{
    await render();await click('Research assistant');
    mocks.fetch.mockRejectedValue(new SurfaceCacheEvictionError(new Error('not_found')));
    await act(async()=>window.dispatchEvent(new CustomEvent(WORKSPACE_IDENTITY_REFRESH_EVENT,{detail:{workspaceId:'workspace-fixture'}})));
    expect(host.textContent).not.toContain('Research assistant');expect(host.textContent).not.toContain('Riley');expect(host.textContent).toContain(en.organization.loadError);
  });
  it('never reuses an old viewer selection or directory on an account switch',async()=>{
    await render();await click('Research assistant');mocks.viewer.me.id='other-member';
    mocks.fetch.mockResolvedValue({...fixture(),canManage:false,subjects:[],units:[],placements:[]});await render();
    expect(host.textContent).not.toContain('Research assistant');expect(host.querySelector('aside')).toBeNull();
  });
  it('purges selected details at the projection deadline even without a permission event',async()=>{
    vi.useFakeTimers({toFake:['Date','performance','setTimeout','clearTimeout']});
    mocks.fetch.mockResolvedValue(fixture());await render();await click('Research assistant');
    mocks.fetch.mockRejectedValue(new SurfaceCacheEvictionError(new Error('not_found')));
    await act(async()=>{await vi.advanceTimersByTimeAsync(30_001);});
    expect(host.textContent).not.toContain('Research assistant');
    expect(host.querySelector('aside')).toBeNull();expect(host.textContent).toContain(en.organization.loadError);
  });
  it('renews unchanged permissions without losing a partially completed editor',async()=>{
    vi.useFakeTimers({toFake:['Date','performance','setTimeout','clearTimeout']});
    mocks.fetch.mockImplementation(async()=>fixture());await render();await click(en.organization.addUnit);await input(en.organization.unitName,'Draft division');
    await act(async()=>{await vi.advanceTimersByTimeAsync(25_001);});
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    await act(async()=>{await vi.advanceTimersByTimeAsync(10_000);});
    expect(host.querySelector('form input')?.getAttribute('value')).toBe('Draft division');
    expect(host.querySelector('aside')).not.toBeNull();
  });
  it('clears an old selection before displaying a changed renewal projection',async()=>{
    vi.useFakeTimers({toFake:['Date','performance','setTimeout','clearTimeout']});
    mocks.fetch.mockImplementation(async()=>fixture());await render();await click('Research assistant');
    mocks.fetch.mockImplementation(async()=>({...fixture(),canManage:false,subjects:[],units:[],placements:[]}));
    await act(async()=>{await vi.advanceTimersByTimeAsync(25_001);});
    expect(host.textContent).not.toContain('Research assistant');expect(host.querySelector('aside')).toBeNull();
  });
  it('never extends an expired projection when background renewal hangs',async()=>{
    vi.useFakeTimers({toFake:['Date','performance','setTimeout','clearTimeout']});
    mocks.fetch.mockResolvedValue(fixture());await render();await click('Research assistant');
    mocks.fetch.mockReturnValue(new Promise(()=>{}));
    await act(async()=>{await vi.advanceTimersByTimeAsync(30_001);});
    expect(host.textContent).not.toContain('Research assistant');expect(host.querySelector('aside')).toBeNull();
  });
  it('never paints an expired cached chart on revisit while its replacement is pending',async()=>{
    const expired={...fixture(),projectionDeadline:Date.now()-1,projectionMonotonicDeadline:performance.now()-1};
    await loadSurfaceCache('organization:workspace-fixture:member-fixture',async()=>expired);
    mocks.fetch.mockReturnValue(new Promise(()=>{}));await render();
    expect(host.textContent).not.toContain('Research assistant');expect(host.querySelector('[data-skeleton]')).not.toBeNull();
  });
  it('contains matching complete translated controls in all four locales',()=>{
    for(const dict of [ja,zh,zhCN]){expect(Object.keys(dict.organization)).toEqual(Object.keys(en.organization));for(const value of Object.values(dict.organization))expect(value.trim().length).toBeGreaterThan(0);}
    for(const dict of [en,ja,zh,zhCN])for(const value of Object.values(dict.organization))expect(value).not.toContain('—');
  });
});
