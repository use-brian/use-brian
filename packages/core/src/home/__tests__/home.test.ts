import { describe, it, expect, vi } from 'vitest'
import { mergeHomeDock } from '../merge.js'
import { createHomeTools } from '../tools.js'
import type { HomeDockLayout, HomeDockStore, HomeSignals } from '../types.js'

function signals(over: Partial<HomeSignals> = {}): HomeSignals {
  return {
    brainReviewCount: 5,
    approvalsCount: 2,
    autopilotCount: 0,
    taskTriageCount: 0,
    connectorAttentionCount: 0,
    workflowAttentionCount: 0,
    upcomingWorkflows: [{ id: 'w1', name: 'Investor digest', nextRunAt: '2026-06-10T17:00:00Z' }],
    recentDrafts: [{ id: 'd1', name: 'Q2 memo', updatedAt: '2026-06-10T08:00:00Z' }],
    brainEntryCount: 142,
    brainGrowth7d: 18,
    brainSparkline: [0, 1, 0, 2, 3, 1, 0, 4, 2, 1, 0, 2, 1, 1],
    onboarding: { hasConnector: false },
    ...over,
  }
}

function ctx() {
  return {
    userId: 'u1',
    assistantId: 'a1',
    sessionId: 's1',
    appId: 'app',
    channelType: 'home-refresh',
    channelId: 'wNone',
    workspaceId: 'ws1',
    abortSignal: new AbortController().signal,
  }
}

describe('[COMP:home/merge] mergeHomeDock', () => {
  it('falls back to deterministic ordering when no artifact, dropping zero-count cards', () => {
    const dock = mergeHomeDock(null, signals({ approvalsCount: 0 }))
    expect(dock.source).toBe('default')
    // brain_review (5) kept, approvals (0) dropped
    expect(dock.needsYou.map((n) => n.kind)).toEqual(['brain_review'])
    expect(dock.needsYou[0].count).toBe(5)
    expect(dock.note).toBeNull()
    expect(dock.pickUp).toHaveLength(1)
    expect(dock.comingUp).toHaveLength(1)
    expect(dock.brain).toEqual({
      entryCount: 142,
      growth7d: 18,
      sparkline: [0, 1, 0, 2, 3, 1, 0, 4, 2, 1, 0, 2, 1, 1],
      hasConnector: false,
    })
  })

  it('honours assistant order + caption + note, but counts stay live', () => {
    const layout: HomeDockLayout = {
      version: 1,
      note: 'Term sheet lands Thursday.',
      needsYou: [
        { kind: 'approvals', caption: 'Two need a signature' },
        { kind: 'brain_review' },
      ],
      generatedAt: '2026-06-10T09:00:00Z',
      generatedByAssistantId: 'a1',
    }
    const dock = mergeHomeDock(layout, signals())
    expect(dock.source).toBe('assistant')
    expect(dock.note).toBe('Term sheet lands Thursday.')
    // assistant order respected
    expect(dock.needsYou.map((n) => n.kind)).toEqual(['approvals', 'brain_review'])
    // caption from artifact, count from live signals (not the artifact)
    expect(dock.needsYou[0].caption).toBe('Two need a signature')
    expect(dock.needsYou[0].count).toBe(2)
  })

  it('drops a card the artifact selected once its live count is gone (freshness)', () => {
    const layout: HomeDockLayout = {
      version: 1,
      note: null,
      needsYou: [{ kind: 'brain_review' }, { kind: 'approvals' }],
      generatedAt: '2026-06-10T09:00:00Z',
      generatedByAssistantId: 'a1',
    }
    const dock = mergeHomeDock(layout, signals({ brainReviewCount: 0 }))
    expect(dock.needsYou.map((n) => n.kind)).toEqual(['approvals'])
  })

  it('surfaces the autopilot card when goals wait on a kick-start/unblock', () => {
    const dock = mergeHomeDock(null, signals({ autopilotCount: 3 }))
    expect(dock.needsYou.map((n) => n.kind)).toEqual(['brain_review', 'approvals', 'autopilot'])
    expect(dock.needsYou[2].count).toBe(3)
  })

  it('surfaces the task_triage card when judge-drafted goals await triage (§8)', () => {
    const dock = mergeHomeDock(null, signals({ taskTriageCount: 4 }))
    expect(dock.needsYou.map((n) => n.kind)).toEqual(['brain_review', 'approvals', 'task_triage'])
    expect(dock.needsYou[2].count).toBe(4)
  })

  it('appends a live task_triage the artifact omitted (a stale layout cannot hide pending triage)', () => {
    const layout: HomeDockLayout = {
      version: 1,
      note: null,
      needsYou: [{ kind: 'brain_review' }],
      generatedAt: '2026-06-10T09:00:00Z',
      generatedByAssistantId: 'a1',
    }
    const dock = mergeHomeDock(layout, signals({ taskTriageCount: 2 }))
    const kinds = dock.needsYou.map((n) => n.kind)
    expect(kinds[0]).toBe('brain_review')
    expect(kinds).toContain('task_triage')
    expect(dock.needsYou.find((n) => n.kind === 'task_triage')?.count).toBe(2)
  })

  it('leads the default order with live attention kinds (broken connector, failed runs)', () => {
    const dock = mergeHomeDock(
      null,
      signals({ connectorAttentionCount: 1, workflowAttentionCount: 2 }),
    )
    expect(dock.needsYou.map((n) => n.kind)).toEqual([
      'connector_attention',
      'workflow_attention',
      'brain_review',
      'approvals',
    ])
  })

  it('appends a live attention kind the artifact omitted (a stale artifact cannot hide breakage)', () => {
    const layout: HomeDockLayout = {
      version: 1,
      note: null,
      needsYou: [{ kind: 'brain_review' }, { kind: 'approvals' }],
      generatedAt: '2026-06-10T09:00:00Z',
      generatedByAssistantId: 'a1',
    }
    const dock = mergeHomeDock(layout, signals({ connectorAttentionCount: 1 }))
    expect(dock.needsYou.map((n) => n.kind)).toEqual([
      'brain_review',
      'approvals',
      'connector_attention',
    ])
    expect(dock.needsYou[2].count).toBe(1)
  })

  it('appends live approvals + autopilot the artifact omitted (a stale layout cannot hide a pending-you action)', () => {
    // The real incident: a month-old layout listing only brain_review hid a
    // freshly-drafted goal awaiting confirmation (autopilot) — and would hide a
    // new approval too. Both are blocking user actions; the merge must surface
    // them without waiting for the next curation turn.
    const layout: HomeDockLayout = {
      version: 1,
      note: null,
      needsYou: [{ kind: 'brain_review' }],
      generatedAt: '2026-06-10T09:00:00Z',
      generatedByAssistantId: 'a1',
    }
    const dock = mergeHomeDock(layout, signals({ autopilotCount: 1 }))
    const kinds = dock.needsYou.map((n) => n.kind)
    expect(kinds[0]).toBe('brain_review') // the artifact's one choice still leads
    expect(kinds).toContain('approvals') // live (2), surfaced despite being omitted
    expect(kinds).toContain('autopilot') // live (1), surfaced despite being omitted
    expect(dock.needsYou.find((n) => n.kind === 'autopilot')?.count).toBe(1)
  })

  it('lets the artifact reposition + caption an attention kind without duplicating it', () => {
    const layout: HomeDockLayout = {
      version: 1,
      note: null,
      needsYou: [
        { kind: 'workflow_attention', caption: 'The digest run broke overnight' },
        { kind: 'approvals' },
      ],
      generatedAt: '2026-06-10T09:00:00Z',
      generatedByAssistantId: 'a1',
    }
    const dock = mergeHomeDock(layout, signals({ workflowAttentionCount: 3 }))
    expect(dock.needsYou.map((n) => n.kind)).toEqual(['workflow_attention', 'approvals'])
    expect(dock.needsYou[0].caption).toBe('The digest run broke overnight')
    expect(dock.needsYou[0].count).toBe(3)
  })

  it('drops a dead attention kind like any other card', () => {
    const dock = mergeHomeDock(null, signals())
    expect(dock.needsYou.map((n) => n.kind)).toEqual(['brain_review', 'approvals'])
  })

  it('de-dups a kind the artifact listed twice', () => {
    const layout: HomeDockLayout = {
      version: 1,
      note: null,
      needsYou: [{ kind: 'approvals' }, { kind: 'approvals' }],
      generatedAt: '2026-06-10T09:00:00Z',
      generatedByAssistantId: 'a1',
    }
    const dock = mergeHomeDock(layout, signals())
    expect(dock.needsYou).toHaveLength(1)
  })
})

