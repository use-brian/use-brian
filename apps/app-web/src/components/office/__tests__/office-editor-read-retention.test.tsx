// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {snapshotToYDoc,appendOfficeCommand,type OfficeArtifactSnapshot,type OfficeCommand} from '@use-brian/office-model';
import type {Doc} from 'yjs';
import {OfficeEditorShell} from '../office-editor-shell';
import {documentFixture,presentationFixture,spreadsheetFixture,uid} from './editor-fixtures';
import {I18nProvider} from '@/lib/i18n/client';
import {en} from '@/lib/i18n/dictionaries/en';
import {loadSurfaceCache,readSurfaceCache,resetSurfaceCache,markSurfaceCacheStale,invalidateSurfaceCache} from '@/lib/surface-cache';
import {officeArtifactCacheKey,officeSnapshotCacheKey,officeListCacheKey} from '@/lib/surface-prefetch';
import {attachOfficeMetadata} from '@/lib/office/metadata';
import {loadOfflinePackage,quarantineOfflineWork,removeOfflineJournalEntry} from '@/lib/office/offline';
import type {LoadedOfficeOfflinePackage} from '@/lib/office/offline';
const state=vi.hoisted(()=>({viewer:'viewer-a',workspace:'workspace-a',search:'',doc:null as Doc|null,fetch:vi.fn(),command:null as ((command:OfficeCommand)=>void)|null,collabTarget:null as string|null,accessDenied:false}));
vi.mock('@/lib/user',()=>({getUserInfo:()=>({id:state.viewer})}));
vi.mock('@/lib/auth-fetch',()=>({authFetch:(...args:unknown[])=>state.fetch(...args)}));
vi.mock('@/lib/workspace-context',()=>({useOptionalWorkspaceContext:()=>({workspaceId:state.workspace,me:{id:state.viewer}})}));
vi.mock('next/navigation',()=>({useRouter:()=>({push:vi.fn(),replace:vi.fn(),back:vi.fn(),forward:vi.fn(),prefetch:vi.fn()}),usePathname:()=>'/office',useSearchParams:()=>new URLSearchParams(state.search)}));
vi.mock('next/link',()=>({default:({children,href}:{children:React.ReactNode;href:string})=><a href={href}>{children}</a>}));
vi.mock('@/components/doc/doc-sidebar-data',()=>({useSidebarData:()=>({sidebarCollapsed:false,setSidebarCollapsed:vi.fn()})}));
vi.mock('@/lib/collab/use-collab-provider',()=>({useCollabProvider:(target:string|null)=>{state.collabTarget=target;return {doc:target?state.doc:null,provider:null,status:'connected',synced:Boolean(target&&state.doc),accessDenied:state.accessDenied};}}));
vi.mock('@/lib/collab/use-presence',()=>({usePresence:()=>[],usePublishPresenceIdentity:vi.fn(),usePublishPresenceActivity:vi.fn()}));
vi.mock('@/components/doc/presence-avatars',()=>({PresenceAvatars:()=>null}));
vi.mock('@/components/context/reclassify-context-dialog',()=>({ReclassifyContextButton:()=>null}));
vi.mock('@/components/chrome/dock-recorder',()=>({DockRecorderFallback:()=>null}));
vi.mock('@/lib/chat-dock-suppress',()=>({chatDockSuppression:{suppress:()=>()=>{}}}));
// Observe actual shell outputs/commands. SDK, bounded reads, cache and Yjs are
// real; rich-editor rendering and socket/device transport are separate adapters.
vi.mock('../document-editor',()=>({DocumentEditor:({snapshot,onCommand,onSelectTargets}:{snapshot:OfficeArtifactSnapshot;onCommand:(command:OfficeCommand)=>void;onSelectTargets:(ids:string[])=>void})=>{state.command=onCommand;return <div data-editor>{snapshot.title}{snapshot.family==='document'?JSON.stringify(snapshot.sections):null}<button onClick={()=>onSelectTargets(['block-a'])}>Select block</button></div>;}}));
vi.mock('../presentation-editor',()=>({PresentationEditor:({snapshot}:{snapshot:OfficeArtifactSnapshot})=><div data-editor>{snapshot.title}</div>}));
vi.mock('../presentation-presenter',()=>({PresentationPresenter:({snapshot}:{snapshot:OfficeArtifactSnapshot})=><div data-presenter>{snapshot.title}</div>}));
vi.mock('../office-review',()=>({OfficeReview:({onPresent}:{onPresent:()=>void})=><button onClick={onPresent}>Present fixture</button>}));
vi.mock('../job-activity',()=>({OfficeJobActivity:({targetIds}:{targetIds:string[]})=><div data-selection>{targetIds.join('|')}</div>}));
vi.mock('../template-routing-inspector',()=>({TemplateRoutingInspector:()=>null}));
vi.mock('@/lib/office/offline',()=>({loadOfflinePackage:vi.fn(async()=>null),listOfflineJournal:vi.fn(async()=>[]),appendOfflineCommand:vi.fn(async()=>{}),removeOfflinePackage:vi.fn(async()=>{}),removeOfflineJournalEntry:vi.fn(async()=>{}),classifyOfficeReconnect:vi.fn(),materializeOfflineRecoverySnapshot:vi.fn(),officeOfflineDeviceId:vi.fn(async()=>"fixture-device"),quarantineOfflineWork:vi.fn(async()=>{})}));
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const artifact=()=>({artifactId:uid(1),title:'Protected artifact title',family:'document',role:'edit',version:1,lifecycleState:'active',...(state.search?{mode:'template'}:{})});
const snapshot=(title='Protected snapshot text')=>({...documentFixture(),workspaceId:state.workspace,title});
const live=(title?:string)=>({snapshot:snapshot(title),seq:1,baseVersion:1});
const response=(body:unknown,ttl='6000',status=200)=>new Response(JSON.stringify(body),{status,headers:{'X-Brian-Projection-Valid-For-Ms':ttl}});
const pending=()=>new Promise<Response>(()=>{});
const command=(text='Live edited title',commandId=uid(100)):OfficeCommand=>({kind:'updateText',artifactId:uid(1),commandId,actor:{type:'user',id:state.viewer},origin:'manual',baseVersion:1,targetId:uid(12),runs:[{...documentFixture().sections[0]!.header[0]!,text}]});
const artifactKey=()=>officeArtifactCacheKey(state.workspace,uid(1),state.viewer);
const snapshotKey=()=>officeSnapshotCacheKey(state.workspace,uid(1),state.viewer);
const reads=(suffix:string)=>state.fetch.mock.calls.filter(([url,init])=>url.endsWith(suffix)&&!init?.method);
let root:Root,host:HTMLDivElement;
beforeEach(()=>{vi.useFakeTimers();resetSurfaceCache();vi.clearAllMocks();vi.mocked(loadOfflinePackage).mockResolvedValue(null);state.viewer=uid(99);state.workspace=uid(2);state.search='';state.doc=null;state.command=null;state.collabTarget=null;state.accessDenied=false;host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());state.doc?.destroy();host.remove();resetSurfaceCache();vi.useRealTimers();});
function setup(artifactTtl='6000',snapshotTtl=artifactTtl){state.fetch.mockImplementation(async(url:string)=>{
  if(url.endsWith('/snapshot'))return response(live(),snapshotTtl);
  if(url.endsWith('/comments/detach-missing'))return response({detached:0});
  if(url.endsWith('/comments'))return response({threads:[]});
  if(url.endsWith('/suggestions'))return response({suggestions:[]});
  return response({artifact:artifact()},artifactTtl);
});}
async function render(){await act(async()=>root.render(<I18nProvider locale="en" dict={en}><OfficeEditorShell workspaceId={state.workspace} artifactId={uid(1)}/></I18nProvider>));}
async function advance(ms:number){await act(async()=>vi.advanceTimersByTime(ms));}
async function click(label:string){await act(async()=>{const button=[...host.querySelectorAll('button')].find(row=>row.textContent===label);expect(button).toBeDefined();button!.click();});}

