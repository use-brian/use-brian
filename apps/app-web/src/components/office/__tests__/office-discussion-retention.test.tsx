// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {appendOfflineCommand,removeOfflineJournalEntry,type OfflineJournalEntry} from '@/lib/office/offline';
import {OfficeComments} from '../comments/office-comments';
import {OfficeSuggestions} from '../suggestions/office-suggestions';
import {I18nProvider} from '@/lib/i18n/client';
import {en} from '@/lib/i18n/dictionaries/en';
import {readSurfaceCache,resetSurfaceCache} from '@/lib/surface-cache';
import {officePanelCacheKey,officePanelCachePrefix} from '@/lib/surface-prefetch';
import {applySpineEventToSurfaceCache} from '@/lib/surface-cache-invalidation';
import {WORKSPACE_IDENTITY_REFRESH_EVENT} from '@/lib/workspace-identity-events';
const state=vi.hoisted(()=>({canAct:true,viewer:'viewer-a',workspace:'workspace-a',fetch:vi.fn(),journal:vi.fn<(...args:unknown[])=>Promise<OfflineJournalEntry[]>>(async()=>[])}));
vi.mock('@/lib/user',()=>({getUserInfo:()=>({id:state.viewer}),subscribeUserInfo:()=>()=>{}}));
vi.mock('@/lib/auth-fetch',()=>({authFetch:(...args:unknown[])=>state.fetch(...args)}));
vi.mock('@/lib/workspace-context',()=>({useOptionalWorkspaceContext:()=>({workspaceId:state.workspace,me:{id:state.viewer}})}));
vi.mock('@/lib/office/offline',()=>({listOfflineJournal:(...args:unknown[])=>state.journal(...args),removeOfflineJournalEntry:vi.fn(async()=>{}),appendOfflineCommand:vi.fn(async()=>{})}));
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const threads=[{id:'thread-a',artifactVersionId:'version-a',anchorKind:'block',anchor:{kind:'block',targetIds:['block-a']},status:'open',messages:[{id:'message-a',authorType:'user',body:'Protected comment body',mentions:[],createdAt:'2026-01-01T00:00:00Z'}]}];
const suggestions=[{id:'suggestion-a',status:'open',commandBatch:{kind:'replaceTextRange'}},{id:'suggestion-b',status:'open',commandBatch:{kind:'replaceTextRange'}}];
const proposal={targetId:'block-a',from:0,to:16,text:'Protected source',style:{fontFamily:'Arial',fontSizePt:12,bold:false,italic:false,underline:false,strike:false,color:'#000000'}};
const response=(body:unknown,ttl='6000',status=200)=>new Response(JSON.stringify(body),{status,headers:{'X-Brian-Projection-Valid-For-Ms':ttl}});
const pending=()=>new Promise<Response>(()=>{});
type Kind='comments'|'suggestions';
let root:Root,host:HTMLDivElement;
const changed=vi.fn(),applied=vi.fn();
beforeEach(()=>{vi.useFakeTimers();resetSurfaceCache();vi.clearAllMocks();state.journal.mockResolvedValue([]);state.canAct=true;state.viewer='viewer-a';state.workspace='workspace-a';host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();resetSurfaceCache();vi.useRealTimers();});
async function render(kind:Kind,offline=false){await act(async()=>root.render(<I18nProvider locale="en" dict={en}>{kind==='comments'?<OfficeComments artifactId="artifact-a" workspaceId={state.workspace} version={1} targetIds={['block-a']} canComment={state.canAct} offline={offline} onThreadsChange={changed} onRevisionCompleted={applied}/>:<OfficeSuggestions workspaceId={state.workspace} artifactId="artifact-a" canDecide={state.canAct} canSuggest={state.canAct} actorId={state.viewer} proposal={proposal} offline={offline} onSuggestionsChange={changed} onApplied={applied}/>}</I18nProvider>));}
function setup(ttl='800'){state.fetch.mockImplementation(async(url:string)=>url.includes('/api/workspaces/')?response({workspaceId:state.workspace,viewerId:state.viewer,validForMs:Number(ttl),members:[]}):url.endsWith('/comments')?response({threads},ttl):response({suggestions},ttl));}
function input(value:string,index=0){act(()=>{const element=host.querySelectorAll('textarea')[index]!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));});}
async function click(label:string,last=false){await act(async()=>{const matches=[...host.querySelectorAll('button')].filter(row=>row.textContent===label&&!row.disabled);const button=last?matches.at(-1):matches[0];expect(button,`button ${label}`).toBeDefined();button!.click();});}
const posts=()=>state.fetch.mock.calls.filter(([,init])=>init?.method==='POST');

