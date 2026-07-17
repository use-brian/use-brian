/**
 * [COMP:engine/introspection-tools] Read-only workspace-visibility toolkit
 * (`listPendingApprovals` / `listScheduledJobs` / `listResearchRuns` /
 * `listWorkspaceSessions` / `readSessionTranscript`) that closes the P1 gaps
 * in the assistant ability audit (docs/plans/assistant-ability-audit.md
 * §1.3 / §6-a).
 *
 * Tests cover, per tool: the happy-path render, the workspace-context guard,
 * that `ToolContext.workspaceId` (never model input) is the scope threaded
 * into the port, the shared `limit` default (20) + cap (50) behaviour, and
 * the friendly empty-state message. The §6-a session-history pair adds:
 * workspace-scoping recorded via the stub, the identical-not-found-wording
 * property (no existence oracle), the text-gist extraction with a tool_use
 * message, and the transcript cap (default 30 / max 100). Ports are `vi.fn()`
 * stubs — no DB.
 *
 * Spec: docs/architecture/engine/introspection-tools.md.
 */

import { describe, expect, it, vi } from 'vitest'
import { createIntrospectionTools } from '../tools.js'
import type {
  IntrospectionDeps,
  IntrospectionPendingApproval,
  IntrospectionScheduledJob,
  IntrospectionWorkerRun,
  IntrospectionSessionSummary,
  IntrospectionTranscriptMessage,
} from '../types.js'
import type { Tool, ToolContext } from '../../tools/types.js'

// ── Fixtures ─────────────────────────────────────────────────────────

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'
const ASSISTANT_ID = 'asst-1'
const USER_ID = 'user-1'

const ctx: ToolContext = {
  userId: USER_ID,
  assistantId: ASSISTANT_ID,
  sessionId: 'sess-1',
  appId: 'Use Brian',
  channelType: 'web',
  channelId: 'chan-1',
  workspaceId: WORKSPACE_ID,
  abortSignal: new AbortController().signal,
}

/** A ctx with no workspace — every tool must reject this. */
const ctxNoWorkspace: ToolContext = { ...ctx, workspaceId: null }

// ── Stub ports (vi.fn recorders) ─────────────────────────────────────

type StubDeps = IntrospectionDeps & {
  pendingApprovals: { listPendingForWorkspace: ReturnType<typeof vi.fn> }
  scheduledJobs: { search: ReturnType<typeof vi.fn> }
  workerRuns: { listRecentForWorkspace: ReturnType<typeof vi.fn> }
  sessionHistory: {
    listSessionsForWorkspaceSystem: ReturnType<typeof vi.fn>
    getSessionTranscriptForWorkspaceSystem: ReturnType<typeof vi.fn>
  }
}

function makeDeps(overrides: {
  approvals?: IntrospectionPendingApproval[]
  jobs?: IntrospectionScheduledJob[]
  runs?: IntrospectionWorkerRun[]
  sessions?: IntrospectionSessionSummary[]
  /** Present key wins (including an explicit `null` = out-of-scope / unknown). */
  transcript?: IntrospectionTranscriptMessage[] | null
} = {}): StubDeps {
  // Distinguish an explicit `transcript: null` (not-found) from an absent key
  // (default to an empty transcript so happy-path list tests need not set it).
  const transcriptValue = 'transcript' in overrides ? overrides.transcript : []
  return {
    pendingApprovals: {
      listPendingForWorkspace: vi.fn(async () => overrides.approvals ?? []),
    },
    scheduledJobs: {
      search: vi.fn(async () => ({ jobs: overrides.jobs ?? [] })),
    },
    workerRuns: {
      listRecentForWorkspace: vi.fn(async () => overrides.runs ?? []),
    },
    sessionHistory: {
      listSessionsForWorkspaceSystem: vi.fn(async () => overrides.sessions ?? []),
      getSessionTranscriptForWorkspaceSystem: vi.fn(async () => transcriptValue),
    },
  } as StubDeps
}

/** Locate a tool by name from the factory's `Tool[]` return. */
function toolNamed(tools: Tool[], name: string): Tool {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`tool ${name} not built`)
  return t
}

const APPROVAL: IntrospectionPendingApproval = {
  id: 'aaaaaaaa-1111-4111-8111-111111111111',
  kind: 'tool_invocation',
  toolName: 'gmailSendMessage',
  createdAt: new Date('2026-07-01T10:00:00.000Z'),
  expiresAt: new Date('2026-07-02T10:00:00.000Z'),
  arguments: { to: 'x@y.com', subject: 'hi' },
  approvalPayload: { description: 'Send an email to the vendor' },
}