describe('[COMP:app-web/office-editor-shell] bounded online editor reads',()=>{
  it.each(['focus','visibilitychange'])('retains the mounted editor and selection during %s revalidation',async event=>{
    setup();await render();await click('Select block');
    const editor=host.querySelector('[data-editor]');
    const normal=state.fetch.getMockImplementation()!;
    const finish:Array<()=>void>=[];
    state.fetch.mockImplementation((...args)=>new Promise(resolve=>finish.push(()=>resolve(normal(...args)))));
    await act(async()=>{(event==='focus'?window:document).dispatchEvent(new Event(event));});
    expect(host.querySelector('[data-editor]')).toBe(editor);
    expect(host.querySelector('[data-selection]')?.textContent).toBe('block-a');
    expect(state.collabTarget).toBe(`office:${uid(1)}`);
    await act(async()=>{finish.forEach(resolve=>resolve());});
    expect(host.querySelector('[data-editor]')).toBe(editor);
    expect(host.querySelector('[data-selection]')?.textContent).toBe('block-a');
  });
  it.each(['focus','visibilitychange'])('preserves the real spreadsheet cell and worksheet selection on %s',async event=>{
    const workbook=spreadsheetFixture();
    workbook.worksheets.push({...workbook.worksheets[0],id:uid(190),name:'Second sheet',cells:workbook.worksheets[0].cells.map((cell,index)=>({...cell,id:uid(200+index)}))});
    setup();const normal=state.fetch.getMockImplementation()!;
    const read=async(url:string)=>url.endsWith('/snapshot')?response({snapshot:workbook,seq:1,baseVersion:0})
      :url.endsWith(`/artifacts/${uid(1)}`)?response({artifact:{...artifact(),family:'spreadsheet',version:0,mode:'template'}}):normal(url);
    state.fetch.mockImplementation(read);await render();
    await click('Second sheet');
    await act(async()=>{host.querySelector<HTMLElement>('[data-cell-address="A2"]')!.click();});
    const grid=host.querySelector('[role="grid"]');
    const selected=()=>host.querySelector(`[aria-label="${en.office.cellReference}"]`)?.textContent;
    expect(selected()).toBe('A2');
    const finish:Array<()=>void>=[];
    state.fetch.mockImplementation((url:string)=>new Promise(resolve=>finish.push(()=>resolve(read(url)))));
    await act(async()=>{(event==='focus'?window:document).dispatchEvent(new Event(event));});
    expect(host.querySelector('[role="grid"]')).toBe(grid);expect(selected()).toBe('A2');
    await act(async()=>{finish.forEach(resolve=>resolve());});
    expect(host.querySelector('[role="grid"]')).toBe(grid);expect(selected()).toBe('A2');
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Second sheet');
  });
  it('does not let repeated focus renew a stalled projection deadline',async()=>{
    setup('800');await render();state.fetch.mockImplementation(pending);
    await act(async()=>window.dispatchEvent(new Event('focus')));
    await advance(400);await act(async()=>window.dispatchEvent(new Event('focus')));
    expect(host.querySelector('[data-editor]')).not.toBeNull();
    await advance(401);expect(host.querySelector('[data-editor]')).toBeNull();
    expect(state.collabTarget).toBeNull();
  });
  it.each(['artifact','snapshot'])('removes working content and collaboration when the %s expires, and clears selection before renewal',async kind=>{
    setup(kind==='artifact'?'800':'6000',kind==='snapshot'?'800':'6000');await render();await click('Select block');expect(host.querySelector('[data-selection]')?.textContent).toBe('block-a');
    const oldCommand=state.command!;state.fetch.mockImplementation(pending);await advance(801);
    expect(host.querySelector('[data-editor]')).toBeNull();expect(host.textContent).not.toContain('Protected snapshot text');expect(state.collabTarget).toBeNull();
    if(kind==='artifact')expect(host.textContent).not.toContain('Protected artifact title');
    await act(async()=>oldCommand(command()));expect(state.fetch.mock.calls.filter(([url])=>url.endsWith('/commands'))).toHaveLength(0);
    setup();await act(async()=>{invalidateSurfaceCache(kind==='artifact'?artifactKey():snapshotKey());});
    expect(host.querySelector('[data-editor]')).not.toBeNull();expect(host.querySelector('[data-selection]')?.textContent).toBe('');
  });
  it.each([401,403,404,409])('removes the working editor after a snapshot renewal returns %s',async status=>{
    setup();await render();const normal=state.fetch.getMockImplementation()!;
    state.fetch.mockImplementation((url:string)=>url.endsWith('/snapshot')?Promise.resolve(response({error:status===409?'office_projection_changed':'denied'},'0',status)):normal(url));
    await act(async()=>markSurfaceCacheStale(snapshotKey()));expect(host.querySelector('[data-editor]')).toBeNull();expect(state.collabTarget).toBeNull();
  });
  it('keeps content through transient refresh failure only until the original deadline',async()=>{
    setup('2000');await render();state.fetch.mockRejectedValue(new Error('offline'));await advance(1001);expect(host.querySelector('[data-editor]')).not.toBeNull();await advance(1000);expect(host.querySelector('[data-editor]')).toBeNull();
  });
  it('inherits the list deadline, starts both reads immediately, and cannot resurrect the old hint',async()=>{
    const key=officeListCacheKey(state.workspace,'active',state.viewer);
    await loadSurfaceCache(key,async()=>attachOfficeMetadata([artifact()],1000,performance.now(),state.viewer));await advance(500);state.fetch.mockImplementation(pending);await render();
    expect(host.textContent).toContain('Protected artifact title');expect(reads(`/artifacts/${uid(1)}`)).toHaveLength(1);expect(reads('/snapshot')).toHaveLength(1);
    await advance(501);expect(host.textContent).not.toContain('Protected artifact title');await render();expect(host.textContent).not.toContain('Protected artifact title');expect(readSurfaceCache(artifactKey()).data).toBeUndefined();
  });
  it('bounds live Yjs edits to the snapshot read without renewing it',async()=>{
    state.doc=snapshotToYDoc(snapshot());setup('6000','800');await render();await advance(400);
    act(()=>appendOfficeCommand(state.doc!,command()));expect(host.textContent).toContain('Live edited title');state.fetch.mockImplementation(pending);await advance(401);
    expect(host.textContent).not.toContain('Live edited title');expect(state.collabTarget).toBeNull();act(()=>appendOfficeCommand(state.doc!,command('Late live text',uid(101))));expect(host.textContent).not.toContain('Late live text');
  });
  it('closes presentation mode on expiry and does not reopen it after renewal',async()=>{
    const presentation=()=>response({snapshot:{...presentationFixture(),title:'Protected presentation'},seq:1,baseVersion:1},'800');
    const row=()=>response({artifact:{...artifact(),family:'presentation'}});
    state.fetch.mockImplementation(url=>Promise.resolve(url.endsWith('/snapshot')?presentation():row()));await render();await click(en.office.fileActions);await click('Present fixture');expect(host.querySelector('[data-presenter]')).not.toBeNull();
    state.fetch.mockImplementation(pending);await advance(801);expect(host.querySelector('[data-presenter]')).toBeNull();expect(host.textContent).not.toContain('Protected presentation');
    state.fetch.mockImplementation(url=>Promise.resolve(url.endsWith('/snapshot')?presentation():row()));await act(async()=>invalidateSurfaceCache(snapshotKey()));expect(host.querySelector('[data-editor]')).not.toBeNull();expect(host.querySelector('[data-presenter]')).toBeNull();
  });
  it('keeps keyboard history usable through a successful read renewal',async()=>{
    state.doc=snapshotToYDoc(snapshot());setup('2000');await render();
    act(()=>appendOfficeCommand(state.doc!,command()));expect(host.textContent).toContain('Live edited title');
    setup('6000');await advance(1001);await advance(1000);
    await act(async()=>document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true})));
    expect(host.querySelector('[data-editor]')).not.toBeNull();expect(host.textContent).not.toContain('Live edited title');
  });
  it('never adopts a delayed device package once an online read has established ownership',async()=>{
    let finish!:(value:LoadedOfficeOfflinePackage)=>void;vi.mocked(loadOfflinePackage).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));setup('800');await render();state.fetch.mockImplementation(pending);await advance(801);
    await act(async()=>finish({savedAt:'2026-01-01T00:00:00Z',payload:{artifact:{...artifact(),title:'Old offline title'},...live('Old offline content')}} as unknown as LoadedOfficeOfflinePackage));
    expect(host.textContent).not.toContain('Old offline');expect(host.querySelector('[data-editor]')).toBeNull();expect(removeOfflineJournalEntry).not.toHaveBeenCalled();
  });
  it('rejects obsolete responses after switching viewers',async()=>{
    let finish!:(value:Response)=>void;setup();await render();state.fetch.mockImplementation(url=>url.endsWith('/snapshot')?new Promise(resolve=>{finish=resolve;}):pending());await act(async()=>markSurfaceCacheStale(snapshotKey()));const oldKey=snapshotKey();state.viewer='viewer-b';state.fetch.mockImplementation(pending);await render();await act(async()=>finish(response(live('Old viewer text'))));
    expect(host.textContent).not.toContain('Old viewer text');expect(readSurfaceCache(oldKey).data).toBeUndefined();
  });
  it('purges the live projection and quarantines explicit offline work on typed socket revocation',async()=>{
    state.doc=snapshotToYDoc(snapshot());setup();await render();expect(host.querySelector('[data-editor]')).not.toBeNull();expect(state.collabTarget).toBe(`office:${uid(1)}`);
    state.accessDenied=true;await render();
    expect(host.querySelector('[data-editor]')).toBeNull();expect(state.collabTarget).toBeNull();
    expect(readSurfaceCache(artifactKey()).data).toBeUndefined();expect(readSurfaceCache(snapshotKey()).data).toBeUndefined();
    expect(vi.mocked(quarantineOfflineWork)).toHaveBeenCalledWith(uid(1),{workspaceId:state.workspace,userId:state.viewer});
  });
});

