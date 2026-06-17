import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  runSessionResume,
  type SessionResumeDeps,
  type SessionResumeReplay,
  type ResumeReplayParams,
} from '../chat.js'
import type { SessionResumeStore, SessionResumePoint } from '../../db/session-resume-store.js'
import type { PendingApprovalsStore, PendingApproval } from '../../db/pending-approvals-store.js'

// ─────────────────────────────────────────────────────────────────────
// `runSessionResume` orchestrator (WU-6.4 — Path B durable chat resume).
// This file pins the lifecycle contract the poll worker depends on:
//   * idempotent on missing resume_point
//   * skip when approval still pending
//   * fail on session_id mismatch
//   * delete resume_point only when replay returns 'completed'
// The actual tool replay (mocked via `replay`) is wired in apps/api.
// ─────────────────────────────────────────────────────────────────────

const SAMPLE_POINT: SessionResumePoint = {
  sessionId: 'sess-1',
  approvalId: 'app-1',
  suspendedToolName: 'gmailSendMessage',
  suspendedToolInput: { to: 'user@example.com' },
  loopStepIndex: 2,
  createdAt: new Date('2026-05-14T00:00:00Z'),
}

function makeApproval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: 'app-1',
    workspaceId: 'ws-1',
    workflowRunId: 'run-1',
    workflowStepRunId: 'step-1',
    toolName: 'gmailSendMessage',
    arguments: { to: 'user@example.com' },
    approverUserId: 'user-1',
    deliveryChannelType: 'web',
    deliveryChannelId: null,
    status: 'approved',
    expiresAt: null,
    respondedAt: new Date('2026-05-14T00:01:00Z'),
    respondedBy: 'user-1',
    rejectReason: null,
    createdAt: new Date('2026-05-14T00:00:00Z'),
    kind: 'tool_invocation',
    blockingSessionId: 'sess-1',
    approvalPayload: {},
    originatingAssistantId: null,
    answerText: null,
    ...overrides,
  }
}

function makeStubResumeStore(point: SessionResumePoint | null) {
  return {
    create: vi.fn(),
    getBySessionId: vi.fn(),
    getByApprovalId: vi.fn().mockResolvedValue(point),
    deleteBySessionId: vi.fn().mockResolvedValue(true),
    deleteByApprovalId: vi.fn().mockResolvedValue(true),
  } satisfies SessionResumeStore as unknown as SessionResumeStore & {
    deleteBySessionId: ReturnType<typeof vi.fn>
    getByApprovalId: ReturnType<typeof vi.fn>
  }
}

function makeStubApprovalsStore(approval: PendingApproval | null) {
  return {
    create: vi.fn(),
    createToolInvocation: vi.fn(),
    createStagedSkillUpdate: vi.fn(),
    createStagedSkillCreation: vi.fn(),
    createStagedWrite: vi.fn(),
    createQuestion: vi.fn(),
    recordAnswer: vi.fn(),
    listSkillApprovals: vi.fn(),
    listPendingForWorkspace: vi.fn(),
    countPendingForUser: vi.fn(),
    getById: vi.fn(),
    getByIdSystem: vi.fn().mockResolvedValue(approval),
    respond: vi.fn(),
    expireDue: vi.fn(),
    expireDueQuestions: vi.fn(),
    // Wave 3 admin-side surface — not exercised by this test.
    listForAdmin: vi.fn(),
    rankWorkspacesForAdmin: vi.fn(),
    getByIdForAdmin: vi.fn(),
    forceExpireForAdmin: vi.fn(),
  } satisfies PendingApprovalsStore as unknown as PendingApprovalsStore
}

