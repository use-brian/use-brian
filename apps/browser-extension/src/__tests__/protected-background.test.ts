import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  relay: null as any,
  executor: {
    attach: vi.fn(async () => {}), detach: vi.fn(async () => {}), snapshot: vi.fn(async () => ({nodes:[]})),
    currentUrl: vi.fn(async () => 'https://destination.example'), prepareProtectedFill: vi.fn(),
  },
  gate: {
    requireTab:vi.fn(async () => 1), entries:vi.fn(() => [{tabId:1}]), stop:vi.fn(() => []),
    endTask:vi.fn(() => []), currentTab:vi.fn(() => 1), isStopped:vi.fn(() => false),
  },
  result:vi.fn(),
}))
vi.mock('../relay-client.js', () => ({RelayClient:class {
  constructor(deps:any) {mocks.relay=deps}
  start() {} stop() {} sendResult = mocks.result
  sendEvent() {} getState() {return 'ready'} isBuildStale() {return false}
}}))
vi.mock('../executor.js', async importOriginal => ({
  ...await importOriginal<any>(), TabExecutor:class {constructor() {return mocks.executor}},
}))
vi.mock('../task-gate.js', () => ({TaskGate:class {constructor() {return mocks.gate}},CONSENT_PROMPT_TIMEOUT_MS:1000}))
let data:Record<string,any>
let messages: any
const token = `x.${btoa(JSON.stringify({kind:'browser-ext-session',userId:'u',workspaceId:'w',browserProfileId:'p',exp:Date.now()/1000+600}))}.x`
const request = {workspaceId:'w',sessionId:'s',taskId:'t',browserProfileId:'p',destinationOrigin:'https://destination.example',items:[{referenceId:'a'.repeat(43),ref:'@e1'}]}
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks()
  data={sessionToken:token,protectedApiBase:'https://api.example'}
  const sessionData:Record<string,unknown> = {}
  const event=()=>({addListener:vi.fn()})
  vi.stubGlobal('chrome',{
    runtime:{id:'id',getURL:(s:string)=>`chrome-extension://id/${s}`,getManifest:()=>({}),
      onMessage:{addListener:(fn:any)=>{messages=fn}},onMessageExternal:event()},
    storage:{session:{
      get:vi.fn(async(key:string)=>({[key]:sessionData[key]})),
      set:vi.fn(async(v:any)=>{Object.assign(sessionData,v)}),
    },local:{
      get:vi.fn(async(keys:string|string[])=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,data[k]]))),
      set:vi.fn(async(v:any)=>{Object.assign(data,structuredClone(v))}),remove:vi.fn(async(k:string)=>{delete data[k]}),
    }},
    action:{setBadgeText:vi.fn(async()=>{}),setBadgeBackgroundColor:vi.fn(async()=>{})},
    debugger:{onDetach:event()},
    tabs:{get:vi.fn(async()=>({id:1,active:true,url:'https://destination.example'})),onRemoved:event(),onCreated:event(),remove:vi.fn(async()=>{})},
    windows:{create:vi.fn(async()=>{
      messages({type:'protected-approval',allowed:true},{id:'id',url:'chrome-extension://id/popup.html'},vi.fn())
    })},
    permissions:{contains:vi.fn(async()=>true)},
  })
  mocks.executor.prepareProtectedFill.mockResolvedValue(vi.fn(async()=>{}))
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({items:[{ref:'@e1',value:'SENTINEL'}]})})))
  await import('../background.js')
})
function command(op:string,id=op,args:Record<string,unknown>={}) {
  mocks.relay.onCommand({id,op,args,controlMode:'full_browser'})
}
describe('actual background relay lock boundary',()=>{
  it('denies every observation/action/raw/unknown command after restart with persisted lock; stop cannot unlock',async()=>{
    data.protectedDisclosureLock={request,tabIds:[1],apiBase:'https://api.example',token}
    const ops=['snapshot','currentUrl','listTabs','captureFrame','captureState','type','click','navigate','openTab','closeTab','switchTab','takeoverInput','skills','executeSkill','rawCdp','browserFillReference','unknown']
    for(const op of ops) command(op)
    await vi.waitFor(()=>expect(mocks.result).toHaveBeenCalledTimes(ops.length))
    for(const [result] of mocks.result.mock.calls) expect(result).toEqual({id:result.id,ok:false,error:'Protected fill unavailable',code:'protected_fill_denied'})
    expect(mocks.gate.requireTab).not.toHaveBeenCalled()
    expect(mocks.executor.attach).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    command('stop')
    await vi.waitFor(()=>expect(mocks.result).toHaveBeenCalledTimes(ops.length+1))
    expect(mocks.gate.stop).toHaveBeenCalledOnce()
    expect(data.protectedDisclosureLock).toBeTruthy()
  })
  it('finishes an in-flight observation before disclosure and never executes queued observations after it',async()=>{
    let release!:()=>void
    mocks.executor.snapshot.mockImplementationOnce(()=>new Promise(resolve=>{release=()=>resolve({nodes:[]})}))
    command('snapshot','before')
    await vi.waitFor(()=>expect(mocks.executor.snapshot).toHaveBeenCalledOnce())
    command('browserFillReference','fill',request)
    command('currentUrl','after')
    expect(data.protectedDisclosureLock).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
    release()
    await vi.waitFor(()=>expect(mocks.result).toHaveBeenCalledTimes(3))
    expect(mocks.result.mock.calls.map(c=>c[0].id)).toEqual(['before','fill','after'])
    expect(mocks.result.mock.calls[1][0]).toEqual({id:'fill',ok:true,data:{status:'filled',filledCount:1,requiresHumanCompletion:true}})
    expect(mocks.result.mock.calls[2][0]).toMatchObject({ok:false,code:'protected_fill_denied'})
    expect(mocks.executor.currentUrl).not.toHaveBeenCalled()
    expect(JSON.stringify(mocks.result.mock.calls)).not.toContain('SENTINEL')
  })
  it('rejects page-origin approval/configuration messages',()=>{
    const reply=vi.fn()
    messages({type:'protected-configure',protectedApiBase:'https://evil.example'},{id:'id',url:'https://destination.example'},reply)
    expect(reply).not.toHaveBeenCalled()
    expect(data.protectedApiBase).toBe('https://api.example')
  })
})

