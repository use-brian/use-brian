// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {OfficeJobActivity} from '../job-activity';
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
import {_resetOfficeJobStreams} from '@/lib/office/job-stream';
const state=vi.hoisted(()=>({viewer:'viewer-a',workspace:'workspace-a',fetch:vi.fn()}));
vi.mock('@/lib/user',()=>({getUserInfo:()=>({id:state.viewer})}));
vi.mock('next/navigation',()=>({useRouter:()=>({push:vi.fn()})}));
vi.mock('@/components/doc/composer-controls',()=>({useComposerControls:()=>({model:'standard',setModel:vi.fn(),plan:'pro',researchMode:false,setResearchMode:vi.fn(),researchQuota:null,researchExhausted:false}),ComposerControls:()=>null}));
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
const copied=vi.fn(),restored=vi.fn();
beforeEach(()=>{vi.useFakeTimers();resetSurfaceCache();vi.clearAllMocks();state.viewer='viewer-a';state.workspace='workspace-a';host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();resetSurfaceCache();_resetOfficeJobStreams();vi.useRealTimers();});
async function render(kind:'history'|'sharing'|'job'|'new-job'='history'){await act(async()=>root.render(<I18nProvider locale="en" dict={en}><PromptDialogProvider/><ConfirmDialogProvider/>{kind==='history'?<OfficeHistory artifactId={uid(1)} artifactTitle="Protected artifact" currentVersion={2} canEdit onCopied={copied} onRestored={restored}/>:kind==='sharing'?<OfficeSharing artifactId={uid(1)}/>:<OfficeJobActivity workspaceId={state.workspace} artifactId={uid(1)} jobId={kind==='job'?'job-a':undefined} snapshot={documentFixture()} targetIds={[uid(10)]} onRevisionCompleted={restored}/>}</I18nProvider>));}
const button=(label:string,scope:ParentNode=document)=>[...scope.querySelectorAll('button')].find(x=>x.textContent===label && !x.disabled)!;
const click=async(label:string,scope?:ParentNode)=>{await act(async()=>button(label,scope).click());};
function change(input:HTMLInputElement|HTMLTextAreaElement,value:string){act(()=>{Object.getOwnPropertyDescriptor(input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});}
function historyReads(ttl='800'){state.fetch.mockImplementation(async(url:string)=>url.endsWith('/preview')?response({snapshot:{...documentFixture(),title:'Private preview'}}):response({versions},ttl));}
function sharingReads(ttl='800'){state.fetch.mockImplementation(async()=>response(sharing,ttl));}
/** An SSE body that stays open; `onPush`/`onEnd` expose its controller to the test. */
function sse(frames:Array<[string,unknown]>,onPush?:(push:(frame:[string,unknown])=>void)=>void,onEnd?:(end:()=>void)=>void){
  const encode=(frame:[string,unknown])=>new TextEncoder().encode(`event: ${frame[0]}\ndata: ${JSON.stringify(frame[1])}\n\n`);
  return new Response(new ReadableStream({start(controller){for(const frame of frames)controller.enqueue(encode(frame));onPush?.(frame=>controller.enqueue(encode(frame)));onEnd?.(()=>controller.close());}}),{status:200,headers:{'Content-Type':'text/event-stream'}});
}
async function flush(){for(let i=0;i<5;i++)await act(async()=>{await vi.advanceTimersByTimeAsync(0);});}

describe('[COMP:app-web/office-iteration-panel] bounded activity retention',()=>{
  it('shows activity from the job stream and clears it when the stream revokes access',async()=>{
    let push!:(frame:[string,unknown])=>void;
    state.fetch.mockImplementation(async(url:string)=>String(url).includes('/jobs/')?sse([['job',job],['event',events[0]]],(enqueue)=>{push=enqueue;}):pending());
    await render('job');await flush();expect(host.querySelector('details')).not.toBeNull();
    change(host.querySelector('textarea')!,'Draft based on protected activity');
    await act(async()=>push(['revoked',{}]));await flush();
    expect(host.querySelector('details')).toBeNull();expect(host.querySelector('textarea')!.value).toBe('');
  });
  it('removes activity when the stream answers 404 for a job the viewer cannot read',async()=>{
    state.fetch.mockImplementation(async()=>response({error:'Office job not found'},'0',404));
    await render('job');await flush();expect(host.querySelector('details')).toBeNull();
  });
  it('keeps the last persisted step but says it is reconnecting when the stream drops',async()=>{
    let close!:()=>void;
    state.fetch.mockImplementationOnce(async()=>sse([['job',{...job,status:'running'}],['event',{...events[0],code:'office.job.objects_constructed'}]],undefined,(end)=>{close=end;})).mockImplementation(pending);
    await render('job');await flush();expect(host.textContent).toContain(en.office.eventObjects);
    await act(async()=>close());await flush();
    expect(host.textContent).toContain(en.office.jobReconnecting);expect(host.textContent).toContain(en.office.eventObjects);
    expect(host.querySelector('.animate-spin')).toBeNull();
  });
  it.each(['viewer','workspace'] as const)('drops a late thread creation after changing %s',async identity=>{
    let finish!:(response:Response)=>void;
    state.fetch.mockImplementation(async(url:string,init?:RequestInit)=>{
      if(url.endsWith('/conversation')&&init?.method==='POST')return new Promise<Response>(resolve=>{finish=resolve;});
      if(url.endsWith('/conversation'))return new Response(JSON.stringify({sessionId:null,canSend:true,role:'edit',assistant:{id:'assistant-a',name:'Brian'}}),{status:200});
      return pending();
    });
    await render('new-job');await flush();change(host.querySelector('textarea')!,'Revise this');await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    state[identity]=`${identity}-b`;await render('new-job');
    await act(async()=>finish(new Response(JSON.stringify({sessionId:'late-session',assistant:{id:'assistant-a',name:'Brian'}}),{status:201})));await flush();
    expect(host.querySelector('textarea')!.value).toBe('');
    expect(state.fetch.mock.calls.some(([url])=>String(url).endsWith('/api/chat'))).toBe(false);
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
  it('purges an unmounted history panel on a workspace authority event',async()=>{
    historyReads('6000');await render('history');const prefix=officePanelCachePrefix(state.workspace,state.viewer);const key=officePanelCacheKey(prefix,'versions',uid(1));expect(readSurfaceCache(key).data).toBeDefined();
    await act(async()=>root.render(null));applySpineEventToSurfaceCache(WORKSPACE_IDENTITY_REFRESH_EVENT,{workspaceId:state.workspace},state.workspace);expect(readSurfaceCache(key).data).toBeUndefined();state.fetch.mockImplementation(pending);await render('history');expect(host.textContent).not.toContain(versions[0]!.summary);
  });
  it('retains nothing from an unmounted job panel: a remount reads the stream again',async()=>{
    state.fetch.mockImplementation(async()=>sse([['job',job],['event',events[0]]]));await render('job');await flush();expect(host.querySelector('details')).not.toBeNull();
    await act(async()=>root.render(null));state.fetch.mockImplementation(pending);await render('job');await flush();expect(host.querySelector('details')).toBeNull();
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
