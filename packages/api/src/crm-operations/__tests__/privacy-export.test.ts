import {EventEmitter} from 'node:events'
import type {Response} from 'express'
import {beforeEach,describe,expect,it,vi} from 'vitest'
import type {CrmOperationsContext} from '@use-brian/core'

const mocks=vi.hoisted(()=>({query:vi.fn(),release:vi.fn(),connect:vi.fn()}))
vi.mock('../../db/client.js',()=>({getPool:()=>({connect:mocks.connect,query:mocks.query})}))
import {streamCrmPrivacyExport,sendCrmPrivacyExport} from '../privacy-export.js'

const context:CrmOperationsContext={workspaceId:'11111111-1111-4111-8111-111111111111',actor:{kind:'user',userId:'22222222-2222-4222-8222-222222222222'},authority:{role:'owner',canConfigure:true,canWrite:true,trustedIdentitySources:[]}}
const rows=(values:unknown[]=[])=>({rows:values,rowCount:values.length})
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve))
class Output extends EventEmitter {
  headersSent=false
  chunks:string[]=[]
  pause=true
  write=vi.fn((line:string)=>{this.headersSent=true;this.chunks.push(line);return !this.pause})
  set=vi.fn()
  type=vi.fn()
  end=vi.fn()
  destroy=vi.fn(()=>this.emit('close'))
}
describe('[COMP:crm/privacy-export] Stream resource and failure contract',()=>{
  beforeEach(()=>{
    vi.resetAllMocks()
    mocks.connect.mockResolvedValue({query:mocks.query,release:mocks.release})
    mocks.query.mockImplementation(async(sql:string)=>{
      if(sql.includes('SELECT role FROM workspace_members'))return rows([{role:'owner'}])
      if(sql.includes('SELECT department_read_v2 FROM workspaces'))return rows([{department_read_v2:true}])
      if(sql.includes('transaction_timestamp()'))return rows([{snapshotAt:new Date('2026-01-01T00:00:00Z')}])
      return rows()
    })
  })
  it('rolls back a consumer return after the header and releases exactly once',async()=>{
    const stream=streamCrmPrivacyExport(context)
    expect((await stream.next()).value).toContain('"type":"header"')
    await stream.return(undefined)
    expect(mocks.query).toHaveBeenLastCalledWith('ROLLBACK')
    expect(mocks.query).not.toHaveBeenCalledWith('COMMIT')
    expect(mocks.release).toHaveBeenCalledTimes(1)
  })
  it('does not acquire a connection for an already cancelled request',async()=>{
    const abort=new AbortController();abort.abort()
    await expect(streamCrmPrivacyExport(context,{signal:abort.signal}).next()).rejects.toMatchObject({details:{reason:'privacy_export_cancelled'}})
    expect(mocks.connect).not.toHaveBeenCalled()
  })
  it('rolls back cancellation after the header without a success manifest',async()=>{
    const abort=new AbortController(),stream=streamCrmPrivacyExport(context,{signal:abort.signal})
    await stream.next();abort.abort()
    await expect(stream.next()).rejects.toMatchObject({details:{reason:'privacy_export_cancelled'}})
    expect(mocks.query).toHaveBeenLastCalledWith('ROLLBACK')
    expect(mocks.release).toHaveBeenCalledTimes(1)
  })
  it('bounds an oversized row without returning its data or a final manifest',async()=>{
    const original=mocks.query.getMockImplementation()!
    mocks.query.mockImplementation(async(sql:string)=>sql.startsWith('FETCH')?rows([{payload:null,bytes:67108865}]):original(sql))
    const stream=streamCrmPrivacyExport(context)
    await stream.next()
    await expect(stream.next()).rejects.toMatchObject({details:{reason:'privacy_export_row_too_large'}})
    expect(mocks.query).toHaveBeenLastCalledWith('ROLLBACK')
    expect(mocks.release).toHaveBeenCalledTimes(1)
  })
  it('emits success only after commit and hides database failure details',async()=>{
    const original=mocks.query.getMockImplementation()!
    mocks.query.mockImplementation(async(sql:string)=>{if(sql==='COMMIT')throw new Error('private row value');return original(sql)})
    const received:string[]=[]
    await expect((async()=>{for await(const line of streamCrmPrivacyExport(context))received.push(line)})()).rejects.toMatchObject({message:'CRM privacy export could not be completed.',details:{reason:'privacy_export_failed'}})
    expect(received.some(line=>line.includes('"type":"manifest"'))).toBe(false)
    expect(mocks.query).toHaveBeenLastCalledWith('ROLLBACK')
  })
  it('waits for HTTP backpressure before fetching rows and closes cleanly',async()=>{
    const res=new Output(),sent=sendCrmPrivacyExport(res as unknown as Response,context)
    await tick()
    expect(res.chunks).toHaveLength(1)
    expect(mocks.query.mock.calls.some(([sql])=>String(sql).startsWith('FETCH'))).toBe(false)
    res.pause=false;res.emit('drain');await sent
    expect(JSON.parse(res.chunks.at(-1)!)).toMatchObject({type:'manifest',complete:true})
    expect(res.end).toHaveBeenCalledTimes(1)
    expect(mocks.query).toHaveBeenLastCalledWith('COMMIT')
    expect(mocks.release).toHaveBeenCalledTimes(1)
  })
  it('cancels a disconnected HTTP consumer waiting for drain and releases its snapshot',async()=>{
    const res=new Output(),sent=sendCrmPrivacyExport(res as unknown as Response,context)
    await tick();res.emit('close');await sent
    expect(res.chunks).toHaveLength(1)
    expect(res.end).not.toHaveBeenCalled()
    expect(mocks.query).toHaveBeenLastCalledWith('ROLLBACK')
    expect(mocks.release).toHaveBeenCalledTimes(1)
    expect(res.listenerCount('close')).toBe(0)
  })
  it('renews owner authority before the manifest even when the workspace has no subject floor',async()=>{
    const stream=streamCrmPrivacyExport(context)
    expect((await stream.next()).value).toContain('"type":"header"')
    const original=mocks.query.getMockImplementation()!
    mocks.query.mockImplementation(async(sql:string)=>sql.includes('SELECT role FROM workspace_members')?rows([]):original(sql))
    await expect(stream.next()).rejects.toMatchObject({code:'not_authorized'})
    expect(mocks.query).not.toHaveBeenCalledWith('COMMIT')
    expect(mocks.query).toHaveBeenLastCalledWith('ROLLBACK')
    expect(mocks.release).toHaveBeenCalledTimes(1)
  })
  it('leaves headers untouched for an authorization failure',async()=>{
    const original=mocks.query.getMockImplementation()!
    mocks.query.mockImplementation(async(sql:string)=>sql.includes('SELECT role FROM workspace_members')?rows([{role:'member'}]):original(sql))
    const res=new Output()
    await expect(sendCrmPrivacyExport(res as unknown as Response,context)).rejects.toMatchObject({code:'not_authorized'})
    expect(res.set).not.toHaveBeenCalled()
    expect(res.write).not.toHaveBeenCalled()
    expect(mocks.release).toHaveBeenCalledTimes(1)
  })
})
