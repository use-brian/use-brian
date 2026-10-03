// @vitest-environment jsdom
import { StrictMode, act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { useChatHandoff } from '@/lib/use-chat-handoff'
import { stashChatHandoff, takeChatHandoff, CHAT_HANDOFF_EVENT, CHAT_HANDOFF_TTL_MS, type PendingChatHandoff } from '@/lib/chat-handoff'
import { readChatDrafts, writeChatDrafts } from '@/lib/chat-draft-recovery'
import { readFileSync } from 'node:fs'
let root:Root,host:HTMLDivElement
const sends=vi.fn(),prepare=vi.fn(),prefill=vi.fn(),validate=vi.fn()
let unblock:()=>void
function Consumer({initialView='personal',initialSession='existing',blocked=false}:{initialView?:'personal'|'workspace';initialSession?:string|null;blocked?:boolean}) {
  const [view,setView]=useState(initialView),[session,setSession]=useState<string|null>(initialSession),[assistant,setAssistant]=useState<string|null>('assistant'),[waiting,setWaiting]=useState(blocked)
  unblock=()=>setWaiting(false)
  useChatHandoff({workspaceId:'workspace',assistantsLoaded:true,blocked:waiting,view,activeSessionId:session,activeAssistantId:assistant,
    prepare(handoff){prepare(handoff);setView('personal');setSession(null);setAssistant(handoff.assistantId)},
    validateAssistant:validate,
    async send(handoff){const fresh=crypto.randomUUID();sends({id:fresh,sessionId:session,view,assistant,text:handoff.text,requestId:handoff.requestId});setSession(fresh);return true},
    prefill,
  })
  return <p>{session??'fresh'}:{view}</p>
}
const launch=(requestId=crypto.randomUUID(),text='Fixture question')=>stashChatHandoff({workspaceId:'workspace',assistantId:'assistant',requestId,text,ts:Date.now()})
const settle=async()=>{await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0))})}
beforeEach(()=>{
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true
  sessionStorage.clear();takeChatHandoff('workspace',Date.now());vi.clearAllMocks();validate.mockResolvedValue(true)
  host=document.createElement('div');document.body.append(host);root=createRoot(host)
})
afterEach(()=>{act(()=>root.unmount());host.remove()})
describe('[COMP:app-web/chat-handoff] repeated search launches',()=>{
  it.each(['personal','workspace'] as const)('creates two separate fresh Personal sends from an existing %s chat without unmounting',async initialView=>{
    act(()=>root.render(<StrictMode><Consumer initialView={initialView}/></StrictMode>))
    act(()=>{launch('one');window.dispatchEvent(new CustomEvent(CHAT_HANDOFF_EVENT,{detail:{workspaceId:'workspace',requestId:'one'}}))});await settle();await settle()
    act(()=>launch('two'));await settle();await settle()
    expect(sends).toHaveBeenCalledTimes(2)
    expect(sends.mock.calls.map(([send])=>[send.sessionId,send.view,send.requestId])).toEqual([[null,'personal','one'],[null,'personal','two']])
    expect(sends.mock.calls[0][0].id).not.toBe(sends.mock.calls[1][0].id)
    act(()=>launch('two'));await settle();expect(sends).toHaveBeenCalledTimes(2)
  })
  it('consumes an initial handoff once in Strict Mode and does not replay on refresh',async()=>{
    launch('initial');act(()=>root.render(<StrictMode><Consumer/></StrictMode>));await settle();await settle();expect(sends).toHaveBeenCalledTimes(1)
    act(()=>root.unmount());root=createRoot(host);act(()=>root.render(<StrictMode><Consumer/></StrictMode>));await settle();expect(sends).toHaveBeenCalledTimes(1)
  })
  it('prefills a removed assistant and never sends to a substitute',async()=>{
    validate.mockResolvedValue(false);act(()=>root.render(<Consumer/>));act(()=>launch('removed'));await settle();await settle()
    expect(sends).not.toHaveBeenCalled();expect(prefill).toHaveBeenCalledWith(expect.objectContaining({text:'Fixture question',assistantId:'assistant'}))
  })
  it('retains a pending incoming prompt while an upload blocks transition',async()=>{
    act(()=>root.render(<Consumer blocked/>));act(()=>launch('waiting'));await settle();expect(prepare).not.toHaveBeenCalled();expect(sends).not.toHaveBeenCalled()
    act(()=>unblock());await settle();await settle();expect(sends).toHaveBeenCalledTimes(1)
  })
  it('rejects expired and other-workspace payloads',async()=>{
    stashChatHandoff({workspaceId:'workspace',assistantId:'assistant',text:'Expired',ts:Date.now()-CHAT_HANDOFF_TTL_MS})
    act(()=>root.render(<Consumer/>));await settle();expect(sends).not.toHaveBeenCalled()
    act(()=>stashChatHandoff({workspaceId:'other',assistantId:'assistant',text:'Other private prompt',ts:Date.now()}));await settle();expect(prepare).not.toHaveBeenCalled()
  })
  it('keeps prior composer text and uploaded references scoped to its user and original room',()=>{
    const draft={id:'draft',text:'Prior unsent text',sessionId:'old-room',assistantId:'assistant',view:'workspace' as const,attachments:[{localId:'chip',fileId:'file',fileName:'fixture.txt',mimeType:'text/plain',sizeBytes:5,status:'done' as const,previewUrl:'blob:expired'}],recordings:[],researchMode:true}
    writeChatDrafts('workspace','person',[draft]);expect(readChatDrafts('workspace','person')).toMatchObject([{text:draft.text,sessionId:'old-room',attachments:[{fileId:'file'}]}])
    expect(readChatDrafts('workspace','person')[0]?.attachments[0]).not.toHaveProperty('previewUrl')
    expect(readChatDrafts('workspace','another')).toEqual([]);expect(readChatDrafts('other','person')).toEqual([])
  })
  it('wires the consumer to ChatSurface send with empty inherited attachments and explicit research state',()=>{
    const source=readFileSync('src/components/chat-app/chat-surface.tsx','utf8')
    expect(source).toContain('useChatHandoff({')
    expect(source).toContain('return send({text:handoff.text,fileIds:handoff.fileIds??[],attachedRecordingIds:handoff.attachedRecordingIds??[],researchMode:handoff.researchMode??false})')
    expect(source).toContain('pendingReplyRef.current=null')
    expect(source).toContain('captureComposerDraft()')
    expect(source).not.toContain('handoffWorkspaceRef')
  })
})
