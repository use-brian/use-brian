import { describe, it, expect, vi } from 'vitest'
import { mergeHomeDock } from '../merge.js'
import { createHomeTools } from '../tools.js'
import type { HomeDockLayout, HomeDockStore, HomeSignals } from '../types.js'

function signals(over: Partial<HomeSignals> = {}): HomeSignals {
  return {
    brainReviewCount: 5,
    approvalsCount: 2,
    upcomingWorkflows: [{ id: 'w1', name: 'Investor digest', nextRunAt: '2026-06-10T17:00:00Z' }],
    recentDrafts: [{ id: 'd1', name: 'Q2 memo', updatedAt: '2026-06-10T08:00:00Z' }],
    brainEntryCount: 142,
    brainGrowth7d: 18,
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
    expect(dock.brain).toEqual({ entryCount: 142, growth7d: 18, hasConnector: false })
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