const JOB: IntrospectionScheduledJob = {
  id: 'bbbbbbbb-2222-4222-8222-222222222222',
  instructions: 'Remind me to take the medication',
  schedule: { type: 'daily', time: '09:00' },
  nextRunAt: new Date('2026-07-08T09:00:00.000Z'),
  lastRunAt: new Date('2026-07-07T09:00:00.000Z'),
  lastStatus: 'completed',
  enabled: true,
  workflowId: null,
  channelType: 'telegram',
}

const RUN: IntrospectionWorkerRun = {
  id: 'cccccccc-3333-4333-8333-333333333333',
  status: 'completed',
  description: 'Instagram growth tactics 1984',
  prompt: 'research instagram growth tactics',
  sessionId: 'dddddddd-4444-4444-8444-444444444444',
  createdAt: new Date('2026-07-07T08:00:00.000Z'),
  updatedAt: new Date('2026-07-07T08:05:00.000Z'),
}

const SESSION: IntrospectionSessionSummary = {
  id: 'eeeeeeee-5555-4555-8555-555555555555',
  assistantId: 'ffffffff-6666-4666-8666-666666666666',
  assistantName: 'Product',
  channelType: 'telegram',
  status: 'idle',
  createdAt: new Date('2026-07-06T12:00:00.000Z'),
  lastActiveAt: new Date('2026-07-07T09:30:00.000Z'),
}

/** A valid UUID sessionId the model would pass to readSessionTranscript. */
const SESSION_ID = 'eeeeeeee-5555-4555-8555-555555555555'

const TRANSCRIPT: IntrospectionTranscriptMessage[] = [
  { role: 'user', gist: 'send the vendor the invoice' },
  { role: 'assistant', gist: '[tool: gmailSendMessage] [tool result] Done, sent it.' },
]

// ── Shared: factory shape + safety flags ─────────────────────────────

describe('[COMP:engine/introspection-tools] factory shape', () => {
  it('builds exactly the five documented tools in order', () => {
    const tools = createIntrospectionTools(makeDeps())
    expect(tools.map((t) => t.name)).toEqual([
      'listPendingApprovals',
      'listScheduledJobs',
      'listResearchRuns',
      'listWorkspaceSessions',
      'readSessionTranscript',
    ])
  })

  it('marks all tools read-only and concurrency-safe', () => {
    for (const tool of createIntrospectionTools(makeDeps())) {
      expect(tool.isReadOnly).toBe(true)
      expect(tool.isConcurrencySafe).toBe(true)
      // A read tool never gates behind a confirmation.
      expect(tool.requiresConfirmation).toBe(false)
    }
  })
})

// ── Shared: workspace-context guard ──────────────────────────────────

describe('[COMP:engine/introspection-tools] workspace-context guard', () => {
  it('every tool errors without a workspace and never touches its port', async () => {
    const deps = makeDeps()
    const tools = createIntrospectionTools(deps)
    // The workspace guard runs before any input parsing, so an empty input
    // is fine here even for readSessionTranscript (which normally needs a
    // sessionId) — the tool short-circuits on the missing workspace first.
    const results = await Promise.all(
      tools.map((t) => t.execute({}, ctxNoWorkspace)),
    )
    for (const r of results) expect(r.isError).toBe(true)
    expect(deps.pendingApprovals.listPendingForWorkspace).not.toHaveBeenCalled()
    expect(deps.scheduledJobs.search).not.toHaveBeenCalled()
    expect(deps.workerRuns.listRecentForWorkspace).not.toHaveBeenCalled()
    expect(deps.sessionHistory.listSessionsForWorkspaceSystem).not.toHaveBeenCalled()
    expect(deps.sessionHistory.getSessionTranscriptForWorkspaceSystem).not.toHaveBeenCalled()
  })
})

// ── listPendingApprovals ─────────────────────────────────────────────

