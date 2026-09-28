// @vitest-environment jsdom
import {act,type ReactNode} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {en} from '@/lib/i18n/dictionaries/en';
import {WorkspaceContextProvider} from '@/lib/workspace-context';
import {resetSurfaceCache,readSurfaceCache} from '@/lib/surface-cache';
import {docMediaCacheKey} from '@/lib/surface-prefetch';
import {applySpineEventToSurfaceCache} from '@/lib/surface-cache-invalidation';
import {WORKSPACE_IDENTITY_REFRESH_EVENT} from '@/lib/workspace-identity-events';
import {FeedGenerationImage} from '@/components/feed/generation-placeholder';
import {PostMediaTray} from '@/components/feed/post-media-tray';
import {LinkedInPublishing} from '@/components/feed/linkedin-publishing';
import {ChatFileAttachments} from '@/components/chrome/chat-file-attachment';
import {importLegacyFeed} from '@use-brian/doc-model';
import type {FeedWorkingContent} from '@/lib/offline/feed-offline';

const {http}=vi.hoisted(()=>({http:vi.fn()}));
vi.mock('@/lib/auth-fetch',()=>({authFetch:http}));
vi.mock('@/lib/i18n/client',()=>({useT:()=>en,useLocale:()=> 'en'}));
vi.mock('@/lib/api/workspaces',()=>({updateWorkspacePickerPreferences:vi.fn(async()=>{})}));
vi.mock('@/contexts/feed-profiles-context',()=>({useFeedWorkspace:()=>({profiles:[]})}));
vi.mock('@/lib/api/feed-linkedin',()=>({linkedinDraftPath:()=> 'fixture',linkedinRequest:vi.fn(async()=>({sources:[],destinations:[],deliveries:[],receipt:null}))}));
vi.mock('@/lib/api/feed',()=>({exportFeedSessionArticle:vi.fn()}));
vi.mock('@/lib/feed-posts-events',()=>({notifyFeedPostsChanged:vi.fn()}));

const WS='11111111-1111-4111-8111-111111111111', FILE='22222222-2222-4222-8222-222222222222';
const bytes=(ttl='30000',blob=async()=>new Blob(['fixture'],{type:'image/png'}))=>({ok:true,headers:new Headers({'X-Brian-Media-Valid-For-Ms':ttl}),blob});
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};};
let root:Root,host:HTMLDivElement;
let click:ReturnType<typeof vi.spyOn>,errors:ReturnType<typeof vi.spyOn>;
const key=(viewer='viewer')=>docMediaCacheKey(WS,viewer,FILE);
const image=(fileId=FILE)=><FeedGenerationImage workspaceId={WS} fileId={fileId} alt="Generated fixture"/>;
const attachment=()=> <ChatFileAttachments attachments={[{workspaceId:WS,fileId:FILE,path:'/doc/fixture.png',name:'fixture.png',mime:'image/png',sizeBytes:7}]}/>;
async function render(node:ReactNode,viewer='viewer',workspaceId=WS){
  await act(async()=>root.render(<WorkspaceContextProvider value={{workspaceId,name:'Fixture',role:'member',clearance:'internal',me:{id:viewer}}}>{node}</WorkspaceContextProvider>));
}
async function download(){await act(async()=>host.querySelector<HTMLButtonElement>('.group\\/file')!.click());}
function invalidate(){applySpineEventToSurfaceCache(WORKSPACE_IDENTITY_REFRESH_EVENT,{workspaceId:WS},WS);}

beforeEach(()=>{
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
  resetSurfaceCache();http.mockReset();http.mockResolvedValue(bytes());
  let sequence=0;
  vi.stubGlobal('URL',class extends URL{static createObjectURL=vi.fn(()=>`blob:fixture-${++sequence}`);static revokeObjectURL=vi.fn();});
  click=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});
  errors=vi.spyOn(console,'error').mockImplementation(()=>{});
  host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(()=>{act(()=>root.unmount());host.remove();resetSurfaceCache();vi.useRealTimers();click.mockRestore();errors.mockRestore();vi.unstubAllGlobals();});

