// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
const state=vi.hoisted(()=>({http:vi.fn(),disk:new Map<string,unknown>(),merge:vi.fn()}));
vi.mock('@/lib/user',()=>({getUserInfo:()=>({id:'viewer'})}));
vi.mock('@/lib/auth-fetch',()=>({authFetch:(...args:unknown[])=>state.http(...args)}));
vi.mock('@/lib/offline/idb',()=>({idbGet:async(k:string)=>state.disk.get(k)??null,idbSet:async(k:string,v:unknown)=>{state.disk.set(k,v)},idbDelete:async(k:string)=>{state.disk.delete(k)}}));
vi.mock('@/lib/offline/feed-offline',()=>({FEED_LOCAL_CHANGED:'fixture-local',adoptFeedServerCopy:vi.fn(),readLocalFeedPost:async()=>null,mergeLocalFeedSessions:(...args:unknown[])=>state.merge(...args)}));
import {useFeedCollaboration,useFeedLearning} from '../feed-collaboration';
import {loadSurfaceCache,resetSurfaceCache,markSurfaceCacheStale,readSurfaceCache,useCachedResource} from '../surface-cache';
import {loadFeedWorkspaceRecord,loadFeedPlatformSessions} from '../feed-surface-cache';
import {feedCollaborationCacheKey,feedLearningCacheKey,feedSessionsCacheKey,feedWorkspaceCacheKey} from '../surface-prefetch';
let root:Root,host:HTMLDivElement;
function Probe({kind}:{kind:'collaboration'|'learning'}){
 const collaboration=useFeedCollaboration('w','a','s',kind==='collaboration');
 const learning=useFeedLearning('w','a','s',kind==='learning');
 const value=kind==='collaboration'?collaboration:learning;
 return <div>{value.error?'unavailable':JSON.stringify(value.data)??'pending'}<button aria-label="Retry" onClick={()=>void value.refresh()}/></div>;
}
beforeEach(()=>{(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;resetSurfaceCache();state.disk.clear();state.http.mockReset();state.merge.mockImplementation(async(_assistant,sessions)=>sessions);host=document.createElement('div');document.body.append(host);root=createRoot(host)});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.useRealTimers()});
describe('[COMP:app-web/feed-composition-editor] denied reads',()=>{
 it('renews idle collaboration and stops automatic reads after denial',async()=>{
  vi.useFakeTimers();
  await loadSurfaceCache(feedCollaborationCacheKey('w','a','s'),async()=>({protected:'private fixture'}));
  state.http.mockImplementation(async()=>new Response('{}',{status:403}));
  await act(async()=>root.render(<Probe kind="collaboration"/>));
  await act(async()=>{await vi.advanceTimersByTimeAsync(15000)});
  expect(host.textContent).toBe('unavailable');
  expect(state.http).toHaveBeenCalledTimes(1);
  await act(async()=>{await vi.advanceTimersByTimeAsync(45000)});
  expect(state.http).toHaveBeenCalledTimes(1);
 });
 it('evicts a disk-first snapshot when the pending network read is denied',async()=>{
  state.disk.set('feed:cache:viewer:/api/distribution/a/draft-sessions/s/collaboration',{feedAuthority:1,confirmedAt:Date.now(),value:{protected:'private fixture'}});
  let reply!: (value:Response)=>void;
  state.http.mockImplementationOnce(()=>new Promise<Response>(resolve=>{reply=resolve})).mockImplementation(()=>new Promise(()=>{}));
  await act(async()=>root.render(<Probe kind="collaboration"/>));
  expect(host.textContent).toContain('private fixture');
  await act(async()=>{reply(new Response('{}',{status:403}));await new Promise(r=>setTimeout(r,10))});
  expect(host.textContent).toBe('unavailable');
  expect(state.http).toHaveBeenCalledTimes(1);
 });
 for(const kind of ['collaboration','learning'] as const) for(const warm of [false,true]) it(`${kind} ${warm?'warm':'cold'} denial settles once without retrying itself`,async()=>{
  const key=(kind==='collaboration'?feedCollaborationCacheKey:feedLearningCacheKey)('w','a','s');
  if(warm)await loadSurfaceCache(key,async()=>({protected:'private fixture'}));
  state.http.mockResolvedValueOnce(new Response('{}',{status:403})).mockImplementation(()=>new Promise(()=>{}));
  await act(async()=>root.render(<Probe kind={kind}/>));
  if(warm)await act(async()=>{markSurfaceCacheStale(key)});
  await act(async()=>{await new Promise(r=>setTimeout(r,10))});
  expect(host.textContent).toBe('unavailable');
  expect(state.http).toHaveBeenCalledTimes(1);
 });
});