for(const kind of ['comments','suggestions'] as const) describe(`[COMP:app-web/office-${kind}] collection retention`,()=>{
  it('expires collection contents, drafts and parent highlights',async()=>{
    setup();await render(kind);input('Protected draft');expect(host.querySelector('textarea')).not.toBeNull();
    state.fetch.mockImplementation(pending);await act(async()=>vi.advanceTimersByTime(801));
    expect(host.querySelector('textarea')).toBeNull();expect(host.textContent).not.toContain('Protected');expect(changed).toHaveBeenLastCalledWith([]);
  });
  it('preserves a draft on a current renewal but discards it after a failed renewal expires',async()=>{
    setup('6000');await render(kind);input('Unsaved draft');await act(async()=>vi.advanceTimersByTime(3001));expect(host.querySelector('textarea')!.value).toBe('Unsaved draft');
    state.fetch.mockRejectedValue(new Error('offline'));await act(async()=>vi.advanceTimersByTime(3001));expect(host.querySelector('textarea')).not.toBeNull();await act(async()=>vi.advanceTimersByTime(3000));expect(host.querySelector('textarea')).toBeNull();
  });
  it.each([401,403,404,409])('drops the collection on authoritative %s',async status=>{
    setup('6000');await render(kind);input('Old draft');state.fetch.mockImplementation(async()=>response({error:status===409?'office_projection_changed':'denied'},'0',status));await act(async()=>vi.advanceTimersByTime(3001));expect(host.querySelector('textarea')).toBeNull();expect(changed).toHaveBeenLastCalledWith([]);
  });
  it.each(['viewer','workspace'] as const)('drops late reads and old drafts on a %s switch',async identity=>{
    setup('6000');await render(kind);input('Old draft');let finish!:(response:Response)=>void;
    state.fetch.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));await act(async()=>window.dispatchEvent(new Event('focus')));
    state.fetch.mockImplementation(pending);state[identity]=`${identity}-b`;await render(kind);
    await act(async()=>finish(response(kind==='comments'?{threads}:{suggestions})));
    expect(host.querySelector('textarea')).toBeNull();expect(host.textContent).not.toContain('Protected');expect(changed).toHaveBeenLastCalledWith([]);
  });
  it('purges the unmounted collection on an authority event',async()=>{
    setup('6000');await render(kind);const key=officePanelCacheKey(officePanelCachePrefix(state.workspace,state.viewer),kind,'artifact-a');expect(readSurfaceCache(key).data).toBeDefined();await act(async()=>root.render(null));
    applySpineEventToSurfaceCache(WORKSPACE_IDENTITY_REFRESH_EVENT,{workspaceId:state.workspace},state.workspace);expect(readSurfaceCache(key).data).toBeUndefined();state.fetch.mockImplementation(pending);await render(kind);expect(host.querySelector('textarea')).toBeNull();
  });
});

describe('[COMP:app-web/office-suggestions] owned decisions',()=>{
  it.each(['expiry','viewer','workspace','permission'] as const)('stops a bulk decision after losing %s without a callback',async reason=>{
    setup();await render('suggestions');let finish!:(response:Response)=>void;state.fetch.mockImplementation((_url:string,init:RequestInit)=>init?.method==='POST'?new Promise(resolve=>{finish=resolve;}):pending());await click(en.office.acceptAll);expect(posts()).toHaveLength(1);
    if(reason==='expiry')await act(async()=>vi.advanceTimersByTime(801));else if(reason==='permission'){state.canAct=false;await render('suggestions');}else{state[reason]=`${reason}-b`;state.fetch.mockImplementation(pending);await render('suggestions');}
    await act(async()=>finish(response({})));expect(posts()).toHaveLength(1);expect(applied).not.toHaveBeenCalled();
  });
  it('accepts current suggestions and confirms through a fresh list',async()=>{
    setup('6000');await render('suggestions');state.fetch.mockImplementation(async(url:string,init:RequestInit)=>init?.method==='POST'?response({}):response({suggestions:suggestions.map(row=>({...row,status:'accepted'}))}));await click(en.office.acceptAll);expect(posts()).toHaveLength(2);expect(applied).toHaveBeenCalledTimes(1);expect(host.textContent).toContain(en.office.noSuggestions);
  });
  it('submits a current selection and refuses to renew ownership from its acknowledgement',async()=>{
    setup();await render('suggestions');input('New replacement');let finish!:(response:Response)=>void;state.fetch.mockImplementation((_url:string,init:RequestInit)=>init?.method==='POST'?new Promise(resolve=>{finish=resolve;}):pending());await click(en.office.submitSuggestion);await act(async()=>vi.advanceTimersByTime(801));const count=state.fetch.mock.calls.length;
    await act(async()=>finish(response({mode:'suggestion'})));expect(state.fetch.mock.calls.length).toBe(count);expect(host.querySelector('textarea')).toBeNull();
  });
});