describe('[COMP:app-web/doc-file-url] durable consumer admission',()=>{
  it('shares one current byte admission across generated, tray and LinkedIn previews',async()=>{
    const media=[{fileId:FILE,mimeType:'image/png' as const,alt:'Linked fixture'}];
    const content:FeedWorkingContent={title:'Fixture',text:'Fixture',privateBrief:'',postFormat:'post',threadSegments:[],article:{sourceUrl:'',title:'',description:''},media,schemaVersion:2,composition:importLegacyFeed({text:'Fixture',postFormat:'post',threadSegments:[],media}),linkedin:{version:1,mode:'post',authorKind:'person',destinationId:null}};
    await render(<>{image()}<PostMediaTray workspaceId={WS} platform="linkedin" media={media} readOnly onChange={()=>{}}/><LinkedInPublishing workspaceId={WS} workspaceName="Fixture" assistantId="assistant" sessionId="session" revision={1} content={content} ready readOnly disabled={false} onCommand={async()=>true} onPreview={()=>{}} onPromotion={async()=>{}} onRefresh={()=>{}}/></>);
    expect(host.querySelectorAll('img')).toHaveLength(3);
    expect(new Set([...host.querySelectorAll('img')].map(img=>img.src))).toEqual(new Set(['blob:fixture-1']));
    expect(http).toHaveBeenCalledOnce();
    http.mockResolvedValue({ok:false,status:403});
    await act(async()=>invalidate());
    expect(host.querySelectorAll('img')).toHaveLength(0);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fixture-1');
  });
  it('withholds expired generated images while renewal is pending',async()=>{
    vi.useFakeTimers();http.mockResolvedValueOnce(bytes('1000')).mockImplementation(()=>new Promise(()=>{}));
    await render(image());expect(host.querySelector('img')).not.toBeNull();
    await act(async()=>vi.advanceTimersByTimeAsync(1001));
    expect(host.querySelector('img')).toBeNull();expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fixture-1');
  });
  it('clears previews immediately when the viewer changes and discards the old late read',async()=>{
    const first=deferred<Blob>();http.mockResolvedValueOnce(bytes('30000',()=>first.promise)).mockResolvedValue({ok:false,status:403});
    await render(image());await render(image(),'other-viewer');
    await act(async()=>first.resolve(new Blob(['late'],{type:'image/png'})));
    expect(host.querySelector('img')).toBeNull();expect(readSurfaceCache(key()).data).toBeUndefined();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fixture-1');
  });
  it('does not paint the previous file while the replacement is pending',async()=>{
    await render(image());http.mockImplementation(()=>new Promise(()=>{}));
    await render(image('replacement'));expect(host.querySelector('img')).toBeNull();expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fixture-1');
  });
});

describe('[COMP:app-web/chat-file-attachment] current-authority downloads',()=>{
  it('does not prefetch attachments and downloads only after a fresh current read',async()=>{
    await render(attachment());expect(http).not.toHaveBeenCalled();
    await download();expect(http).toHaveBeenCalledOnce();expect(click).toHaveBeenCalledOnce();
    const anchor=click.mock.instances[0] as HTMLAnchorElement;
    expect(anchor.download).toBe('fixture.png');expect(anchor.href).toBe('blob:fixture-1');
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });
  it.each(['scope','viewer','workspace','unmount','focus','visibility','logout','identity-round-trip'] as const)('cancels a late download after %s changes',async change=>{
    const body=deferred<Blob>();http.mockResolvedValue(bytes('30000',()=>body.promise));
    await render(attachment());await download();
    await act(async()=>{
      if(change==='scope')invalidate();
      if(change==='focus')window.dispatchEvent(new Event('focus'));
      if(change==='visibility')document.dispatchEvent(new Event('visibilitychange'));
      if(change==='logout')resetSurfaceCache();
    });
    if(change==='viewer')await render(attachment(),'other-viewer');
    if(change==='workspace')await render(attachment(),'viewer','another-workspace');
    if(change==='unmount')await render(null);
    if(change==='identity-round-trip'){await render(attachment(),'other-viewer');await render(attachment());}
    await act(async()=>body.resolve(new Blob(['late'],{type:'image/png'})));
    expect(click).not.toHaveBeenCalled();expect(readSurfaceCache(key()).data).toBeUndefined();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fixture-1');
  });
  it('refuses a download whose byte transfer consumes its entire admission lifetime',async()=>{
    vi.useFakeTimers();const body=deferred<Blob>();http.mockResolvedValue(bytes('100',()=>body.promise));
    await render(attachment());await download();await act(async()=>vi.advanceTimersByTimeAsync(101));
    await act(async()=>body.resolve(new Blob(['late'])));
    expect(click).not.toHaveBeenCalled();expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('never substitutes a cached display when the fresh download is denied',async()=>{
    await render(<>{image()}{attachment()}</>);expect(host.querySelector('img')).not.toBeNull();
    http.mockResolvedValue({ok:false,status:404});await download();
    expect(click).not.toHaveBeenCalled();expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain(en.chat.fileAttachments.downloadFailed);
  });
  it('does not invalidate another preview immediately after a successful download',async()=>{
    await render(<>{image()}{attachment()}</>);await download();
    expect(http).toHaveBeenCalledTimes(2);expect(click).toHaveBeenCalledOnce();
    expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:fixture-2');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fixture-1');
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:fixture-2');
  });
});
