import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import type {Response} from 'express'
import {officeProjectionHeaderLifetime,officeProjectionQuery,readOfficeProjection} from '../office-read-projection.js'
import {sendOfficeMetadata} from '../../routes/office-metadata.js'

const state=vi.hoisted(()=>({now:0,readDelay:100,queryDelay:200,cleanupDelay:0,ttl:500,reads:0,changed:false}))
const query=vi.hoisted(()=>vi.fn())
vi.mock('../client.js',()=>({
  getAppPool:()=>({connect:async()=>({query})}),
  applyRLSGucs:async()=>{},
  rollbackAndRelease:async()=>{state.now+=state.cleanupDelay},
}))

async function read(cap?:number){
  const result=await officeProjectionQuery('viewer')!< {title:string}>('viewer','SELECT title FROM fixture',[])
  return {workspaceId:'workspace',body:result.rows[0],...(cap===undefined?{}:{validForMs:cap})}
}
function transport(){
  const headers=new Map<string,string>();let status=200,body=''
  const res={
    setHeader:(name:string,value:string)=>{headers.set(name,value)},
    append:vi.fn(),
    status:(value:number)=>{status=value;return res},
    type:()=>res,
    end:(value:string)=>{body=value;return res},
  }
  return {res:res as unknown as Response,headers,result:()=>({status,body:JSON.parse(body)})}
}

beforeEach(()=>{
  Object.assign(state,{now:0,readDelay:100,queryDelay:200,cleanupDelay:0,ttl:500,reads:0,changed:false})
  vi.spyOn(performance,'now').mockImplementation(()=>state.now)
  query.mockReset().mockImplementation(async(sql:string)=>{
    if(sql==='SELECT title FROM fixture'){
      state.reads++
      if(state.reads===1)state.now+=state.readDelay
      return {rows:[{title:state.changed&&state.reads>1?'Changed':'Protected fixture'}]}
    }
    if(sql.startsWith('SELECT department_media_valid_for_ms')){
      state.now+=state.queryDelay
      return {rows:[{ttl:state.ttl}]}
    }
    return {rows:[]}
  })
})
afterEach(()=>vi.restoreAllMocks())

describe('[COMP:api/office-routes] metadata request-origin lifetime',()=>{
  it('leaves a slow browser read renewable without changing internal remaining lifetime',async()=>{
    Object.assign(state,{readDelay:9000,queryDelay:200,ttl:27000})
    const result=await readOfficeProjection('viewer',()=>read())
    expect(result.validForMs).toBe(17800)
    const header=officeProjectionHeaderLifetime(result)!
    expect(header).toBe(30000)
    // The browser keeps subtracting its complete request and body duration.
    expect(header-10456).toBe(19544)
    expect(JSON.stringify(result)).not.toMatch(/started|allowance|requestOrigin/)
  })
  it('samples before lifetime SQL so query response time cannot extend grant expiry',async()=>{
    const result=await readOfficeProjection('viewer',()=>read())
    expect(result.validForMs).toBe(200)
    expect(officeProjectionHeaderLifetime(result)).toBe(600)
    // SQL TTL500 at the pre-query sample100 bounds the deadline to600.
    state.now=600
    expect(officeProjectionHeaderLifetime(result)).toBe(0)
  })
  it.each([0,-1,NaN,Infinity])('does not resurrect invalid/expired SQL lifetime %s',async ttl=>{
    state.ttl=ttl
    expect(await readOfficeProjection('viewer',()=>read())).toEqual({status:404,body:{error:'Office metadata unavailable'}})
  })
  it('does not refresh the lifetime of an earlier protected dependency',async()=>{
    state.ttl=30000
    const result=await readOfficeProjection('viewer',()=>read(750))
    expect(result.validForMs).toBe(450)
    expect(officeProjectionHeaderLifetime(result)).toBe(750)
  })
  it('withholds body and header when transaction cleanup crosses the deadline',async()=>{
    state.cleanupDelay=301
    const t=transport()
    await sendOfficeMetadata(t.res,'viewer',()=>read())
    expect(t.result()).toEqual({status:404,body:{error:'Office metadata unavailable'}})
    expect(t.headers.has('X-Brian-Projection-Valid-For-Ms')).toBe(false)
    expect(t.headers.get('Cache-Control')).toBe('private, no-store')
  })
  it('charges cleanup and body duration through the browser origin rather than extending the header',async()=>{
    state.cleanupDelay=250
    const t=transport()
    await sendOfficeMetadata(t.res,'viewer',()=>read())
    expect(t.headers.get('X-Brian-Projection-Valid-For-Ms')).toBe('600')
    expect(t.result()).toEqual({status:200,body:{title:'Protected fixture'}})
    expect(600-state.now).toBe(50)
  })
  it('still withholds changed authorized rows before calculating any allowance',async()=>{
    state.changed=true
    expect(await readOfficeProjection('viewer',()=>read())).toEqual({status:409,body:{error:'office_projection_changed'}})
    expect(query.mock.calls.some(([sql])=>String(sql).startsWith('SELECT department_media_valid_for_ms'))).toBe(false)
  })
})
