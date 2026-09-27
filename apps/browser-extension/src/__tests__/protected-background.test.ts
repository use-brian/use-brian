import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  relay: null as any,
  executor: {
    attach: vi.fn(async () => {}), detach: vi.fn(async () => {}), snapshot: vi.fn(async () => ({nodes:[]})),
    currentUrl: vi.fn(async () => 'https://destination.example'), prepareProtectedFill: vi.fn(),
    captureFrame: vi.fn(async () => ({data:'frame',mimeType:'image/jpeg'})),
  },
  gate: {
    requireTab:vi.fn(async () => 1), entries:vi.fn(() => [{tabId:1}]), stop:vi.fn((): number[] => []),
    endTask:vi.fn(() => []), currentTab:vi.fn(() => 1), isStopped:vi.fn(() => false),
    canOpenTaskTab:vi.fn(() => true), registerCreatedTab:vi.fn(() => 'created'),
    selectHandle:vi.fn(() => 1), onTabRemoved:vi.fn(() => false),
    handleForTab:vi.fn(() => null), registerFullTab:vi.fn(() => 'existing'),
    currentHandle:vi.fn(() => 'existing'), isTaskOwnedTab:vi.fn(() => false),
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
    tabs:{get:vi.fn(async()=>({id:1,active:true,url:'https://destination.example'})),onRemoved:event(),onCreated:event(),remove:vi.fn(async()=>{}),
      create:vi.fn(async()=>({id:2,url:'https://destination.example'})),
      query:vi.fn(async()=>[{id:1,url:'https://destination.example'}]),
      update:vi.fn(async()=>({id:1}))},
    windows:{update:vi.fn(async()=>({})),create:vi.fn(async()=>{
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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function popup(type: string, extra: Record<string, unknown> = {}) {
  const reply = vi.fn()
  messages({type, ...extra}, {id:'id', url:'chrome-extension://id/popup.html'}, reply)
  return reply
}
function resultFor(id: string) {
  return mocks.result.mock.calls.find(([result]) => result.id === id)?.[0]
}

describe('unified background scheduling and Stop', () => {
  it.each(['relay', 'popup', 'transport'])('%s cancellation immediately invalidates waiting work without releasing an active capture barrier', async source => {
    const frame = deferred<{data:string;mimeType:string}>()
    mocks.executor.captureFrame.mockImplementationOnce(() => frame.promise)
    command('captureFrame', 'active')
    await vi.waitFor(() => expect(mocks.executor.captureFrame).toHaveBeenCalledOnce())
    command('browserFillReference', 'stale-fill', request)
    command('captureFrame', 'stale-frame')
    const recovery = popup('protected-recover-server', {allowed:true})
    if (source === 'relay') command('stop')
    else if (source === 'popup') popup('stop-task')
    else {
      mocks.relay.onStateChange('ready')
      mocks.relay.onStateChange('disconnected')
    }
    expect(mocks.executor.detach).toHaveBeenCalledOnce()
    await vi.waitFor(() => {
      expect(resultFor('stale-frame')).toMatchObject({ok:false,code:'stopped'})
      expect(resultFor('stale-fill')).toMatchObject({ok:false,code:'protected_fill_denied'})
      expect(recovery).toHaveBeenCalledWith({ok:false})
    })
    if (source === 'relay') expect(resultFor('stop')).toMatchObject({ok:true,data:{stopped:true}})
    expect(fetch).not.toHaveBeenCalled()
    frame.resolve({data:'old-frame',mimeType:'image/jpeg'})
    await vi.waitFor(() => expect(resultFor('active')).toMatchObject({ok:false,code:'stopped'}))
    expect(mocks.gate.requireTab).toHaveBeenCalledOnce()
    expect(mocks.executor.captureFrame).toHaveBeenCalledOnce()
    expect(mocks.executor.prepareProtectedFill).not.toHaveBeenCalled()
    expect(data.protectedDisclosureLock).toBeUndefined()
    expect(JSON.stringify(mocks.result.mock.calls)).not.toContain('old-frame')
  })

  it('fails closed when storage cannot establish the disclosure lock state', async () => {
    vi.mocked(chrome.storage.local.get).mockRejectedValue(new Error('storage unavailable'))
    command('captureFrame')
    await vi.waitFor(() => expect(resultFor('captureFrame')).toMatchObject({ok:false,code:'protected_fill_denied'}))
    expect(mocks.executor.captureFrame).not.toHaveBeenCalled()
  })

  it.each(['protected-complete', 'protected-recover-all-tabs'])('Stop cancels queued popup %s without running cleanup', async type => {
    const { ProtectedFill } = await import('../protected-fill.js')
    const complete = vi.spyOn(ProtectedFill.prototype, 'complete')
    const frame = deferred<{data:string;mimeType:string}>()
    mocks.executor.captureFrame.mockImplementationOnce(() => frame.promise)
    try {
      command('captureFrame', 'active')
      await vi.waitFor(() => expect(mocks.executor.captureFrame).toHaveBeenCalledOnce())
      const reply = popup(type, {allowed:true})
      command('stop')
      await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ok:false}))
      expect(complete).not.toHaveBeenCalled()
      frame.resolve({data:'old',mimeType:'image/jpeg'})
      await vi.waitFor(() => expect(resultFor('active')).toMatchObject({ok:false,code:'stopped'}))
      expect(complete).not.toHaveBeenCalled()
    } finally { complete.mockRestore() }
  })

  it('bounds work at relay receipt, with Stop still able to cancel a full queue', async () => {
    const frame = deferred<{data:string;mimeType:string}>()
    mocks.executor.captureFrame.mockImplementationOnce(() => frame.promise)
    command('captureFrame', 'active')
    await vi.waitFor(() => expect(mocks.executor.captureFrame).toHaveBeenCalledOnce())
    for (let i = 0; i < 32; i++) command('captureFrame', `poll-${i}`)
    await vi.waitFor(() => expect(resultFor('poll-31')).toMatchObject({ok:false,error:'Browser command queue is full.'}))
    command('stop')
    await vi.waitFor(() => expect(resultFor('poll-0')).toMatchObject({ok:false,code:'stopped'}))
    expect(mocks.executor.captureFrame).toHaveBeenCalledOnce()
    frame.resolve({data:'old',mimeType:'image/jpeg'})
    await vi.waitFor(() => expect(mocks.result).toHaveBeenCalledTimes(34))
  })

  it('detaches a late attachment instead of reading or reviving a stopped task', async () => {
    const attached = deferred<void>()
    mocks.executor.attach.mockImplementationOnce(() => attached.promise)
    command('captureFrame', 'late-attach')
    await vi.waitFor(() => expect(mocks.executor.attach).toHaveBeenCalledOnce())
    command('stop')
    expect(mocks.executor.detach).toHaveBeenCalledOnce()
    attached.resolve()
    await vi.waitFor(() => expect(resultFor('late-attach')).toMatchObject({ok:false,code:'stopped'}))
    expect(mocks.executor.detach).toHaveBeenCalledTimes(2)
    expect(mocks.executor.captureFrame).not.toHaveBeenCalled()
  })

  it('Stop during protected preflight prevents a late approval popup or disclosure, retaining the lock', async () => {
    const prepared = deferred<any>()
    const assign = vi.fn(async () => {})
    mocks.executor.prepareProtectedFill.mockImplementationOnce(() => prepared.promise)
    command('browserFillReference', 'fill', request)
    await vi.waitFor(() => expect(mocks.executor.prepareProtectedFill).toHaveBeenCalledOnce())
    command('stop')
    await vi.waitFor(() => expect(resultFor('stop')).toMatchObject({ok:true}))
    prepared.resolve(assign)
    await vi.waitFor(() => expect(resultFor('fill')).toMatchObject({ok:false,code:'protected_fill_denied'}))
    expect(chrome.windows.create).not.toHaveBeenCalled()
    expect(assign).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(data.protectedDisclosureLock).toBeTruthy()
  })

  it('Stop immediately denies pending approval; a late Allow cannot revive it', async () => {
    vi.mocked(chrome.windows.create).mockResolvedValueOnce({} as chrome.windows.Window)
    command('browserFillReference', 'fill', request)
    await vi.waitFor(() => expect(chrome.windows.create).toHaveBeenCalledOnce())
    command('captureFrame', 'waiting')
    command('stop')
    popup('protected-approval', {allowed:true})
    await vi.waitFor(() => {
      expect(resultFor('stop')).toMatchObject({ok:true})
      expect(resultFor('fill')).toMatchObject({ok:false,code:'protected_fill_denied'})
      expect(resultFor('waiting')).toMatchObject({ok:false,code:'protected_fill_denied'})
    })
    expect(fetch).not.toHaveBeenCalled()
    expect(mocks.executor.captureFrame).not.toHaveBeenCalled()
    expect(data.protectedDisclosureLock).toBeTruthy()
  })

  it('discards a resolver response after Stop and never captures material while locked', async () => {
    const resolved = deferred<any>()
    vi.mocked(fetch).mockImplementationOnce(() => resolved.promise)
    const assign = vi.fn(async () => {})
    mocks.executor.prepareProtectedFill.mockResolvedValueOnce(assign)
    command('browserFillReference', 'fill', request)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    command('stop')
    command('captureFrame', 'after-stop')
    resolved.resolve({ok:true,json:async () => ({items:[{ref:'@e1',value:'SENTINEL'}]})})
    await vi.waitFor(() => expect(resultFor('after-stop')).toMatchObject({ok:false,code:'protected_fill_denied'}))
    expect(resultFor('fill')).toMatchObject({ok:false,code:'protected_fill_denied'})
    expect(assign.mock.calls).toEqual([[[]]]) // preflight only, never values
    expect(mocks.executor.captureFrame).not.toHaveBeenCalled()
    expect(data.protectedDisclosureLock).toBeTruthy()
    expect(JSON.stringify(mocks.result.mock.calls)).not.toContain('SENTINEL')
  })
})

describe('capture, protected fill and trusted recovery share the same lane', () => {
  it('finishes an active capture before protected fill, then rejects the queued capture', async () => {
    const frame = deferred<{data:string;mimeType:string}>()
    mocks.executor.captureFrame.mockImplementationOnce(() => frame.promise)
    command('captureFrame', 'before')
    await vi.waitFor(() => expect(mocks.executor.captureFrame).toHaveBeenCalledOnce())
    command('browserFillReference', 'fill', request)
    command('captureFrame', 'after')
    expect(fetch).not.toHaveBeenCalled()
    expect(data.protectedDisclosureLock).toBeUndefined()
    frame.resolve({data:'public-frame',mimeType:'image/jpeg'})
    await vi.waitFor(() => expect(mocks.result).toHaveBeenCalledTimes(3))
    expect(resultFor('before')).toMatchObject({ok:true})
    expect(resultFor('fill')).toMatchObject({ok:true})
    expect(resultFor('after')).toMatchObject({ok:false,code:'protected_fill_denied'})
    expect(mocks.executor.captureFrame).toHaveBeenCalledOnce()
  })

  it('serializes server recovery behind an active capture and blocks subsequent captures on the recovered lock', async () => {
    const frame = deferred<{data:string;mimeType:string}>()
    mocks.executor.captureFrame.mockImplementationOnce(() => frame.promise)
    vi.mocked(fetch).mockResolvedValueOnce({ok:true,json:async () => ({status:'cleanup_required',request})} as Response)
    command('captureFrame', 'before')
    await vi.waitFor(() => expect(mocks.executor.captureFrame).toHaveBeenCalledOnce())
    const recovery = popup('protected-recover-server', {allowed:true})
    command('captureFrame', 'after')
    expect(fetch).not.toHaveBeenCalled()
    frame.resolve({data:'public-frame',mimeType:'image/jpeg'})
    await vi.waitFor(() => expect(recovery).toHaveBeenCalledWith({ok:true,status:'cleanup_required'}))
    await vi.waitFor(() => expect(resultFor('after')).toMatchObject({ok:false,code:'protected_fill_denied'}))
    expect(mocks.executor.captureFrame).toHaveBeenCalledOnce()
    expect(data.protectedDisclosureLock).toBeTruthy()
  })

  it('serializes completion behind active fill and keeps capture blocked throughout cleanup', async () => {
    const writing = deferred<void>()
    const completing = deferred<any>()
    const assign = vi.fn(async (items: unknown[]) => { if (items.length) await writing.promise })
    mocks.executor.prepareProtectedFill.mockResolvedValueOnce(assign)
    vi.mocked(fetch).mockImplementation(async url => String(url).endsWith('/complete')
      ? completing.promise
      : ({ok:true,json:async () => ({items:[{ref:'@e1',value:'SENTINEL'}]})} as Response))
    chrome.tabs.query = vi.fn(async () => [])
    command('browserFillReference', 'fill', request)
    await vi.waitFor(() => expect(assign).toHaveBeenCalledTimes(2))
    command('captureFrame', 'before-cleanup')
    const completion = popup('protected-complete')
    command('captureFrame', 'stale-after-cleanup')
    expect(chrome.tabs.query).not.toHaveBeenCalled()
    writing.resolve()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(resultFor('before-cleanup')).toMatchObject({ok:false,code:'protected_fill_denied'})
    expect(resultFor('stale-after-cleanup')).toMatchObject({ok:false,code:'protected_fill_denied'})
    command('captureFrame', 'during-cleanup')
    expect(mocks.executor.captureFrame).not.toHaveBeenCalled()
    expect(data.protectedDisclosureLock).toBeTruthy()
    completing.resolve({ok:true})
    await vi.waitFor(() => expect(completion).toHaveBeenCalledWith({ok:true}))
    // A new command may proceed only AFTER proven cleanup (real gate requires
    // fresh manual consent); no capture fast path is allowed during the lock.
    await vi.waitFor(() => expect(resultFor('during-cleanup')).toMatchObject({ok:true}))
    expect(data.protectedDisclosureLock).toBeUndefined()
    expect(mocks.executor.captureFrame).toHaveBeenCalledOnce()
  })
})


describe('tab helpers honor cancellation across asynchronous Chrome calls', () => {
  it('closes only the orphan created after Stop, without registering or attaching it', async () => {
    const created = deferred<chrome.tabs.Tab>()
    vi.mocked(chrome.tabs.create).mockImplementationOnce(() => created.promise)
    command('openTab', 'open', {url:'https://destination.example'})
    await vi.waitFor(() => expect(chrome.tabs.create).toHaveBeenCalledOnce())
    command('stop')
    await vi.waitFor(() => expect(resultFor('stop')).toMatchObject({ok:true}))
    expect(chrome.tabs.remove).not.toHaveBeenCalled()
    created.resolve({id:2,url:'https://destination.example'} as chrome.tabs.Tab)
    await vi.waitFor(() => expect(resultFor('open')).toMatchObject({ok:false,code:'stopped'}))
    expect(chrome.tabs.remove).toHaveBeenCalledExactlyOnceWith(2)
    expect(mocks.gate.registerCreatedTab).not.toHaveBeenCalled()
    expect(mocks.executor.attach).not.toHaveBeenCalled()
  })

  it('does not attach a registered new tab when Stop races its eligibility lookup', async () => {
    const tab = deferred<chrome.tabs.Tab>()
    vi.mocked(chrome.tabs.get).mockImplementationOnce(() => tab.promise)
    mocks.gate.stop.mockReturnValueOnce([2])
    command('openTab', 'open', {url:'https://destination.example'})
    await vi.waitFor(() => expect(chrome.tabs.get).toHaveBeenCalledWith(2))
    expect(mocks.gate.registerCreatedTab).toHaveBeenCalledExactlyOnceWith(2, true)
    command('stop')
    await vi.waitFor(() => expect(resultFor('stop')).toMatchObject({ok:true}))
    tab.resolve({id:2,url:'https://destination.example'} as chrome.tabs.Tab)
    await vi.waitFor(() => expect(resultFor('open')).toMatchObject({ok:false,code:'stopped'}))
    expect(mocks.executor.attach).not.toHaveBeenCalled()
    expect(chrome.tabs.remove).toHaveBeenCalledExactlyOnceWith([2])
  })

  it.each(['initial', 'attachment'])('does not attach or close an existing switch target when Stop races the %s lookup', async stage => {
    const tab = deferred<chrome.tabs.Tab>()
    if (stage === 'attachment') vi.mocked(chrome.tabs.get).mockResolvedValueOnce({id:1,windowId:5,url:'https://destination.example'} as chrome.tabs.Tab)
    vi.mocked(chrome.tabs.get).mockImplementationOnce(() => tab.promise)
    command('switchTab', 'switch', {tabId:'existing'})
    await vi.waitFor(() => expect(chrome.tabs.get).toHaveBeenCalledTimes(stage === 'initial' ? 1 : 2))
    command('stop')
    await vi.waitFor(() => expect(resultFor('stop')).toMatchObject({ok:true}))
    tab.resolve({id:1,windowId:5,url:'https://destination.example'} as chrome.tabs.Tab)
    await vi.waitFor(() => expect(resultFor('switch')).toMatchObject({ok:false,code:'stopped'}))
    expect(mocks.executor.attach).not.toHaveBeenCalled()
    expect(chrome.tabs.remove).not.toHaveBeenCalled()
    if (stage === 'initial') {
      expect(chrome.tabs.update).not.toHaveBeenCalled()
      expect(chrome.windows.update).not.toHaveBeenCalled()
    }
  })

  it('does not focus the window or attach after a cancelled tab activation', async () => {
    const activated = deferred<chrome.tabs.Tab>()
    vi.mocked(chrome.tabs.get).mockResolvedValueOnce({id:1,windowId:5,url:'https://destination.example'} as chrome.tabs.Tab)
    vi.mocked(chrome.tabs.update).mockImplementationOnce(() => activated.promise)
    command('switchTab', 'switch', {tabId:'existing'})
    await vi.waitFor(() => expect(chrome.tabs.update).toHaveBeenCalledOnce())
    command('stop')
    activated.resolve({id:1} as chrome.tabs.Tab)
    await vi.waitFor(() => expect(resultFor('switch')).toMatchObject({ok:false,code:'stopped'}))
    expect(chrome.windows.update).not.toHaveBeenCalled()
    expect(mocks.executor.attach).not.toHaveBeenCalled()
    expect(chrome.tabs.remove).not.toHaveBeenCalled()
  })

  it('does not close a user tab when Stop races the preceding detach', async () => {
    const detached = deferred<void>()
    mocks.executor.detach.mockImplementationOnce(() => detached.promise)
    command('closeTab', 'close', {tabId:'existing'})
    await vi.waitFor(() => expect(mocks.executor.detach).toHaveBeenCalledOnce())
    command('stop')
    await vi.waitFor(() => expect(resultFor('stop')).toMatchObject({ok:true}))
    detached.resolve()
    await vi.waitFor(() => expect(resultFor('close')).toMatchObject({ok:false,code:'stopped'}))
    expect(chrome.tabs.remove).not.toHaveBeenCalled()
    expect(mocks.gate.onTabRemoved).not.toHaveBeenCalled()
  })

  it('does not mutate the stopped gate after an already-issued tab removal completes', async () => {
    const removed = deferred<void>()
    vi.mocked(chrome.tabs.remove).mockImplementationOnce(() => removed.promise)
    command('closeTab', 'close', {tabId:'existing'})
    await vi.waitFor(() => expect(chrome.tabs.remove).toHaveBeenCalledOnce())
    command('stop')
    removed.resolve()
    await vi.waitFor(() => expect(resultFor('close')).toMatchObject({ok:false,code:'stopped'}))
    expect(mocks.gate.onTabRemoved).not.toHaveBeenCalled()
    expect(chrome.tabs.remove).toHaveBeenCalledExactlyOnceWith(1)
  })

  it.each(['query', 'get', 'failed-get'])('does not repopulate or mutate the gate after a cancelled list %s', async stage => {
    const read = deferred<void>()
    if (stage === 'query') vi.mocked(chrome.tabs.query).mockImplementationOnce(async () => {
      await read.promise
      return [{id:1,url:'https://destination.example'} as chrome.tabs.Tab]
    })
    else vi.mocked(chrome.tabs.get).mockImplementationOnce(async () => {
      await read.promise
      if (stage === 'failed-get') throw new Error('tab disappeared')
      return {id:1,url:'https://destination.example'} as chrome.tabs.Tab
    })
    mocks.relay.onCommand({id:'list',op:'listTabs',args:{},controlMode:stage === 'query' ? 'full_browser' : 'task_tabs'})
    await vi.waitFor(() => expect(stage === 'query' ? chrome.tabs.query : chrome.tabs.get).toHaveBeenCalledOnce())
    command('stop')
    read.resolve()
    await vi.waitFor(() => expect(resultFor('list')).toMatchObject({ok:false,code:'stopped'}))
    expect(mocks.gate.registerFullTab).not.toHaveBeenCalled()
    expect(mocks.gate.onTabRemoved).not.toHaveBeenCalled()
    expect(mocks.executor.attach).not.toHaveBeenCalled()
    expect(chrome.tabs.remove).not.toHaveBeenCalled()
  })

  it.each(['openTab', 'switchTab', 'closeTab', 'listTabs'])('still completes uncancelled %s', async op => {
    command(op, 'normal', {tabId:'existing',url:'https://destination.example'})
    await vi.waitFor(() => expect(resultFor('normal')).toMatchObject({ok:true}))
    if (op === 'openTab' || op === 'switchTab') expect(mocks.executor.attach).toHaveBeenCalledOnce()
    if (op === 'closeTab') expect(chrome.tabs.remove).toHaveBeenCalledExactlyOnceWith(1)
    if (op === 'listTabs') expect(mocks.gate.registerFullTab).toHaveBeenCalledOnce()
  })
})
