/**
 * Unit tests for induction governance on staged-skill-creation approval.
 * Component tag: [COMP:api/skill-approvals-route].
 *
 * Exercises `applyStagedSkillCreation` through the route handler's
 * `POST /:id/approve` path with mocked stores. Verifies the two re-derivation
 * branches (`docs/plans/skills-as-procedural-brain-primitive.md` §5.2, §6):
 *   * matched existing skill → recordRederivation + learned_from edge, NO create;
 *   * no match → create with inductionSource='self' + learned_from edge.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../../db/client.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  queryWithRLS: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
}))

import { skillApprovalsRoutes, type SkillApprovalRouteOptions } from '../skill-approvals.js'

const WS = 'ws-1'
const APPROVER = 'user-1'
const ASSISTANT = 'asst-1'

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
    expect(opts.workspaceSkillStore.create).toHaveBeenCalledTimes(1)
    const createInput = (opts.workspaceSkillStore.create as ReturnType<typeof vi.fn>).mock.calls[0][2]
    expect(createInput.inductionSource).toBe('self')
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

  it('matched existing skill → recordRederivation + learned_from edge, NO create', async () => {
    const opts = baseOpts({
      workspaceSkillStore: {
        listForWorkspace: vi.fn().mockResolvedValue([
          {
            rowId: 'existing-skill-9',
            slug: 'weekly-investor-update',
            name: 'Weekly Investor Update',
            whenToUse: undefined,
            state: 'active',
          },
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

    // Slug-exact match → re-derivation recorded against the EXISTING skill.
    expect(opts.workspaceSkillStore.recordRederivation).toHaveBeenCalledWith('existing-skill-9')
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
