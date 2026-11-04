// @vitest-environment jsdom
import {act} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {I18nProvider} from '@/lib/i18n/client'
import {en} from '@/lib/i18n/dictionaries/en'
import type {Dictionary} from '@/lib/i18n/dictionaries'
const mocks=vi.hoisted(()=>({read:vi.fn(),actor:'owner',listener:null as null|((value:{id:string}|null)=>void)}))
vi.mock('@/lib/api/sessions',()=>({readPrivateChatHistory:mocks.read}))
vi.mock('@/lib/user',()=>({getUserInfo:()=>({id:mocks.actor}),subscribeUserInfo:(fn:typeof mocks.listener)=>{mocks.listener=fn;return()=>{mocks.listener=null}}}))
import {ChatLegacyHistory} from '../chat-legacy-history'
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true})
let root:Root|undefined,container:HTMLDivElement|undefined
const workspace='workspace',source='source'
const page={sessionId:source,workspaceId:workspace,mode:'private_legacy_history',nextSequence:null,
 rows:[{id:'message',sequence:1,role:'user',text:'Private text <img src="https://example.invalid/image">',timestamp:'2026-01-01',available:true}]}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes});return{promise,resolve}}
async function render(id=source){
 await act(async()=>{root!.render(<I18nProvider locale="en" dict={en as unknown as Dictionary}>
  <ChatLegacyHistory workspaceId={workspace} sessionId={id} fallback="Unavailable"><button>Continue</button></ChatLegacyHistory>
 </I18nProvider>)})
}
beforeEach(()=>{
 vi.clearAllMocks();mocks.actor='owner';mocks.listener=null;mocks.read.mockResolvedValue(page)
 container=document.createElement('div');document.body.append(container);root=createRoot(container)
})
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=undefined;container?.remove();container=undefined})
describe('[COMP:app-web/chat-legacy-history] automatic private display',()=>{
 it('loads automatically as inert text without remote resources or message actions',async()=>{
  await render()
  expect(mocks.read).toHaveBeenCalledWith(source,workspace,0,expect.any(AbortSignal))
  expect(container!.textContent).toContain(page.rows[0].text)
  expect(container!.querySelector('img,iframe,a,textarea')).toBeNull()
  expect([...container!.querySelectorAll('button')].map(button=>button.textContent)).toEqual(['Continue'])
 })
 it('uses bounded pagination and renders withheld rows explicitly',async()=>{
  mocks.read.mockResolvedValueOnce({...page,nextSequence:1})
  await render()
  mocks.read.mockResolvedValueOnce({...page,rows:[{...page.rows[0],id:'second',sequence:2,available:false,text:null}]})
  await act(async()=>{container!.querySelector('button')!.click()})
  expect(mocks.read.mock.calls[1][2]).toBe(1)
  expect(container!.querySelectorAll('article')).toHaveLength(2)
  expect(container!.textContent).toContain(en.chatApp.legacyHistory.unavailableMessage)
 })
 it('drops late history from a previous chat',async()=>{
  const old=deferred<typeof page>();mocks.read.mockReturnValueOnce(old.promise)
  await render();const signal=mocks.read.mock.calls[0][3] as AbortSignal
  mocks.read.mockResolvedValueOnce({...page,sessionId:'new',rows:[{...page.rows[0],text:'New chat text'}]})
  await render('new');expect(signal.aborted).toBe(true)
  await act(async()=>old.resolve(page))
  expect(container!.textContent).toContain('New chat text')
  expect(container!.textContent).not.toContain('Private text')
 })
 it('clears already displayed history on an identity change and ignores in-flight old requests',async()=>{
  await render()
  mocks.read.mockRejectedValueOnce(new Error('denied'))
  await act(async()=>{mocks.actor='other';mocks.listener?.({id:'other'})})
  expect(container!.textContent).not.toContain('Private text')
  expect(container!.querySelector('[role="alert"]')?.textContent).toBe('Unavailable')
 })
 it('revalidates on focus and removes historical bytes when current access is denied',async()=>{
  await render();mocks.read.mockRejectedValueOnce(new Error('denied'))
  await act(async()=>window.dispatchEvent(new Event('focus')))
  expect(container!.textContent).not.toContain('Private text')
  expect(container!.querySelector('[role="alert"]')?.textContent).toBe('Unavailable')
 })
})
