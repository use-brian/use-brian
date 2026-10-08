// @vitest-environment jsdom
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {OfficeClassificationPanel} from '../sharing/office-classification';
import {I18nProvider} from '@/lib/i18n/client';
import {en} from '@/lib/i18n/dictionaries/en';
import {resetSurfaceCache} from '@/lib/surface-cache';
const mocks=vi.hoisted(()=>({fetch:vi.fn(),confirm:vi.fn()}));
vi.mock('@/lib/auth-fetch',()=>({authFetch:(...args:unknown[])=>mocks.fetch(...args)}));
vi.mock('@/lib/workspace-context',()=>({useOptionalWorkspaceContext:()=>({workspaceId:'workspace',me:{id:'viewer'}})}));
vi.mock('@/lib/user',()=>({getUserInfo:()=>({id:'viewer'})}));
vi.mock('@/components/ui/confirm-dialog',()=>({confirmDialog:(...args:unknown[])=>mocks.confirm(...args)}));
vi.mock('../office-scope-picker',()=>({OfficeScopePicker:({onChange}:{onChange:(value:unknown)=>void})=><button onClick={()=>onChange({destination:{kind:'department',departmentId:'planning'},sensitivity:'confidential'})}>Choose Planning</button>}));
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
afterEach(()=>{vi.useRealTimers();vi.clearAllMocks();resetSurfaceCache();});
const classification={workspaceId:'workspace',revision:'a'.repeat(64),sensitivity:'internal',compartments:['team:operations'],canManage:true,history:[]};
const response=(value:unknown,ttl='1000')=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json','X-Brian-Projection-Valid-For-Ms':ttl}});
async function mount(){const host=document.createElement('div');document.body.append(host);const root=createRoot(host);await act(async()=>root.render(<I18nProvider locale="en" dict={en}><OfficeClassificationPanel artifactId="artifact"/></I18nProvider>));return {host,close:()=>{act(()=>root.unmount());host.remove();}};}
const button=(host:HTMLElement,text:string)=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent===text)!;
describe('[COMP:app-web/office-classification] reviewed department protection',()=>{
  it('sends the exact reviewed revision and chosen protection through the canonical command',async()=>{
    mocks.fetch.mockImplementation(async()=>response(classification));mocks.confirm.mockResolvedValue(true);
    const view=await mount();
    await act(async()=>button(view.host,'Choose Planning').click());
    await act(async()=>button(view.host,en.office.restrictClassification).click());
    const write=mocks.fetch.mock.calls.find(call=>call[1]?.method==='POST');
    expect(JSON.parse(write![1].body)).toEqual({expectedRevision:classification.revision,departmentId:'planning',sensitivity:'confidential'});
    expect(mocks.confirm.mock.calls[0][0].description).toContain('Undo cannot');view.close();
  });
  it('never writes after the classification expires while confirmation is pending',async()=>{
    vi.useFakeTimers();mocks.fetch.mockImplementation(async()=>response(classification));let approve!:(value:boolean)=>void;
    mocks.confirm.mockImplementation(()=>new Promise<boolean>(resolve=>{approve=resolve;}));
    const view=await mount();await act(async()=>button(view.host,'Choose Planning').click());
    await act(async()=>button(view.host,en.office.restrictClassification).click());
    await act(async()=>{await vi.advanceTimersByTimeAsync(1100);});
    await act(async()=>approve(true));
    expect(mocks.fetch.mock.calls.some(call=>call[1]?.method==='POST')).toBe(false);view.close();
  });
  it('shows protected classification but no mutation control to a reader',async()=>{
    mocks.fetch.mockImplementation(async()=>response({...classification,canManage:false}));const view=await mount();
    expect(view.host.textContent).toContain('team:operations');expect(view.host.querySelector('button')).toBeNull();view.close();
  });
});
