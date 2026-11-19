import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createProjectHarnessStore } from '../project-harness-store.js'
import { WorkspaceAccessError } from '../../workspace-access/policy.js'

const mocks = vi.hoisted(() => {
  const query = vi.fn(), release = vi.fn(), applyRLSGucs = vi.fn()
  const client = { query, release }
  const connect = vi.fn(async () => client)
  return { query, release, client, connect, applyRLSGucs, rollbackAndRelease: vi.fn() }
})
vi.mock('../client.js', () => ({
  getAppPool: () => ({ connect: mocks.connect }),
  applyRLSGucs: mocks.applyRLSGucs,
  rollbackAndRelease: mocks.rollbackAndRelease,
}))
const actor = randomUUID(), w = randomUUID(), p = randomUUID(), product = randomUUID(), child = randomUUID()
const body = { schemaVersion: 1 as const, rules: [], codeChecks: [], acceptanceScenarios: [] }
const store = createProjectHarnessStore()
const row = { id: randomUUID(), workspace_id: w, project_id: p, product_id: product, component_id: child,
  revision: 1, definition: body, created_by: actor, created_at: '2026-01-01T00:00:00+00:00' }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith('SELECT') ? [{ result: [row] }] : [] }))
})

describe('project harness actor-bound store', () => {
  it('reads lineage as one actor-bound repeatable-read transaction with complete target', async () => {
    const result = await store.lineage(actor,w,p,{kind:'component',productId:product,componentId:child})
    expect(result[0]).toMatchObject({workspaceId:w,projectId:p,scope:{kind:'component',productId:product,componentId:child},revision:1,createdBy:actor})
    expect(mocks.connect).toHaveBeenCalledTimes(1)
    expect(mocks.query.mock.calls[0]).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'])
    expect(mocks.applyRLSGucs).toHaveBeenCalledWith(mocks.client, actor)
    expect(mocks.query.mock.calls[1]).toEqual(['SELECT public.project_harness_read($1,$2,$3,$4,$5) AS result', [w,p,product,child,'lineage']])
    expect(mocks.query.mock.calls[2]).toEqual(['COMMIT'])
    expect(mocks.rollbackAndRelease).toHaveBeenCalledWith(mocks.client)
  })
  it('delegates even missing definitions and invalid targets to the authorized SQL read', async () => {
    mocks.query.mockResolvedValue({rows:[{result:[]}]})
    expect(await store.definition(actor,w,p,{kind:'product',productId:product})).toBeNull()
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT')) throw new Error('harness_not_found')
      return {rows:[]}
    })
    await expect(store.lineage(actor,w,p,{kind:'product',productId:product})).rejects.toMatchObject({code:'harness_not_found',status:404})
  })
  it('validates strict inputs and mandatory revisions before acquiring a connection', async () => {
    for (const input of [{name:'new'}, {name:'new',expectedRevision:null}, {name:'new',expectedRevision:0},
      {name:'new',expectedRevision:1,projectId:p}, {expectedRevision:1}]) {
      await expect(store.updateProduct(actor,w,p,product,input as never)).rejects.toBeInstanceOf(WorkspaceAccessError)
    }
    await expect(store.createProduct(actor,w,p,{name:'x',status:'archived'} as never)).rejects.toMatchObject({code:'harness_invalid_input',status:400})
    await expect(store.putDefinition(actor,w,p,{scope:{kind:'project'},expectedRevision:0,definition:{...body,rules:[{key:'bad',kind:'local',value:'secret',extra:'secret'}]}} as never)).rejects.toMatchObject({code:'harness_invalid_input',status:400})
    await expect(store.lineage(actor,w,p,{kind:'project',productId:product} as never)).rejects.toMatchObject({code:'harness_invalid_input',status:400})
    expect(mocks.connect).not.toHaveBeenCalled()
  })
  it('normalizes shared schema defaults and sends only immutable ancestry plus expected revision', async () => {
    mocks.query.mockResolvedValue({rows:[{result:row}]})
    await store.putDefinition(actor,w,p,{scope:{kind:'component',productId:product,componentId:child},expectedRevision:0,
      definition:{...body,rules:[{key:'rule',kind:'invariant',value:'  contract  '}]}} as never)
    expect(mocks.query.mock.calls[1][1]).toEqual([w,p,product,child,0,JSON.stringify({...body,rules:[{key:'rule',kind:'invariant',value:'contract',override:false}]})])
    expect(mocks.query.mock.calls[0]).toEqual(['BEGIN'])
  })
  it('maps typed SQL errors and never exposes payload-bearing database details', async () => {
    const failures = [
      [new Error('harness_requires_shared_project'),'harness_requires_shared_project',409],
      [new Error('harness_owner_required'),'harness_owner_required',403],
      [Object.assign(new Error('payload-secret'),{code:'23514',detail:'payload-secret'}),'harness_invalid_input',400],
      [Object.assign(new Error('payload-secret'),{code:'40001'}),'harness_revision_stale',409],
      [new Error('payload-secret'),'harness_unavailable',503],
    ] as const
    for (const [error,code,status] of failures) {
      mocks.query.mockImplementation(async (sql: string) => { if (sql.startsWith('SELECT')) throw error; return {rows:[]} })
      await expect(store.history(actor,w,p,{kind:'project'})).rejects.toMatchObject({code,status,message:code})
    }
    expect(mocks.rollbackAndRelease).toHaveBeenCalledTimes(failures.length)
    expect(mocks.query.mock.calls.some(([sql]) => sql==='COMMIT')).toBe(false)
  })
})
