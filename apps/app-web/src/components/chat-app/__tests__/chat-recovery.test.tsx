// @vitest-environment jsdom
import {act} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {I18nProvider} from '@/lib/i18n/client'
import {en} from '@/lib/i18n/dictionaries/en'
import type {Dictionary} from '@/lib/i18n/dictionaries'
const mocks=vi.hoisted(()=>({inspect:vi.fn(),recover:vi.fn(),confirm:vi.fn(),actor:'owner' as string|null,listener:null as null|((value:{id:string}|null)=>void)}))
vi.mock('@/lib/api/sessions',async original=>({...await original<typeof import('@/lib/api/sessions')>(),inspectChatRecovery:mocks.inspect,recoverChat:mocks.recover}))
vi.mock('@/components/ui/confirm-dialog',()=>({confirmDialog:mocks.confirm}))
vi.mock('@/lib/user',()=>({getUserInfo:()=>mocks.actor?{id:mocks.actor}:null,subscribeUserInfo:(fn:typeof mocks.listener)=>{mocks.listener=fn;return()=>{mocks.listener=null}}}))
import {ChatRecoveryAction} from '../chat-recovery'
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true})
const source='11111111-1111-4111-8111-111111111111',workspace='22222222-2222-4222-8222-222222222222'
const target='33333333-3333-4333-8333-333333333333',assistant='44444444-4444-4444-8444-444444444444'
const revision='a'.repeat(64),result={sessionId:target,workspaceId:workspace,assistantId:assistant,replayed:false,channelId:target,lastActive:"2026-10-31T00:00:00.000Z",status:"idle",contextGroupId:null,contextProjectId:null}
let root:Root|undefined,container:HTMLDivElement|undefined
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes});return{promise,resolve}}
async function mount(){
 container=document.createElement('div');document.body.append(container);root=createRoot(container)
 const onRecovered=vi.fn()
 await act(async()=>{root!.render(<I18nProvider locale="en" dict={en as unknown as Dictionary}><ChatRecoveryAction
  workspaceId={workspace} sessionId={source} onRecovered={onRecovered}/></I18nProvider>)})
 return onRecovered
}
async function click(){await act(async()=>{container!.querySelector('button')!.click()})}
beforeEach(()=>{
 vi.clearAllMocks();mocks.actor='owner';mocks.listener=null
 mocks.inspect.mockResolvedValue({sessionId:source,workspaceId:workspace,revision,status:'available',continuationSessionId:null})
 mocks.confirm.mockResolvedValue(true);mocks.recover.mockResolvedValue(result)
})
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=undefined;container?.remove();container=undefined})
describe('[COMP:app-web/chat-recovery] owner-scoped confirmation and async ownership',()=>{
 it('confirms a private fresh start and applies only the frozen metadata revision',async()=>{
  const onRecovered=await mount();await click()
  expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({description:en.chatApp.recovery.description,confirmLabel:en.chatApp.recovery.confirm}))
  expect(mocks.recover).toHaveBeenCalledWith(source,workspace,revision,expect.any(AbortSignal))
  expect(onRecovered).toHaveBeenCalledExactlyOnceWith(result)
  expect(container!.querySelector('button')!.className).toContain('min-h-11')
 })
 it('does not apply cancelled confirmation or a busy original chat',async()=>{
  await mount();mocks.confirm.mockResolvedValueOnce(false);await click();expect(mocks.recover).not.toHaveBeenCalled()
  mocks.inspect.mockResolvedValueOnce({status:'busy',continuationSessionId:null});await click()
  expect(container!.textContent).toContain(en.chatApp.recovery.busy);expect(mocks.recover).not.toHaveBeenCalled()
 })
 it('rechecks the server even when reopening an existing continuation',async()=>{
  const onRecovered=await mount();mocks.inspect.mockResolvedValueOnce({revision,status:'available',continuationSessionId:target})
  mocks.recover.mockResolvedValueOnce({...result,replayed:true});await click()
  expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({description:en.chatApp.recovery.existingDescription}))
  expect(mocks.recover).toHaveBeenCalledTimes(1);expect(onRecovered).toHaveBeenCalledWith({...result,replayed:true})
 })
 it('blocks duplicate clicks while preparation is pending',async()=>{
  const wait=deferred<unknown>();mocks.inspect.mockReturnValueOnce(wait.promise);await mount();await click();await click()
  expect(mocks.inspect).toHaveBeenCalledTimes(1)
  await act(async()=>wait.resolve({revision,status:'available',continuationSessionId:null}));expect(mocks.recover).toHaveBeenCalledTimes(1)
 })
 it('aborts confirmation and cannot navigate after unmount or identity switch',async()=>{
  const wait=deferred<boolean>();mocks.confirm.mockReturnValueOnce(wait.promise)
  const onRecovered=await mount();await click();const signal=mocks.confirm.mock.calls[0][0].signal as AbortSignal
  await act(async()=>{mocks.actor='other';mocks.listener?.({id:'other'})})
  expect(signal.aborted).toBe(true)
  await act(async()=>wait.resolve(true));expect(mocks.recover).not.toHaveBeenCalled();expect(onRecovered).not.toHaveBeenCalled()
 })
 it('drops a late completed apply after its chat has unmounted',async()=>{
  const wait=deferred<typeof result>();mocks.recover.mockReturnValueOnce(wait.promise)
  const onRecovered=await mount();await click();const signal=mocks.recover.mock.calls[0][3] as AbortSignal
  await act(async()=>root!.unmount());root=undefined;expect(signal.aborted).toBe(true)
  await act(async()=>wait.resolve(result));expect(onRecovered).not.toHaveBeenCalled()
 })
 it('reports uncertain failure without automatically redispatching',async()=>{
  await mount();mocks.recover.mockRejectedValueOnce(new Error('Fictional lost response'));await click()
  expect(container!.querySelector('[role="alert"]')?.textContent).toBe(en.chatApp.recovery.failed)
  expect(mocks.recover).toHaveBeenCalledTimes(1)
 })
})
