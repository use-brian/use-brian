// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {OfficeEditorShell} from '../office-editor-shell';
import {documentFixture,uid} from './editor-fixtures';
import {I18nProvider} from '@/lib/i18n/client';
import {en} from '@/lib/i18n/dictionaries/en';
import {readSurfaceCache,resetSurfaceCache,markSurfaceCacheStale} from '@/lib/surface-cache';
import {officeArtifactCacheKey,officePanelCacheKey,officePanelCachePrefix} from '@/lib/surface-prefetch';
import {applySpineEventToSurfaceCache} from '@/lib/surface-cache-invalidation';
import {WORKSPACE_IDENTITY_REFRESH_EVENT} from '@/lib/workspace-identity-events';
import {appendOfflineCommand} from '@/lib/office/offline';
import type {OfficeCommentThread,OfficeSuggestion} from '@/lib/office/api';
const state=vi.hoisted(()=>({viewer:'viewer-a',workspace:'workspace-a',status:'connected',role:'view',fetch:vi.fn()}));
vi.mock('@/lib/user',()=>({getUserInfo:()=>({id:state.viewer}),subscribeUserInfo:()=>()=>{}}));
vi.mock('@/lib/auth-fetch',()=>({authFetch:(...args:unknown[])=>state.fetch(...args)}));
vi.mock('@/lib/workspace-context',()=>({useOptionalWorkspaceContext:()=>({workspaceId:state.workspace,me:{id:state.viewer}})}));
vi.mock('next/navigation',()=>({useRouter:()=>({push:vi.fn(),replace:vi.fn(),back:vi.fn(),forward:vi.fn(),prefetch:vi.fn()}),usePathname:()=>'/office',useSearchParams:()=>new URLSearchParams()}));
vi.mock('next/link',()=>({default:({children,href}:{children:React.ReactNode;href:string})=><a href={href}>{children}</a>}));
vi.mock('@/components/doc/doc-sidebar-data',()=>({useSidebarData:()=>({sidebarCollapsed:false,setSidebarCollapsed:vi.fn()})}));
vi.mock('@/lib/collab/use-collab-provider',()=>({useCollabProvider:()=>({doc:null,provider:null,status:state.status,synced:false})}));
vi.mock('@/lib/collab/use-presence',()=>({usePresence:()=>[],usePublishPresenceIdentity:vi.fn(),usePublishPresenceActivity:vi.fn()}));
vi.mock('@/components/doc/presence-avatars',()=>({PresenceAvatars:()=>null}));
vi.mock('@/components/context/reclassify-context-dialog',()=>({ReclassifyContextButton:()=>null}));
vi.mock('@/components/chrome/dock-recorder',()=>({DockRecorderFallback:()=>null}));
vi.mock('@/lib/chat-dock-suppress',()=>({chatDockSuppression:{suppress:()=>()=>{}}}));
// The shell's actual editor prop boundary is observed; rich-document rendering
// and websocket transport have separate tests. SDK/cache/panels/composer are real.
vi.mock('../document-editor',()=>({DocumentEditor:({commentThreads,suggestions,onSelectTargets}:{commentThreads:OfficeCommentThread[];suggestions:OfficeSuggestion[];onSelectTargets:(ids:string[])=>void})=><div data-editor><button onClick={()=>onSelectTargets(['block-a'])}>Select block</button><div data-comments>{commentThreads.flatMap(row=>row.messages).map(row=>row.body).join('|')}</div><div data-suggestions>{suggestions.map(row=>row.id).join('|')}</div></div>}));
vi.mock('../presentation-editor',()=>({PresentationEditor:()=>null}));
vi.mock('../spreadsheet-editor',()=>({SpreadsheetEditor:()=>null}));
vi.mock('../presentation-presenter',()=>({PresentationPresenter:()=>null}));
vi.mock('../job-activity',()=>({OfficeJobActivity:()=>null}));
vi.mock('../office-card-preview',()=>({OfficeCardPreview:()=>null}));
vi.mock('@/lib/office/offline',()=>({loadOfflinePackage:vi.fn(async()=>null),listOfflineJournal:vi.fn(async()=>[]),appendOfflineCommand:vi.fn(async()=>{}),removeOfflinePackage:vi.fn(async()=>{}),removeOfflineJournalEntry:vi.fn(async()=>{}),classifyOfficeReconnect:vi.fn(),materializeOfflineRecoverySnapshot:vi.fn(),officeOfflineDeviceId:vi.fn(async()=>"fixture-device"),quarantineOfflineWork:vi.fn(async()=>{})}));
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const threads=[{id:'thread-a',artifactVersionId:'version-a',anchorKind:'block',anchor:{kind:'block',targetIds:['block-a']},status:'open',messages:[{id:'message-a',authorType:'user',body:'Protected server comment',mentions:[],createdAt:'2026-01-01T00:00:00Z'}]}];
const suggestions=[{id:'protected-suggestion',status:'open',commandBatch:{kind:'replaceTextRange'}}];
const response=(body:unknown,ttl='6000',status=200)=>new Response(JSON.stringify(body),{status,headers:{'X-Brian-Projection-Valid-For-Ms':ttl}});
const pending=()=>new Promise<Response>(()=>{});
let root:Root,host:HTMLDivElement;
beforeEach(()=>{vi.useFakeTimers();resetSurfaceCache();vi.clearAllMocks();state.viewer='viewer-a';state.workspace='workspace-a';state.status='connected';state.role='view';host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();resetSurfaceCache();vi.useRealTimers();});
function setup(ttl='800',suggestionTtl=ttl){state.fetch.mockImplementation(async(url:string)=>{
  if(url.includes('/workspaces/'))return response({members:[]});
  if(url.endsWith('/snapshot'))return response({snapshot:{...documentFixture(),workspaceId:state.workspace},seq:1,baseVersion:1});
  if(url.endsWith('/comments/detach-missing'))return response({detached:0});
  if(url.endsWith('/comments'))return response({threads},ttl);
  if(url.endsWith('/suggestions'))return response({suggestions},suggestionTtl);
  return response({artifact:{artifactId:uid(1),title:'Document',family:'document',role:state.role,version:1,lifecycleState:'active'}});
});}
async function render(){await act(async()=>root.render(<I18nProvider locale="en" dict={en}><OfficeEditorShell workspaceId={state.workspace} artifactId={uid(1)}/></I18nProvider>));}
async function click(label:string){await act(async()=>{const button=[...host.querySelectorAll('button')].find(row=>row.textContent===label||row.getAttribute('aria-label')===label);expect(button,`button ${label}`).toBeDefined();button!.click();});}
function input(value:string){act(()=>{const element=host.querySelector('textarea')!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));});}
const comments=()=>host.querySelector('[data-comments]')?.textContent;
const suggestionsText=()=>host.querySelector('[data-suggestions]')?.textContent;
const detachCalls=()=>state.fetch.mock.calls.filter(([url])=>url.endsWith('/comments/detach-missing'));
const commentReads=()=>state.fetch.mock.calls.filter(([url,init])=>url.endsWith('/comments')&&!init?.method);

