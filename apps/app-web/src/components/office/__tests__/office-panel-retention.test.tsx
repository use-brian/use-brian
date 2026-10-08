// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {OfficeJobActivity,type OfficeBrianRevisionRequest} from '../job-activity';
import {OfficeHistory} from '../history/office-history';
import {OfficeSharing} from '../sharing/office-sharing';
import {documentFixture,uid} from './editor-fixtures';
import {I18nProvider} from '@/lib/i18n/client';
import {en} from '@/lib/i18n/dictionaries/en';
import {PromptDialogProvider} from '@/components/ui/prompt-dialog';
import {ConfirmDialogProvider} from '@/components/ui/confirm-dialog';
import {readSurfaceCache,resetSurfaceCache} from '@/lib/surface-cache';
import {officePanelCachePrefix,officePanelCacheKey} from '@/lib/surface-prefetch';
import {applySpineEventToSurfaceCache} from '@/lib/surface-cache-invalidation';
import {WORKSPACE_IDENTITY_REFRESH_EVENT} from '@/lib/workspace-identity-events';
const state=vi.hoisted(()=>({viewer:'viewer-a',workspace:'workspace-a',fetch:vi.fn()}));
vi.mock('@/lib/user',()=>({getUserInfo:()=>({id:state.viewer})}));
vi.mock('@/lib/auth-fetch',()=>({authFetch:(...args:unknown[])=>state.fetch(...args)}));
vi.mock('@/lib/workspace-context',()=>({useOptionalWorkspaceContext:()=>({workspaceId:state.workspace,me:{id:state.viewer}})}));
vi.mock('@/components/ui/searchable-select',()=>({SearchableSelect:(props:{items:Array<{value:string;label:string}>;onValueChange:(value:string)=>void;disabled?:boolean;'aria-label':string})=><div aria-label={props['aria-label']}>{props.items.map(item=><button type="button" key={item.value} disabled={props.disabled} onClick={()=>props.onValueChange(item.value)}>{item.label}</button>)}</div>}));
vi.mock('../sharing/office-classification',()=>({OfficeClassificationPanel:()=>null}));
vi.mock('../office-card-preview',()=>({OfficeCardPreviewCanvas:({snapshot}:{snapshot:{title:string}})=><div data-preview>{snapshot.title}</div>}));
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const job={id:'job-a',workspaceId:'workspace-a',artifactId:uid(1),status:'completed',stage:'completed',errorCode:null};
const events=[{id:'event-a',seq:1,code:'office.job.completed',params:{},safeNarration:null,createdAt:'2026-09-27T01:00:00Z'}];
const versions=[{id:'version-a',version:1,summary:'Protected version summary',origin:'manual',createdAt:'2026-09-27T01:00:00Z'}];
const sharing={defaultWorkspaceRole:'comment',canManage:true,grants:[],members:[{userId:'member-a',userName:'Protected member',email:'member@example.com',isOwner:false}]};
const response=(body:unknown,ttl='6000',status=200)=>new Response(JSON.stringify(body),{status,headers:{'X-Brian-Projection-Valid-For-Ms':ttl}});
const pending=()=>new Promise<Response>(()=>{});
let root:Root,host:HTMLDivElement;
const copied=vi.fn(),restored=vi.fn(),requested=vi.fn<()=>Promise<OfficeBrianRevisionRequest>>();
beforeEach(()=>{vi.useFakeTimers();resetSurfaceCache();vi.clearAllMocks();state.viewer='viewer-a';state.workspace='workspace-a';host=document.createElement('div');document.body.append(host);root=createRoot(host);requested.mockResolvedValue({jobId:'revision-a',mode:'direct'});});
afterEach(()=>{act(()=>root.unmount());host.remove();resetSurfaceCache();vi.useRealTimers();});
async function render(kind:'history'|'sharing'|'job'|'new-job'='history'){await act(async()=>root.render(<I18nProvider locale="en" dict={en}><PromptDialogProvider/><ConfirmDialogProvider/>{kind==='history'?<OfficeHistory artifactId={uid(1)} artifactTitle="Protected artifact" currentVersion={2} canEdit onCopied={copied} onRestored={restored}/>:kind==='sharing'?<OfficeSharing artifactId={uid(1)}/>:<OfficeJobActivity jobId={kind==='job'?'job-a':undefined} snapshot={documentFixture()} targetIds={[uid(10)]} canRequestRevision onRequestRevision={requested} onRevisionCompleted={restored}/>}</I18nProvider>));}
const button=(label:string,scope:ParentNode=document)=>[...scope.querySelectorAll('button')].find(x=>x.textContent===label && !x.disabled)!;
const click=async(label:string,scope?:ParentNode)=>{await act(async()=>button(label,scope).click());};
function change(input:HTMLInputElement|HTMLTextAreaElement,value:string){act(()=>{Object.getOwnPropertyDescriptor(input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});}
function historyReads(ttl='800'){state.fetch.mockImplementation(async(url:string)=>url.endsWith('/preview')?response({snapshot:{...documentFixture(),title:'Private preview'}}):response({versions},ttl));}
function sharingReads(ttl='800'){state.fetch.mockImplementation(async()=>response(sharing,ttl));}
function jobReads(jobTtl='800',eventTtl=jobTtl){state.fetch.mockImplementation(async(url:string)=>url.includes('/events?')?response({events},eventTtl):response({job},jobTtl));}

describe('[COMP:app-web/office-iteration-panel] bounded activity retention',()=>{
  it('expires terminal activity when either independent read expires',async()=>{
    jobReads('800','400');await render('job');expect(host.querySelector('details')).not.toBeNull();
    change(host.querySelector('textarea')!,'Draft based on protected activity');state.fetch.mockImplementation(pending);await act(async()=>vi.advanceTimersByTime(401));
    expect(host.querySelector('details')).toBeNull();expect(host.querySelector('textarea')!.value).toBe('');
    const prefix=officePanelCachePrefix(state.workspace,state.viewer);expect(readSurfaceCache(officePanelCacheKey(prefix,'job','job-a')).data).toBeDefined();
  });
  it('renews completed jobs and events instead of retaining them indefinitely',async()=>{
    jobReads('6000');await render('job');expect(state.fetch).toHaveBeenCalledTimes(2);await act(async()=>vi.advanceTimersByTime(3001));expect(state.fetch).toHaveBeenCalledTimes(4);expect(host.querySelector('details')).not.toBeNull();
    state.fetch.mockRejectedValue(new Error('offline'));await act(async()=>vi.advanceTimersByTime(3001));expect(host.querySelector('details')).not.toBeNull();await act(async()=>vi.advanceTimersByTime(3000));expect(host.querySelector('details')).toBeNull();
  });
  it.each([401,403,404,409])('removes activity after an authoritative %s',async status=>{
    jobReads('6000');await render('job');state.fetch.mockImplementation(async()=>response({error:status===409?'office_projection_changed':'denied'},'0',status));await act(async()=>vi.advanceTimersByTime(3001));expect(host.querySelector('details')).toBeNull();
  });
  it.each(['viewer','workspace'] as const)('drops a late revision acknowledgement after changing %s',async identity=>{
    let finish!:(result:OfficeBrianRevisionRequest)=>void;requested.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));state.fetch.mockImplementation(pending);await render('new-job');change(host.querySelector('textarea')!,'Revise this');await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    state[identity]=`${identity}-b`;await render('new-job');await act(async()=>finish({jobId:'old-revision',mode:'direct'}));expect(host.querySelector('textarea')!.value).toBe('');expect(state.fetch).not.toHaveBeenCalled();
  });
});

