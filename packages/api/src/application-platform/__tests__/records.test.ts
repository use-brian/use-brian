import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { Pool, PoolClient } from 'pg'
import { createExecutionContext, type ApplicationModuleDefinition } from '@use-brian/core'
import { ApplicationPlatformService } from '../service.js'

const workspaceId='10000000-0000-4000-8000-000000000001',userId='10000000-0000-4000-8000-000000000002'
function context(assertCurrent=async()=>{}) {
  return createExecutionContext({identity:{kind:'attended',principal:{kind:'workspace_member',userId}},ownership:{kind:'workspace',workspaceId},
    access:{workspaceId,userId,assistantId:'10000000-0000-4000-8000-000000000003',assistantKind:'primary',clearance:'internal',
      compartments:[],mutationCompartments:[],projectIds:[],visibilityAssistantIds:[]},writeDefaults:{compartments:[],projectIds:[]},
    authority:{assertCurrent,execute:operation=>operation()},
    lifecycle:{sessionId:'fixture',sessionPersisted:false,channelType:'test',channelId:'fixture',abortSignal:new AbortController().signal}})
}
function module():ApplicationModuleDefinition<PoolClient> {
  return {key:'fixture',defaultState:'enabled',application:{version:'1',dependencies:[],resources:[],queries:[],commands:['create'],
    events:['fixture.created'],policyCapabilities:[],backgroundHandlers:[],uiContributions:[]},queries:{},commands:{create:{
    eventKey:'fixture.created',input:z.object({title:z.string().min(1)}).strict(),authorize:async()=>{},authorizeResult:async()=>{},
    execute:async()=>[{workspaceId,origin:{kind:'native',moduleKey:'fixture'},typeKey:'request',id:'fixture-record',version:'1'}],
  }}}
}

describe('[COMP:api/application-records] command failure and retry semantics',()=>{
  it('rejects invalid typed inputs before obtaining a transaction',async()=>{
    const connect=vi.fn(),service=new ApplicationPlatformService([module()],{connect} as unknown as Pool)
    await expect(service.command(context(),'fixture','create',{idempotencyKey:'once',input:{title:''}})).rejects.toMatchObject({code:'invalid_value',effect:'none',retrySafe:true})
    expect(connect).not.toHaveBeenCalled()
  })
  it('stops a revoked authority before any operation or SQL',async()=>{
    const connect=vi.fn(),service=new ApplicationPlatformService([module()],{connect} as unknown as Pool)
    await expect(service.command(context(async()=>{throw new Error('authority revoked')}),'fixture','create',{idempotencyKey:'once',input:{title:'Request'}})).rejects.toThrow('authority revoked')
    expect(connect).not.toHaveBeenCalled()
  })
  it('reports an ambiguous COMMIT as outcome_uncertain without repeating the effect',async()=>{
    const definition=module(),execute=vi.fn(definition.commands.create.execute)
    definition.commands={create:{...definition.commands.create,execute}}
    const queries:string[]=[]
    const client={release:vi.fn(),query:vi.fn(async(text:string)=>{
      queries.push(text)
      if(text==='COMMIT')throw new Error('connection lost after commit dispatch')
      if(text.includes('FROM pg_catalog.pg_roles'))return {rows:[{bypass:false}]}
      if(text.includes('FROM workspace_members'))return {rows:[{user_id:userId}]}
      if(text.includes('FROM workspaces'))return {rows:[{id:workspaceId}]}
      return {rows:[]}
    })}
    const service=new ApplicationPlatformService([definition],{connect:async()=>client} as unknown as Pool)
    await expect(service.command(context(),'fixture','create',{idempotencyKey:'same-key',input:{title:'Request'}})).rejects.toMatchObject({code:'outcome_uncertain',effect:'uncertain',retrySafe:false})
    expect(execute).toHaveBeenCalledTimes(1)
    expect(queries.filter(query=>query.startsWith('INSERT INTO application_committed_events'))).toHaveLength(1)
    expect(client.release).toHaveBeenCalledTimes(1)
  })
})