describe('[COMP:app-web/office-editor-shell] bounded discussion decorations',()=>{
  it('expires decorations while panels are closed and keeps the document mounted',async()=>{
    setup();await render();expect(comments()).toContain('Protected server comment');expect(suggestionsText()).toContain('protected-suggestion');await click(en.office.collapseAssistantPanel);
    state.fetch.mockImplementation(pending);await act(async()=>vi.advanceTimersByTime(801));expect(comments()).toBe('');expect(suggestionsText()).toBe('');expect(host.querySelector('[data-editor]')).not.toBeNull();
  });
  it('expires comments independently from suggestions',async()=>{
    setup('400','800');await render();state.fetch.mockImplementation(pending);await act(async()=>vi.advanceTimersByTime(401));expect(comments()).toBe('');expect(suggestionsText()).toContain('protected-suggestion');await act(async()=>vi.advanceTimersByTime(400));expect(suggestionsText()).toBe('');
  });
  it('shares one read with each panel and retains current decorations when a panel closes',async()=>{
    setup('6000');await render();await click(en.office.comments);expect(commentReads()).toHaveLength(1);await click(en.office.suggestions);expect(state.fetch.mock.calls.filter(([url])=>url.endsWith('/suggestions'))).toHaveLength(1);await click(en.office.collapseAssistantPanel);expect(comments()).toContain('Protected server comment');expect(suggestionsText()).toContain('protected-suggestion');
  });
  it.each([401,403,404,409])('drops decorations on an authoritative %s renewal',async status=>{
    setup('6000');await render();state.fetch.mockImplementation(async()=>response({error:status===409?'office_projection_changed':'denied'},'0',status));await act(async()=>vi.advanceTimersByTime(3001));expect(host.textContent).not.toContain('Protected server comment');expect(host.textContent).not.toContain('protected-suggestion');
  });
  it.each(['viewer','workspace'] as const)('purges previous keys and refuses late collections after changing %s',async identity=>{
    setup('6000');await render();const prefix=officePanelCachePrefix(state.workspace,state.viewer);let finish!:(response:Response)=>void;
    state.fetch.mockImplementation((url:string)=>url.endsWith('/comments')?new Promise(resolve=>{finish=resolve;}):pending());await act(async()=>markSurfaceCacheStale(officePanelCacheKey(prefix,'comments',uid(1))!));
    state[identity]=`${identity}-b`;state.fetch.mockImplementation(pending);await render();await act(async()=>finish(response({threads})));
    expect(readSurfaceCache(officePanelCacheKey(prefix,'comments',uid(1))).data).toBeUndefined();expect(readSurfaceCache(officePanelCacheKey(prefix,'suggestions',uid(1))).data).toBeUndefined();expect(host.textContent).not.toContain('Protected server comment');
  });
  it('purges decorations immediately on a workspace authority event',async()=>{
    setup('6000');await render();state.fetch.mockImplementation(pending);await act(async()=>applySpineEventToSurfaceCache(WORKSPACE_IDENTITY_REFRESH_EVENT,{workspaceId:state.workspace},state.workspace));expect(host.textContent).not.toContain('Protected server comment');expect(host.textContent).not.toContain('protected-suggestion');
  });
  it('keeps local queued comments across closing the offline panel without retaining server comments after expiry',async()=>{
    state.status='disconnected';state.role='edit';setup();await render();await click('Select block');await click(en.office.comments);input('Local queued comment');await click(en.office.comment);expect(appendOfflineCommand).toHaveBeenCalledWith(expect.objectContaining({body:'Local queued comment'}),{workspaceId:state.workspace,userId:state.viewer});
    await click(en.office.collapseAssistantPanel);state.fetch.mockImplementation(pending);await act(async()=>vi.advanceTimersByTime(801));expect(comments()).toBe('Local queued comment');
    await click(en.office.comments);expect(host.textContent).toContain('Local queued comment');expect(host.textContent).not.toContain('Protected server comment');
  });
});

