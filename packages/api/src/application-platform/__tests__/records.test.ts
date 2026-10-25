import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { Pool, PoolClient } from 'pg'
import { createExecutionContext, type ApplicationModuleDefinition, type ExecutionContext } from '@use-brian/core'
import { ApplicationPlatformService } from '../service.js'

const workspaceId='10000000-0000-4000-8000-000000000001',userId='10000000-0000-4000-8000-000000000002'
function context(assertCurrent=async()=>{}, identity?: ExecutionContext['identity']) {
  return createExecutionContext({identity:identity??{kind:'attended',principal:{kind:'workspace_member',userId}},ownership:{kind:'workspace',workspaceId},
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
  it('refuses an owner or unknown runtime role before publishing actor context or invoking a handler', async () => {
    for (const bypass of [true, undefined]) {
      const definition = module(), execute = vi.fn(definition.commands.create.execute)
      definition.commands = { create: { ...definition.commands.create, execute } }
      const client = { release: vi.fn(), query: vi.fn(async (_sql: string) => ({ rows: [{ bypass }] })) }
      const service = new ApplicationPlatformService([definition], { connect: async () => client } as unknown as Pool)
      await expect(service.command(context(), 'fixture', 'create', { idempotencyKey: 'role-once', input: { title: 'Request' } }))
        .rejects.toMatchObject({ code: 'access_unavailable', effect: 'none' })
      expect(execute).not.toHaveBeenCalled()
      const statements = client.query.mock.calls.map(([sql]) => sql)
      expect(statements).toHaveLength(3)
      expect(statements[0]).toBe('BEGIN')
      expect(statements[2]).toBe('ROLLBACK')
      expect(client.release).toHaveBeenCalledTimes(1)
    }
  })

  it('rechecks authority after the duplicate-command lock before acquiring row locks or publishing RLS context', async () => {
    const events: string[] = []
    let checks = 0
    const execution = context(async () => { events.push('authority'); if (++checks === 2) throw new Error('revoked while waiting') })
    const definition = module(), execute = vi.fn(definition.commands.create.execute)
    definition.commands = { create: { ...definition.commands.create, execute } }
    const client = { release: vi.fn(() => { events.push('release') }), query: vi.fn(async (sql: string) => {
      if (sql.includes('pg_catalog.pg_roles')) { events.push('role'); return { rows: [{ bypass: false }] } }
      events.push(sql.includes('pg_advisory_xact_lock') ? 'duplicate-lock' : sql)
      return { rows: [] }
    }) }
    const service = new ApplicationPlatformService([definition], { connect: async () => { events.push('connect'); return client } } as unknown as Pool)
    await expect(service.command(execution, 'fixture', 'create', { idempotencyKey: 'lock-once', input: { title: 'Request' } }))
      .rejects.toThrow('revoked while waiting')
    expect(events).toEqual(['authority', 'connect', 'BEGIN', 'role', 'duplicate-lock', 'authority', 'ROLLBACK', 'release'])
    expect(execute).not.toHaveBeenCalled()
  })

  it('passes the supplied transaction client to the operation and publishes effects only after commit', async () => {
    const events: string[] = []
    const definition = module(), execute = definition.commands.create.execute
    let suppliedClient: PoolClient | undefined
    definition.commands = { create: { ...definition.commands.create, execute: async (operation, input) => {
      suppliedClient = operation.transaction
      operation.afterCommit(() => { events.push('effect') })
      events.push('operation')
      return execute(operation, input)
    } } }
    const client = { release: vi.fn(() => { events.push('release') }), query: vi.fn(async (sql: string) => {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) events.push(sql)
      if (sql.includes('FROM pg_catalog.pg_roles')) return { rows: [{ bypass: false }] }
      if (sql.includes('FROM workspace_members')) return { rows: [{ user_id: userId }] }
      if (sql.includes('FROM workspaces')) return { rows: [{ id: workspaceId }] }
      return { rows: [] }
    }) }
    const connect = vi.fn(async () => client)
    const service = new ApplicationPlatformService([definition], { connect } as unknown as Pool)
    await service.command(context(), 'fixture', 'create', { idempotencyKey: 'same-client-once', input: { title: 'Request' } })
    expect(suppliedClient).toBe(client)
    expect(connect).toHaveBeenCalledTimes(1)
    expect(events).toEqual(['BEGIN', 'operation', 'COMMIT', 'effect', 'ROLLBACK', 'release'])
  })

  it('requires genuine host binding for an application identity before obtaining a connection', async () => {
    const connect = vi.fn(), service = new ApplicationPlatformService([module()], { connect } as unknown as Pool)
    const execution = context(async () => {}, { kind: 'programmatic', credentialOwnerUserId: userId,
      principal: { kind: 'application', credentialId: 'fixture-credential', applicationId: 'fixture-app', actorUserId: userId, subjectKind: 'service', serviceUserId: userId } })
    await expect(service.command(execution, 'fixture', 'create', { idempotencyKey: 'unbound-once', input: { title: 'Request' } }))
      .rejects.toMatchObject({ code: 'authentication_required', effect: 'none' })
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
