/**
 * Unit tests for induction governance on staged-skill-creation approval.
 * Component tag: [COMP:api/skill-approvals-route].
 *
 * Exercises `applyStagedSkillCreation` through the route handler's
 * `POST /:id/approve` path with mocked stores. Verifies the two re-derivation
 * branches (`docs/architecture/engine/skill-system.md` §5.2, §6):
 *   * matched existing skill → recordRederivation + learned_from edge, NO create;
 *   * no match → create with inductionSource='self' + learned_from edge.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

const { createDerivedMock, rederiveMock } = vi.hoisted(() => ({
  createDerivedMock: vi.fn(async (_params: unknown) => ({ rowId: 'new-skill-1', slug: 'weekly-investor-update' })),
  rederiveMock: vi.fn(async (_params: unknown) => undefined),
}))

vi.mock('../../db/client.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  queryWithRLS: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
}))
vi.mock('../../db/skill-derived-store.js', () => ({
  createDerivedWorkspaceSkill: (args: unknown) => createDerivedMock(args),
  recordDerivedSkillRederivation: (args: unknown) => rederiveMock(args),
  applyDerivedSkillPatch: vi.fn(async () => undefined),
  applyDerivedSkillSupportFile: vi.fn(async () => undefined),
}))

import { skillApprovalsRoutes, type SkillApprovalRouteOptions } from '../skill-approvals.js'
import { bindScopeSource } from '@use-brian/core'

const WS = 'ws-1'
const APPROVER = 'user-1'
const ASSISTANT = 'asst-1'
const DERIVATION = {
  producer: 'fixture:procedural-review',
  sources: [{
    workspaceId: WS,
    userId: APPROVER,
    assistantId: ASSISTANT,
    sensitivity: 'internal' as const,
    compartments: [],
    projectIds: [],
    resourceKind: 'session_message',
    resourceId: 'message-1',
    version: '1',
  }, {
    workspaceId: WS,
    userId: APPROVER,
    assistantId: ASSISTANT,
    sensitivity: 'internal' as const,
    compartments: [],
    projectIds: [],
    resourceKind: 'workspace_skill_revision',
    resourceId: 'existing-revision-9',
    version: '1',
  }],
}

function mountApp(opts: SkillApprovalRouteOptions) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as { userId?: string }).userId = APPROVER
    next()
  })
  app.use('/api/skills/approvals', skillApprovalsRoutes(opts))
  return app
}

function baseOpts(over: Partial<SkillApprovalRouteOptions> = {}): SkillApprovalRouteOptions {
  const approval = {
    id: 'appr-1',
    kind: 'staged_skill_creation' as const,
    status: 'pending' as const,
    workspaceId: WS,
    originatingAssistantId: ASSISTANT,
    arguments: {
      umbrella: {
        slug: 'weekly-investor-update',
        name: 'Weekly Investor Update',
        description: 'Compose the weekly investor update',
        content: 'Step 1. Gather metrics.',
      },
      derivation: DERIVATION,
    },
  }
  return {
    approvalsStore: {
      getById: vi.fn().mockResolvedValue(approval),
      respond: vi.fn().mockResolvedValue({ ...approval, status: 'approved' }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    workspaceStore: {
      getRole: vi.fn().mockResolvedValue('admin'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    workspaceSkillStore: {
      listForWorkspace: vi.fn().mockResolvedValue([]),
      listScopedForWorkspace: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ rowId: 'new-skill-1' }),
      recordRederivation: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(true),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    fileStore: {
      upsert: vi.fn().mockResolvedValue(undefined),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    enablementStore: {
      enable: vi.fn().mockResolvedValue(undefined),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    entityLinks: {
      create: vi.fn().mockResolvedValue({ id: 'edge-1' }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    ...over,
  }
}

describe('[COMP:api/skill-approvals-route] induction governance on approve', () => {
  beforeEach(() => vi.clearAllMocks())

  it('unmatched → creates with inductionSource=self + emits a learned_from edge', async () => {
    const opts = baseOpts()
    const app = mountApp(opts)

    const res = await request(app).post('/api/skills/approvals/appr-1/approve').send({})
    expect(res.status).toBe(200)
    expect(res.body.applied).toBe(true)

    // Created (no match) with inductionSource='self'.
    expect(createDerivedMock).toHaveBeenCalledTimes(1)
    const createInput = createDerivedMock.mock.calls[0]![0] as Record<string, unknown>
    expect(createInput.inductionSource).toBe('self')
    expect(createInput.evidence).toEqual(DERIVATION)
    expect(opts.workspaceSkillStore.recordRederivation).not.toHaveBeenCalled()

    // learned_from edge → the originating assistant.
    expect(opts.entityLinks!.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKind: 'skill',
        sourceId: 'new-skill-1',
        targetKind: 'assistant',
        targetId: ASSISTANT,
        edgeType: 'learned_from',
        workspaceId: WS,
      }),
    )
  })

  it('keeps a legacy proposal pending when its canonical derivation is missing', async () => {
    const opts = baseOpts()
    const approval = await opts.approvalsStore.getById(APPROVER, 'appr-1')
    if (!approval) throw new Error('fixture approval missing')
    const argumentsWithoutEvidence = { ...approval.arguments }
    delete argumentsWithoutEvidence.derivation
    opts.approvalsStore.getById = vi.fn().mockResolvedValue({
      ...approval,
      arguments: argumentsWithoutEvidence,
    })
    const app = mountApp(opts)

    const res = await request(app).post('/api/skills/approvals/appr-1/approve').send({})

    expect(res.status).toBe(500)
    expect(res.body.detail).toBe('scope_evidence_missing')
    expect(createDerivedMock).not.toHaveBeenCalled()
    expect(opts.approvalsStore.respond).not.toHaveBeenCalled()
  })

  it('GET / enriches staged_skill_update rows with a workspace-scoped targetSkill snapshot', async () => {
    const updateApproval = {
      id: 'appr-2',
      kind: 'staged_skill_update' as const,
      status: 'pending' as const,
      workspaceId: WS,
      originatingAssistantId: ASSISTANT,
      arguments: { targetSkillId: 'skill-1', patch: { newContent: '# New body' } },
      approvalPayload: { kind: 'staged_skill_update', targetSkillId: 'skill-1' },
      createdAt: new Date('2026-07-07T08:00:00Z'),
    }
    const foreignApproval = {
      ...updateApproval,
      id: 'appr-3',
      arguments: { targetSkillId: 'foreign-skill', patch: { newContent: 'x' } },
      approvalPayload: { kind: 'staged_skill_update', targetSkillId: 'foreign-skill' },
    }
    const opts = baseOpts({
      approvalsStore: {
        listSkillApprovals: vi.fn().mockResolvedValue([updateApproval, foreignApproval]),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      workspaceSkillStore: {
        // skill-1 belongs to the route workspace; foreign-skill does not —
        // the RLS-bypassing system read must re-scope before responding.
        getByIdSystem: vi.fn(async (id: string) =>
          id === 'skill-1'
            ? {
                rowId: 'skill-1',
                workspaceId: WS,
                name: 'Research HKTV Mall Shop Contacts',
                slug: 'research-hktv-mall-shop-contacts',
                content: '# Old body',
              }
            : {
                rowId: 'foreign-skill',
                workspaceId: 'ws-other',
                name: 'Foreign',
                slug: 'foreign',
                content: 'nope',
              },
        ),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    })
    const app = mountApp(opts)

    const res = await request(app).get(`/api/skills/approvals?workspaceId=${WS}`)
    expect(res.status).toBe(200)
    expect(res.body.approvals).toHaveLength(2)
    expect(res.body.approvals[0].targetSkill).toEqual({
      id: 'skill-1',
      name: 'Research HKTV Mall Shop Contacts',
      slug: 'research-hktv-mall-shop-contacts',
      content: '# Old body',
    })
    // Cross-workspace target → stripped to null, never leaked.
    expect(res.body.approvals[1].targetSkill).toBeNull()
  })

  it('matched existing skill → recordRederivation + learned_from edge, NO create', async () => {
    const opts = baseOpts({
      workspaceSkillStore: {
        listScopedForWorkspace: vi.fn().mockResolvedValue([
          bindScopeSource({
            rowId: 'existing-skill-9',
            slug: 'weekly-investor-update',
            name: 'Weekly Investor Update',
            whenToUse: undefined,
            state: 'active',
          }, {
            workspaceId: WS,
            userId: APPROVER,
            assistantId: ASSISTANT,
            sensitivity: 'internal',
            compartments: [],
            projectIds: [],
            resourceKind: 'workspace_skill_revision',
            resourceId: 'existing-revision-9',
            version: '1',
          }),
        ]),
        create: vi.fn().mockResolvedValue({ rowId: 'should-not-be-created' }),
        recordRederivation: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(true),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    })
    const app = mountApp(opts)

    const res = await request(app).post('/api/skills/approvals/appr-1/approve').send({})
    expect(res.status).toBe(200)

    // Slug-exact match → counter/confidence and revision are one derived transaction.
    expect(opts.workspaceSkillStore.recordRederivation).not.toHaveBeenCalled()
    expect(rederiveMock).toHaveBeenCalledWith(expect.objectContaining({
      skillId: 'existing-skill-9',
      evidence: DERIVATION,
    }))
    // No duplicate created.
    expect(opts.workspaceSkillStore.create).not.toHaveBeenCalled()
    // learned_from edge points at the existing skill row (audit trail).
    expect(opts.entityLinks!.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKind: 'skill',
        sourceId: 'existing-skill-9',
        targetKind: 'assistant',
        edgeType: 'learned_from',
      }),
    )
  })
})

// ── Origin-aware induction: workflow refinements + attach offer ─────

describe('[COMP:api/skill-approvals-route] workflow_refinement approve', () => {
  beforeEach(() => vi.clearAllMocks())

  const REFINEMENT_APPROVAL = {
    id: 'appr-wr-1',
    kind: 'workflow_refinement' as const,
    status: 'pending' as const,
    workspaceId: WS,
    originatingAssistantId: ASSISTANT,
    arguments: {
      workflowId: 'wf-1',
      stepId: 'step-1',
      patch: { prompt: 'Improved step prompt' },
      rationale: 'The run showed the old prompt truncates',
    },
    approvalPayload: { kind: 'workflow_refinement', workflowId: 'wf-1', stepId: 'step-1' },
  }

  function refinementOpts(over: Partial<SkillApprovalRouteOptions> = {}) {
    return baseOpts({
      approvalsStore: {
        getById: vi.fn().mockResolvedValue(REFINEMENT_APPROVAL),
        respond: vi.fn().mockResolvedValue({ ...REFINEMENT_APPROVAL, status: 'approved' }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      ...over,
    })
  }

  it('applies the step-prompt patch through the validated definition editor', async () => {
    const applyDefinitionEdit = vi.fn(
      async (params: {
        mutate: (d: { steps: Array<{ id: string; type: string; prompt?: string }> }) =>
          | { steps: Array<{ id: string; type: string; prompt?: string }> }
          | { error: string }
      }) => {
        // Drive the mutate exactly like the real editor: clone + transform.
        const def = { steps: [{ id: 'step-1', type: 'assistant_call', prompt: 'old' }] }
        const mutated = params.mutate(def)
        expect('error' in mutated).toBe(false)
        expect((mutated as { steps: Array<{ prompt?: string }> }).steps[0]!.prompt).toBe(
          'Improved step prompt',
        )
        return { ok: true as const }
      },
    )
    const opts = refinementOpts({ applyDefinitionEdit: applyDefinitionEdit as never })
    const app = mountApp(opts)

    const res = await request(app).post('/api/skills/approvals/appr-wr-1/approve').send({})
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'approved', kind: 'workflow_refinement' })
    expect(applyDefinitionEdit).toHaveBeenCalledWith(
      expect.objectContaining({ userId: APPROVER, workspaceId: WS, workflowId: 'wf-1' }),
    )
    expect(opts.approvalsStore.respond).toHaveBeenCalledWith('appr-wr-1', 'approved', APPROVER)
  })

  it('leaves the row pending when the validated edit is rejected', async () => {
    const applyDefinitionEdit = vi.fn(async () => ({
      ok: false as const,
      error: 'definition.steps.0.prompt: too long',
    }))
    const opts = refinementOpts({ applyDefinitionEdit: applyDefinitionEdit as never })
    const app = mountApp(opts)

    const res = await request(app).post('/api/skills/approvals/appr-wr-1/approve').send({})
    expect(res.status).toBe(500)
    expect(opts.approvalsStore.respond).not.toHaveBeenCalled()
  })

  it('rejects a refinement without mutation', async () => {
    const opts = refinementOpts()
    const app = mountApp(opts)

    const res = await request(app).post('/api/skills/approvals/appr-wr-1/reject').send({})
    expect(res.status).toBe(200)
    expect(opts.approvalsStore.respond).toHaveBeenCalledWith(
      'appr-wr-1',
      'rejected',
      APPROVER,
      undefined,
    )
  })
})

describe('[COMP:api/skill-approvals-route] attach offer on creation approve', () => {
  beforeEach(() => vi.clearAllMocks())

  const CREATION_WITH_ATTACH = {
    id: 'appr-ca-1',
    kind: 'staged_skill_creation' as const,
    status: 'pending' as const,
    workspaceId: WS,
    originatingAssistantId: ASSISTANT,
    arguments: {
      umbrella: {
        slug: 'paging-github-activity',
        name: 'Paging through GitHub activity',
        description: 'Enumerate events past the API page limit',
        content: 'Use per_page + since cursors.',
      },
      derivation: DERIVATION,
    },
    approvalPayload: {
      kind: 'staged_skill_creation',
      origin: 'workflow-session',
      sourceWorkflowIds: ['wf-1'],
      attachTo: { workflowId: 'wf-1', stepId: 'step-1' },
    },
  }

  function attachOpts(over: Partial<SkillApprovalRouteOptions> = {}) {
    return baseOpts({
      approvalsStore: {
        getById: vi.fn().mockResolvedValue(CREATION_WITH_ATTACH),
        respond: vi.fn().mockResolvedValue({ ...CREATION_WITH_ATTACH, status: 'approved' }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      ...over,
    })
  }

  it('appends the slug to the step skills allow-list when attach is accepted', async () => {
    const applyDefinitionEdit = vi.fn(
      async (params: {
        mutate: (d: {
          steps: Array<{ id: string; type: string; skills?: string[] }>
        }) => { steps: Array<{ id: string; type: string; skills?: string[] }> } | { error: string }
      }) => {
        const def = { steps: [{ id: 'step-1', type: 'assistant_call' }] }
        const mutated = params.mutate(def)
        expect(
          (mutated as { steps: Array<{ skills?: string[] }> }).steps[0]!.skills,
        ).toEqual(['paging-github-activity'])
        return { ok: true as const }
      },
    )
    const opts = attachOpts({ applyDefinitionEdit: applyDefinitionEdit as never })
    const app = mountApp(opts)

    const res = await request(app)
      .post('/api/skills/approvals/appr-ca-1/approve')
      .send({ attach: true })
    expect(res.status).toBe(200)
    expect(res.body.attach).toEqual({ applied: true })
    expect(createDerivedMock).toHaveBeenCalledTimes(1)
  })

  it('a failed attach never unwinds the approved creation', async () => {
    const applyDefinitionEdit = vi.fn(async () => ({
      ok: false as const,
      error: 'step vanished',
    }))
    const opts = attachOpts({ applyDefinitionEdit: applyDefinitionEdit as never })
    const app = mountApp(opts)

    const res = await request(app)
      .post('/api/skills/approvals/appr-ca-1/approve')
      .send({ attach: true })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('approved')
    expect(res.body.attach).toMatchObject({ applied: false })
    expect(createDerivedMock).toHaveBeenCalledTimes(1)
    expect(opts.approvalsStore.respond).toHaveBeenCalled()
  })

  it('skips the attach entirely without explicit opt-in', async () => {
    const applyDefinitionEdit = vi.fn(async () => ({ ok: true as const }))
    const opts = attachOpts({ applyDefinitionEdit: applyDefinitionEdit as never })
    const app = mountApp(opts)

    const res = await request(app).post('/api/skills/approvals/appr-ca-1/approve').send({})
    expect(res.status).toBe(200)
    expect(res.body.attach).toBeUndefined()
    expect(applyDefinitionEdit).not.toHaveBeenCalled()
  })

  it('routes the learned_from edge at the source workflow for workflow-origin inductions', async () => {
    const opts = attachOpts()
    const app = mountApp(opts)

    const res = await request(app).post('/api/skills/approvals/appr-ca-1/approve').send({})
    expect(res.status).toBe(200)
    expect(opts.entityLinks!.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKind: 'skill',
        targetKind: 'workflow',
        targetId: 'wf-1',
        edgeType: 'learned_from',
      }),
    )
  })
})
