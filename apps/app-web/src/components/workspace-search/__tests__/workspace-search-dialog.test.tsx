// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n/client'
import { en } from '@/lib/i18n/dictionaries/en'
import { WorkspaceSearchDialog } from '../workspace-search-dialog'
import { WorkspaceSearchProvider, WorkspaceSearchSlot, WorkspaceSearchFallback } from '../workspace-search-provider'
import type { WorkspaceSearchResponse, WorkspaceSearchItem } from '@use-brian/shared'
const mocks=vi.hoisted(()=>({search:vi.fn(),preview:vi.fn(),push:vi.fn(),stash:vi.fn(),roster:vi.fn(),path:'/w/ws/p',close:vi.fn()}))
vi.mock('next/navigation',()=>({useRouter:()=>({push:mocks.push}),usePathname:()=>mocks.path}))
vi.mock('@/lib/workspace-context',()=>({useWorkspaceContext:()=>({name:'Fixture workspace'})}))
vi.mock('@/contexts/primary-assistant',()=>({usePrimaryAssistant:()=>({assistantId:'assistant',resolved:true})}))
vi.mock('@/lib/api/views',()=>({listWorkspaceAssistants:mocks.roster}))
vi.mock('@/lib/api/workspace-search',()=>({searchWorkspace:mocks.search,previewWorkspaceSearchItem:mocks.preview}))
vi.mock('@/lib/active-assistant',()=>({readActiveAssistantId:()=>null,resolveDraftAssistantId:()=> 'assistant'}))
vi.mock('@/lib/chat-handoff',()=>({stashChatHandoff:mocks.stash,personalChatHandoffPath:()=>'/w/ws/chat?v=personal&assistant=assistant'}))
vi.mock('@/lib/surface-cache-invalidation',()=>({SURFACE_CACHE_SPINE_EVENTS:['sidan:brain-refresh','brian:organization-changed']}))
const strong:WorkspaceSearchItem={key:'task:1',id:'1',kind:'tasks',title:'Atlas',snippet:'<img src=x onerror=alert(1)>',source:'tasks',match:'exact',target:{type:'brain',id:'1',primitive:'tasks'}}
let host:HTMLDivElement,root:Root
const response=(items:WorkspaceSearchItem[]=[],completeness:'complete'|'partial'='complete'):WorkspaceSearchResponse=>({items,completeness,nextCursor:null,unavailableFamilies:completeness==='partial'?['office']:[]})
const tick=async()=>{await act(async()=>{await new Promise(resolve=>setTimeout(resolve,230))})}
function render(node:React.ReactNode){act(()=>root.render(<I18nProvider locale="en" dict={en}>{node}</I18nProvider>))}
async function type(text:string){const input=document.querySelector<HTMLInputElement>('[data-workspace-search-input]')!;act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,text);input.dispatchEvent(new Event('input',{bubbles:true}))});await tick();return input}
function key(input:HTMLElement,name:string,extra:KeyboardEventInit={}){act(()=>{input.dispatchEvent(new KeyboardEvent('keydown',{key:name,bubbles:true,cancelable:true,...extra}))})}
beforeEach(()=>{
  (globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true
  host=document.createElement('div');document.body.append(host);root=createRoot(host);vi.clearAllMocks()
  mocks.path='/w/ws/p';mocks.stash.mockReturnValue('request-id');mocks.roster.mockResolvedValue([{id:'assistant',name:'Fixture assistant'}]);mocks.search.mockResolvedValue(response());mocks.preview.mockResolvedValue({...strong,text:'Authorized detail'})
})
afterEach(()=>{act(()=>root.unmount());host.remove()})
describe('[COMP:app-web/workspace-search] persistent modal behavior',()=>{
  it('places labelled workspace context above main navigation and removes the page-only search',()=>{
    const source=readFileSync('src/components/doc/doc-sidebar.tsx','utf8')
    const nav=source.slice(source.indexOf('<nav data-doc-chrome'),source.indexOf('</nav>',source.indexOf('<nav data-doc-chrome')))
    const context=source.slice(source.indexOf('<div data-doc-chrome data-workspace-context-nav'),source.indexOf('<nav data-doc-chrome'))
    expect(context).toContain('/projects');expect(context).toContain('/organization')
    expect(context).not.toContain('PhoneNavLabel')
    expect(nav).not.toContain('/organization');expect(nav).not.toContain('/projects')
    expect((source.match(/href=\{`\/w\/\$\{workspaceId\}\/organization`\}/g)??[]).length).toBe(1)
    expect(source).not.toContain('searchOpen');expect(source).not.toContain('EmptySearchResults')
    for(const header of ['brain/brain-topbar','doc/doc-topbar','operator/operator-topbar','studio/studio-topbar','workflow/workflow-topbar']) {
      const code=readFileSync(`src/components/${header}.tsx`,'utf8')
      expect(code).toContain('<WorkspaceSearchSlot />')
    }
  })
  it('autofocuses, escapes previews, selects a strong hit and Enter opens without sending',async()=>{
    mocks.search.mockResolvedValue(response([strong]));render(<WorkspaceSearchDialog workspaceId="ws" open onClose={mocks.close}/>);await tick()
    const input=await type('Atlas');expect(document.activeElement).toBe(input)
    expect(input.getAttribute('aria-activedescendant')).toContain('task%3A1');expect(document.querySelector('img')).toBeNull()
    key(input,'Enter');await tick();expect(mocks.push).toHaveBeenCalledWith('/w/ws/brain?row=1');expect(mocks.stash).not.toHaveBeenCalled()
  })
  it('defaults a weak-only complete result to Ask and keeps weak results selectable',async()=>{
    mocks.search.mockResolvedValue(response([{...strong,match:'body'}]));render(<WorkspaceSearchDialog workspaceId="ws" open onClose={mocks.close}/>)
    const input=await type('question');expect(input.getAttribute('aria-activedescendant')).toContain('ask');expect(document.body.textContent).toContain('Atlas')
    key(input,'ArrowUp');expect(input.getAttribute('aria-activedescendant')).toContain('task%3A1');key(input,'ArrowDown');key(input,'Enter');await tick()
    expect(mocks.stash).toHaveBeenCalledTimes(1);expect(mocks.stash.mock.calls[0][0]).toMatchObject({text:'question',assistantId:'assistant'});expect(mocks.push.mock.calls[0][0]).not.toContain('question')
  })
  it.each(['partial','error','loading'] as const)('never defaults failure/pending %s to Ask',async state=>{
    if(state==='error')mocks.search.mockRejectedValue(new Error('failure'));else if(state==='loading')mocks.search.mockImplementation(()=>new Promise(()=>{}));else mocks.search.mockResolvedValue(response([],state))
    render(<WorkspaceSearchDialog workspaceId="ws" open onClose={mocks.close}/>);const input=await type('question');key(input,'Enter');await tick();expect(mocks.stash).not.toHaveBeenCalled();expect(input.value).toBe('question')
  })
  it('ignores IME and repeats and explicit Close never sends',async()=>{
    render(<WorkspaceSearchDialog workspaceId="ws" open onClose={mocks.close}/>);const input=await type('question');key(input,'Enter',{isComposing:true});key(input,'Enter',{repeat:true})
    act(()=>document.querySelector<HTMLButtonElement>('[aria-label="Close search"]')!.click());expect(mocks.close).toHaveBeenCalled();expect(mocks.stash).not.toHaveBeenCalled()
  })
  it('aborts and rejects old query responses and clears rows immediately on privacy events',async()=>{
    let oldResolve!:(value:WorkspaceSearchResponse)=>void
    mocks.search.mockImplementationOnce(()=>new Promise(resolve=>{oldResolve=resolve})).mockResolvedValue(response([strong]))
    render(<WorkspaceSearchDialog workspaceId="ws" open onClose={mocks.close}/>);await type('old');await type('Atlas')
    expect(mocks.search.mock.calls[0][2].aborted).toBe(true)
    await act(async()=>oldResolve(response([{...strong,title:'Stale private row'}])));expect(document.body.textContent).not.toContain('Stale private row')
    act(()=>window.dispatchEvent(new CustomEvent('brian:organization-changed',{detail:{workspaceId:'ws'}})));expect(document.body.textContent).not.toContain('Atlas')
  })
  it('provides phone preview and Back without sending, and clears on workspace switch',async()=>{
    mocks.search.mockResolvedValue(response([strong]));render(<WorkspaceSearchDialog key="ws" workspaceId="ws" open onClose={mocks.close}/>);await type('Atlas')
    const previewButton=[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Preview')!
    act(()=>previewButton.click());expect(document.querySelector('[aria-label="Preview"]')?.className).not.toContain('hidden md:flex')
    const back=[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Back to results')!
    act(()=>back.click());expect(document.querySelector('[aria-label="Preview"]')?.className).toContain('hidden md:flex')
    expect(mocks.stash).not.toHaveBeenCalled()
    render(<WorkspaceSearchDialog key="other" workspaceId="other" open onClose={mocks.close}/>);await tick()
    expect(document.querySelector<HTMLInputElement>('[data-workspace-search-input]')?.value).toBe('')
    expect(document.body.textContent).not.toContain('Atlas')
  })
  it('restores trigger focus on Escape',async()=>{
    render(<WorkspaceSearchProvider workspaceId="ws"><WorkspaceSearchFallback/></WorkspaceSearchProvider>);await tick()
    const trigger=document.querySelector<HTMLButtonElement>('[data-workspace-search-trigger]')!;act(()=>{trigger.focus();trigger.click()});await tick()
    key(document.querySelector<HTMLInputElement>('[data-workspace-search-input]')!,'Escape');await tick()
    expect(document.querySelector('[data-workspace-search-dialog]')).toBeNull();expect(document.activeElement).toBe(trigger)
  })
  it.each(['p','brain','studio/connectors','workflow','live','office','chat','organization','apps/fixture'])('opens a single modal from %s and reserves a header slot',async route=>{
    mocks.path=`/w/ws/${route}`;render(<WorkspaceSearchProvider workspaceId="ws"><WorkspaceSearchFallback/><WorkspaceSearchSlot/></WorkspaceSearchProvider>);await tick()
    expect(document.querySelectorAll('[data-workspace-search-trigger]').length).toBe(1)
    act(()=>document.querySelector<HTMLButtonElement>('[data-workspace-search-trigger]')!.click());await tick()
    expect(document.querySelectorAll('[data-workspace-search-dialog]').length).toBe(1)
    key(window as unknown as HTMLElement,'k',{ctrlKey:true});await tick();expect(document.querySelectorAll('[data-workspace-search-dialog]').length).toBe(1)
  })
  it('captures global K from editors, ignores IME/repeats, and respects another blocking dialog',async()=>{
    render(<WorkspaceSearchProvider workspaceId="ws"><WorkspaceSearchFallback/><textarea/></WorkspaceSearchProvider>);await tick()
    const editor=host.querySelector('textarea')!;key(editor,'k',{metaKey:true,isComposing:true});key(editor,'k',{ctrlKey:true,repeat:true});expect(document.querySelector('[data-workspace-search-dialog]')).toBeNull()
    const block=document.createElement('div');block.setAttribute('role','dialog');block.setAttribute('aria-modal','true');block.getClientRects=()=>[{width:10}] as unknown as DOMRectList;document.body.append(block)
    key(editor,'k',{ctrlKey:true});expect(document.querySelector('[data-workspace-search-dialog]')).toBeNull();block.setAttribute('aria-hidden','true');key(editor,'k',{metaKey:true});await tick();expect(document.querySelector('[data-workspace-search-dialog]')).not.toBeNull();block.remove()
  })
})
