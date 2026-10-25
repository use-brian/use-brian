import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { Pool, PoolClient } from 'pg'
import { createExecutionContext, type ApplicationModuleDefinition, type ExecutionContext } from '@use-brian/core'
import { ApplicationPlatformError, WorkspaceModuleError, type WorkspaceModuleOperationClass, type WorkspaceModuleState } from '@use-brian/shared'
import { ApplicationPlatformService } from '../service.js'
import { buildNativeApplicationModuleMcpTools } from '../mcp.js'
import { AuthorityChangedError } from '../../context-scope/authority-lease.js'

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

/** Transaction replies model receipt persistence, not PostgreSQL locking/RLS. */
function receiptHarness(input: z.ZodType = z.object({ title: z.string() }),
  options: { operationClass?: WorkspaceModuleOperationClass; state?: WorkspaceModuleState } = {}) {
  const definition = module()
  const execute = vi.fn(definition.commands.create.execute)
  const authorize = vi.fn(definition.commands.create.authorize)
  const authorizeResult = vi.fn(definition.commands.create.authorizeResult)
  definition.commands = { create: { ...definition.commands.create, input, execute, authorize, authorizeResult,
    ...(options.operationClass === undefined ? {} : { operationClass: options.operationClass }) } }
  let state = options.state
  let receipt: { id: string; request_hash: string; resources: unknown } | undefined
  const client = { release: vi.fn(), query: vi.fn(async (text: string, args: unknown[] = []) => {
    if (text.includes('FROM pg_catalog.pg_roles')) return { rows: [{ bypass: false }] }
    if (text.includes('FROM workspace_members')) return { rows: [{ user_id: userId }] }
    if (text.includes('FROM workspaces')) return { rows: [{ id: workspaceId }] }
    if (text.includes('FROM workspace_modules') && state !== undefined) return { rows: [{ workspaceId, moduleKey: 'fixture', state, version: 1,
      enabledAt: null, disableRequestedAt: null, disabledAt: null, updatedAt: null, updatedByUserId: null }] }
    if (text.includes('FROM application_operation_receipts')) return { rows: receipt ? [receipt] : [] }
    if (text.startsWith('INSERT INTO application_operation_receipts')) {
      receipt = { id: String(args[0]), request_hash: String(args[7]), resources: JSON.parse(String(args[8])) }
    }
    return { rows: [] }
  }) }
  return {
    service: new ApplicationPlatformService([definition], { connect: async () => client } as unknown as Pool),
    execute, authorize, authorizeResult, client, definition,
    setModuleState(value: WorkspaceModuleState) { state = value },
    replaceFingerprint(value: string) { if (!receipt) throw new Error('Missing test receipt'); receipt.request_hash = value },
  }
}

