// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {attachOfficeMetadata,inheritOfficeMetadata,officeMetadataRemaining} from '../metadata';
import {useOfficeMetadataResource} from '../surface-cache';
import * as api from '../api';
import {OfficeHome} from '@/components/office/office-home';
import {OfficeTemplateLibrary} from '@/components/office/template-library';
import {I18nProvider} from '@/lib/i18n/client';
import {en} from '@/lib/i18n/dictionaries/en';
import {documentFixture} from '@/components/office/__tests__/editor-fixtures';
import {applySpineEventToSurfaceCache} from '@/lib/surface-cache-invalidation';
import {WORKSPACE_IDENTITY_REFRESH_EVENT} from '@/lib/workspace-identity-events';
import {loadSurfaceCache,readSurfaceCache,resetSurfaceCache} from '@/lib/surface-cache';
import {officeListCacheKey,officePreviewCacheKey,warmTargetFor} from '@/lib/surface-prefetch';
const state=vi.hoisted(()=>({viewer:'viewer-a',fetch:vi.fn()}));
vi.mock('@/lib/user',()=>({getUserInfo:()=>({id:state.viewer})}));
vi.mock('@/lib/auth-fetch',()=>({authFetch:(...args:unknown[])=>state.fetch(...args)}));
vi.mock('next/navigation',()=>({useRouter:()=>({prefetch:vi.fn(),back:vi.fn(),forward:vi.fn(),replace:vi.fn(),push:vi.fn()}),usePathname:()=>'/office/templates/template-a',useSearchParams:()=>new URLSearchParams()}));
vi.mock('@/lib/workspace-context',()=>({useOptionalWorkspaceContext:()=>({workspaceId:'workspace-a',me:{id:state.viewer}})}));
vi.mock('@/components/doc/doc-sidebar-data',()=>({useSidebarData:()=>({sidebarCollapsed:false,setSidebarCollapsed:vi.fn()})}));
vi.mock('@/lib/use-doc-media',()=>({useOfficeResourceUrls:()=>({urls:{}})}));
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const row={artifactId:'artifact-a',family:'document',title:'Department report',role:'view',version:1,lifecycleState:'active'};
let host:HTMLDivElement,root:Root;
function response(body:unknown,ttl:string|null='6000',status=200){return new Response(JSON.stringify(body),{status,headers:ttl===null?{}:{'X-Brian-Projection-Valid-For-Ms':ttl}});}
function Harness({viewer=state.viewer}:{viewer?:string}){
  const key=officeListCacheKey('workspace-a','active',viewer);
  const read=useOfficeMetadataResource(key,viewer,()=>api.listOfficeArtifacts('workspace-a'));
  return <div>{read.data?.map(value=><span key={value.artifactId}>{value.title}</span>)}</div>;
}
async function flush(){await act(async()=>{await Promise.resolve();await Promise.resolve();});}
beforeEach(()=>{
  vi.useFakeTimers();resetSurfaceCache();state.viewer='viewer-a';state.fetch.mockReset();
  host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(()=>{act(()=>root.unmount());host.remove();resetSurfaceCache();vi.useRealTimers();});

describe('[COMP:app-web/office-surface-cache] bounded Office metadata',()=>{
  it('inherits both original deadlines without renewing or serializing them',()=>{
    const source=attachOfficeMetadata([row],2000,performance.now(),state.viewer);
    vi.advanceTimersByTime(700);
    const derived=inheritOfficeMetadata({...row},source,state.viewer);
    expect(officeMetadataRemaining(derived,state.viewer)).toBe(1300);
    expect(officeMetadataRemaining(JSON.parse(JSON.stringify(derived)),state.viewer)).toBe(0);
    expect(()=>inheritOfficeMetadata({...row},source,'viewer-b')).toThrow('office_projection_expired');
    vi.setSystemTime(Date.now()-60_000);vi.advanceTimersByTime(1301);
    expect(officeMetadataRemaining(derived,state.viewer)).toBe(0);
    expect(()=>inheritOfficeMetadata({...row},derived,state.viewer)).toThrow('office_projection_expired');
  });
  it.each([
    ['artifacts',()=>api.listOfficeArtifacts('workspace-a'),{artifacts:[row]}],
    ['artifact',()=>api.getOfficeArtifact('artifact-a'),{artifact:row}],
    ['snapshot',()=>api.getOfficeSnapshot('artifact-a'),{snapshot:{title:'Report'},seq:1,baseVersion:1}],
    ['comments',()=>api.listOfficeComments('artifact-a'),{threads:[{id:'thread-a'}]}],
    ['suggestions',()=>api.listOfficeSuggestions('artifact-a'),{suggestions:[{id:'suggestion-a'}]}],
    ['versions',()=>api.listOfficeVersions('artifact-a'),{versions:[{id:'version-a'}]}],
    ['templates',()=>api.listOfficeTemplates('workspace-a'),{templates:[{id:'template-a'}]}],
    ['routing',()=>api.getOfficeTemplateRouting('template-a'),{routing:{fields:[]}}],
    ['job',()=>api.getOfficeJob('job-a'),{job:{id:'job-a'}}],
    ['events',()=>api.listOfficeJobEvents('job-a'),{events:[{seq:1}]}],
  ] as const)('retains a bounded lifetime on %s without serializing it',async(_name,read,body)=>{
    state.fetch.mockResolvedValue(response(body));const result=await read();
    expect(officeMetadataRemaining(result,state.viewer)).toBeGreaterThan(0);
    expect(officeMetadataRemaining(result,'other-viewer')).toBe(0);
    expect(JSON.stringify(result)).not.toMatch(/Deadline|monotonic|viewerId/);
    expect(state.fetch).toHaveBeenCalledWith(expect.any(String),{cache:'no-store'});
  });
  it.each([null,'','0','-1','Infinity','nonsense'])('rejects missing or invalid lifetime %s',async ttl=>{
    state.fetch.mockResolvedValue(response({artifacts:[row]},ttl));
    await expect(api.listOfficeArtifacts('workspace-a')).rejects.toMatchObject({message:'office_projection_expired'});
  });
  it('subtracts the complete body read duration and rejects a response crossing identities',async()=>{
    state.fetch.mockResolvedValue({ok:true,headers:new Headers({'X-Brian-Projection-Valid-For-Ms':'4000'}),json:async()=>{
      vi.advanceTimersByTime(1000);return {artifacts:[row]};
    }});
    const result=await api.listOfficeArtifacts('workspace-a');expect(officeMetadataRemaining(result)).toBeLessThanOrEqual(3000);
    state.fetch.mockImplementation(async()=>{state.viewer='viewer-b';return response({artifacts:[row]});});
    await expect(api.listOfficeArtifacts('workspace-a')).rejects.toMatchObject({message:'office_projection_expired'});
  });
  it('caps generous server lifetimes and never extends them by rolling back the wall clock',()=>{
    const result=attachOfficeMetadata([row],90_000,performance.now(),state.viewer);
    expect(officeMetadataRemaining(result)).toBe(30_000);
    vi.advanceTimersByTime(5000);vi.setSystemTime(Date.now()-60_000);
    expect(officeMetadataRemaining(result)).toBe(25_000);
    expect(officeMetadataRemaining([...result])).toBe(0);
  });
  it('expires visible data and prefetched data even while refresh is unresolved',async()=>{
    const target=warmTargetFor('office','workspace-a');state.fetch.mockResolvedValueOnce(response({artifacts:[row]},'800'));
    await loadSurfaceCache(target.key,target.fetch,target.lifecycle);
    state.fetch.mockImplementation(()=>new Promise(()=>{}));
    await act(async()=>root.render(<Harness/>));expect(host.textContent).toContain(row.title);
    await act(async()=>vi.advanceTimersByTime(801));expect(host.textContent).not.toContain(row.title);
    expect(readSurfaceCache(target.key).data).toBeUndefined();
  });
  it.each([401,403,404,409])('evicts protected data on an authoritative %s refresh',async status=>{
    state.fetch.mockResolvedValueOnce(response({artifacts:[row]}));await act(async()=>root.render(<Harness/>));await flush();
    expect(host.textContent).toContain(row.title);
    state.fetch.mockResolvedValueOnce(response({error:status===409?'office_projection_changed':'denied'},null,status));
    await act(async()=>vi.advanceTimersByTime(3001));await flush();expect(host.textContent).not.toContain(row.title);
  });
  it('keeps current data on a transient error only until its original deadline',async()=>{
    state.fetch.mockResolvedValueOnce(response({artifacts:[row]}));await act(async()=>root.render(<Harness/>));await flush();
    state.fetch.mockRejectedValue(new Error('network unavailable'));
    await act(async()=>vi.advanceTimersByTime(3001));await flush();expect(host.textContent).toContain(row.title);
    await act(async()=>vi.advanceTimersByTime(3000));expect(host.textContent).not.toContain(row.title);
  });
  it.each(['focus','visibilitychange'])('purges on %s and refuses a late old request after the new read wins',async event=>{
    let old:(value:Response)=>void=()=>{};
    state.fetch.mockImplementationOnce(()=>new Promise(resolve=>{old=resolve}));await act(async()=>root.render(<Harness/>));
    state.fetch.mockResolvedValueOnce(response({artifacts:[{...row,title:'Fresh report'}]}));
    await act(async()=>{(event==='focus'?window:document).dispatchEvent(new Event(event));});await flush();
    await act(async()=>old(response({artifacts:[row]})));await flush();
    expect(host.textContent).toContain('Fresh report');expect(host.textContent).not.toContain(row.title);
  });
  it('removes real home cards and lazy preview content at their separate deadlines',async()=>{
    state.fetch.mockImplementation(async(url:string)=>url.endsWith('/snapshot')
      ?response({snapshot:documentFixture(),seq:1,baseVersion:1},'400')
      :response({artifacts:[row]},'800'));
    await act(async()=>root.render(<I18nProvider locale="en" dict={en}><OfficeHome workspaceId="workspace-a"/></I18nProvider>));await flush();
    expect(host.textContent).toContain(row.title);expect(host.querySelector('[data-office-card-preview="document"]')).not.toBeNull();
    state.fetch.mockImplementation(()=>new Promise(()=>{}));
    await act(async()=>vi.advanceTimersByTime(401));
    expect(host.querySelector('[data-office-card-preview="document"]')).toBeNull();expect(host.textContent).toContain(row.title);
    await act(async()=>vi.advanceTimersByTime(400));expect(host.textContent).not.toContain(row.title);
  });
  it('removes a template name and clears its confirmation after expiry before a new projection appears',async()=>{
    const template={id:'template-a',name:'Department template',family:'document',description:'Restricted guidance',lifecycleState:'trash',draftArtifactId:null,currentVersionId:null};
    state.fetch.mockResolvedValue(response({templates:[template]},'800'));
    await act(async()=>root.render(<I18nProvider locale="en" dict={en}><OfficeTemplateLibrary workspaceId="workspace-a" templateId="template-a"/></I18nProvider>));await flush();
    const input=host.querySelector('input')!;expect(input).not.toBeNull();
    await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,template.name);input.dispatchEvent(new Event('input',{bubbles:true}));});
    state.fetch.mockImplementation(()=>new Promise(()=>{}));await act(async()=>vi.advanceTimersByTime(801));
    expect(host.textContent).not.toContain(template.name);expect(host.querySelector('input')).toBeNull();
    state.fetch.mockResolvedValue(response({templates:[template]},'800'));
    await act(async()=>window.dispatchEvent(new Event('focus')));await flush();
    expect(host.querySelector('input')?.value).toBe('');
  });
  it('does not resurrect an initial seed after an authority event while a new read is pending',async()=>{
    state.fetch.mockImplementation(()=>new Promise(()=>{}));
    const seed=attachOfficeMetadata([row] as api.OfficeArtifact[],6000,performance.now(),state.viewer);
    await act(async()=>root.render(<I18nProvider locale="en" dict={en}><OfficeHome workspaceId="workspace-a" initialArtifacts={seed}/></I18nProvider>));await flush();
    expect(host.textContent).toContain(row.title);
    await act(async()=>applySpineEventToSurfaceCache(WORKSPACE_IDENTITY_REFRESH_EVENT,{workspaceId:'workspace-a'},'workspace-a'));
    expect(host.textContent).not.toContain(row.title);
  });
  it('purges unmounted Office collections and preview keys on authority changes, scoped to workspace',async()=>{
    const keys=[officeListCacheKey('workspace-a','active'),officePreviewCacheKey('workspace-a',state.viewer,'artifact-a',1),`office-templates:workspace-a:${state.viewer}`];
    for(const key of keys)await loadSurfaceCache(key,async()=>attachOfficeMetadata([row],6000,performance.now(),state.viewer));
    applySpineEventToSurfaceCache(WORKSPACE_IDENTITY_REFRESH_EVENT,{workspaceId:'other'},'workspace-a');
    for(const key of keys)expect(readSurfaceCache(key).data).toBeDefined();
    applySpineEventToSurfaceCache(WORKSPACE_IDENTITY_REFRESH_EVENT,{workspaceId:'workspace-a'},'workspace-a');
    for(const key of keys)expect(readSurfaceCache(key).data).toBeUndefined();
  });
  it('drops old viewer cache and rejects its delayed response on an account switch',async()=>{
    let old:(value:Response)=>void=()=>{};state.fetch.mockImplementationOnce(()=>new Promise(resolve=>{old=resolve}));
    const key=officeListCacheKey('workspace-a','active',state.viewer);await act(async()=>root.render(<Harness/>));
    state.viewer='viewer-b';state.fetch.mockResolvedValueOnce(response({artifacts:[]}));await act(async()=>root.render(<Harness/>));
    await act(async()=>old(response({artifacts:[row]})));await flush();
    expect(host.textContent).not.toContain(row.title);expect(readSurfaceCache(key).data).toBeUndefined();
    expect(officePreviewCacheKey('workspace-a','viewer-a','artifact-a',1)).not.toBe(officePreviewCacheKey('workspace-a','viewer-b','artifact-a',1));
  });
});
