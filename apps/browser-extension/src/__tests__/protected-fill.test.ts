import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProtectedFill, LOCK_KEY, BROWSER_SESSION_KEY, validateFill, trustedApiBase, checkIdentity } from '../protected-fill.js'

const request = {
  workspaceId:'w', sessionId:'s', taskId:'t', browserProfileId:'p', destinationOrigin:'https://destination.example',
  items:[{referenceId:'a'.repeat(43),ref:'@e1'},{referenceId:'b'.repeat(43),ref:'@e2'}],
}
const token = (extra = {}) => `x.${btoa(JSON.stringify({kind:'browser-ext-session',userId:'u',workspaceId:'w',browserProfileId:'p',exp:Date.now()/1000+600,...extra}))}.x`
let data: Record<string, any>
let storage: any
const browserSessionId = '12345678-1234-1234-1234-123456789abc'
let sessionData: Record<string, any>
let fill: ProtectedFill
let tabs: Array<{id:number}>
beforeEach(() => {
  data = {sessionToken:token(),protectedApiBase:'https://trusted.example'}
  storage = {
    get:vi.fn(async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,data[k]]))),
    set:vi.fn(async (values:any) => { Object.assign(data,structuredClone(values)) }),
    remove:vi.fn(async (key:string) => { delete data[key] }),
  }
  sessionData = {[BROWSER_SESSION_KEY]:browserSessionId}
  tabs=[{id:1},{id:2}]
  vi.stubGlobal('chrome', {
    storage:{session:{
      get:vi.fn(async(key:string)=>({[key]:sessionData[key]})),
      set:vi.fn(async(values:any)=>{Object.assign(sessionData,values)}),
    }},
    action:{setBadgeText:vi.fn(async()=>{})},
    runtime:{getURL:(s:string)=>`chrome-extension://id/${s}`},
    windows:{create:vi.fn(async()=>{fill.approve(true)})},
    tabs:{query:vi.fn(async()=>tabs),remove:vi.fn(async(ids:number[])=>{tabs=tabs.filter(t=>!ids.includes(t.id))})},
  })
  fill = new ProtectedFill(storage)
})
describe('protected fill trust boundary', () => {
  it('accepts only exact bounded batches and HTTPS origins', () => {
    expect(validateFill(request)).toEqual(request)
    for (const bad of [
      {...request,url:'https://attacker.example'}, {...request,destinationOrigin:'https://destination.example/path'},
      {...request,destinationOrigin:'http://destination.example'}, {...request,items:[]},
      {...request,items:[request.items[0],request.items[0]]},
      {...request,items:[{...request.items[0],value:'sentinel'}]},
      {...request,items:Array(21).fill(request.items[0])},
    ]) expect(()=>validateFill(bad)).toThrow()
  })
  it('requires session identity, matching profile/workspace and expiry', () => {
    expect(()=>checkIdentity(token(),request)).not.toThrow()
    for (const extra of [{kind:'browser-ext-pair'},{browserProfileId:'other'},{workspaceId:'other'},{exp:0},{exp:null}]) {
      expect(()=>checkIdentity(token(extra),request)).toThrow()
    }
    for (const bad of ['http://evil.example','https://api.example/path','https://user:pass@api.example']) expect(()=>trustedApiBase(bad)).toThrow()
    expect(trustedApiBase('http://localhost:3000')).toBe('http://localhost:3000')
  })
  it('preflights before approval and durably locks before direct authenticated resolution; batch stays internal', async () => {
    const assign=vi.fn(async()=>{})
    const prepare=vi.fn(async()=>assign)
    vi.stubGlobal('fetch',vi.fn(async(url,options)=>{
      expect(data[LOCK_KEY]).toBeTruthy()
      expect(prepare).toHaveBeenCalledOnce()
      expect(url).toBe('https://trusted.example/api/protected-browser-fill/resolve')
      expect(options.headers.Authorization).toBe(`Bearer ${data.sessionToken}`)
      expect(options.redirect).toBe('error')
      return {ok:true,json:async()=>({items:request.items.map(i=>({ref:i.ref,value:'RAW_SENTINEL'}))})}
    }))
    const result=await fill.fill(request,()=>[1,2],prepare)
    expect(result).toEqual({status:'filled',filledCount:2,requiresHumanCompletion:true})
    expect(JSON.stringify(result)).not.toContain('RAW_SENTINEL')
    expect(assign.mock.calls.length).toBe(2)
    expect(await new ProtectedFill(storage).locked()).toBe(true)
    await expect(fill.fill(request,()=>[1],prepare)).rejects.toMatchObject({code:'protected_fill_denied'})
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('retains the lock on timeout, malformed response, or partial assignment and never echoes errors', async () => {
    for (const mode of ['timeout','malformed','partial']) {
      delete data[LOCK_KEY]
      vi.stubGlobal('fetch',vi.fn(async()=>{
        if(mode==='timeout') throw new Error('RAW_SENTINEL')
        return {ok:true,json:async()=>({items:mode==='malformed'?[]:request.items.map(i=>({ref:i.ref,value:'RAW_SENTINEL'}))})}
      }))
      await expect(fill.fill(request,()=>[1],async()=>async items=>{if(items.length) throw new Error('RAW_SENTINEL')})).rejects.toMatchObject({message:'Protected fill unavailable',code:'protected_fill_denied'})
      expect(await fill.locked()).toBe(true)
    }
  })
  it('denial and failed preflight never resolve but retain backend reservation cleanup lock', async () => {
    vi.stubGlobal('fetch',vi.fn())
    chrome.windows.create=vi.fn(async()=>{fill.approve(false)}) as any
    await expect(fill.fill(request,()=>[1],async()=>vi.fn())).rejects.toThrow('Protected fill unavailable')
    expect(await fill.locked()).toBe(true)
    delete data[LOCK_KEY]
    await expect(fill.fill(request,()=>[1],async()=>{throw new Error('page data')})).rejects.toThrow('Protected fill unavailable')
    expect(fetch).not.toHaveBeenCalled()
    expect(await fill.locked()).toBe(true)
  })
  it('clears only after all affected tabs close, detach and completion API succeed', async () => {
    data[LOCK_KEY]={browserSessionId,request,tabIds:[1,2],apiBase:'https://trusted.example',token:token()}
    const detach=vi.fn(async()=>{expect(tabs).toEqual([])})
    vi.stubGlobal('fetch',vi.fn(async(url,options)=>{
      expect(url).toBe('https://trusted.example/api/protected-browser-fill/complete')
      expect(JSON.parse(options.body)).toEqual({workspaceId:'w',sessionId:'s',taskId:'t',browserProfileId:'p'})
      expect(detach).toHaveBeenCalledOnce()
      expect(data[LOCK_KEY]).toBeTruthy()
      return {ok:true}
    }))
    await fill.complete(detach)
    expect(await fill.locked()).toBe(false)
  })
  it('failed close or completion retains persistent lock', async()=>{
    data[LOCK_KEY]={browserSessionId,request,tabIds:[1,2],apiBase:'https://trusted.example',token:token()}
    chrome.tabs.remove=vi.fn(async()=>{throw new Error('failed')}) as any
    vi.stubGlobal('fetch',vi.fn(async()=>({ok:false})))
    await expect(fill.complete(vi.fn())).rejects.toThrow('Protected fill unavailable')
    expect(fetch).not.toHaveBeenCalled()
    tabs=[]
    await expect(fill.complete(vi.fn())).rejects.toThrow('Protected fill unavailable')
    expect(await fill.locked()).toBe(true)
  })
})

describe('cleanup concurrency and same-identity renewal', () => {
  function lock() { data[LOCK_KEY]={browserSessionId,request,tabIds:[1],apiBase:'https://trusted.example',token:token()} }
  it('merges multiple concurrently tracked descendants without losing IDs', async () => {
    lock()
    fill.trackTab(2,1)
    fill.trackTab(3,2)
    fill.trackTab(4,1)
    tabs=[{id:1},{id:2},{id:3},{id:4}]
    vi.stubGlobal('fetch',vi.fn(async()=>({ok:true})))
    await fill.complete(vi.fn())
    expect(tabs).toEqual([])
    expect(await fill.locked()).toBe(false)
    fill.trackTab(5,1)
    await new Promise(resolve=>setTimeout(resolve,0))
    expect(await fill.locked()).toBe(false) // queued writers cannot resurrect removed state
  })
  it('closes and persists descendants arriving during the completion network await', async () => {
    lock(); tabs=[{id:1}]
    vi.stubGlobal('fetch',vi.fn(async()=>{
      tabs.push({id:7})
      fill.trackTab(7,1)
      await new Promise(resolve=>setTimeout(resolve,0))
      expect(data[LOCK_KEY].tabIds).toContain(7)
      return {ok:true}
    }))
    await fill.complete(vi.fn())
    expect(tabs).toEqual([])
    expect(await fill.locked()).toBe(false)
  })
  it('discovers opener descendants even without onCreated notification', async () => {
    lock(); tabs=[{id:1},{id:2,openerTabId:1},{id:3,openerTabId:2}] as any
    vi.stubGlobal('fetch',vi.fn(async()=>({ok:true})))
    await fill.complete(vi.fn())
    expect(tabs).toEqual([])
  })
  it('fails closed when descendant persistence fails', async () => {
    lock()
    storage.set.mockRejectedValueOnce(new Error('storage unavailable'))
    fill.trackTab(2,1)
    vi.stubGlobal('fetch',vi.fn())
    await new Promise(resolve=>setTimeout(resolve,0))
    await expect(fill.complete(vi.fn())).rejects.toThrow('Protected fill unavailable')
    expect(await fill.locked()).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('supports cleanup with renewed session JWT only for original user/workspace/profile', async () => {
    lock()
    data[LOCK_KEY].token=token({exp:1})
    const renewed=token({exp:Date.now()/1000+3600})
    await expect(fill.allowCredential(token({kind:'browser-ext-pair'}),'browser-ext-pair')).resolves.toBeUndefined()
    for(const extra of [{userId:'other'},{workspaceId:'other'},{browserProfileId:'other'}]) {
      await expect(fill.allowCredential(token({...extra,kind:'browser-ext-pair'}),'browser-ext-pair')).rejects.toThrow()
    }
    data.sessionToken=renewed
    vi.stubGlobal('fetch',vi.fn(async(_url,options)=>{
      expect(options.headers.Authorization).toBe(`Bearer ${renewed}`)
      return {ok:true}
    }))
    await fill.complete(vi.fn())
    expect(await fill.locked()).toBe(false)
  })
  it('never changes a pinned endpoint, but allows explicit setup for missing configuration', async () => {
    lock()
    await expect(fill.configureApi('https://other.example')).rejects.toThrow()
    data[LOCK_KEY].apiBase=''
    await fill.configureApi('https://configured.example')
    expect(data[LOCK_KEY].apiBase).toBe('https://configured.example')
    expect(data.protectedApiBase).toBe('https://configured.example')
  })
  it('keeps backend reservation recoverable when API setup is missing', async () => {
    delete data.protectedApiBase
    vi.stubGlobal('fetch',vi.fn())
    await expect(fill.fill(request,()=>[1],vi.fn())).rejects.toThrow()
    expect(await fill.locked()).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
    await fill.configureApi('https://trusted.example')
    vi.stubGlobal('fetch',vi.fn(async()=>({ok:true})))
    await fill.complete(vi.fn())
    expect(await fill.locked()).toBe(false)
  })
})

describe('browser-session cleanup identity', () => {
  function lock() { data[LOCK_KEY]={browserSessionId,request,tabIds:[1],apiBase:'https://trusted.example',token:token()} }
  function installRecoveryWindow() {
    chrome.windows.create = vi.fn(async () => {
      tabs.push({id:900})
      return {tabs:[{id:900}]}
    }) as any
    chrome.tabs.get = vi.fn(async id => {
      if (id !== 900 || !tabs.some(t=>t.id===900)) throw new Error('missing keeper')
      return {id:900,url:'chrome-extension://id/popup.html#protected-cleanup'}
    }) as any
  }
  it('binds disclosure to storage.session and retains it across service-worker restart', async () => {
    vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({items:request.items.map(i=>({ref:i.ref,value:'sentinel'}))})})))
    await fill.fill(request,()=>[1],async()=>vi.fn())
    expect(data[LOCK_KEY].browserSessionId).toBe(browserSessionId)
    const restartedWorker=new ProtectedFill(storage)
    expect(await restartedWorker.status()).toMatchObject({locked:true,needsSessionRecovery:false})
    vi.stubGlobal('fetch',vi.fn(async()=>({ok:true})))
    await restartedWorker.complete(vi.fn())
    expect(tabs).toEqual([{id:2}]) // unrelated tab is preserved in same browser session
    expect(await restartedWorker.locked()).toBe(false)
  })
  it.each(['missing','changed','legacy'] as const)('fails closed for %s identity: missing numeric IDs never prove restored protected tabs are closed', async mode => {
    lock()
    tabs=[{id:101}] // protected page restored under a different numeric tab ID
    if(mode==='missing') delete sessionData[BROWSER_SESSION_KEY]
    if(mode==='changed') sessionData[BROWSER_SESSION_KEY]='87654321-4321-4321-4321-cba987654321'
    if(mode==='legacy') delete data[LOCK_KEY].browserSessionId
    const restartedWorker=new ProtectedFill(storage)
    vi.stubGlobal('fetch',vi.fn())
    expect(await restartedWorker.status()).toMatchObject({locked:true,needsSessionRecovery:true})
    await expect(restartedWorker.complete(vi.fn())).rejects.toThrow('Protected fill unavailable')
    expect(chrome.tabs.remove).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(tabs).toEqual([{id:101}])
    expect(await restartedWorker.locked()).toBe(true)
  })
  it('does not close unrelated tabs that reuse old IDs, or track their descendants after restart', async () => {
    lock(); delete sessionData[BROWSER_SESSION_KEY]
    tabs=[{id:1},{id:2}] // ID 1 now belongs to unrelated page
    fill.trackTab(2,1)
    await expect(fill.complete(vi.fn())).rejects.toThrow()
    expect(data[LOCK_KEY].tabIds).toEqual([1])
    expect(chrome.tabs.remove).not.toHaveBeenCalled()
  })
  it('does not disclose when browser-session persistence is unavailable', async () => {
    delete sessionData[BROWSER_SESSION_KEY]
    chrome.storage.session.set=vi.fn(async()=>{throw new Error('storage failed')}) as any
    vi.stubGlobal('fetch',vi.fn())
    await expect(fill.fill(request,()=>[1],vi.fn())).rejects.toThrow('Protected fill unavailable')
    expect(fetch).not.toHaveBeenCalled()
    expect(await fill.status()).toMatchObject({locked:true,needsSessionRecovery:true})
  })
  it('requires explicit broad approval, closes restored AND unrelated tabs, retains a known-clean extension window, then completes', async () => {
    lock(); delete sessionData[BROWSER_SESSION_KEY]
    tabs=[{id:101},{id:202}]
    installRecoveryWindow()
    vi.stubGlobal('fetch',vi.fn(async()=>{
      expect(tabs).toEqual([{id:900}])
      expect(data[LOCK_KEY].browserSessionId).toBe(browserSessionId) // never rebind stale IDs
      return {ok:true}
    }))
    await expect(fill.complete(vi.fn())).rejects.toThrow()
    expect(chrome.tabs.remove).not.toHaveBeenCalled()
    await fill.complete(vi.fn(),true)
    expect(fetch).toHaveBeenCalledOnce()
    expect(tabs).toEqual([{id:900}])
    expect(await fill.locked()).toBe(false)
  })
  it('failed broad cleanup retains original identity and requires fresh explicit approval on retry', async () => {
    lock(); delete sessionData[BROWSER_SESSION_KEY]
    installRecoveryWindow()
    vi.stubGlobal('fetch',vi.fn(async()=>({ok:false})))
    await expect(fill.complete(vi.fn(),true)).rejects.toThrow()
    expect(await fill.status()).toMatchObject({locked:true,needsSessionRecovery:true})
    expect(data[LOCK_KEY].browserSessionId).toBe(browserSessionId)
    const closes=vi.mocked(chrome.tabs.remove).mock.calls.length
    tabs.push({id:303})
    await expect(new ProtectedFill(storage).complete(vi.fn())).rejects.toThrow()
    expect(chrome.tabs.remove).toHaveBeenCalledTimes(closes)
    expect(tabs.some(t=>t.id===303)).toBe(true)
  })
  it('failed tab closure or changed session during broad cleanup cannot call completion', async () => {
    lock(); delete sessionData[BROWSER_SESSION_KEY]
    installRecoveryWindow()
    chrome.tabs.remove=vi.fn(async()=>{throw new Error('failed close')}) as any
    vi.stubGlobal('fetch',vi.fn())
    await expect(fill.complete(vi.fn(),true)).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
    expect(await fill.locked()).toBe(true)
    chrome.tabs.remove=vi.fn(async()=>{tabs=[{id:900}]; delete sessionData[BROWSER_SESSION_KEY]}) as any
    await expect(fill.complete(vi.fn(),true)).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
    expect(await fill.locked()).toBe(true)
  })
})

