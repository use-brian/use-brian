import { describe, it, expect, vi } from 'vitest'
import { webcrypto, createHash } from 'node:crypto'
import { setImmediate as flush } from 'node:timers/promises'
import { createApplicationClient, createFetchTransport, createApplicationSignIn, createHomeApplicationTransport, ApplicationSdkError } from '../application.js'
import { createNativeSchemaPorts, createServiceTransport } from '../module.js'
const app = '00000000-0000-4000-8000-000000000001', workspace = '00000000-0000-4000-8000-000000000002', home = '00000000-0000-4000-8000-000000000003'
const origin = 'https://brain.example', oauth = `oat_${app}_${'s'.repeat(43)}`
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
describe('[COMP:shared/brian-app-sdk] application client', () => {
  it('K02 maps every maintained route/input and preserves opaque versions, fields, evidence and receipts', async () => {
    const response = { ref: { version: 'opaque/v7' }, fields: ['title'], absentFields: ['optional'], sourceEvidence: { id: 'source-proof' }, receipt: { effect: 'committed' } }
    const fetch = vi.fn(async () => reply(response)), transport = createFetchTransport({ apiOrigin: origin, fetch, credential: async () => oauth })
    const client = createApplicationClient({ appId: app, transport }), signal = new AbortController().signal
    const query = { fields: ['title'], filters: [], sort: [], aggregate: [], limit: 3 }, command = { idempotencyKey: 'once', expectedVersion: 'opaque/v7', input: { title: 'Test' } }
    const results = await Promise.all([client.catalog(), client.schema('item'), client.get('item','id/slash'), client.query('item',query),
      client.history('item','id','old/version'), client.registeredQuery('lookup',{ id: 'x' }), client.command('change',command,{signal})])
    expect(results).toEqual(Array(7).fill(response))
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(['catalog','schemas/item','records/item/id%2Fslash','records/item/query',
      'records/item/id/history?beforeVersion=old%2Fversion','queries/lookup','commands/change'].map(path => `${origin}/api/applications/${app}/${path}`))
    const init = fetch.mock.calls[6][1]!
    expect(init).toMatchObject({ method: 'POST', signal, cache: 'no-store', credentials: 'same-origin', redirect: 'error', headers: { Authorization: `Bearer ${oauth}` } })
    expect(JSON.parse(String(init.body))).toEqual(command)
    expect(JSON.parse(String(fetch.mock.calls[3][1]!.body))).toEqual(query)
    await expect(client.previewSchema({typeId:home,expectedVersion:1,properties:[]})).rejects.toMatchObject({code:'operation_not_available'})
    await expect(client.applySchema({previewId:home})).rejects.toMatchObject({code:'operation_not_available'})
    expect(fetch).toHaveBeenCalledTimes(7)
    const previewResult={id:home,entityTypeId:home,expectedSchemaVersion:1,before:[],proposed:[],affectedRecords:0,invalidRecords:0,canApply:true}
    const applied={entityTypeId:home,schemaVersion:2,applied:true}
    const preview=vi.fn(async()=>previewResult),apply=vi.fn(async()=>applied), configured=createApplicationClient({appId:app,transport,schemas:{preview,apply}})
    expect(await configured.previewSchema({typeId:home,expectedVersion:1,properties:[]})).toBe(previewResult)
    expect(await configured.applySchema({previewId:home})).toBe(applied)
  })
  it.each(['access_unavailable','source_unavailable','outcome_uncertain','grant_revoked'])('K02 surfaces safe typed %s without a write retry', async code => {
    const fetch = vi.fn(async () => reply({ error: code, effect: 'uncertain', retrySafe: true, secret: 'private exception' }, 403))
    const client=createApplicationClient({ appId:app,transport:createFetchTransport({apiOrigin:origin,fetch,credential:async()=>oauth}) })
    const failure=await client.command('change',{idempotencyKey:'once',input:{}}).catch(e=>e)
    expect(failure).toBeInstanceOf(ApplicationSdkError);expect(failure).toMatchObject({code,effect:'uncertain',retrySafe:false,status:403})
    expect(String(failure)).not.toContain('private exception');expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('K02 preserves committed effect metadata and denial without inventing a retry',async()=>{
    const fetch=vi.fn(async()=>reply({error:'grant_revoked',effect:'committed',retrySafe:false},403))
    const client=createApplicationClient({appId:app,transport:createFetchTransport({apiOrigin:origin,fetch,credential:async()=>oauth})})
    await expect(client.command('change',{idempotencyKey:'once',input:{}})).rejects.toMatchObject({effect:'committed',retrySafe:false})
    fetch.mockImplementation(async()=>reply({error:'access_unavailable',effect:'none',retrySafe:true},403))
    await expect(client.catalog()).rejects.toMatchObject({effect:'none',retrySafe:true})
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('K02 preserves the query page, opaque cursor and lossless aggregate envelope',async()=>{
    const page={records:[{ref:{workspaceId:workspace,origin:{kind:'native',moduleKey:'example_module'},typeKey:'deal',id:home,version:'opaque/v1'},values:{amount:'123456789.123456789'},fields:['amount'],absentFields:[],policyVersion:'policy/v1'}],nextCursor:'opaque/page',aggregates:[{field:'amount',operation:'sum',value:'123456789.123456789'}],sourceEvidence:{id:'query-proof'}}
    const transport=vi.fn(async()=>page),client=createApplicationClient({appId:app,transport})
    const result=await client.query('deal',{fields:['amount'],filters:[],sort:[],aggregate:[{field:'amount',operation:'sum'}],limit:10})
    expect(result).toBe(page)
    expect(result.records[0].ref.version).toBe('opaque/v1')
    expect(result.nextCursor).toBe('opaque/page')
    expect(result.aggregates?.[0].value).toBe('123456789.123456789')
    expect(transport).toHaveBeenCalledTimes(1)
  })
  it('K02 treats disconnected, malformed and cancelled writes after dispatch as uncertain; pre-abort sends nothing', async()=>{
    const abort=new AbortController(), fetch=vi.fn(async()=>{abort.abort();throw new Error('private')})
    const client=createApplicationClient({appId:app,transport:createFetchTransport({apiOrigin:origin,fetch,credential:async()=>oauth})})
    await expect(client.command('change',{idempotencyKey:'once',input:{}},{signal:abort.signal})).rejects.toMatchObject({effect:'uncertain',cancelled:true,retrySafe:false})
    await expect(client.command('change',{idempotencyKey:'once',input:{}},{signal:abort.signal})).rejects.toMatchObject({effect:'none',cancelled:true})
    expect(fetch).toHaveBeenCalledTimes(1)
    fetch.mockImplementation(async()=>new Response('not json'))
    await expect(client.command('change',{idempotencyKey:'once',input:{}})).rejects.toMatchObject({code:'invalid_response',effect:'uncertain'})
  })
  it('K02 makes response-body cancellation and schema-port pre-abort explicit',async()=>{
    const abort=new AbortController(), fetch=vi.fn(async()=>({ok:true,status:200,json:async()=>{abort.abort();throw new Error('private stream failure')}} as Response))
    const preview=vi.fn(),apply=vi.fn(), client=createApplicationClient({appId:app,transport:createFetchTransport({apiOrigin:origin,fetch,credential:async()=>oauth}),schemas:{preview,apply}})
    await expect(client.command('change',{idempotencyKey:'once',input:{}},{signal:abort.signal})).rejects.toMatchObject({code:'cancelled',cancelled:true,effect:'uncertain'})
    await expect(client.applySchema({previewId:home},{signal:abort.signal})).rejects.toMatchObject({code:'cancelled',effect:'none'})
    await expect(client.previewSchema({typeId:home,expectedVersion:1,properties:[]},{signal:abort.signal})).rejects.toMatchObject({code:'cancelled',effect:'none'})
    expect(preview).not.toHaveBeenCalled();expect(apply).not.toHaveBeenCalled()
  })
  it.each(['browser','service','delegated'] as const)('K02 cancels pending %s credentials before dispatch and ignores their late outcome',async profile=>{
    const abort=new AbortController(),fetch=vi.fn()
    let start!:()=>void,release!:()=>void,fail!:(error:Error)=>void,received:AbortSignal|undefined
    const ready=new Promise<void>(resolve=>{start=resolve})
    const credential=new Promise<void>((resolve,reject)=>{release=resolve;fail=reject})
    const supply=async(call?:{signal?:AbortSignal})=>{received=call?.signal;start();await credential}
    const transport=profile==='browser'
      ?createFetchTransport({apiOrigin:origin,fetch,credential:async(_app,call)=>{await supply(call);return oauth}})
      :createServiceTransport({apiOrigin:origin,fetch,credential:async call=>{
        await supply(call)
        return profile==='delegated'?{kind:'delegated',token:'sk_app_fixture',userAuthorization:oauth}:{kind:'service',token:'sk_app_fixture'}
      }})
    let settled=false
    const pending=createApplicationClient({appId:app,transport}).command('change',{idempotencyKey:'once',input:{}},{signal:abort.signal}).catch(error=>{settled=true;return error})
    await ready;abort.abort();await flush()
    const promptly=settled
    if(profile==='delegated')fail(new Error('private credential rejection'))
    else release()
    const error=await pending;await flush()
    expect(promptly).toBe(true)
    expect(received).toBe(abort.signal)
    expect(error).toMatchObject({code:'cancelled',effect:'none',cancelled:true,retrySafe:false})
    expect(String(error)).not.toContain('private credential rejection')
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each(['sk_app_secret','native.jwt.token','cookie=value','oat_bad\r\nInjected: true'])('K03 rejects non-app browser credential %s',async token=>{
    const fetch=vi.fn(); const client=createApplicationClient({appId:app,transport:createFetchTransport({apiOrigin:origin,fetch,credential:async()=>token})})
    await expect(client.catalog()).rejects.toMatchObject({code:'authentication_required'});expect(fetch).not.toHaveBeenCalled()
  })
  it('K03 server service/delegated profile has no arbitrary user-ID adapter',async()=>{
    const fetch=vi.fn(async()=>reply({ok:true})), service=createServiceTransport({apiOrigin:origin,fetch,credential:async()=>({kind:'service',token:'sk_app_synthetic'})})
    await createApplicationClient({appId:app,transport:service}).catalog()
    expect(fetch.mock.calls[0][1]!.headers).toEqual({Authorization:'Bearer sk_app_synthetic'})
    const delegated=createServiceTransport({apiOrigin:origin,fetch,credential:async()=>({kind:'delegated',token:'sk_app_synthetic',userAuthorization:oauth})})
    await createApplicationClient({appId:app,transport:delegated}).catalog()
    expect(fetch.mock.calls[1][1]!.headers).toMatchObject({'X-UseBrian-User-Authorization':`Bearer ${oauth}`})
  })
})
describe('[COMP:shared/brian-app-sdk] authentication adapters',()=>{
  it('K03 cannot revive a cancelled login while its PKCE digest is pending',async()=>{
    const fetch=vi.fn(),login=createApplicationSignIn({appId:app,clientId:'public',apiOrigin:origin,redirectUri:'https://portal.example/callback',crypto:webcrypto as unknown as Crypto,fetch})
    const opening=login.begin();login.cancel()
    await expect(opening).rejects.toMatchObject({code:'cancelled',effect:'none',cancelled:true})
    expect(fetch).not.toHaveBeenCalled()
  })
  it('K03 keeps the newest login when an earlier PKCE digest completes late',async()=>{
    const releases:Array<()=>Promise<void>>=[]
    const crypto={getRandomValues:webcrypto.getRandomValues.bind(webcrypto),subtle:{digest:(algorithm:AlgorithmIdentifier,bytes:BufferSource)=>{
      const digest=webcrypto.subtle.digest(algorithm,bytes as ArrayBuffer)
      return new Promise<ArrayBuffer>(resolve=>{releases.push(async()=>{resolve(await digest)})})
    }}} as unknown as Crypto
    const fetch=vi.fn(async()=>reply({token_type:'Bearer',access_token:oauth,expires_in:300}))
    const login=createApplicationSignIn({appId:app,clientId:'public',apiOrigin:origin,redirectUri:'https://portal.example/callback',crypto,fetch})
    const first=login.begin().catch(error=>error),second=login.begin()
    await releases[1]();const latest=await second;await releases[0]()
    expect(await first).toMatchObject({code:'cancelled',effect:'none'})
    const state=new URL(latest.authorizationUrl).searchParams.get('state')
    expect(await login.complete(`https://portal.example/callback?code=synthetic-code&state=${state}`)).toMatchObject({accessToken:oauth})
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each(['signal','cancel'] as const)('K03 withholds a login token after %s during response-body consumption',async mode=>{
    let start!:()=>void,release!:(value:unknown)=>void,fail!:(error:Error)=>void
    const ready=new Promise<void>(resolve=>{start=resolve})
    const body=new Promise<unknown>((resolve,reject)=>{release=resolve;fail=reject})
    const fetch=vi.fn(async()=>({ok:true,status:200,json:()=>{start();return body}} as Response))
    const login=createApplicationSignIn({appId:app,clientId:'public',apiOrigin:origin,redirectUri:'https://portal.example/callback',crypto:webcrypto as unknown as Crypto,fetch})
    const {authorizationUrl}=await login.begin(),state=new URL(authorizationUrl).searchParams.get('state'),abort=new AbortController()
    const completing=login.complete(`https://portal.example/callback?code=synthetic-code&state=${state}`,{signal:abort.signal})
    await ready
    if(mode==='signal'){abort.abort();release({token_type:'Bearer',access_token:oauth,expires_in:300})}
    else {login.cancel();fail(new Error('private token response failure'))}
    await expect(completing).rejects.toMatchObject({code:'cancelled',effect:'none',cancelled:true,retrySafe:false})
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('K03 uses app-audience S256/consent and a one-use exact redirect/state verifier',async()=>{
    const fetch=vi.fn(async()=>reply({access_token:oauth,token_type:'Bearer',expires_in:3600}))
    const login=createApplicationSignIn({apiOrigin:origin,appId:app,clientId:'registered-app',redirectUri:'https://portal.example/callback',crypto:webcrypto as Crypto,fetch})
    const {authorizationUrl}=await login.begin(),url=new URL(authorizationUrl)
    expect(url.pathname).toBe(`/api/applications/${app}/authorize`);expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    const callback=`https://portal.example/callback?code=one-use&state=${url.searchParams.get('state')}`
    expect(await login.complete(callback)).toEqual({accessToken:oauth,expiresIn:3600})
    const params=new URLSearchParams(String(fetch.mock.calls[0][1]!.body))
    expect(createHash('sha256').update(params.get('code_verifier')!).digest('base64url')).toBe(url.searchParams.get('code_challenge'))
    expect(params.get('client_id')).toBe('registered-app');expect(params.has('userId')).toBe(false);expect(params.has('client_secret')).toBe(false)
    await expect(login.complete(callback)).rejects.toMatchObject({code:'invalid_callback'});expect(fetch).toHaveBeenCalledTimes(1)
    for(const bad of ['https://foreign.example/callback','https://portal.example/wrong','https://portal.example/callback?state=wrong']){
      const fresh=await login.begin();const state=new URL(fresh.authorizationUrl).searchParams.get('state')
      await expect(login.complete(`${bad}${bad.includes('?')?'&':'?'}code=x&state=${state}`)).rejects.toBeInstanceOf(ApplicationSdkError)
    }
    await login.begin();login.cancel();await expect(login.complete(callback)).rejects.toMatchObject({code:'invalid_callback'})
  })
  it('K03 binds popup callbacks to the opened window and exact redirect origin/app audience',async()=>{
    const fetch=vi.fn(async()=>reply({access_token:oauth,token_type:'Bearer',expires_in:3600})),popup={} as Window
    const login=createApplicationSignIn({apiOrigin:origin,appId:app,clientId:'public',redirectUri:'https://portal.example/callback',crypto:webcrypto as Crypto,fetch})
    const url=new URL((await login.begin({popup})).authorizationUrl), data={type:'ub:application:callback',appId:app,url:`https://portal.example/callback?code=x&state=${url.searchParams.get('state')}`}
    for(const event of [{source:{},origin:'https://portal.example',data},{source:popup,origin:'https://foreign.example',data},{source:popup,origin:'https://portal.example',data:{...data,appId:home}}])
      await expect(login.completeFromMessage(event as MessageEvent)).rejects.toMatchObject({code:'invalid_callback'})
    expect(fetch).not.toHaveBeenCalled()
    expect(await login.completeFromMessage({source:popup,origin:'https://portal.example',data} as MessageEvent)).toMatchObject({accessToken:oauth})
  })
  function fakeFrame(){
    const listeners=new Set<(e:MessageEvent)=>void>(), parent={postMessage:vi.fn()}
    const frame={parent,addEventListener:(_name:string,fn:(e:MessageEvent)=>void)=>listeners.add(fn),removeEventListener:(_name:string,fn:(e:MessageEvent)=>void)=>listeners.delete(fn)} as unknown as Window
    return{frame,parent,listeners,emit:(data:unknown,source:unknown=parent,eventOrigin=origin)=>{for(const listener of [...listeners])listener({data,source,origin:eventOrigin} as MessageEvent)}}
  }
  it('K02 uses the native schema routes and canonical review envelopes without app credentials',async()=>{
    const preview={id:home,entityTypeId:app,expectedSchemaVersion:7,before:[],proposed:[],affectedRecords:12,invalidRecords:2,canApply:false}
    const applied={entityTypeId:app,schemaVersion:8,applied:true}
    const nativeFetch=vi.fn(async()=>reply(preview)),appTransport=vi.fn()
    const schemas=createNativeSchemaPorts({apiOrigin:origin,workspaceId:workspace,fetch:nativeFetch})
    const client=createApplicationClient({appId:app,transport:appTransport,schemas}),signal=new AbortController().signal
    expect(await client.previewSchema({typeId:app,expectedVersion:7,properties:[],assistantId:home},{signal})).toEqual(preview)
    nativeFetch.mockImplementation(async()=>reply(applied))
    expect(await client.applySchema({previewId:home,assistantId:home},{signal})).toEqual(applied)
    expect(nativeFetch.mock.calls.map(([url])=>String(url))).toEqual([
      `${origin}/api/applications/workspaces/${workspace}/schemas/${app}/preview`,
      `${origin}/api/applications/workspaces/${workspace}/schema-reviews/${home}/apply`])
    expect(nativeFetch.mock.calls.map(([,init])=>JSON.parse(String(init!.body)))).toEqual([
      {expectedVersion:7,properties:[],assistantId:home},{assistantId:home}])
    for(const [,init]of nativeFetch.mock.calls)expect(init).toMatchObject({method:'POST',signal,cache:'no-store',credentials:'same-origin',redirect:'error',headers:{'Content-Type':'application/json'}})
    expect(appTransport).not.toHaveBeenCalled()
  })
  it('K02 keeps native schema cancellation, uncertain writes and review reconciliation explicit',async()=>{
    const fetch=vi.fn(async()=>{throw new Error('private native session detail')})
    const schemas=createNativeSchemaPorts({apiOrigin:origin,workspaceId:workspace,fetch})
    await expect(schemas.preview({typeId:app,expectedVersion:1,properties:[]})).rejects.toMatchObject({code:'transport_unavailable',effect:'uncertain',retrySafe:false})
    const abort=new AbortController();abort.abort()
    await expect(schemas.apply({previewId:home},{signal:abort.signal})).rejects.toMatchObject({code:'cancelled',effect:'none'})
    expect(fetch).toHaveBeenCalledTimes(1)
    fetch.mockImplementation(async()=>reply({error:'schema_version_conflict',effect:'none',retrySafe:false},409))
    await expect(schemas.apply({previewId:home})).rejects.toMatchObject({code:'schema_version_conflict',effect:'none',status:409,retrySafe:false})
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(()=>createNativeSchemaPorts({apiOrigin:origin,workspaceId:'../escape',fetch})).toThrow(ApplicationSdkError)
    await expect(schemas.apply({previewId:'../escape'})).rejects.toMatchObject({code:'invalid_value'})
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('K03 preserves signed Home budget denial without a retry or Origin override',async()=>{
    const f=fakeFrame(),fetch=vi.fn(async()=>reply({error:'access_unavailable',effect:'none',retrySafe:false},429))
    const bridge=createHomeApplicationTransport({apiOrigin:origin,hostOrigin:origin,appId:app,homeAppId:home,workspaceId:workspace,window:f.frame,fetch})
    const pending=createApplicationClient({appId:app,transport:bridge.transport}).catalog()
    f.emit({type:'ub:token',token:'opaque.signature',apiOrigin:origin,appId:home,workspaceId:workspace})
    await expect(pending).rejects.toMatchObject({code:'access_unavailable',effect:'none',status:429,retrySafe:false})
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][1]!.headers).toEqual({Authorization:'Bearer opaque.signature'})
    bridge.dispose()
  })
  it('K03 accepts Home tokens only from exact parent/host/Home/workspace/API binding and disposes pending calls',async()=>{
    const f=fakeFrame(),fetch=vi.fn(async()=>reply({fields:['title']}))
    const bridge=createHomeApplicationTransport({apiOrigin:origin,hostOrigin:origin,appId:app,homeAppId:home,workspaceId:workspace,window:f.frame,fetch})
    const pending=createApplicationClient({appId:app,transport:bridge.transport}).catalog()
    const data={type:'ub:token',token:'opaque.signature',apiOrigin:origin,appId:home,workspaceId:workspace}
    f.emit(data,{});f.emit(data,f.parent,'https://foreign.example');f.emit({...data,workspaceId:app});f.emit({...data,apiOrigin:'https://foreign.example'})
    await Promise.resolve();expect(fetch).not.toHaveBeenCalled()
    f.emit(data);expect(await pending).toEqual({fields:['title']});expect(fetch.mock.calls[0][1]!.headers).toEqual({Authorization:'Bearer opaque.signature'})
    expect(f.parent.postMessage).toHaveBeenCalledWith({type:'ub:ready'},origin)
    const cancelled=createApplicationClient({appId:app,transport:bridge.transport}).catalog();bridge.dispose()
    await expect(cancelled).rejects.toMatchObject({cancelled:true});expect(f.listeners.size).toBe(0)
  })
})