describe('[COMP:app-web/office-editor-shell] bounded command readback',()=>{
  it('ignores a command snapshot acknowledgement and renders only the bounded GET readback',async()=>{
    setup();await render();const normal=state.fetch.getMockImplementation()!;let finish!:(value:Response)=>void;
    state.fetch.mockImplementation((url:string,init:RequestInit)=>url.endsWith('/commands')?Promise.resolve(response(live('Unbounded acknowledgement'))):url.endsWith('/snapshot')?new Promise(resolve=>{finish=resolve;}):normal(url,init));
    await act(async()=>state.command!(command()));expect(reads('/snapshot')).toHaveLength(2);expect(host.textContent).not.toContain('Unbounded acknowledgement');
    await act(async()=>finish(response(live('Authorized readback'),'400')));expect(host.textContent).toContain('Authorized readback');state.fetch.mockImplementation(pending);await advance(401);expect(host.textContent).not.toContain('Authorized readback');
  });
  it.each(['expiry','viewer','unmount','role'] as const)('does not read back a command acknowledgement after losing %s',async reason=>{
    setup('800');await render();let finish!:(value:Response)=>void;state.fetch.mockImplementation((url:string)=>url.endsWith('/commands')?new Promise(resolve=>{finish=resolve;}):pending());await act(async()=>state.command!(command()));
    if(reason==='expiry')await advance(801);else if(reason==='viewer'){state.viewer='viewer-b';await render();}else if(reason==='unmount')act(()=>root.render(null));else{
      state.fetch.mockImplementation(url=>url.endsWith(`/artifacts/${uid(1)}`)?Promise.resolve(response({artifact:{...artifact(),role:'view'}})):pending());await act(async()=>markSurfaceCacheStale(artifactKey()));
    }
    const count=reads('/snapshot').length;await act(async()=>finish(response(live('Late command result'))));expect(reads('/snapshot')).toHaveLength(count);expect(host.textContent).not.toContain('Late command result');
  });
  it('drains a snapshot request already in flight before starting the command readback',async()=>{
    setup();await render();let finish!:(value:Response)=>void;let requests=0;const normal=state.fetch.getMockImplementation()!;
    state.fetch.mockImplementation((url:string,init:RequestInit)=>url.endsWith('/commands')?Promise.resolve(response(live('Ack'))):url.endsWith('/snapshot')?(++requests===1?new Promise(resolve=>{finish=resolve;}):Promise.resolve(response(live('Fresh command read')))):normal(url,init));
    await act(async()=>markSurfaceCacheStale(snapshotKey()));await act(async()=>state.command!(command()));expect(requests).toBe(1);await act(async()=>finish(response(live('Pre-command read'))));expect(requests).toBe(2);expect(host.textContent).toContain('Fresh command read');
  });
  it.each(['current','expired'])('initializes a template through readback only while the opening artifact is %s',async stateAtAck=>{
    state.search='templateId=template-a';let finish!:(value:Response)=>void;let readsStarted=0;
    state.fetch.mockImplementation((url:string)=>url.endsWith('/draft/initialize')?new Promise(resolve=>{finish=resolve;}):url.endsWith('/snapshot')?Promise.resolve(++readsStarted===1?response({error:'artifact_not_ready'},'0',409):response(live('Initialized readback'))):url.endsWith('/comments')?Promise.resolve(response({threads:[]})):url.endsWith('/suggestions')?Promise.resolve(response({suggestions:[]})):Promise.resolve(response({artifact:artifact()},'800')));
    await render();expect(state.fetch.mock.calls.filter(([url])=>url.endsWith('/draft/initialize'))).toHaveLength(1);
    if(stateAtAck==='expired'){state.fetch.mockImplementation(pending);await advance(801);}
    const count=reads('/snapshot').length;await act(async()=>finish(response(live('Initialization acknowledgement'))));expect(host.textContent).not.toContain('Initialization acknowledgement');
    if(stateAtAck==='current'){expect(reads('/snapshot')).toHaveLength(count+1);expect(host.textContent).toContain('Initialized readback');}else{expect(reads('/snapshot')).toHaveLength(count);expect(host.querySelector('[data-editor]')).toBeNull();}
  });
});