describe('restart recovery trusted UI boundary and capability',()=>{
  it('advertises the implemented capability from Chromium background',()=>{
    expect(mocks.relay.capabilities).toEqual({protectedFillV1:true})
  })
  it('rejects broad cleanup without explicit approval or from another extension page; relay cannot invoke it',async()=>{
    data.protectedDisclosureLock={request,tabIds:[1],apiBase:'https://api.example',token}
    for(const [url,allowed] of [['chrome-extension://id/popup.html',false],['chrome-extension://id/allow.html',true]] as const) {
      const reply=vi.fn()
      messages({type:'protected-recover-all-tabs',allowed},{id:'id',url},reply)
      expect(reply).toHaveBeenCalledWith({ok:false})
    }
    command('protected-recover-all-tabs','relay-recovery',{allowed:true})
    await vi.waitFor(()=>expect(mocks.result).toHaveBeenCalledOnce())
    expect(mocks.result.mock.calls[0][0]).toMatchObject({ok:false,code:'protected_fill_denied'})
    expect(chrome.tabs.remove).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(data.protectedDisclosureLock).toBeTruthy()
  })
})

describe('server recovery is a human popup operation, never a relay action', () => {
  it('requires the trusted popup and explicit approval', async () => {
    for (const [url, allowed] of [['chrome-extension://id/popup.html',false],['chrome-extension://id/allow.html',true]] as const) {
      const reply=vi.fn()
      messages({type:'protected-recover-server',allowed},{id:'id',url},reply)
      expect(reply).toHaveBeenCalledWith({ok:false})
    }
    command('protected-recover-server','relay-server-recovery',{allowed:true})
    await vi.waitFor(()=>expect(mocks.result).toHaveBeenCalledOnce())
    expect(mocks.result.mock.calls[0][0]).toMatchObject({ok:false})
    expect(fetch).not.toHaveBeenCalled()
  })
  it('lets the popup recover an undisclosed server reservation without local task state', async () => {
    vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({status:'cancelled'})})))
    const reply=vi.fn()
    messages({type:'protected-recover-server',allowed:true},{id:'id',url:'chrome-extension://id/popup.html'},reply)
    await vi.waitFor(()=>expect(reply).toHaveBeenCalledWith({ok:true,status:'cancelled'}))
    expect(data.protectedDisclosureLock).toBeUndefined()
    expect(chrome.tabs.remove).not.toHaveBeenCalled()
  })
})
