/**
 * KB self-maintain agents — the workflow materializer + the run-starter
 * budget guard. Component tag: [COMP:knowledge/maintenance].
 *
 * The materializer's output is validated against the REAL workflow Zod
 * schemas (`WorkflowDefinitionSchema` / `WorkflowTriggerSchema`), so a
 * definition the builder would reject can never ship from the maintenance
 * PUT route.
 */

import { describe, it, expect, vi } from 'vitest'
import { WorkflowDefinitionSchema, WorkflowTriggerSchema } from '@use-brian/core'

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))

import {
  buildMaintenanceWorkflow,
  kbMaintenanceRunGuard,
  KbMaintenanceConfigSchema,
  KBM_STEP_JUDGE,
  KBM_STEP_WRITE_CREATE,
  KBM_STEP_WRITE_UPDATE,
  type KbMaintenanceStore,
  type KbMaintenanceAgent,
} from '../maintenance.js'

const SOURCE = {
  id: 'src-1',
  repo: 'acme-corp/kb',
  rootPath: 'docs',
  sourceType: 'github' as const,
}

const CONFIG = KbMaintenanceConfigSchema.parse({
  enabled: true,
  charter: 'Product and API documentation for Acme. Out of scope: finances and HR.',
  pathScope: ['products/', 'guides/'],
  signals: { mode: 'events' },
  similarityThreshold: 0.8,
  styleContract: 'Short declarative sentences. Headings over prose walls.',
  sensitivityCeiling: 'internal',
  weeklyProposalBudget: 5,
})

describe('[COMP:knowledge/maintenance] buildMaintenanceWorkflow', () => {
  it('materializes a definition the workflow schemas accept', () => {
    const { definition, trigger } = buildMaintenanceWorkflow(CONFIG, SOURCE)
    expect(WorkflowDefinitionSchema.safeParse(definition).success).toBe(true)
    expect(WorkflowTriggerSchema.safeParse(trigger).success).toBe(true)
  })

  it('events mode → a knowledge event trigger (bot events NOT opted in)', () => {
    const { trigger } = buildMaintenanceWorkflow(CONFIG, SOURCE)
    expect(trigger).toEqual({
      kind: 'event',
      event: { sources: [{ source: { type: 'knowledge' } }] },
    })
  })

  it('daily mode → a schedule trigger at the configured time', () => {
    const { trigger } = buildMaintenanceWorkflow(
      { ...CONFIG, signals: { mode: 'daily', time: '09:30' } },
      SOURCE,
    )
    expect(trigger).toEqual({
      kind: 'schedule',
      schedule: { type: 'daily', time: '09:30' },
      mode: 'local',
    })
  })

  it('judge prompt carries the anti-slop contract (charter, scope, ceiling, budget, threshold)', () => {
    const { definition } = buildMaintenanceWorkflow(CONFIG, SOURCE)
    const judge = definition.steps.find((s) => s.id === KBM_STEP_JUDGE)
    expect(judge?.type).toBe('assistant_call')
    const prompt = (judge as { prompt: string }).prompt
    expect(prompt).toContain(CONFIG.charter)
    expect(prompt).toContain('"products/"')
    expect(prompt).toContain('"guides/"')
    expect(prompt).toContain('internal')
    expect(prompt).toContain('at most 5 proposals')
    expect(prompt).toContain('80%')
    expect(prompt).toContain('{{input.event}}')
  })

  it('the create step pins the repo so a multi-source workspace cannot cross-write', () => {
    const { definition } = buildMaintenanceWorkflow(CONFIG, SOURCE)
    const create = definition.steps.find((s) => s.id === KBM_STEP_WRITE_CREATE)
    expect(create?.type).toBe('tool_call')
    expect((create as { arguments: Record<string, unknown> }).arguments.repo).toBe('acme-corp/kb')
  })

  it('write steps interpolate the judge verdict and are terminal', () => {
    const { definition } = buildMaintenanceWorkflow(CONFIG, SOURCE)
    const update = definition.steps.find((s) => s.id === KBM_STEP_WRITE_UPDATE)
    expect((update as { arguments: Record<string, unknown> }).arguments).toMatchObject({
      id: '{{vars.verdict.id}}',
      content: '{{vars.verdict.content}}',
      changeSummary: '{{vars.verdict.changeSummary}}',
    })
    expect((update as { nextStepId?: string | null }).nextStepId).toBeNull()
  })
})