function SessionProbe() {
 const key=feedSessionsCacheKey('w','threads');
 const list=useCachedResource(key,()=>loadFeedPlatformSessions({workspaceId:'w',platform:'threads',sessionsKey:key,workspaceKey:feedWorkspaceCacheKey('w')}));
 return <section>{JSON.stringify(list.data)}</section>;
}
describe('[COMP:app-web/feed-surface-cache] known collaboration denial',()=>{
 it('clears a warm list and filters late server and dirty-local titles, then recovers after retry',async()=>{
  const row={id:'s',title:'Protected draft'};
  const list=[{assistantId:'a',sessions:[row]}];
  const collab=feedCollaborationCacheKey('w','a','s');
  const sessions=feedSessionsCacheKey('w','threads');
  await loadSurfaceCache(feedWorkspaceCacheKey('w'),async()=>({assistants:[{id:'a'}],profiles:[]}));
  await loadSurfaceCache(sessions,async()=>list);
  await loadSurfaceCache(collab,async()=>({copy:null}));
  state.merge.mockImplementation(async()=>[row]);
  let denied=true;
  state.http.mockImplementation(async(url:string)=>url.endsWith('/collaboration')
   ?new Response('{}',{status:denied?403:200})
   :new Response(JSON.stringify({sessions:[row]})));
  await act(async()=>root.render(<><Probe kind="collaboration"/><SessionProbe/></>));
  expect(host.querySelector('section')?.textContent).toContain('Protected draft');
  await act(async()=>{markSurfaceCacheStale(collab);await new Promise(r=>setTimeout(r,10))});
  expect(host.querySelector('section')?.textContent).not.toContain('Protected draft');
  expect(readSurfaceCache(sessions).data).toEqual([{assistantId:'a',sessions:[]}]);
  expect(state.merge).toHaveBeenCalled();
  denied=false;
  await act(async()=>{host.querySelector('button')!.click();await new Promise(r=>setTimeout(r,10))});
  await act(async()=>{await vi.waitFor(()=>expect(JSON.stringify(readSurfaceCache(sessions).data)).toContain('Protected draft'))});
 });
 it('filters a disk-seeded list after local overlays while the network is pending',async()=>{
  const row={id:'s',title:'Protected disk draft'};
  state.http.mockImplementation(async()=>new Response('{}',{status:403}));
  await act(async()=>root.render(<Probe kind="collaboration"/>));
  state.disk.set('feed:cache:viewer:record:feed-sessions:w:threads',{feedAuthority:1,confirmedAt:Date.now(),value:[{assistantId:'a',sessions:[row]}]});
  state.merge.mockImplementation(async()=>[row]);
  state.http.mockImplementation(()=>new Promise(()=>{}));
  await act(async()=>root.render(<><Probe kind="collaboration"/><SessionProbe/></>));
  expect(host.querySelector('section')?.textContent).not.toContain('Protected disk draft');
  expect(readSurfaceCache(feedSessionsCacheKey('w','threads')).data).toEqual([{assistantId:'a',sessions:[]}]);
 });
});

describe('[COMP:app-web/feed-surface-cache] workspace denial',()=>{
 it.each([false,true])('settles the workspace denial with warm=%s',async warm=>{
  const key='feed-workspace:w:viewer';
  if(warm)await loadSurfaceCache(key,async()=>({name:'Protected workspace',profiles:[]}));
  state.http.mockImplementation(async()=>new Response('{}',{status:403}));
  await loadSurfaceCache(key,()=>loadFeedWorkspaceRecord('w',key));
  expect(readSurfaceCache(key).data).toBeUndefined();
  expect(readSurfaceCache(key).error).toMatchObject({status:403});
 });
});