describe('[COMP:engine/introspection-tools] listPendingApprovals', () => {
  it('scopes the read to the ToolContext userId + workspaceId', async () => {
    const deps = makeDeps({ approvals: [APPROVAL] })
    const tool = toolNamed(createIntrospectionTools(deps), 'listPendingApprovals')
    await tool.execute({}, ctx)
    expect(deps.pendingApprovals.listPendingForWorkspace).toHaveBeenCalledWith(
      USER_ID,
      WORKSPACE_ID,
    )
  })

  it('renders id, kind, tool, timestamps and the payload description gist', async () => {
    const deps = makeDeps({ approvals: [APPROVAL] })
    const tool = toolNamed(createIntrospectionTools(deps), 'listPendingApprovals')
    const text = String((await tool.execute({}, ctx)).data)
    expect(text).toContain('aaaaaaaa') // 8-char id prefix
    expect(text).toContain('tool_invocation')
    expect(text).toContain('gmailSendMessage')
    expect(text).toContain('2026-07-01T10:00:00.000Z')
    expect(text).toContain('Send an email to the vendor')
  })

  it('renders "(never)" for a null expiry and falls back to arg keys with no description', async () => {
    const deps = makeDeps({
      approvals: [
        {
          ...APPROVAL,
          expiresAt: null,
          approvalPayload: {},
        },
      ],
    })
    const tool = toolNamed(createIntrospectionTools(deps), 'listPendingApprovals')
    const text = String((await tool.execute({}, ctx)).data)
    expect(text).toContain('expires (never)')
    // With no description, the gist is a compact hint of the frozen args.
    expect(text).toContain('args: to, subject')
  })

  it('caps the returned rows at the limit (default 20, hard max 50)', async () => {
    // 60 rows returned by the port; default limit trims to 20.
    const many: IntrospectionPendingApproval[] = Array.from({ length: 60 }, (_, i) => ({
      ...APPROVAL,
      id: `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`,
    }))
    const deps = makeDeps({ approvals: many })
    const tool = toolNamed(createIntrospectionTools(deps), 'listPendingApprovals')

    const defaultText = String((await tool.execute({}, ctx)).data)
    expect(defaultText.split('\n')).toHaveLength(20)

    // An over-cap explicit limit is clamped to 50.
    const cappedText = String((await tool.execute({ limit: 999 }, ctx)).data)
    expect(cappedText.split('\n')).toHaveLength(50)
  })

  it('reports a friendly message when nothing is pending', async () => {
    const deps = makeDeps()
    const tool = toolNamed(createIntrospectionTools(deps), 'listPendingApprovals')
    const result = await tool.execute({}, ctx)
    expect(result.isError).toBeFalsy()
    expect(String(result.data)).toMatch(/No approvals are pending/i)
  })
})

// ── listScheduledJobs ────────────────────────────────────────────────

describe('[COMP:engine/introspection-tools] listScheduledJobs', () => {
  it('threads assistant/user/workspace + a clamped limit into search', async () => {
    const deps = makeDeps({ jobs: [JOB] })
    const tool = toolNamed(createIntrospectionTools(deps), 'listScheduledJobs')
    await tool.execute({}, ctx)
    expect(deps.scheduledJobs.search).toHaveBeenCalledWith({
      assistantId: ASSISTANT_ID,
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      limit: 20,
    })
  })

  it('passes an explicit limit through and clamps an over-cap value to 50', async () => {
    const deps = makeDeps({ jobs: [JOB] })
    const tool = toolNamed(createIntrospectionTools(deps), 'listScheduledJobs')
    await tool.execute({ limit: 5 }, ctx)
    expect(deps.scheduledJobs.search.mock.calls[0][0].limit).toBe(5)
    await tool.execute({ limit: 999 }, ctx)
    expect(deps.scheduledJobs.search.mock.calls[1][0].limit).toBe(50)
  })

  it('renders schedule summary, run times, status, enabled state and gist', async () => {
    const deps = makeDeps({ jobs: [JOB] })
    const tool = toolNamed(createIntrospectionTools(deps), 'listScheduledJobs')
    const text = String((await tool.execute({}, ctx)).data)
    expect(text).toContain('bbbbbbbb')
    expect(text).toContain('daily @ 09:00')
    expect(text).toContain('reminder')
    expect(text).toContain('next 2026-07-08T09:00:00.000Z')
    expect(text).toContain('last 2026-07-07T09:00:00.000Z')
    expect(text).toContain('status: completed')
    expect(text).toContain('enabled')
    expect(text).toContain('Remind me to take the medication')
  })

  it('labels a workflow-trigger job and renders (never run) + disabled', async () => {
    const deps = makeDeps({
      jobs: [
        {
          ...JOB,
          workflowId: 'wf-1',
          channelType: 'workflow',
          lastRunAt: null,
          lastStatus: null,
          enabled: false,
          schedule: { type: 'cron', expression: '0 9 * * *' },
        },
      ],
    })
    const tool = toolNamed(createIntrospectionTools(deps), 'listScheduledJobs')
    const text = String((await tool.execute({}, ctx)).data)
    expect(text).toContain('workflow trigger')
    expect(text).toContain('cron 0 9 * * *')
    expect(text).toContain('last (never run)')
    expect(text).toContain('status: none')
    expect(text).toContain('disabled')
  })

  it('reports a friendly message when there are no scheduled jobs', async () => {
    const deps = makeDeps()
    const tool = toolNamed(createIntrospectionTools(deps), 'listScheduledJobs')
    expect(String((await tool.execute({}, ctx)).data)).toMatch(/No scheduled jobs/i)
  })
})

