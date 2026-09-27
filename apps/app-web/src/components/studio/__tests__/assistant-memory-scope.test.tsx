// @vitest-environment jsdom
import {act} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {I18nProvider} from '@/lib/i18n/client'
import {en} from '@/lib/i18n/dictionaries/en'
import type {Dictionary} from '@/lib/i18n/dictionaries'

vi.mock('@/lib/workspace-context',()=>({useWorkspaceContext:()=>({workspaceId:'workspace-1',me:{id:'fixture-actor'}})}))
vi.mock('next/navigation',()=>({useRouter:()=>({push:vi.fn()}),useSearchParams:()=>new URLSearchParams(),useParams:()=>({workspaceId:'workspace-1'})}))
vi.mock('@/lib/surface-cache',()=>({useCachedResource:()=>({data:{assistant:{id:'assistant-1',name:'Fixture assistant',role:'Assistant',workspaceId:'workspace-1'},workspaceRole:'owner',workspaceName:'Fixture workspace'}}),mutateSurfaceCache:vi.fn()}))
vi.mock('@/components/ui/confirm-dialog',()=>({confirmDialog:vi.fn(async()=>true)}))
vi.mock('@/lib/auth-fetch',()=>({authFetch:vi.fn()}))
import {authFetch} from '@/lib/auth-fetch'
import {confirmDialog} from '@/components/ui/confirm-dialog'
import {AssistantDetail} from '../assistant-detail'

(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true
let host:HTMLDivElement,root:Root
const memory={id:'memory-1',type:'context',scope:'shared',summary:'Fixture scoped memory',detail:null,tags:[],confidence:1,recallCount:0,usefulRecallCount:0,lastRecalledAt:null,createdAt:'2026-01-01',updatedAt:'2026-01-01'}
let scope='shared'
beforeEach(()=>{
  vi.clearAllMocks();scope='shared';localStorage.clear()
  host=document.createElement('div');document.body.append(host);root=createRoot(host)
  vi.mocked(authFetch).mockImplementation(async(input,init)=>{
    const url=String(input)
    if(url.endsWith('/scope')){scope=JSON.parse(String(init?.body)).scope==='workspace'?'workspace':'shared';return Response.json({memory:{...memory,scope}})}
    if(url.endsWith('/stats'))return Response.json({total:1,totalRecalls:0})
    if(url.endsWith('/soul'))return Response.json({soul:null})
    if(url.includes('/memories/team'))return Response.json({memories:[],total:0})
    return Response.json({memories:[{...memory,scope}],total:1})
  })
})
afterEach(()=>{act(()=>root.unmount());host.remove()})
async function click(text:string){
  const button=Array.from(host.querySelectorAll('button')).find(item=>item.textContent?.includes(text))
  expect(button,`button: ${text}`).toBeTruthy()
  await act(async()=>{button!.click()})
}
describe('[COMP:app-web/assistant-detail] Memory scope controls',()=>{
  it('sends workspace scope and offers the reverse action after the real API response shape',async()=>{
    await act(async()=>{root.render(<I18nProvider locale="en" dict={en as unknown as Dictionary}><AssistantDetail id="assistant-1" workspaceId="workspace-1"/></I18nProvider>)})
    await click(memory.summary)
    await click(en.assistant.brainTab.promoteToTeam)
    expect(vi.mocked(authFetch).mock.calls.find(([url])=>String(url).endsWith('/scope'))?.[1]?.body).toBe(JSON.stringify({scope:'workspace'}))
    expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({description:en.assistant.brainTab.promoteDesc}))
    expect(host.textContent).toContain(en.assistant.brainTab.makePersonal)
    await click(en.assistant.brainTab.makePersonal)
    const calls=vi.mocked(authFetch).mock.calls.filter(([url])=>String(url).endsWith('/scope'))
    expect(calls.at(-1)?.[1]?.body).toBe(JSON.stringify({scope:'user'}))
  })
})
