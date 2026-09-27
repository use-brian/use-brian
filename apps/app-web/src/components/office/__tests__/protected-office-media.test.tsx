// @vitest-environment jsdom
import {act,type ReactNode} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {WorkspaceContextProvider} from '@/lib/workspace-context';
import {I18nProvider} from '@/lib/i18n/client';
import {en} from '@/lib/i18n/dictionaries/en';
import {resetSurfaceCache,readSurfaceCache} from '@/lib/surface-cache';
import {officeMediaCacheKey} from '@/lib/surface-prefetch';
import {applySpineEventToSurfaceCache} from '@/lib/surface-cache-invalidation';
import {WORKSPACE_IDENTITY_REFRESH_EVENT} from '@/lib/workspace-identity-events';
import {useOfficeResourceUrls} from '@/lib/use-doc-media';
import {OfficeCardPreviewCanvas} from '../office-card-preview';
import {DocumentEditor} from '../document-editor';
import {SpreadsheetEditor} from '../spreadsheet-editor';
import {documentFixture,presentationFixture,spreadsheetFixture,uid} from './editor-fixtures';
const {http}=vi.hoisted(()=>({http:vi.fn()}));
vi.mock('@/lib/auth-fetch',()=>({authFetch:http}));
vi.mock('@/lib/api/workspaces',()=>({updateWorkspacePickerPreferences:vi.fn(async()=>{})}));
const bytes=(ttl='30000',blob=async()=>new Blob(['fixture'],{type:'image/png'}))=>({ok:true,headers:new Headers({'X-Brian-Media-Valid-For-Ms':ttl}),blob});
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};};
let root:Root,host:HTMLDivElement;
const document=documentFixture(),presentation=presentationFixture(),sheet=spreadsheetFixture();
sheet.worksheets[0].images.push({id:uid(96),resourceId:uid(50),altText:'Fixture image',decorative:false,from:{row:1,column:0},to:{row:2,column:1}});
document.sections[0].headerImage={resourceId:uid(50),altText:'Fixture header',decorative:false,widthPt:100,heightPt:40};
const surfaces={
  documentCard:()=> <OfficeCardPreviewCanvas snapshot={document}/>,
  presentationCard:()=> <OfficeCardPreviewCanvas snapshot={presentation}/>,
  spreadsheetCard:()=> <OfficeCardPreviewCanvas snapshot={sheet}/>,
  documentEditor:()=> <DocumentEditor snapshot={document} baseVersion={1} role="edit" suggestMode={false} onCommand={()=>{}}/>,
  spreadsheetEditor:()=> <SpreadsheetEditor snapshot={sheet} baseVersion={1} role="edit" suggestMode={false} onCommand={()=>{}}/>,
};
async function render(node:ReactNode,viewer='viewer',workspaceId=uid(2)) {
  await act(async()=>root.render(<WorkspaceContextProvider value={{workspaceId,name:'Fixture',role:'member',clearance:'internal',me:{id:viewer}}}><I18nProvider locale="en" dict={en}>{node}</I18nProvider></WorkspaceContextProvider>));
}
const key=(viewer='viewer')=>officeMediaCacheKey(uid(2),viewer,uid(1),[uid(50)]);
function Probe({ids=[uid(50)]}:{ids?:string[]}){const {urls}=useOfficeResourceUrls(uid(1),ids);return <span>{JSON.stringify(urls)}</span>;}
beforeEach(()=>{
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
  resetSurfaceCache();http.mockReset();http.mockResolvedValue(bytes());
  let sequence=0;vi.stubGlobal('URL',class extends URL{static createObjectURL=vi.fn(()=>`blob:fixture-${++sequence}`);static revokeObjectURL=vi.fn();});
  host=window.document.createElement('div');window.document.body.append(host);root=createRoot(host);
});
afterEach(()=>{act(()=>root.unmount());host.remove();resetSurfaceCache();vi.useRealTimers();vi.unstubAllGlobals();});
describe('[COMP:app-web/doc-file-url] protected Office resource consumers',()=>{
  it.each(Object.entries(surfaces))('renders and expires %s through real media hooks',async(_name,view)=>{
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date','performance']});http.mockResolvedValue(bytes('200'));
    await render(view());expect(host.innerHTML).toContain('blob:fixture-1');
    expect(http).toHaveBeenCalledWith(expect.stringContaining(`/api/office/artifacts/${uid(1)}/resources/${uid(50)}?workspaceId=${uid(2)}`),{cache:'no-store'});
    http.mockResolvedValue({ok:false,status:404});await act(async()=>vi.advanceTimersByTimeAsync(201));
    expect(host.innerHTML).not.toContain('blob:fixture');expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fixture-1');
  });
  it('shares the resource admission across separate renderer consumers',async()=>{
    await render(<>{surfaces.documentCard()}{surfaces.presentationCard()}{surfaces.spreadsheetEditor()}</>);
    expect(http).toHaveBeenCalledTimes(1);expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });
  it.each(['viewer','workspace','focus','visibility','authority'] as const)('clears old bytes on %s change while replacement is pending',async change=>{
    await render(surfaces.presentationCard());http.mockImplementation(()=>new Promise(()=>{}));
    if(change==='viewer')await render(surfaces.presentationCard(),'replacement');
    else if(change==='workspace')await render(surfaces.presentationCard(),'viewer',uid(999));
    else await act(async()=>{
      if(change==='authority')applySpineEventToSurfaceCache(WORKSPACE_IDENTITY_REFRESH_EVENT,{workspaceId:uid(2)},uid(2));
      if(change==='focus')window.dispatchEvent(new Event('focus'));
      if(change==='visibility'){Object.defineProperty(window.document,'visibilityState',{configurable:true,value:'visible'});window.document.dispatchEvent(new Event('visibilitychange'));}
    });
    expect(host.innerHTML).not.toContain('blob:fixture');expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fixture-1');
  });
  it('disposes a late old-viewer response without painting it',async()=>{
    const body=deferred<Blob>();http.mockResolvedValueOnce(bytes('30000',()=>body.promise));
    await render(surfaces.presentationCard());http.mockImplementation(()=>new Promise(()=>{}));
    await render(surfaces.presentationCard(),'replacement');
    await act(async()=>body.resolve(new Blob(['late'],{type:'image/png'})));
    expect(host.innerHTML).not.toContain('blob:fixture');expect(readSurfaceCache(key()).data).toBeUndefined();expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fixture-1');
  });
  it('keeps authorized images while removing a denied image from a set',async()=>{
    http.mockImplementation((url:string)=>Promise.resolve(url.includes(uid(51))?{ok:false,status:404}:bytes()));
    await render(<Probe ids={[uid(50),uid(51)]}/>);
    expect(host.textContent).toContain(uid(50));expect(host.textContent).not.toContain(uid(51));
  });
  it('binds simultaneous document node views to their own artifact',async()=>{
    const other={...document,artifactId:uid(999)};
    await render(<>{surfaces.documentEditor()}<DocumentEditor snapshot={other} baseVersion={1} role="edit" suggestMode={false} onCommand={()=>{}}/></>);
    const paths=http.mock.calls.map(([url])=>url);
    expect(paths.some(path=>path.includes(`/artifacts/${uid(1)}/`))).toBe(true);
    expect(paths.some(path=>path.includes(`/artifacts/${uid(999)}/`))).toBe(true);
  });
});