// ── listResearchRuns ─────────────────────────────────────────────────

describe('[COMP:engine/introspection-tools] listResearchRuns', () => {
  it('scopes the read to the ToolContext workspaceId with a clamped limit', async () => {
    const deps = makeDeps({ runs: [RUN] })
    const tool = toolNamed(createIntrospectionTools(deps), 'listResearchRuns')
    await tool.execute({}, ctx)
    expect(deps.workerRuns.listRecentForWorkspace).toHaveBeenCalledWith(WORKSPACE_ID, 20)
  })

  it('passes an explicit limit and clamps an over-cap value to 50', async () => {
    const deps = makeDeps({ runs: [RUN] })
    const tool = toolNamed(createIntrospectionTools(deps), 'listResearchRuns')
    await tool.execute({ limit: 7 }, ctx)
    expect(deps.workerRuns.listRecentForWorkspace.mock.calls[0][1]).toBe(7)
    await tool.execute({ limit: 999 }, ctx)
    expect(deps.workerRuns.listRecentForWorkspace.mock.calls[1][1]).toBe(50)
  })

  it('renders a terminal run with a real finish time + session origin + gist', async () => {
    const deps = makeDeps({ runs: [RUN] })
    const tool = toolNamed(createIntrospectionTools(deps), 'listResearchRuns')
    const text = String((await tool.execute({}, ctx)).data)
    expect(text).toContain('cccccccc')
    expect(text).toContain('completed')
    expect(text).toContain('started 2026-07-07T08:00:00.000Z')
    expect(text).toContain('finished 2026-07-07T08:05:00.000Z')
    expect(text).toContain('session dddddddd')
    expect(text).toContain('Instagram growth tactics 1984')
  })

  it('shows (running) for a running row and falls back to the prompt when description is empty', async () => {
    const deps = makeDeps({
      runs: [
        {
          ...RUN,
          status: 'running',
          description: '   ',
          prompt: 'research instagram growth tactics',
        },
      ],
    })
    const tool = toolNamed(createIntrospectionTools(deps), 'listResearchRuns')
    const text = String((await tool.execute({}, ctx)).data)
    expect(text).toContain('running')
    expect(text).toContain('finished (running)')
    // Description was whitespace-only → gist falls back to the seed prompt.
    expect(text).toContain('research instagram growth tactics')
  })

  it('reports a friendly message when there are no research runs', async () => {
    const deps = makeDeps()
    const tool = toolNamed(createIntrospectionTools(deps), 'listResearchRuns')
    expect(String((await tool.execute({}, ctx)).data)).toMatch(/No research runs/i)
  })
})

// ── listWorkspaceSessions (§6-a) ─────────────────────────────────────

describe('[COMP:engine/introspection-tools] listWorkspaceSessions', () => {
  it('scopes the read to the ToolContext workspaceId, never model input', async () => {
    const deps = makeDeps({ sessions: [SESSION] })
    const tool = toolNamed(createIntrospectionTools(deps), 'listWorkspaceSessions')
    await tool.execute({}, ctx)
    expect(deps.sessionHistory.listSessionsForWorkspaceSystem).toHaveBeenCalledWith(
      WORKSPACE_ID,
      { limit: 20, channelType: undefined },
    )
  })

  it('threads an explicit channelType filter and clamps an over-cap limit to 50', async () => {
    const deps = makeDeps({ sessions: [SESSION] })
    const tool = toolNamed(createIntrospectionTools(deps), 'listWorkspaceSessions')
    await tool.execute({ limit: 999, channelType: 'telegram' }, ctx)
    expect(deps.sessionHistory.listSessionsForWorkspaceSystem).toHaveBeenCalledWith(
      WORKSPACE_ID,
      { limit: 50, channelType: 'telegram' },
    )
  })

  it('renders id, assistant name + id, channel, status, created and last-active', async () => {
    const deps = makeDeps({ sessions: [SESSION] })
    const tool = toolNamed(createIntrospectionTools(deps), 'listWorkspaceSessions')
    const text = String((await tool.execute({}, ctx)).data)
    expect(text).toContain('eeeeeeee') // 8-char session id prefix
    expect(text).toContain('Product')
    expect(text).toContain('ffffffff') // 8-char assistant id prefix
    expect(text).toContain('channel: telegram')
    expect(text).toContain('status: idle')
    expect(text).toContain('created 2026-07-06T12:00:00.000Z')
    expect(text).toContain('active 2026-07-07T09:30:00.000Z')
  })

  it('reports a plain empty message with no filter', async () => {
    const deps = makeDeps()
    const tool = toolNamed(createIntrospectionTools(deps), 'listWorkspaceSessions')
    expect(String((await tool.execute({}, ctx)).data)).toMatch(/No sessions in this workspace/i)
  })

  it('names the filtered channel in the empty message', async () => {
    const deps = makeDeps()
    const tool = toolNamed(createIntrospectionTools(deps), 'listWorkspaceSessions')
    const text = String((await tool.execute({ channelType: 'slack' }, ctx)).data)
    expect(text).toMatch(/No slack sessions/i)
  })
})

