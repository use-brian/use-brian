/**
 * [COMP:views/bindings] Bindings catalog smoke tests.
 *
 * Mocks the underlying primitive stores and verifies that buildPayload
 * produces a valid A2UI v0.8 ViewPayload for each entity / view-type
 * combination in the locked catalog.
 */

import { describe, expect, it } from 'vitest'
import type { CrmStore } from '../../crm/types.js'
import type { TaskStore } from '../../tasks/types.js'
import type { WorkflowRunStore } from '../../workflow/types.js'
import type { WorkspaceDirectoryStore } from '../../workspace/types.js'
import { buildPayload, type BindingDeps } from '../bindings.js'
import { bindScopeSources,boundScopeSources } from '../../security/source-evidence.js'
import { viewPayloadSchema } from '../a2ui.js'

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001'
const USER_ID = '00000000-0000-0000-0000-000000000002'

function fakeTaskStore(): TaskStore {
  return {
    async create() {
      throw new Error('not used')
    },
    async getById() {
      return null
    },
    async list() {
      return [
        {
          id: 't1',
          workspaceId: WORKSPACE_ID,
          title: 'Buy milk',
          status: 'todo',
          assigneeId: null,
          due: new Date('2026-05-20T12:00:00Z'),
          tags: ['shopping'],
          parentId: null,
          attributes: {},
          updatedAt: new Date('2026-05-09T10:00:00Z'),
        },
        {
          id: 't2',
          workspaceId: WORKSPACE_ID,
          title: 'Email Acme',
          status: 'in_progress',
          assigneeId: 'm1',
          due: null,
          tags: [],
          parentId: null,
          attributes: {},
          updatedAt: new Date('2026-05-09T11:00:00Z'),
        },
      ]
    },
    async update() {
      return null
    },
  }
}

function fakeCrmStore(): CrmStore {
  const empty = async () => []
  return {
    async createCompany() {
      throw new Error('not used')
    },
    async getCompanyById() {
      return null
    },
    listCompanies: empty,
    async updateCompany() {
      return null
    },
    async createContact() {
      throw new Error('not used')
    },
    async getContactById() {
      return null
    },
    listContacts: empty,
    async updateContact() {
      return null
    },
    async createDeal() {
      throw new Error('not used')
    },
    async getDealById() {
      return null
    },
    async listDeals() {
      return [
        {
          id: 'd1',
          workspaceId: WORKSPACE_ID,
          entityId: null,
          name: 'Deal - Acme',
          contactId: 'c1',
          companyId: 'co1',
          stage: 'lead',
          amount: 1000,
          closeDate: null,
          updatedAt: new Date('2026-05-09T10:00:00Z'),
        },
        {
          id: 'd2',
          workspaceId: WORKSPACE_ID,
          entityId: null,
          name: 'Deal - Acme renewal',
          contactId: null,
          companyId: 'co1',
          stage: 'won',
          amount: 5000,
          closeDate: new Date('2026-05-01T00:00:00Z'),
          updatedAt: new Date('2026-05-09T12:00:00Z'),
        },
      ]
    },
    async updateDeal() {
      return null
    },
    async setDealStage() {
      return null
    },
    async batchLabels() {
      return new Map()
    },
  }
}

function fakeWorkflowRunStore(): WorkflowRunStore {
  return {
    async createRun() {
      throw new Error('not used')
    },
    async getRunById() {
      return null
    },
    async getRunSystem() {
      return null
    },
    async updateRun() {
      return null
    },
    async createStepRun() {
      throw new Error('not used')
    },
    async updateStepRun() {
      return null
    },
    async listStepRuns() {
      return []
    },
    async listRunsForWorkflow() {
      return [
        {
          id: 'r1',
          workflowId: 'wf1',
          workspaceId: WORKSPACE_ID,
          triggeredBy: USER_ID,
          triggerKind: 'manual',
          status: 'completed',
          input: {},
          vars: {},
          currentStepId: null,
          error: null,
          outcome: null,
          startedAt: new Date('2026-05-09T10:00:00Z'),
          finishedAt: new Date('2026-05-09T10:00:30Z'),
          lastActiveAt: new Date('2026-05-09T10:00:30Z'),
        },
      ]
    },
    async resolveRunsByIdPrefix() {
      return []
    },
    listRunsForPage: async () => [],
    async getLatestOutcomeForWorkflowSystem() {
      return null
    },
  }
}