describe('[COMP:api/application-records] command failure and retry semantics',()=>{
  it.each(['draining', 'disabled'] as const)('blocks omitted, new-work and new-commerce first executions while %s', async state => {
    for (const operationClass of [undefined, 'new_work', 'new_commerce'] as const) {
      const h = receiptHarness(undefined, { operationClass, state })
      await expect(h.service.command(context(), 'fixture', 'create', { idempotencyKey: 'first-once', input: { title: 'Request' } }))
        .rejects.toMatchObject({ name: 'ApplicationPlatformError', code: state === 'draining' ? 'module_draining' : 'module_disabled', effect: 'none', retrySafe: false })
      expect(h.execute).not.toHaveBeenCalled()
      expect(h.client.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO application_operation_receipts'))).toBe(false)
    }
  })
  it.each(['draining', 'disabled'] as const)('admits first recovery only with current authority and a handler-proved existing record while %s', async state => {
    const h = receiptHarness(z.object({ recordId: z.string() }).strict(), { operationClass: 'existing_recovery', state })
    const current = vi.fn(async () => {})
    h.authorize.mockImplementation(async (_operation, input) => {
      if ((input as { recordId: string }).recordId !== 'fixture-record') throw new ApplicationPlatformError('access_unavailable', 'Existing work is unavailable.')
    })
    const command = { idempotencyKey: 'first-recovery', input: { recordId: 'fixture-record' } }
    expect(await h.service.command(context(current), 'fixture', 'create', command)).toMatchObject({ effect: 'committed' })
    expect(current.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(h.execute).toHaveBeenCalledTimes(1)
    await expect(h.service.command(context(), 'fixture', 'create', { ...command, idempotencyKey: 'missing-record', input: { recordId: 'missing' } }))
      .rejects.toMatchObject({ code: 'access_unavailable' })
    const queries = h.client.query.mock.calls.length
    await expect(h.service.command(context(async () => { throw new Error('current authority revoked') }), 'fixture', 'create',
      { ...command, idempotencyKey: 'revoked-recovery' })).rejects.toThrow('current authority revoked')
    expect(h.client.query.mock.calls).toHaveLength(queries)
    expect(h.execute).toHaveBeenCalledTimes(1)
  })
  it('keeps caller input and envelope metadata from selecting a recovery classification', async () => {
    const h = receiptHarness(z.object({ title: z.string(), operationClass: z.string().optional() }), { state: 'disabled' })
    await expect(h.service.command(context(), 'fixture', 'create', { idempotencyKey: 'input-class', input: { title: 'Request', operationClass: 'existing_recovery' } }))
      .rejects.toMatchObject({ code: 'module_disabled' })
    await expect(h.service.command(context(), 'fixture', 'create', Object.assign({ idempotencyKey: 'envelope-class', input: { title: 'Request' } }, { operationClass: 'existing_recovery' })))
      .rejects.toMatchObject({ code: 'invalid_value' })
    expect(h.execute).not.toHaveBeenCalled()
  })
  it('keeps the registered new-work class after original and inspected handler mutation attempts', async () => {
    const h = receiptHarness(undefined, { operationClass: 'new_work', state: 'disabled' })
    Object.assign(h.definition.commands.create, { operationClass: 'existing_recovery' })
    const inspected = h.service.registry.applications.get('fixture')!.commands.create
    expect(() => Object.assign(inspected, { operationClass: 'existing_recovery' })).toThrow(TypeError)
    await expect(h.service.command(context(), 'fixture', 'create', { idempotencyKey: 'retag-once', input: { title: 'Request' } }))
      .rejects.toMatchObject({ code: 'module_disabled' })
    expect(h.execute).not.toHaveBeenCalled()
  })
  it.each(['draining', 'disabled'] as const)('retains current recovery admission for replay and reconciliation while %s without repeating effects', async state => {
    for (const operationClass of [undefined, 'new_work', 'new_commerce'] as const) {
      const h = receiptHarness(undefined, { operationClass })
      const command = { idempotencyKey: 'saved-once', input: { title: 'Request' } }
      const saved = await h.service.command(context(), 'fixture', 'create', command)
      h.setModuleState(state)
      const current = vi.fn(async () => {})
      expect(await h.service.command(context(current), 'fixture', 'create', command)).toEqual(saved)
      expect(await h.service.reconcile(context(current), 'fixture', 'create', command)).toEqual({ state: 'applied', receipt: saved })
      expect(current).toHaveBeenCalled()
      expect(h.execute).toHaveBeenCalledTimes(1)
      h.authorizeResult.mockRejectedValue(new ApplicationPlatformError('access_unavailable', 'Current result access is revoked.'))
      await expect(h.service.command(context(), 'fixture', 'create', command)).rejects.toMatchObject({ code: 'access_unavailable' })
      await expect(h.service.reconcile(context(), 'fixture', 'create', command)).rejects.toMatchObject({ code: 'access_unavailable' })
      expect(h.execute).toHaveBeenCalledTimes(1)
      expect(h.client.query.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO application_operation_receipts'))).toHaveLength(1)
    }
  })

  it('keeps own prototype-named wire keys in command identity before handler parsing', async () => {
    const h = receiptHarness(z.unknown())
    const input = JSON.parse('{"__proto__":{"value":1},"constructor":{"prototype":"data"},"items":[{"__proto__":{"nested":1}},[{"prototype":true}]]}')
    const command = { idempotencyKey: 'prototype-wire-once', input }
    const receipt = await h.service.command(context(), 'fixture', 'create', command)
    expect(h.execute.mock.calls[0][1]).toEqual(input)
    const reordered = { ...command, input: JSON.parse('{"items":[{"__proto__":{"nested":1}},[{"prototype":true}]],"constructor":{"prototype":"data"},"__proto__":{"value":1}}') }
    expect(await h.service.command(context(), 'fixture', 'create', reordered)).toEqual(receipt)
    expect(await h.service.reconcile(context(), 'fixture', 'create', reordered)).toEqual({ state: 'applied', receipt })
    for (const changed of [
      JSON.parse('{"__proto__":{"value":2},"constructor":{"prototype":"data"},"items":[{"__proto__":{"nested":1}},[{"prototype":true}]]}'),
      JSON.parse('{"__proto__":{"value":1},"constructor":{"prototype":"data"},"items":[{"__proto__":{"nested":2}},[{"prototype":true}]]}'),
      JSON.parse('{"constructor":{"prototype":"data"},"items":[{"__proto__":{"nested":1}},[{"prototype":true}]]}'),
    ]) {
      await expect(h.service.command(context(), 'fixture', 'create', { ...command, input: changed })).rejects.toMatchObject({ code: 'record_version_conflict', effect: 'none' })
      await expect(h.service.reconcile(context(), 'fixture', 'create', { ...command, input: changed })).rejects.toMatchObject({ code: 'record_version_conflict', effect: 'none' })
    }
    expect(h.execute).toHaveBeenCalledTimes(1)
    expect(h.client.query.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO application_operation_receipts'))).toHaveLength(1)
    expect(Object.getPrototypeOf(h.execute.mock.calls[0][1] as object)).toBe(Object.prototype)
    expect(({} as { value?: number }).value).toBeUndefined()
  })

  it('distinguishes date wire values before handler transforms on retry and reconciliation', async () => {
    const h = receiptHarness(z.object({ date: z.string().datetime().transform(value => new Date(value)) }))
    const command = { idempotencyKey: 'date-once', input: { date: '2026-01-01T00:00:00.000Z' } }
    const receipt = await h.service.command(context(), 'fixture', 'create', command)
    expect(h.execute.mock.calls[0][1]).toEqual({ date: new Date(command.input.date) })
    expect(await h.service.command(context(), 'fixture', 'create', command)).toEqual(receipt)
    expect(await h.service.reconcile(context(), 'fixture', 'create', command)).toEqual({ state: 'applied', receipt })
    const changed = { ...command, input: { date: '2026-02-01T00:00:00.000Z' } }
    await expect(h.service.command(context(), 'fixture', 'create', changed)).rejects.toMatchObject({ code: 'record_version_conflict' })
    await expect(h.service.reconcile(context(), 'fixture', 'create', changed)).rejects.toMatchObject({ code: 'record_version_conflict' })
    expect(h.execute).toHaveBeenCalledTimes(1)
  })

  it('keeps runtime defaults out of identity and rejects distinct normalized-equal inputs', async () => {
    let defaultValue = 'first'
    const h = receiptHarness(z.object({ title: z.string().trim().default(() => defaultValue) }))
    const command = { idempotencyKey: 'default-once', input: {} }
    const receipt = await h.service.command(context(), 'fixture', 'create', command)
    defaultValue = 'second'
    expect(await h.service.command(context(), 'fixture', 'create', command)).toEqual(receipt)
    expect(await h.service.reconcile(context(), 'fixture', 'create', command)).toEqual({ state: 'applied', receipt })
    await expect(h.service.command(context(), 'fixture', 'create', { ...command, input: { title: ' second ' } }))
      .rejects.toMatchObject({ code: 'record_version_conflict' })
    expect(h.execute).toHaveBeenCalledTimes(1)
  })

  it('canonicalizes nested object keys while preserving array order and expected version', async () => {
    const h = receiptHarness(z.unknown())
    const command = { idempotencyKey: 'ordered-once', expectedVersion: '1', correlationKey: 'first',
      input: { nested: { z: 1, a: 2 }, values: ['one', 'two'] } }
    const receipt = await h.service.command(context(), 'fixture', 'create', command)
    const reordered = { ...command, correlationKey: 'second', input: { values: ['one', 'two'], nested: { a: 2, z: 1 } } }
    expect(await h.service.command(context(), 'fixture', 'create', reordered)).toEqual(receipt)
    expect(await h.service.reconcile(context(), 'fixture', 'create', reordered)).toEqual({ state: 'applied', receipt })
    for (const changed of [
      { ...command, expectedVersion: '2' },
      { ...command, input: { ...command.input, values: ['two', 'one'] } },
    ]) {
      await expect(h.service.command(context(), 'fixture', 'create', changed)).rejects.toMatchObject({ code: 'record_version_conflict' })
      await expect(h.service.reconcile(context(), 'fixture', 'create', changed)).rejects.toMatchObject({ code: 'record_version_conflict' })
    }
    expect(h.execute).toHaveBeenCalledTimes(1)
  })

  it.each(['a'.repeat(64), 'wire-v2:unknown'])('preserves an unverifiable receipt without replaying its effect (%s)', async fingerprint => {
    const h = receiptHarness()
    const command = { idempotencyKey: 'legacy-once', input: { title: 'Request' } }
    await h.service.command(context(), 'fixture', 'create', command)
    h.replaceFingerprint(fingerprint)
    await expect(h.service.command(context(), 'fixture', 'create', command))
      .rejects.toMatchObject({ code: 'outcome_uncertain', effect: 'uncertain', retrySafe: false })
    expect(await h.service.reconcile(context(), 'fixture', 'create', command)).toEqual({ state: 'uncertain' })
    expect(h.execute).toHaveBeenCalledTimes(1)
    expect(h.client.query.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO application_operation_receipts'))).toHaveLength(1)
    h.authorize.mockRejectedValue(new Error('current access revoked'))
    await expect(h.service.command(context(), 'fixture', 'create', command)).rejects.toThrow('current access revoked')
    await expect(h.service.reconcile(context(), 'fixture', 'create', command)).rejects.toThrow('current access revoked')
  })

  it('rechecks current result access for a matching wire receipt', async () => {
    const h = receiptHarness()
    const command = { idempotencyKey: 'access-once', input: { title: 'Request' } }
    await h.service.command(context(), 'fixture', 'create', command)
    h.authorizeResult.mockRejectedValue(new Error('result access revoked'))
    await expect(h.service.command(context(), 'fixture', 'create', command)).rejects.toThrow('result access revoked')
    await expect(h.service.reconcile(context(), 'fixture', 'create', command)).rejects.toThrow('result access revoked')
    expect(h.execute).toHaveBeenCalledTimes(1)
  })

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

  it.each([new Error('connection lost after commit dispatch'), new WorkspaceModuleError('module_draining', 'Module is draining.'), new WorkspaceModuleError('module_disabled', 'Module is disabled.')])('keeps ambiguous COMMIT precedence over %s without repeating the effect',async(commitError)=>{
    const definition=module(),execute=vi.fn(definition.commands.create.execute)
    definition.commands={create:{...definition.commands.create,execute}}
    const queries:string[]=[]
    const client={release:vi.fn(),query:vi.fn(async(text:string)=>{
      queries.push(text)
      if(text==='COMMIT')throw commitError
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

  it('keeps MCP reconciliation non-effectful when current authority changes after its read transaction commits', async () => {
    const h = receiptHarness(), command = { idempotencyKey: 'mcp-saved-once', input: { title: 'Request' } }
    await h.service.command(context(), 'fixture', 'create', command)
    let current = true
    const execution = context(async () => { if (!current) throw new AuthorityChangedError() })
    const query = h.client.query.getMockImplementation()!
    h.client.query.mockImplementation(async (sql, args = []) => {
      const result = await query(sql, args)
      if (sql === 'COMMIT') current = false
      return result
    })
    const reconcile = buildNativeApplicationModuleMcpTools(h.service, execution, 'fixture').find(tool => tool.name === 'nativeModuleReconcile')!
    const result = await reconcile.handler({ commandKey: 'create', command })
    expect(result.isError).toBe(true)
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ error: 'grant_revoked', effect: 'none', retrySafe: false })
    expect(h.execute).toHaveBeenCalledTimes(1)
  })

  it.each(['missing', 'constructor', 'toString', '__proto__'])('refuses the unregistered operation %s on every dispatch path', async key => {
    const connect = vi.fn()
    const service = new ApplicationPlatformService([module()], { connect } as unknown as Pool)
    const execution = context()
    const command = { idempotencyKey: 'once', input: { title: 'Request' } }
    for (const call of [
      () => service.query(execution, 'fixture', key, {}),
      () => service.command(execution, 'fixture', key, command),
      () => service.reconcile(execution, 'fixture', key, command),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'operation_not_available', effect: 'none' })
    }
    expect(connect).not.toHaveBeenCalled()
  })

  it('does not expose a mutable live module map through registry inspection', async () => {
    const connect = vi.fn()
    const service = new ApplicationPlatformService([module()], { connect } as unknown as Pool)
    const inspected = service.registry.applications as Map<string, ApplicationModuleDefinition<PoolClient>>
    inspected.clear()
    expect(service.registry.applications.has('fixture')).toBe(true)
    await expect(service.command(context(), 'fixture', 'create', { idempotencyKey: 'once', input: { title: '' } }))
      .rejects.toMatchObject({ code: 'invalid_value' })
    expect(connect).not.toHaveBeenCalled()
  })

  it('admits an explicitly registered own constructor key through its normal handlers', async () => {
    const definition = module()
    const execute = vi.fn(definition.commands.create.execute)
    definition.application.commands = ['constructor']
    definition.commands = { constructor: { ...definition.commands.create, execute } }
    definition.application.queries = ['constructor']
    const query = vi.fn(async () => 'allowed')
    definition.queries = { constructor: { input: z.object({}).strict(), authorize: async () => {}, execute: query } }
    let savedReceipt: { id: string; request_hash: string; resources: unknown } | undefined
    const client = { release: vi.fn(), query: vi.fn(async (text: string, args: unknown[] = []) => {
      if (text.includes('FROM pg_catalog.pg_roles')) return { rows: [{ bypass: false }] }
      if (text.includes('FROM workspace_members')) return { rows: [{ user_id: userId }] }
      if (text.includes('FROM workspaces')) return { rows: [{ id: workspaceId }] }
      if (text.includes('FROM application_operation_receipts')) return { rows: savedReceipt ? [savedReceipt] : [] }
      if (text.startsWith('INSERT INTO application_operation_receipts')) {
        savedReceipt = { id: String(args[0]), request_hash: String(args[7]), resources: JSON.parse(String(args[8])) }
      }
      return { rows: [] }
    }) }
    const service = new ApplicationPlatformService([definition], { connect: async () => client } as unknown as Pool)
    const execution = context(), command = { idempotencyKey: 'once', input: { title: 'Request' } }
    expect(await service.query(execution, 'fixture', 'constructor', {})).toBe('allowed')
    const receipt = await service.command(execution, 'fixture', 'constructor', command)
    expect(await service.reconcile(execution, 'fixture', 'constructor', command)).toEqual({ state: 'applied', receipt })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledTimes(1)
  })

})