describe('[COMP:knowledge/maintenance] kbMaintenanceRunGuard', () => {
  function makeStore(overrides?: Partial<KbMaintenanceStore>): KbMaintenanceStore {
    return {
      getBySource: vi.fn(),
      listByWorkspace: vi.fn(),
      upsert: vi.fn(),
      setWorkflowId: vi.fn(),
      deleteBySource: vi.fn(),
      countRecentProposalAttempts: vi.fn(async () => 0),
      getByWorkflowId: vi.fn(async () => null),
      ...overrides,
    }
  }

  const AGENT: KbMaintenanceAgent = {
    id: 'ag-1',
    workspaceId: 'ws-1',
    sourceId: 'src-1',
    workflowId: 'wf-1',
    enabled: true,
    charter: 'c'.repeat(40),
    pathScope: ['docs/'],
    signals: { mode: 'events' },
    similarityThreshold: 0.8,
    styleContract: 's'.repeat(20),
    sensitivityCeiling: 'internal',
    weeklyProposalBudget: 3,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  it('passes through a workflow that is not KB-managed (no config row)', async () => {
    const store = makeStore()
    expect(await kbMaintenanceRunGuard(store, 'wf-x')).toEqual({ skip: false })
    expect(store.countRecentProposalAttempts).not.toHaveBeenCalled()
  })

  it('skips a disabled agent', async () => {
    const store = makeStore({
      getByWorkflowId: vi.fn(async () => ({ ...AGENT, enabled: false })),
    })
    const verdict = await kbMaintenanceRunGuard(store, 'wf-1')
    expect(verdict.skip).toBe(true)
  })

  it('skips when the weekly proposal budget is spent', async () => {
    const store = makeStore({
      getByWorkflowId: vi.fn(async () => AGENT),
      countRecentProposalAttempts: vi.fn(async () => 3),
    })
    const verdict = await kbMaintenanceRunGuard(store, 'wf-1')
    expect(verdict.skip).toBe(true)
    expect(verdict.reason).toContain('3/3')
  })

  it('passes while budget remains', async () => {
    const store = makeStore({
      getByWorkflowId: vi.fn(async () => AGENT),
      countRecentProposalAttempts: vi.fn(async () => 2),
    })
    expect(await kbMaintenanceRunGuard(store, 'wf-1')).toEqual({ skip: false })
  })
})

describe('[COMP:knowledge/maintenance] KbMaintenanceConfigSchema (anti-slop contract)', () => {
  it('rejects a trivial charter', () => {
    expect(KbMaintenanceConfigSchema.safeParse({ ...CONFIG, charter: 'short' }).success).toBe(false)
  })

  it('rejects an empty path scope', () => {
    expect(KbMaintenanceConfigSchema.safeParse({ ...CONFIG, pathScope: [] }).success).toBe(false)
  })

  it('rejects daily signals without a valid time', () => {
    expect(
      KbMaintenanceConfigSchema.safeParse({ ...CONFIG, signals: { mode: 'daily', time: '9am' } }).success,
    ).toBe(false)
  })

  it('rejects an out-of-range budget', () => {
    expect(KbMaintenanceConfigSchema.safeParse({ ...CONFIG, weeklyProposalBudget: 0 }).success).toBe(false)
    expect(KbMaintenanceConfigSchema.safeParse({ ...CONFIG, weeklyProposalBudget: 101 }).success).toBe(false)
  })
})