describe('[COMP:app-web/office-editor-shell] owned comment detachment',()=>{
  it('does not dispatch a delayed detach after its read expires',async()=>{
    state.role='edit';setup('400');await render();state.fetch.mockImplementation(pending);await act(async()=>vi.advanceTimersByTime(751));expect(detachCalls()).toHaveLength(0);
  });
  it.each(['expiry','viewer','workspace','role'] as const)('ignores a detach acknowledgement after losing %s',async reason=>{
    state.role='edit';setup('2000');await render();let finish!:(response:Response)=>void;const normal=state.fetch.getMockImplementation()!;
    state.fetch.mockImplementation((url:string,init:RequestInit)=>url.endsWith('/detach-missing')?new Promise(resolve=>{finish=resolve;}):normal(url,init));await act(async()=>vi.advanceTimersByTime(751));expect(detachCalls()).toHaveLength(1);
    state.fetch.mockImplementation(pending);
    if(reason==='expiry')await act(async()=>vi.advanceTimersByTime(1300));else if(reason==='role'){
      state.role='view';state.fetch.mockImplementation(normal);await act(async()=>markSurfaceCacheStale(officeArtifactCacheKey(state.workspace,uid(1),state.viewer)));state.fetch.mockImplementation(pending);
    }else{state[reason]=`${reason}-b`;await render();}
    const count=commentReads().length;await act(async()=>finish(response({detached:1})));expect(commentReads()).toHaveLength(count);
  });
  it('refreshes the shared read after a successful current detach',async()=>{
    state.role='edit';setup('6000');await render();const normal=state.fetch.getMockImplementation()!;
    state.fetch.mockImplementation((url:string,init:RequestInit)=>url.endsWith('/detach-missing')?Promise.resolve(response({detached:1})):url.endsWith('/comments')?Promise.resolve(response({threads:[]})):normal(url,init));
    await act(async()=>vi.advanceTimersByTime(751));expect(detachCalls()).toHaveLength(1);expect(commentReads()).toHaveLength(2);expect(comments()).toBe('');await click(en.office.comments);expect(commentReads()).toHaveLength(2);
  });
  it('drains an older read before the post-detach readback',async()=>{
    state.role='edit';setup('6000');await render();let finishOld!:(response:Response)=>void;let reads=0;const normal=state.fetch.getMockImplementation()!;
    state.fetch.mockImplementation((url:string,init:RequestInit)=>{
      if(url.endsWith('/detach-missing'))return Promise.resolve(response({detached:1}));
      if(url.endsWith('/comments')){reads++;return reads===1?new Promise(resolve=>{finishOld=resolve;}):Promise.resolve(response({threads:[]}));}
      return normal(url,init);
    });
    await act(async()=>markSurfaceCacheStale(officePanelCacheKey(officePanelCachePrefix(state.workspace,state.viewer),'comments',uid(1))!));
    await act(async()=>vi.advanceTimersByTime(751));expect(detachCalls()).toHaveLength(1);expect(reads).toBe(1);
    await act(async()=>finishOld(response({threads})));expect(reads).toBe(2);expect(comments()).toBe('');
  });

});
