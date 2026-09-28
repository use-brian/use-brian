// @vitest-environment jsdom
import {act} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {I18nProvider} from '@/lib/i18n/client'
import {en} from '@/lib/i18n/dictionaries/en'
const mocks=vi.hoisted(()=>({prepare:vi.fn(),apply:vi.fn(),confirm:vi.fn(),refresh:vi.fn(),patch:vi.fn(),fetch:vi.fn(),clearance:'internal'}))
vi.mock('next/navigation',()=>({useRouter:()=>({push:vi.fn()}),useSearchParams:()=>new URLSearchParams(),useParams:()=>({workspaceId:'workspace-1'})}))
vi.mock('@/lib/workspace-context',()=>({useWorkspaceContext:()=>({workspaceId:'workspace-1',me:{id:'fixture-owner'}})}))
vi.mock('@/lib/surface-cache',()=>({useCachedResource:()=>({data:{assistant:{id:'assistant-1',name:'Fixture assistant',role:'owner',workspaceId:'workspace-1',clearance:mocks.clearance},workspaceRole:'owner'},refresh:mocks.refresh}),mutateSurfaceCache:mocks.patch,invalidateSurfaceCache:vi.fn()}))
vi.mock('@/lib/api/workspace-access',()=>({fetchWorkspaceAccess:async()=>({policyRevision:'7'}),prepareWorkspaceAccessCommand:mocks.prepare,saveWorkspaceAccessCommand:mocks.apply,ORGANIZATION_CHANGED_EVENT:'brian:organization-changed'}))
vi.mock('@/components/ui/confirm-dialog',()=>({confirmDialog:mocks.confirm}))
vi.mock('@/components/ui/select',()=>({Select:({value,onValueChange,disabled}:{value:string;onValueChange:(v:string)=>void;disabled:boolean})=><button aria-label="fixture-clearance" disabled={disabled} onClick={()=>onValueChange('public')}>{value}</button>,SelectContent:()=>null,SelectItem:()=>null,SelectTrigger:()=>null,SelectValue:()=>null}))
vi.mock('@/lib/auth-fetch',()=>({authFetch:mocks.fetch}))
import {AssistantDetail} from '../assistant-detail'
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true
let host:HTMLDivElement,root:Root
async function render(){await act(async()=>root.render(<I18nProvider locale="en" dict={en}><AssistantDetail id="assistant-1" workspaceId="workspace-1"/></I18nProvider>))}
beforeEach(()=>{
 vi.clearAllMocks();mocks.clearance='internal';localStorage.clear()
 mocks.prepare.mockResolvedValue({id:'review',payloadHash:'a'.repeat(64),validForMs:30000,changes:[],command:{type:'assistant.clearance.set',assistantId:'assistant-1',clearance:'public'}})
 mocks.apply.mockResolvedValue({});mocks.confirm.mockResolvedValue(true)
 mocks.refresh.mockImplementation(async()=>{mocks.clearance='public'})
 mocks.fetch.mockImplementation(async()=>Response.json({memories:[],total:0,totalRecalls:0,soul:null}))
 host=document.createElement('div');document.body.append(host);root=createRoot(host)
})
afterEach(async()=>{await act(async()=>root.unmount());host.remove()})
describe('[COMP:app-web/assistant-detail] reviewed workspace clearance',()=>{
 it('keeps the old clearance while confirmation is pending and on cancellation',async()=>{
  let decide!:(confirmed:boolean)=>void;mocks.confirm.mockImplementation(()=>new Promise(resolve=>{decide=resolve}))
  await render();await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="fixture-clearance"]')!.click())
  expect(mocks.prepare).toHaveBeenCalledWith('workspace-1',{type:'assistant.clearance.set',assistantId:'assistant-1',clearance:'public'},'7',expect.any(String))
  expect(host.querySelector('[aria-label="fixture-clearance"]')?.textContent).toBe('internal')
  expect(mocks.patch).not.toHaveBeenCalled();expect(mocks.apply).not.toHaveBeenCalled()
  await act(async()=>decide(false));expect(mocks.apply).not.toHaveBeenCalled();expect(mocks.refresh).not.toHaveBeenCalled()
 })
 it('applies only the reviewed payload and refreshes authority after confirmation',async()=>{
  await render();await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="fixture-clearance"]')!.click())
  expect(mocks.apply).toHaveBeenCalledWith('workspace-1',{type:'access.command.apply',reviewId:'review',payloadHash:'a'.repeat(64)})
  expect(mocks.refresh).toHaveBeenCalledOnce();expect(host.querySelector('[aria-label="fixture-clearance"]')?.textContent).toBe('public')
  expect(mocks.fetch.mock.calls.some(([,init])=>init?.method==='PATCH')).toBe(false)
 })
})