function makeDeps(opts: {
  point: SessionResumePoint | null
  approval: PendingApproval | null
  replay?: SessionResumeReplay
}): SessionResumeDeps {
  return {
    sessionResumeStore: makeStubResumeStore(opts.point),
    pendingApprovalsStore: makeStubApprovalsStore(opts.approval),
    replay: opts.replay ?? vi.fn(async () => 'completed' as const),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:brain/session-resume-worker] runSessionResume', () => {
  it("returns 'skipped' when the resume_point row is missing (idempotent re-fire)", async () => {
    const replay = vi.fn<SessionResumeReplay>(async () => 'completed')
    const deps = makeDeps({ point: null, approval: makeApproval(), replay })
    const outcome = await runSessionResume(deps, { sessionId: 'sess-1', approvalId: 'app-1' })
    expect(outcome).toEqual({ status: 'skipped', reason: 'resume_point_missing' })
    expect(replay).not.toHaveBeenCalled()
  })

  it("returns 'failed' when the resume_point's session_id disagrees with the trigger payload", async () => {
    const replay = vi.fn<SessionResumeReplay>(async () => 'completed')
    const deps = makeDeps({
      point: { ...SAMPLE_POINT, sessionId: 'other-session' },
      approval: makeApproval(),
      replay,
    })
    const outcome = await runSessionResume(deps, { sessionId: 'sess-1', approvalId: 'app-1' })
    expect(outcome.status).toBe('failed')
    expect(replay).not.toHaveBeenCalled()
  })

  it("returns 'failed' when the approval row is missing (defensive against broken FK CASCADE)", async () => {
    const replay = vi.fn<SessionResumeReplay>(async () => 'completed')
    const deps = makeDeps({ point: SAMPLE_POINT, approval: null, replay })
    const outcome = await runSessionResume(deps, { sessionId: 'sess-1', approvalId: 'app-1' })
    expect(outcome).toEqual({ status: 'failed', reason: 'approval_missing' })
    expect(replay).not.toHaveBeenCalled()
  })

  it("returns 'skipped' when approval is still pending (poll worker fired too early)", async () => {
    const replay = vi.fn<SessionResumeReplay>(async () => 'completed')
    const deps = makeDeps({
      point: SAMPLE_POINT,
      approval: makeApproval({ status: 'pending' }),
      replay,
    })
    const outcome = await runSessionResume(deps, { sessionId: 'sess-1', approvalId: 'app-1' })
    expect(outcome).toEqual({ status: 'skipped', reason: 'approval_still_pending' })
    expect(replay).not.toHaveBeenCalled()
    expect((deps.sessionResumeStore.deleteBySessionId as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('approved: calls replay with the suspended state and deletes the resume_point on success', async () => {
    const capturedParams: ResumeReplayParams[] = []
    const replay: SessionResumeReplay = async (p) => {
      capturedParams.push(p)
      return 'completed'
    }
    const deps = makeDeps({ point: SAMPLE_POINT, approval: makeApproval({ status: 'approved' }), replay })

    const outcome = await runSessionResume(deps, { sessionId: 'sess-1', approvalId: 'app-1' })
    expect(outcome).toEqual({ status: 'completed' })
    expect(capturedParams).toHaveLength(1)
    expect(capturedParams[0]).toEqual({
      sessionId: 'sess-1',
      approvalId: 'app-1',
      suspendedToolName: 'gmailSendMessage',
      suspendedToolInput: { to: 'user@example.com' },
      loopStepIndex: 2,
      approvalStatus: 'approved',
      rejectReason: null,
      answerText: null,
      approvalKind: 'tool_invocation',
    })
    expect((deps.sessionResumeStore.deleteBySessionId as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('sess-1')
  })

  it('rejected: hands the reject_reason through and still deletes the resume_point', async () => {
    const replay = vi.fn<SessionResumeReplay>(async () => 'completed')
    const deps = makeDeps({
      point: SAMPLE_POINT,
      approval: makeApproval({ status: 'rejected', rejectReason: 'too risky' }),
      replay,
    })
    const outcome = await runSessionResume(deps, { sessionId: 'sess-1', approvalId: 'app-1' })
    expect(outcome).toEqual({ status: 'completed' })
    const params = replay.mock.calls[0][0]
    expect(params.approvalStatus).toBe('rejected')
    expect(params.rejectReason).toBe('too risky')
    expect((deps.sessionResumeStore.deleteBySessionId as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('sess-1')
  })

  it('expired: surfaces the expired status to the replay', async () => {
    const replay = vi.fn<SessionResumeReplay>(async () => 'completed')
    const deps = makeDeps({
      point: SAMPLE_POINT,
      approval: makeApproval({ status: 'expired' }),
      replay,
    })
    const outcome = await runSessionResume(deps, { sessionId: 'sess-1', approvalId: 'app-1' })
    expect(outcome).toEqual({ status: 'completed' })
    expect(replay.mock.calls[0][0].approvalStatus).toBe('expired')
  })

  it("when replay returns 'deferred', leaves the resume_point in place for a retry", async () => {
    const replay = vi.fn<SessionResumeReplay>(async () => 'deferred')
    const deps = makeDeps({ point: SAMPLE_POINT, approval: makeApproval({ status: 'approved' }), replay })
    const outcome = await runSessionResume(deps, { sessionId: 'sess-1', approvalId: 'app-1' })
    expect(outcome).toEqual({ status: 'skipped', reason: 'replay_deferred' })
    expect((deps.sessionResumeStore.deleteBySessionId as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('when replay throws, the resume_point is NOT deleted and the error propagates', async () => {
    const replay = vi.fn<SessionResumeReplay>(async () => {
      throw new Error('replay exploded')
    })
    const deps = makeDeps({ point: SAMPLE_POINT, approval: makeApproval({ status: 'approved' }), replay })
    await expect(
      runSessionResume(deps, { sessionId: 'sess-1', approvalId: 'app-1' }),
    ).rejects.toThrow('replay exploded')
    expect((deps.sessionResumeStore.deleteBySessionId as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it("returns 'skipped' for unsupported approval statuses (e.g. superseded)", async () => {
    const replay = vi.fn<SessionResumeReplay>(async () => 'completed')
    const deps = makeDeps({
      point: SAMPLE_POINT,
      approval: makeApproval({ status: 'superseded' }),
      replay,
    })
    const outcome = await runSessionResume(deps, { sessionId: 'sess-1', approvalId: 'app-1' })
    expect(outcome.status).toBe('skipped')
    expect((outcome as { reason: string }).reason).toContain('superseded')
    expect(replay).not.toHaveBeenCalled()
  })
})