describe('server-only reservation recovery', () => {
  it.each(['none','cancelled'])('accepts authenticated server status %s without creating a local disclosure lock or closing tabs', async status => {
    vi.stubGlobal('fetch',vi.fn(async(url,options)=>{
      expect(url).toBe('https://trusted.example/api/protected-browser-fill/recover')
      expect(options.headers.Authorization).toBe(`Bearer ${data.sessionToken}`)
      expect(JSON.parse(options.body)).toEqual({workspaceId:'w',browserProfileId:'p'})
      return {ok:true,json:async()=>({status})}
    }))
    expect(await fill.recoverServer()).toBe(status)
    expect(await fill.locked()).toBe(false)
    expect(chrome.tabs.remove).not.toHaveBeenCalled()
  })
  it('imports uncertain disclosure without session/tab provenance and requires broad recovery', async () => {
    vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({status:'cleanup_required',request})})))
    expect(await fill.recoverServer()).toBe('cleanup_required')
    expect(data[LOCK_KEY].browserSessionId).toBeUndefined()
    expect(data[LOCK_KEY].tabIds).toEqual([])
    expect(await fill.status()).toMatchObject({locked:true,needsSessionRecovery:true})
    await expect(fill.complete(vi.fn())).rejects.toThrow('Protected fill unavailable')
    expect(fetch).toHaveBeenCalledOnce()
    expect(chrome.tabs.remove).not.toHaveBeenCalled()
    expect(await fill.locked()).toBe(true)
  })
  it('never clears or rebinds an existing local lock even if backend restarted', async () => {
    data[LOCK_KEY]={browserSessionId,request,tabIds:[1],apiBase:'https://trusted.example',token:token()}
    vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({status:'none'})})))
    await expect(fill.recoverServer()).rejects.toThrow('Protected fill unavailable')
    expect(fetch).not.toHaveBeenCalled()
    expect(await fill.locked()).toBe(true)
  })
  it.each(['wrongProfile','malformed','network','storage'])('fails closed on %s recovery without exposing response errors', async mode => {
    vi.stubGlobal('fetch',vi.fn(async()=>{
      if(mode==='network') throw new Error('SECRET_SENTINEL')
      return {ok:true,json:async()=>mode==='malformed'?{status:'cancelled',value:'SECRET_SENTINEL'}:
        {status:'cleanup_required',request:mode==='wrongProfile'?{...request,browserProfileId:'other'}:request}}
    }))
    if(mode==='storage') storage.set.mockRejectedValueOnce(new Error('SECRET_SENTINEL'))
    await expect(fill.recoverServer()).rejects.toMatchObject({message:'Protected fill unavailable',code:'protected_fill_denied'})
    expect(chrome.tabs.remove).not.toHaveBeenCalled()
  })
})
