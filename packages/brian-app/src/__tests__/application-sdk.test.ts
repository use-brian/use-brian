import { describe, it, expect, vi } from 'vitest'
import { webcrypto, createHash } from 'node:crypto'
import { createApplicationClient, createFetchTransport, createApplicationSignIn, createHomeApplicationTransport, ApplicationSdkError } from '../application.js'
import { createServiceTransport } from '../module.js'
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
    await expect(client.previewSchema({})).rejects.toMatchObject({code:'operation_not_available'})
    await expect(client.applySchema(command)).rejects.toMatchObject({code:'operation_not_available'})
    expect(fetch).toHaveBeenCalledTimes(7)
    const preview=vi.fn(async input=>input),apply=vi.fn(async input=>input), configured=createApplicationClient({appId:app,transport,schemas:{preview,apply}})
    expect(await configured.previewSchema({expectedVersion:'v1'})).toEqual({expectedVersion:'v1'})
    expect(await configured.applySchema(command)).toEqual(command)
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
    await expect(client.applySchema({idempotencyKey:'once',input:{}},{signal:abort.signal})).rejects.toMatchObject({code:'cancelled',effect:'none'})
    await expect(client.previewSchema({},{signal:abort.signal})).rejects.toMatchObject({code:'cancelled',effect:'none'})
    expect(preview).not.toHaveBeenCalled();expect(apply).not.toHaveBeenCalled()
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
