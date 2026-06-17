/**
 * [COMP:views/page-render] Page renderer walks blocks and resolves data blocks.
 */

import { describe, expect, it } from 'vitest'
import type { CrmStore } from '../../crm/types.js'
import type { TaskStore } from '../../tasks/types.js'
import type { WorkflowRunStore } from '../../workflow/types.js'
import type { WorkspaceDirectoryStore } from '../../workspace/types.js'
import { viewPayloadSchema } from '../a2ui.js'
import type { BindingDeps } from '../bindings.js'
import type { Page } from '../blocks.js'
import { renderBlock, renderPage } from '../page-render.js'

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001'
const USER_ID = '00000000-0000-0000-0000-000000000002'

function fakeDeps(): BindingDeps {
  const taskStore: TaskStore = {
    async create() { throw new Error('not used') },
    async getById() { return null },
    async list() { return [] },
    async update() { return null },
  }
  const empty = async () => []
  const crmStore: CrmStore = {
    async createCompany() { throw new Error('not used') },
    async getCompanyById() { return null },
    listCompanies: empty,
    async updateCompany() { return null },
    async createContact() { throw new Error('not used') },
    async getContactById() { return null },
    listContacts: empty,
    async updateContact() { return null },
    async createDeal() { throw new Error('not used') },
    async getDealById() { return null },
    listDeals: empty,
    async updateDeal() { return null },
    async setDealStage() { return null },
    async batchLabels() { return new Map() },
  } as unknown as CrmStore
  const workflowRunStore: WorkflowRunStore = {
    async createRun() { throw new Error('not used') },
    async getRunById() { return null },
    async getRunSystem() { return null },
    async updateRun() { return null },
    async createStepRun() { throw new Error('not used') },
    async updateStepRun() { return null },
    async listStepRuns() { return [] },
    async listRunsForWorkflow() { return [] },
  } as unknown as WorkflowRunStore
  const workspaceDirectory: WorkspaceDirectoryStore = {
    async listMembers() { return [] },
    async get() { return null },
    async batchGet() { return new Map() },
  } as unknown as WorkspaceDirectoryStore
  return {
    taskStore,
    crmStore,
    workflowRunStore,
    workspaceDirectory,
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
  }
}

describe('[COMP:views/page-render] renderBlock inline blocks', () => {
  it('text block → TextWidget', async () => {
    const w = await renderBlock({ kind: 'text', id: 'b1', text: 'hi' }, fakeDeps())
    expect(w.type).toBe('text')
  })

  it('heading block → HeadingWidget', async () => {
    const w = await renderBlock({ kind: 'heading', id: 'b1', level: 1, text: 'Title' }, fakeDeps())
    expect(w.type).toBe('heading')
  })

  it('divider block → DividerWidget', async () => {
    const w = await renderBlock({ kind: 'divider', id: 'b1' }, fakeDeps())
    expect(w.type).toBe('divider')
  })
})

describe('[COMP:views/page-render] renderBlock data block', () => {
  it('data block → resolved widget root', async () => {
    const w = await renderBlock(
      { kind: 'data', id: 'b1', binding: { entity: 'tasks', viewType: 'table' } },
      fakeDeps(),
    )
    expect(w.type).toBe('table')
  })
})

describe('[COMP:views/page-render] renderBlock chart block', () => {
  it('chart block resolves to chart_bar widget when chartType=bar', async () => {
    const w = await renderBlock(
      {
        kind: 'chart',
        id: 'b1',
        chartType: 'bar',
        title: 'Tasks by status',
        binding: { entity: 'tasks', op: 'count_by', groupBy: 'status' },
      },
      fakeDeps(),
    )
    expect(w.type).toBe('chart_bar')
  })

  it('chart block resolves to kpi widget when chartType=kpi', async () => {
    const w = await renderBlock(
      {
        kind: 'chart',
        id: 'b1',
        chartType: 'kpi',
        binding: { entity: 'tasks', op: 'count_by', groupBy: 'status' },
      },
      fakeDeps(),
    )
    expect(w.type).toBe('kpi')
  })

  it('renders a muted placeholder (not a blank chart) for an empty-points static chart', async () => {
    // A chart shell authored before its points landed — or a legacy row that
    // predates the `refineChartBlock` guard — must NOT project a bare plot.
    const w = await renderBlock(
      {
        kind: 'chart',
        id: 'b1',
        chartType: 'bar',
        title: 'Average Accounting/Audit Fees',
        data: { points: [] },
      },
      fakeDeps(),
    )
    expect(w.type).toBe('text')
    if (w.type === 'text') {
      expect(w.variant).toBe('muted')
      expect(w.text).toContain('Average Accounting/Audit Fees')
    }
  })
})

describe('[COMP:views/page-render] renderPage', () => {
  it('empty page → root container with no children', async () => {
    const payload = await renderPage({ blocks: [] }, fakeDeps())
    expect(payload.a2ui).toBe('0.8')
    expect(payload.root.type).toBe('container')
    if (payload.root.type === 'container') {
      expect(payload.root.children).toEqual([])
    }
  })

  it('mixed page → container with one child per block in order', async () => {
    const page: Page = {
      blocks: [
        { kind: 'heading', id: 'h1', level: 1, text: 'My Tasks' },
        { kind: 'divider', id: 'd1' },
        { kind: 'data', id: 'd2', binding: { entity: 'tasks', viewType: 'table' } },
      ],
    }
    const payload = await renderPage(page, fakeDeps())
    expect(payload.root.type).toBe('container')
    if (payload.root.type === 'container') {
      expect(payload.root.children).toHaveLength(3)
      expect(payload.root.children[0].type).toBe('heading')
      expect(payload.root.children[1].type).toBe('divider')
      expect(payload.root.children[2].type).toBe('table')
    }
  })

  it('table block → one muted placeholder, index alignment preserved', async () => {
    const page: Page = {
      blocks: [
        {
          kind: 'table',
          id: 'tb',
          hasHeaderRow: true,
          rows: [
            [{ type: 'doc' }, { type: 'doc' }],
            [{ type: 'doc' }, { type: 'doc' }],
          ],
        },
        { kind: 'divider', id: 'd1' },
      ],
    }
    const payload = await renderPage(page, fakeDeps())
    if (payload.root.type === 'container') {
      // exactly one child per block — a table never expands the payload.
      expect(payload.root.children).toHaveLength(2)
      expect(payload.root.children[0].type).toBe('text')
      expect(payload.root.children[1].type).toBe('divider')
    }
  })

  it('rendered payload validates against the A2UI v0.8 schema', async () => {
    const page: Page = {
      blocks: [
        { kind: 'text', id: 't1', text: 'hi', variant: 'muted' },
        { kind: 'heading', id: 'h1', level: 2, text: 'Pipeline' },
        { kind: 'divider', id: 'd1' },
        { kind: 'data', id: 'd2', binding: { entity: 'deals', viewType: 'board', groupBy: 'stage' } },
      ],
    }
    const payload = await renderPage(page, fakeDeps())
    expect(() => viewPayloadSchema.parse(payload)).not.toThrow()
  })
})