function fakeDirectory(): WorkspaceDirectoryStore {
  return {
    async listMembers() { return [] },
    async get() { return null },
    async batchGet(_workspaceId, memberIds) {
      const out = new Map()
      for (const id of memberIds) {
        if (id === 'm1') out.set(id, { memberId: 'm1', name: 'Alice', email: 'alice@x.dev', role: 'member' })
      }
      return out
    },
  }
}

function deps(): BindingDeps {
  return {
    taskStore: fakeTaskStore(),
    crmStore: fakeCrmStore(),
    workflowRunStore: fakeWorkflowRunStore(),
    workspaceDirectory: fakeDirectory(),
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
  }
}

describe('[COMP:views/bindings] buildPayload', () => {
  it('splits 200 mixed deal relation labels into bounded batches without losing references',async()=>{
    const directory=deps(),base=(await directory.crmStore.listDeals({workspaceId:WORKSPACE_ID,userId:USER_ID,assistantId:'',assistantKind:'primary'},{}))[0],batches:number[]=[]
    directory.crmStore.listDeals=async()=>Array.from({length:100},(_,index)=>({...base,id:`deal-${index}`,companyId:`company-${index}`,contactId:`contact-${index}`}))
    directory.crmStore.batchLabels=async(_ctx,requests)=>{
      const refs=requests.flatMap(request=>request.ids.map(id=>[`${request.entity}:${id}`,`Fictional ${id}`] as const));batches.push(refs.length)
      expect(refs.length).toBeLessThanOrEqual(100);return new Map(refs)
    }
    const payload=await buildPayload({entity:'deals',viewType:'table',columns:['company','contact']},directory)
    expect(batches).toEqual([100,100]);expect(payload.root.type).toBe('table')
    if(payload.root.type!=='table')throw new Error('expected table')
    expect(payload.root.rows).toHaveLength(100)
    expect(payload.root.rows[99].company).toMatchObject({label:'Fictional company-99'});expect(payload.root.rows[99].contact).toMatchObject({label:'Fictional contact-99'})
  })
  it.each(['contacts/table','deals/table','deals/board'] as const)('retains canonical label evidence through the actual %s payload adapter',async mode=>{
    const source={workspaceId:WORKSPACE_ID,userId:null,assistantId:null,resourceKind:'application_field' as const,
      resourceId:'00000000-0000-0000-0000-000000000005',version:'label-observation-v1',sensitivity:'internal' as const,compartments:[],projectIds:[]}
    const directory=deps(),labels=bindScopeSources(new Map([['company:company-ref','Fictional label']]),[source])
    directory.crmStore.batchLabels=async()=>labels
    directory.crmStore.listContacts=async()=>[{id:'contact-ref',entityId:'contact-ref',workspaceId:WORKSPACE_ID,name:'Fictional contact',email:null,phone:null,companyId:'company-ref',tags:[],externalRef:{},aliases:[],createdAt:new Date(),updatedAt:new Date()}]
    const base=await directory.crmStore.listDeals({workspaceId:WORKSPACE_ID,userId:USER_ID,assistantId:'',assistantKind:'primary'},{});
    directory.crmStore.listDeals=async()=>base.map(row=>({...row,companyId:'company-ref'}))
    const payload=await buildPayload(mode==='contacts/table'?{entity:'contacts',viewType:'table',columns:['name','company']}:mode==='deals/table'?{entity:'deals',viewType:'table',columns:['name','company']}:{entity:'deals',viewType:'board',groupBy:'stage',columns:['name','company']},directory)
    expect(boundScopeSources(payload)).toEqual([source]);expect(boundScopeSources(payload.root)).toEqual([source])
  })

  it('produces a valid A2UI v0.8 envelope for tasks/table', async () => {
    const payload = await buildPayload({ entity: 'tasks', viewType: 'table' }, deps())
    expect(payload.a2ui).toBe('0.8')
    expect(viewPayloadSchema.parse(payload)).toBeTruthy()
    if (payload.root.type !== 'table') throw new Error('expected table')
    expect(payload.root.rows).toHaveLength(2)
    expect(payload.root.columns.map((c) => c.field)).toContain('title')
    expect(payload.root.rows[0].title).toBe('Buy milk')
  })

  it('renders status as a Badge widget', async () => {
    const payload = await buildPayload({ entity: 'tasks', viewType: 'table' }, deps())
    if (payload.root.type !== 'table') throw new Error('expected table')
    const statusCell = payload.root.rows[0].status
    expect(typeof statusCell).toBe('object')
    if (typeof statusCell !== 'object' || statusCell === null) throw new Error('expected widget')
    expect((statusCell as { type: string }).type).toBe('badge')
  })

  it('produces a valid Board for tasks (groupBy status, archived hidden)', async () => {
    const payload = await buildPayload(
      { entity: 'tasks', viewType: 'board', groupBy: 'status' },
      deps(),
    )
    expect(viewPayloadSchema.parse(payload)).toBeTruthy()
    if (payload.root.type !== 'board') throw new Error('expected board')
    const colIds = payload.root.columns.map((c) => c.id)
    expect(colIds).toEqual(['todo', 'in_progress', 'in_review', 'blocked', 'done'])
    expect(payload.root.groupBy).toBe('status')
  })

  it('produces a valid Board for deals (groupBy stage, all 6 columns)', async () => {
    const payload = await buildPayload(
      { entity: 'deals', viewType: 'board', groupBy: 'stage' },
      deps(),
    )
    expect(viewPayloadSchema.parse(payload)).toBeTruthy()
    if (payload.root.type !== 'board') throw new Error('expected board')
    expect(payload.root.columns.map((c) => c.id)).toEqual([
      'lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost',
    ])
    // d1 lands in lead, d2 lands in won
    const lead = payload.root.columns.find((c) => c.id === 'lead')
    const won = payload.root.columns.find((c) => c.id === 'won')
    expect(lead?.cards).toHaveLength(1)
    expect(won?.cards).toHaveLength(1)
  })

  it('produces a valid Calendar for tasks (dateBy due, rows on due dates)', async () => {
    const payload = await buildPayload(
      { entity: 'tasks', viewType: 'calendar', dateBy: 'due' },
      deps(),
    )
    expect(viewPayloadSchema.parse(payload)).toBeTruthy()
    if (payload.root.type !== 'calendar') throw new Error('expected calendar')
    expect(payload.root.dateColumnId).toBe('due')
    expect(payload.root.rows).toHaveLength(2)
    // t1 carries its due date as a DateWidget cell; t2 has none (dropped
    // from the grid by the renderer, but still present in rows).
    const dueCell = payload.root.rows[0].due
    if (typeof dueCell !== 'object' || dueCell === null) throw new Error('expected widget')
    expect((dueCell as { type: string }).type).toBe('date')
    // Host entity resolution rides on rowAction (same as tables).
    expect(payload.root.rowAction?.params?.entity).toBe('tasks')
  })

  it('force-includes the due column when a column subset omits it', async () => {
    const payload = await buildPayload(
      { entity: 'tasks', viewType: 'calendar', dateBy: 'due', columns: ['title', 'status'] },
      deps(),
    )
    if (payload.root.type !== 'calendar') throw new Error('expected calendar')
    expect(payload.root.columns.map((c) => c.field)).toEqual(['title', 'status', 'due'])
  })

  it('produces a Table for workflow_runs with required workflowId filter', async () => {
    const payload = await buildPayload(
      {
        entity: 'workflow_runs',
        viewType: 'table',
        filters: { workflowId: 'wf1' },
      },
      deps(),
    )
    expect(viewPayloadSchema.parse(payload)).toBeTruthy()
    if (payload.root.type !== 'table') throw new Error('expected table')
    expect(payload.root.rows).toHaveLength(1)
    expect(payload.root.rows[0].id).toBe('r1')
  })

  it('produces a Table for empty contacts (no rows still produces valid payload)', async () => {
    const payload = await buildPayload(
      { entity: 'contacts', viewType: 'table' },
      deps(),
    )
    expect(viewPayloadSchema.parse(payload)).toBeTruthy()
    if (payload.root.type !== 'table') throw new Error('expected table')
    expect(payload.root.rows).toHaveLength(0)
  })
})