describe('[COMP:home/tools] setHomeDock', () => {
  it('persists a v1 artifact carrying note + ordered cards, never counts', async () => {
    const put = vi.fn<HomeDockStore['put']>().mockResolvedValue()
    const store: HomeDockStore = { get: vi.fn().mockResolvedValue(null), put }
    const { setHomeDock } = createHomeTools({ store })

    const res = await setHomeDock.execute(
      {
        note: 'Term sheet lands Thursday.',
        needsYou: [{ kind: 'brain_review', caption: 'New from Gmail' }, { kind: 'approvals' }],
      },
      ctx(),
    )

    expect(res.isError).toBeFalsy()
    expect(put).toHaveBeenCalledOnce()
    const [userId, workspaceId, layout] = put.mock.calls[0]
    expect(userId).toBe('u1')
    expect(workspaceId).toBe('ws1')
    expect(layout.version).toBe(1)
    expect(layout.note).toBe('Term sheet lands Thursday.')
    expect(layout.needsYou).toEqual([
      { kind: 'brain_review', caption: 'New from Gmail' },
      { kind: 'approvals' },
    ])
    expect(layout.generatedByAssistantId).toBe('a1')
    // the artifact must not carry any count field
    expect(JSON.stringify(layout)).not.toMatch(/count/i)
  })

  it('errors (no write) when the turn has no workspace', async () => {
    const put = vi.fn<HomeDockStore['put']>().mockResolvedValue()
    const store: HomeDockStore = { get: vi.fn().mockResolvedValue(null), put }
    const { setHomeDock } = createHomeTools({ store })

    const res = await setHomeDock.execute({ note: 'hi' }, { ...ctx(), workspaceId: null })
    expect(res.isError).toBe(true)
    expect(put).not.toHaveBeenCalled()
  })
})