// ── readSessionTranscript (§6-a) ─────────────────────────────────────

describe('[COMP:engine/introspection-tools] readSessionTranscript', () => {
  it('scopes the fetch to the sessionId + ToolContext workspaceId with a clamped limit', async () => {
    const deps = makeDeps({ transcript: TRANSCRIPT })
    const tool = toolNamed(createIntrospectionTools(deps), 'readSessionTranscript')
    await tool.execute({ sessionId: SESSION_ID }, ctx)
    expect(deps.sessionHistory.getSessionTranscriptForWorkspaceSystem).toHaveBeenCalledWith(
      SESSION_ID,
      WORKSPACE_ID,
      { limit: 30 },
    )
  })

  it('clamps an over-cap transcript limit to 100', async () => {
    const deps = makeDeps({ transcript: TRANSCRIPT })
    const tool = toolNamed(createIntrospectionTools(deps), 'readSessionTranscript')
    await tool.execute({ sessionId: SESSION_ID, limit: 999 }, ctx)
    expect(
      deps.sessionHistory.getSessionTranscriptForWorkspaceSystem.mock.calls[0][2],
    ).toEqual({ limit: 100 })
  })

  it('renders role + gist and collapses tool blocks to one-line markers', async () => {
    const deps = makeDeps({ transcript: TRANSCRIPT })
    const tool = toolNamed(createIntrospectionTools(deps), 'readSessionTranscript')
    const text = String((await tool.execute({ sessionId: SESSION_ID }, ctx)).data)
    expect(text).toContain('user: send the vendor the invoice')
    expect(text).toContain('assistant: [tool: gmailSendMessage] [tool result] Done, sent it.')
    // A read must never surface a full frozen tool payload.
    expect(text).not.toContain('invoice@vendor')
  })

  it('caps each rendered gist at 300 chars', async () => {
    const long = 'x'.repeat(500)
    const deps = makeDeps({ transcript: [{ role: 'assistant', gist: long }] })
    const tool = toolNamed(createIntrospectionTools(deps), 'readSessionTranscript')
    const text = String((await tool.execute({ sessionId: SESSION_ID }, ctx)).data)
    // `assistant: ` prefix (11) + 300-char gist (ellipsis included).
    expect(text.length).toBeLessThanOrEqual(11 + 300)
    expect(text.endsWith('…')).toBe(true)
  })

  // No-existence-oracle: a null return (unknown id OR out-of-scope session)
  // yields the SAME error text either way, so the model cannot use the tool
  // to probe whether a session id exists in another workspace.
  it('returns an identical not-found error for an out-of-scope and an unknown session', async () => {
    const other = 'aaaaaaaa-9999-4999-8999-999999999999'
    const depsOutOfScope = makeDeps({ transcript: null })
    const depsUnknown = makeDeps({ transcript: null })
    const toolA = toolNamed(createIntrospectionTools(depsOutOfScope), 'readSessionTranscript')
    const toolB = toolNamed(createIntrospectionTools(depsUnknown), 'readSessionTranscript')

    const resA = await toolA.execute({ sessionId: SESSION_ID }, ctx)
    const resB = await toolB.execute({ sessionId: other }, ctx)

    expect(resA.isError).toBe(true)
    expect(resB.isError).toBe(true)
    // Byte-identical message — the property that makes this not an oracle.
    expect(String(resA.data)).toBe(String(resB.data))
    expect(String(resA.data)).toMatch(/not exist|another workspace|personal assistant/i)
  })

  it('reports a distinct friendly message for an in-scope session with no messages', async () => {
    const deps = makeDeps({ transcript: [] })
    const tool = toolNamed(createIntrospectionTools(deps), 'readSessionTranscript')
    const result = await tool.execute({ sessionId: SESSION_ID }, ctx)
    expect(result.isError).toBeFalsy()
    expect(String(result.data)).toMatch(/no messages yet/i)
  })
})
