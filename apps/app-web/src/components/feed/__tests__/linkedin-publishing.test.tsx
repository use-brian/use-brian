// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {feedParagraph} from '@use-brian/doc-model';
import {en} from '@/lib/i18n/dictionaries/en';
import {ja} from '@/lib/i18n/dictionaries/ja';
import {zh} from '@/lib/i18n/dictionaries/zh';
import {zhCN} from '@/lib/i18n/dictionaries/zh-cn';
import {LinkedInPublishing} from '../linkedin-publishing';
import type {FeedWorkingContent} from '@/lib/offline/feed-offline';
const mocks=vi.hoisted(()=>({request:vi.fn(),confirm:vi.fn(async(_options:any)=>false),copy:vi.fn(),resolve:vi.fn(async()=>'/fixture.png')}));
vi.mock('@/lib/i18n/client',()=>({useT:()=>en,useLocale:()=> 'ja'}));
vi.mock('@/lib/api/feed-linkedin',()=>({linkedinRequest:mocks.request,linkedinDraftPath:()=> 'fixture'}));
vi.mock('@/lib/api/feed',()=>({exportFeedSessionArticle:vi.fn(async()=>new Blob(['archive']))}));
import {exportFeedSessionArticle} from '@/lib/api/feed';
vi.mock('@/lib/use-doc-media',()=>({useDocMediaSrc:()=>'/fixture.png'}));
vi.mock('@/components/ui/confirm-dialog',()=>({confirmDialog:mocks.confirm}));
vi.mock('@/lib/feed-posts-events',()=>({notifyFeedPostsChanged:vi.fn()}));
vi.mock('@/components/ui/searchable-select',()=>({SearchableSelect:(p:any)=><div aria-label={p['aria-label']}>{p.items.map((item:any)=><button key={item.value} disabled={p.disabled} onClick={()=>p.onValueChange(item.value)}>{item.label}</button>)}</div>}));
let root:Root,host:HTMLDivElement;
function content():FeedWorkingContent{return {title:'Edition',privateBrief:'',text:'Hello',postFormat:'post',threadSegments:[],article:{sourceUrl:'',title:'',description:''},media:[],schemaVersion:2,composition:{version:1,segments:[{id:crypto.randomUUID(),content:[{type:'paragraph',attrs:{id:crypto.randomUUID()},content:[{type:'text',text:'Hello',marks:[{type:'bold'}]}]}]}]},linkedin:{version:1,mode:'post',destinationId:null,authorKind:'person'}};}
const targetId='11111111-1111-4111-8111-111111111111';
const handlers=()=>({onCommand:vi.fn(async()=>true),onPreview:vi.fn(),onPromotion:vi.fn(async()=>{}),onRefresh:vi.fn()});
async function render(value:FeedWorkingContent,h=handlers()){await act(async()=>root.render(<LinkedInPublishing {...h} workspaceId="workspace" workspaceName="Orchard workspace" assistantId="assistant" sessionId="session" revision={3} content={value} ready disabled={false}/>));return h;}
const button=(label:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent===label)!;
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement('div');document.body.append(host);root=createRoot(host);Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:mocks.copy}});mocks.confirm.mockReset();mocks.confirm.mockResolvedValue(false);mocks.request.mockReset();mocks.request.mockImplementation(async(path:string)=>path.includes('destinations')?{destinations:[{destinationId:targetId,authorKind:'organization',displayName:'Orchard Page',connectionStatus:'active',canPublishAs:true,capabilities:{post:true,link_post:true,newsletter_edition:false}}]}:path.includes('receipt')?{receipt:null}:path.includes('sources')?{sources:[]}:{hash:'a'.repeat(64)});});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
describe('[COMP:app-web/feed-linkedin-publishing] explicit intent and operator flow',()=>{
 it('chooses an explicit Page with the canonical command and shows converted text and loss',async()=>{const h=await render(content());expect(host.textContent).toContain('Hello');expect(host.textContent).toContain(en.feedLinkedIn.formatting_loss);await act(async()=>button('Orchard Page').click());expect(h.onCommand).toHaveBeenCalledWith([{kind:'linkedin',metadata:{version:1,mode:'post',destinationId:targetId,authorKind:'organization',authorDisplay:'Orchard Page'}}]);expect(mocks.confirm).not.toHaveBeenCalled();});
 it('shows media/link conflicts and blocks publication preview',async()=>{const c=content();c.linkedin!.mode='link_post';c.article={sourceUrl:'https://example.com',title:'Title',description:''};c.composition!.segments[0]!.content.push({type:'image',attrs:{id:crypto.randomUUID(),fileId:crypto.randomUUID(),mimeType:'image/png',alt:'Orchard',placement:'attachment'}});const h=await render(c);expect(host.textContent).toContain(en.feedLinkedIn.blocked);expect(h.onPreview).toHaveBeenLastCalledWith({hash:null,blocked:true});});
 it('retains the draft and reports reconnect and personal permission denial',async()=>{mocks.request.mockImplementation(async(path:string)=>path.includes('destinations')?{destinations:[{destinationId:targetId,authorKind:'person',displayName:'Writer',connectionStatus:'reconnect_required',canPublishAs:false,capabilities:{post:false,link_post:false,newsletter_edition:false}}]}:path.includes('receipt')?{receipt:null}:{sources:[]});const c=content();c.linkedin!.destinationId=targetId;await render(c);expect(host.textContent).toContain(en.feedLinkedIn.reconnect);expect(host.textContent).toContain(en.feedLinkedIn.denied);expect(host.textContent).toContain('Hello');});
 it('labels newsletter preparation as manual and copies without publishing',async()=>{const c=content();c.linkedin={version:1,mode:'newsletter_edition',destinationId:null,authorKind:'person',newsletter:{name:'Field notes',url:'https://www.linkedin.com/newsletters/123',editionTitle:'Edition'}};await render(c);expect(host.textContent).toContain(en.feedLinkedIn.manualHelp);expect(button(en.feedLinkedIn.prepare)).toBeTruthy();expect(host.querySelector('a[href="https://www.linkedin.com/article/new/"]')).toBeTruthy();await act(async()=>button(en.feedLinkedIn.copyText).click());expect(mocks.copy).toHaveBeenCalledWith('Hello');expect(mocks.request.mock.calls.some(([path])=>String(path).includes('published'))).toBe(false);});
 it('offers a separate promotion only for an observed receipt',async()=>{mocks.request.mockImplementation(async(path:string)=>path.includes('receipt')?{receipt:{url:'https://www.linkedin.com/pulse/story',revision:3}}:path.includes('destinations')?{destinations:[]}:{sources:[]});const h=await render(content());expect(h.onPromotion).not.toHaveBeenCalled();await act(async()=>button(en.feedLinkedIn.promotion).click());expect(h.onPromotion).toHaveBeenCalledWith('https://www.linkedin.com/pulse/story');});
 it('names the workspace in connect consent before requesting OAuth',async()=>{await render(content());await act(async()=>button(en.feedLinkedIn.connectPerson).click());expect(mocks.confirm.mock.calls.at(-1)?.[0].description).toContain('Orchard workspace');expect(mocks.request.mock.calls.some(([path])=>String(path).includes('oauth/authorize'))).toBe(false);});
 it('prepares a ZIP and records publication only after the operator supplies an edition URL',async()=>{
  const c=content();c.linkedin={version:1,mode:'newsletter_edition',destinationId:null,authorKind:'person',newsletter:{name:'Field notes',url:'https://www.linkedin.com/newsletters/123',editionTitle:'Edition'}};
  Object.defineProperty(URL,'createObjectURL',{configurable:true,value:vi.fn(()=> 'blob:fixture')});Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:vi.fn()});const click=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});
  const h=await render(c);await act(async()=>button(en.feedLinkedIn.prepare).click());expect(exportFeedSessionArticle).toHaveBeenCalledWith('assistant','session',3,false);expect(mocks.request.mock.calls.some(([path])=>String(path).includes('published'))).toBe(false);
  const url='https://www.linkedin.com/pulse/fixture-edition';mocks.confirm.mockImplementation(async options=>{const children=options.content.props.children;children.find((child:any)=>child?.type==='input').props.onChange({target:{value:url}});return true});
  mocks.request.mockImplementation(async(path:string)=>path.endsWith('/confirmation')?{confirmationId:'fixture-confirmation'}:path.endsWith('/linkedin-published')?{receipt:{url,revision:3}}:{});
  await act(async()=>button(en.feedLinkedIn.markPublished).click());expect(h.onCommand).toHaveBeenCalledWith([{kind:'release',audience:'public'}]);expect(mocks.request).toHaveBeenCalledWith('fixture/confirmation',expect.objectContaining({locale:'ja',expectedRevision:3}));expect(mocks.request).toHaveBeenCalledWith('fixture/linkedin-published',expect.objectContaining({url,confirmationId:'fixture-confirmation',expectedRevision:3}));expect(host.querySelector(`a[href="${url}"]`)).toBeTruthy();click.mockRestore();
 });
 it('ships the same complete locale shape without banned punctuation',()=>{for(const dictionary of [ja,zh,zhCN])expect(Object.keys(dictionary.feedLinkedIn).sort()).toEqual(Object.keys(en.feedLinkedIn).sort());for(const dictionary of [en,ja,zh,zhCN])expect(JSON.stringify(dictionary.feedLinkedIn)).not.toContain('—');});
});