describe('[COMP:app-web/office-history-sharing] bounded version panel',()=>{
  it('discards the preview and version summary when its list expires',async()=>{
    historyReads();await render();await click(en.office.preview);expect(host.textContent).toContain('Private preview');state.fetch.mockImplementation(pending);await act(async()=>vi.advanceTimersByTime(801));expect(host.textContent).not.toContain('Private preview');expect(host.textContent).not.toContain(versions[0]!.summary);
  });
  it('does not restore a preview completing after expiry',async()=>{
    historyReads();await render();let finish!:(value:Response)=>void;state.fetch.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));await click(en.office.preview);state.fetch.mockImplementation(pending);await act(async()=>vi.advanceTimersByTime(801));await act(async()=>finish(response({snapshot:{...documentFixture(),title:'Late private preview'}})));expect(host.textContent).not.toContain('Late private preview');
    const prefix=officePanelCachePrefix(state.workspace,state.viewer);expect(readSurfaceCache(officePanelCacheKey(prefix,'version-preview',`${uid(1)}:version-a`)).data).toBeUndefined();
  });
  it('aborts pre-filled name prompts on authority invalidation',async()=>{
    historyReads();await render();await click(en.office.nameVersion);expect(document.querySelector('input')!.value).toBe(versions[0]!.summary);state.fetch.mockImplementation(pending);await act(async()=>applySpineEventToSurfaceCache(WORKSPACE_IDENTITY_REFRESH_EVENT,{workspaceId:state.workspace},state.workspace));expect(document.body.innerHTML).not.toContain(versions[0]!.summary);expect(state.fetch.mock.calls.some(call=>call[1]?.method==='PATCH')).toBe(false);
  });
  it('aborts a prompt when its version disappears from a fresh authorized list',async()=>{
    historyReads('6000');await render();await click(en.office.nameVersion);state.fetch.mockImplementation(async()=>response({versions:[]}));await act(async()=>vi.advanceTimersByTime(3001));expect(document.body.innerHTML).not.toContain(versions[0]!.summary);expect(host.textContent).toContain(en.office.noVersions);
  });
  it.each(['viewer','workspace','expiry'] as const)('does not navigate from a copy completing after %s',async reason=>{
    historyReads();await render();await click(en.office.copyVersion);let finish!:(value:Response)=>void;state.fetch.mockImplementation((_url:string,init:RequestInit)=>init?.method==='POST'?new Promise(resolve=>{finish=resolve;}):pending());await click(en.office.copyVersion,document.querySelector('[role="dialog"]')!);
    if(reason==='expiry')await act(async()=>vi.advanceTimersByTime(801));else {state[reason]=`${reason}-b`;await render();}await act(async()=>finish(response({artifactId:'copied',version:1})));expect(copied).not.toHaveBeenCalled();
  });
  it('removes an open preview after authoritative denial during renewal',async()=>{
    historyReads('6000');await render();await click(en.office.preview);state.fetch.mockImplementation(async()=>response({error:'denied'},'0',403));await act(async()=>vi.advanceTimersByTime(3001));expect(host.querySelector('[data-preview]')).toBeNull();expect(host.textContent).not.toContain(versions[0]!.summary);
  });
  it.each(['history','job'] as const)('purges an unmounted %s panel on a workspace authority event',async kind=>{
    if(kind==='history')historyReads('6000');else jobReads('6000');await render(kind);const prefix=officePanelCachePrefix(state.workspace,state.viewer);const key=officePanelCacheKey(prefix,kind==='history'?'versions':'job',kind==='history'?uid(1):'job-a');expect(readSurfaceCache(key).data).toBeDefined();
    await act(async()=>root.render(null));applySpineEventToSurfaceCache(WORKSPACE_IDENTITY_REFRESH_EVENT,{workspaceId:state.workspace},state.workspace);expect(readSurfaceCache(key).data).toBeUndefined();state.fetch.mockImplementation(pending);await render(kind);expect(host.textContent).not.toContain(versions[0]!.summary);expect(host.querySelector('details')).toBeNull();
  });
  it('preserves normal naming, copying and restore through current reads',async()=>{
    let stored=versions;state.fetch.mockImplementation(async(url:string,init:RequestInit)=>{
      if(init?.method==='PATCH'){stored=[{...versions[0]!,summary:JSON.parse(String(init.body)).summary}];return response({versions:stored});}
      if(url.endsWith('/copy'))return response({artifactId:'copied',version:1,artifact:{artifactId:'copied'}});
      if(url.endsWith('/restore'))return response({version:{id:'restored',version:3},versions:stored});
      return response({versions:stored});
    });await render();await click(en.office.nameVersion);change(document.querySelector('input')!,'Renamed version');await click(en.office.saveName,document.querySelector('[role="dialog"]')!);expect(host.textContent).toContain('Renamed version');
    await click(en.office.copyVersion);await click(en.office.copyVersion,document.querySelector('[role="dialog"]')!);expect(copied).toHaveBeenCalledWith('copied');
    stored=[{...versions[0]!,id:'head-version',version:2},...stored];await act(async()=>window.dispatchEvent(new Event('focus')));
    await click(en.office.restoreVersion);await click(en.office.restoreVersion,document.querySelector('[role="alertdialog"]')!);expect(restored).toHaveBeenCalledTimes(1);
  });
});

