// @vitest-environment jsdom
import {act,type ReactNode} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {WorkspaceContextProvider} from '@/lib/workspace-context';
import {en} from '@/lib/i18n/dictionaries/en';
import {resetSurfaceCache,readSurfaceCache} from '@/lib/surface-cache';
import {fileCacheMediaCacheKey} from '@/lib/surface-prefetch';
import {applySpineEventToSurfaceCache} from '@/lib/surface-cache-invalidation';
import {WORKSPACE_IDENTITY_REFRESH_EVENT} from '@/lib/workspace-identity-events';
import {MessageAttachments} from '../message-attachment-card';
import {BlockImage} from '../block-image';
import {useFileCacheMedia} from '@/lib/use-doc-media';
const {http}=vi.hoisted(()=>({http:vi.fn()}));
vi.mock('@/lib/auth-fetch',()=>({authFetch:http}));
vi.mock('@/lib/i18n/client',()=>({useT:()=>en,useLocale:()=> 'en'}));
vi.mock('@/lib/api/workspaces',()=>({updateWorkspacePickerPreferences:vi.fn(async()=>{})}));
const WS='11111111-1111-4111-8111-111111111111',FILE='22222222-2222-4222-8222-222222222222';
const bytes=(ttl='30000',body=async()=>new Blob(['fixture'],{type:'application/pdf'}))=>({ok:true,headers:new Headers({'X-Brian-Media-Valid-For-Ms':ttl}),blob:body});
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done});return {promise,resolve};};
let root:Root,host:HTMLDivElement;
async function render(node:ReactNode,userId='viewer',workspaceId=WS){await act(async()=>root.render(<WorkspaceContextProvider value={{workspaceId,name:'Fixture',role:'member',clearance:'internal',me:{id:userId}}}>{node}</WorkspaceContextProvider>));}
const card=()=> <MessageAttachments workspaceId={WS} attachments={[{id:FILE,name:'fixture.docx',mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}]}/>;
const legacy=()=> <BlockImage workspaceId={WS} blockId="image" block={{kind:'image',id:'image',ref:{bucket:'file_cache',path:FILE,mimeType:'image/png',sizeBytes:7,name:'fixture.png'}}}/>;
const invalidate=()=>applySpineEventToSurfaceCache(WORKSPACE_IDENTITY_REFRESH_EVENT,{workspaceId:WS},WS);
beforeEach(()=>{(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;resetSurfaceCache();http.mockReset();http.mockResolvedValue(bytes());let id=0;vi.stubGlobal('URL',class extends URL{static createObjectURL=vi.fn(()=>`blob:fixture-${++id}`);static revokeObjectURL=vi.fn()});host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();resetSurfaceCache();vi.useRealTimers();vi.unstubAllGlobals();});
async function open(){await act(async()=>host.querySelector<HTMLButtonElement>('button')!.click());}
describe('[COMP:app-web/message-attachment-card] protected remote PDF',()=>{
 it('fetches only on open and removes the iframe/download after scope invalidation',async()=>{
  await render(card());expect(http).not.toHaveBeenCalled();await open();
  expect(document.querySelector('iframe')?.getAttribute('src')).toBe('blob:fixture-1');
  expect(document.querySelector('a[download]')?.getAttribute('href')).toBe('blob:fixture-1');
  expect(http).toHaveBeenCalledWith(expect.stringContaining('/preview-pdf?workspaceId='+WS),{cache:'no-store'});
  http.mockResolvedValue({ok:false,status:404});await act(async()=>invalidate());
  expect(document.querySelector('iframe')).toBeNull();expect(document.querySelector('a[download]')).toBeNull();
  expect(document.body.textContent).toContain(en.attachments.previewUnavailable);expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fixture-1');
 });
 it.each(['viewer','workspace','close'] as const)('discards a late PDF on %s change',async change=>{
  const body=deferred<Blob>();http.mockResolvedValueOnce(bytes('30000',()=>body.promise)).mockResolvedValue({ok:false,status:404});
  await render(card());await open();
  if(change==='viewer')await render(card(),'other-viewer');
  if(change==='workspace')await render(card(),'viewer','other-workspace');
  if(change==='close')await act(async()=>document.querySelector<HTMLButtonElement>('button[aria-label="'+en.attachments.close+'"]')!.click());
  await act(async()=>body.resolve(new Blob(['late'],{type:'application/pdf'})));
  expect(document.querySelector('iframe')).toBeNull();expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fixture-1');
  expect(readSurfaceCache(fileCacheMediaCacheKey(WS,'viewer',FILE,'pdf')).data).toBeUndefined();
 });
 it('removes a remote PDF at expiry while renewal is pending',async()=>{
  vi.useFakeTimers();http.mockResolvedValueOnce(bytes('1000')).mockImplementation(()=>new Promise(()=>{}));
  await render(card());await open();expect(document.querySelector('iframe')).not.toBeNull();
  await act(async()=>vi.advanceTimersByTimeAsync(1001));
  expect(document.querySelector('iframe')).toBeNull();expect(document.querySelector('a[download]')).toBeNull();expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fixture-1');
 });
});
describe('[COMP:app-web/doc-file-url] temporary media cache',()=>{
 it('withholds a legacy image after current authority changes',async()=>{
  await render(legacy());expect(host.querySelector('img')).not.toBeNull();
  expect(http).toHaveBeenCalledWith(expect.stringContaining('/preview?workspaceId='+WS),{cache:'no-store'});
  http.mockResolvedValue({ok:false,status:403});await act(async()=>invalidate());expect(host.querySelector('img')).toBeNull();expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fixture-1');
 });
 it('keeps original and PDF representations separate but deduplicates each',async()=>{
  function Media({pdf=false}:{pdf?:boolean}){const media=useFileCacheMedia(WS,FILE,pdf?'pdf':'original');return media.url?<img alt={pdf?'pdf':'original'} src={media.url}/>:null;}
  await render(<><Media/><Media/><Media pdf/><Media pdf/></>);
  expect(http).toHaveBeenCalledTimes(2);expect(host.querySelectorAll('img')).toHaveLength(4);
  expect(new Set([...host.querySelectorAll('img')].map(img=>img.src)).size).toBe(2);
  http.mockResolvedValue({ok:false,status:404});await act(async()=>invalidate());
  expect(host.querySelectorAll('img')).toHaveLength(0);expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
 });
});