describe('[COMP:app-web/office-comments] owned comment actions',()=>{
  it('posts and reloads a current comment with the exact anchor',async()=>{
    setup('6000');await render('comments');input('New comment');state.fetch.mockImplementation(async(_url:string,init:RequestInit)=>init?.method==='POST'?response({}):response({threads}));await click(en.office.comment);
    expect(JSON.parse(posts()[0]![1].body)).toMatchObject({body:'New comment',anchor:{kind:'object',targetIds:['block-a']}});expect(host.querySelector('textarea')!.value).toBe('');expect(host.textContent).toContain(threads[0]!.messages[0]!.body);
  });
  it('does not poll a returned revision or notify the parent after expiry',async()=>{
    setup();await render('comments');input('@Brian revise this');let finish!:(response:Response)=>void;state.fetch.mockImplementation((_url:string,init:RequestInit)=>init?.method==='POST'?new Promise(resolve=>{finish=resolve;}):pending());await click(en.office.comment);await act(async()=>vi.advanceTimersByTime(801));const count=state.fetch.mock.calls.length;await act(async()=>finish(response({revision:{jobId:'job-a',mode:'direct'}})));expect(state.fetch.mock.calls.length).toBe(count);expect(applied).not.toHaveBeenCalled();
  });
  it('stops an already-started job poll when the comment collection expires',async()=>{
    setup();await render('comments');input('@Brian revise this');state.fetch.mockImplementation(async(url:string,init:RequestInit)=>init?.method==='POST'?response({revision:{jobId:'job-a',mode:'direct'}}):url.includes('/jobs/')?response({job:{id:'job-a',status:'running'}}):response({threads},'800'));
    await click(en.office.comment);expect(state.fetch.mock.calls.filter(([url])=>url.includes('/jobs/'))).toHaveLength(1);await act(async()=>vi.advanceTimersByTime(801));const count=state.fetch.mock.calls.filter(([url])=>url.includes('/jobs/')).length;await act(async()=>vi.advanceTimersByTime(1500));expect(state.fetch.mock.calls.filter(([url])=>url.includes('/jobs/'))).toHaveLength(count);expect(applied).not.toHaveBeenCalled();
  });
  it('clears replies and prevents their late acknowledgement from repopulating the panel',async()=>{
    setup();await render('comments');await click(en.office.reply);input('Private reply');let finish!:(response:Response)=>void;state.fetch.mockImplementation((_url:string,init:RequestInit)=>init?.method==='POST'?new Promise(resolve=>{finish=resolve;}):pending());await click(en.office.reply,true);expect(posts()).toHaveLength(1);await act(async()=>vi.advanceTimersByTime(801));await act(async()=>finish(response({})));expect(host.querySelector('textarea')).toBeNull();expect(changed).toHaveBeenLastCalledWith([]);
  });
});


describe('[COMP:app-web/office-comments] replay ownership',()=>{
  it('stops replaying after its collection expires and removes only the acknowledged entry',async()=>{
    const entries: OfflineJournalEntry[] = [1,2].map(seq=>({artifactId:'artifact-a',seq,kind:'comment',anchor:{kind:'block',targetIds:['block-a']},body:`Queued comment ${seq}`,createdAt:'2026-01-01T00:00:00Z'}));
    state.journal.mockResolvedValue(entries);let finish!:(response:Response)=>void;
    state.fetch.mockImplementation(async(url:string,init:RequestInit)=>init?.method==='POST'?new Promise(resolve=>{finish=resolve;}):url.includes('/workspaces/')?response({workspaceId:state.workspace,viewerId:state.viewer,validForMs:800,members:[]}):response({threads},'800'));
    await render('comments');expect(posts()).toHaveLength(1);
    state.fetch.mockImplementation(pending);await act(async()=>vi.advanceTimersByTime(801));await act(async()=>finish(response({})));
    expect(posts()).toHaveLength(1);expect(removeOfflineJournalEntry).toHaveBeenCalledTimes(1);expect(removeOfflineJournalEntry).toHaveBeenCalledWith(entries[0],{workspaceId:state.workspace,userId:state.viewer});
  });
  it('keeps the existing offline comment path with explicit device ownership',async()=>{
    setup();await render('comments',true);input('Local comment');await click(en.office.comment);expect(appendOfflineCommand).toHaveBeenCalledWith(expect.objectContaining({artifactId:'artifact-a',kind:'comment',body:'Local comment'}),{workspaceId:state.workspace,userId:state.viewer});expect(posts()).toHaveLength(0);expect(host.textContent).toContain('Local comment');
  });
});

describe('[COMP:app-web/office-suggestions] offline and mutation denial',()=>{
  it('keeps the existing offline suggestion path with explicit device ownership',async()=>{
    setup();await render('suggestions',true);input('Local replacement');await click(en.office.submitSuggestion);expect(appendOfflineCommand).toHaveBeenCalledWith(expect.objectContaining({artifactId:'artifact-a',kind:'suggestion'}),{workspaceId:state.workspace,userId:state.viewer});expect(posts()).toHaveLength(0);
  });
  it('evicts a collection denied by a mutation instead of retaining its proposal',async()=>{
    setup('6000');await render('suggestions');state.fetch.mockImplementation(async()=>response({error:'denied'},'0',403));await click(en.office.acceptAll);expect(host.querySelector('textarea')).toBeNull();expect(posts()).toHaveLength(1);expect(applied).not.toHaveBeenCalled();expect(changed).toHaveBeenLastCalledWith([]);
  });
});