describe('[COMP:app-web/office-history-sharing] bounded sharing panel',()=>{
  it('removes member and grant controls when sharing authority expires',async()=>{
    sharingReads();await render('sharing');expect(host.textContent).toContain('Protected member');state.fetch.mockImplementation(pending);await act(async()=>vi.advanceTimersByTime(801));expect(host.textContent).not.toContain('Protected member');
  });
  it.each(['viewer','workspace'] as const)('does not reuse sharing after changing %s',async identity=>{
    sharingReads('6000');await render('sharing');expect(host.textContent).toContain('Protected member');state[identity]=`${identity}-b`;state.fetch.mockImplementation(pending);await render('sharing');expect(host.textContent).not.toContain('Protected member');
  });
  it('drops a sharing mutation publication that completes after expiry',async()=>{
    sharingReads();await render('sharing');await click(en.office.viewer,host.querySelector(`[aria-label="${en.office.workspaceDefault}"]`)!);
    let finish!:(value:Response)=>void;state.fetch.mockImplementation((_url:string,init:RequestInit)=>init?.method==='PATCH'?new Promise(resolve=>{finish=resolve;}):pending());
    await click(en.office.changeRole,document.querySelector('[role="alertdialog"]')!);await act(async()=>vi.advanceTimersByTime(801));
    await act(async()=>finish(response({...sharing,defaultWorkspaceRole:'view'})));expect(host.textContent).not.toContain('Protected member');
    const prefix=officePanelCachePrefix(state.workspace,state.viewer);expect(readSurfaceCache(officePanelCacheKey(prefix,'sharing',uid(1))).data).toBeUndefined();
  });
});
