import { describe, it, expect } from 'vitest'

import {
  matchesEvent,
  createWorkflowEventDispatcher,
  type DispatchEvent,
  type WorkflowEventDispatchError,
  type WorkflowEventInput,
} from '../event-trigger.js'
import type { EventSubscription } from '../types.js'

// ── Fixtures ────────────────────────────────────────────────────────────

/** A Slack channel event — the DeltaDeFi-style incident message. */
const SLACK_EVENT: DispatchEvent = {
  workspaceId: 'ws1',
  source: { type: 'channel', channelIntegrationId: 'ci-slack', channel: 'slack' },
  text: 'prod is DOWN — pager fired',
  actorId: 'U_MONITOR',
  channelId: 'C_INCIDENTS',
  mentions: ['U_ONCALL'],
  isBot: false,
  payload: { text: 'prod is DOWN — pager fired', channel_id: 'C_INCIDENTS', thread_ts: '1700.1' },
}

/** A subscription on the same Slack channel, with an optional match filter. */
const slackSub = (match?: EventSubscription['match']): EventSubscription => ({
  source: { type: 'channel', channelIntegrationId: 'ci-slack', channel: 'slack' },
  match,
})

describe('[COMP:workflow/event-trigger] matchesEvent', () => {
  it('matches a channel source by channelIntegrationId with no filter', () => {
    expect(matchesEvent(SLACK_EVENT, slackSub())).toBe(true)
  })

  it('rejects a different channel integration id', () => {
    expect(
      matchesEvent(SLACK_EVENT, {
        source: { type: 'channel', channelIntegrationId: 'other', channel: 'slack' },
      }),
    ).toBe(false)
  })

  it('rejects a connector subscription for a channel event (type mismatch)', () => {
    expect(
      matchesEvent(SLACK_EVENT, {
        source: { type: 'connector', connectorInstanceId: 'ci-slack', provider: 'slack' },
      }),
    ).toBe(false)
  })

  it('matches a connector source by connectorInstanceId', () => {
    const ev: DispatchEvent = {
      ...SLACK_EVENT,
      source: { type: 'connector', connectorInstanceId: 'gh1', provider: 'github' },
    }
    expect(
      matchesEvent(ev, {
        source: { type: 'connector', connectorInstanceId: 'gh1', provider: 'github' },
      }),
    ).toBe(true)
  })

  it('keyword match is a case-insensitive substring of the event text', () => {
    expect(matchesEvent(SLACK_EVENT, slackSub({ keywords: ['down'] }))).toBe(true)
    expect(matchesEvent(SLACK_EVENT, slackSub({ keywords: ['deploy'] }))).toBe(false)
  })

  it('fromActors gates on the actor id', () => {
    expect(matchesEvent(SLACK_EVENT, slackSub({ fromActors: ['U_MONITOR'] }))).toBe(true)
    expect(matchesEvent(SLACK_EVENT, slackSub({ fromActors: ['U_OTHER'] }))).toBe(false)
  })

  it('inChannels gates on the sub-channel id', () => {
    expect(matchesEvent(SLACK_EVENT, slackSub({ inChannels: ['C_INCIDENTS'] }))).toBe(true)
    expect(matchesEvent(SLACK_EVENT, slackSub({ inChannels: ['C_RANDOM'] }))).toBe(false)
  })

  it('mentions gates on the event mention list', () => {
    expect(matchesEvent(SLACK_EVENT, slackSub({ mentions: ['U_ONCALL'] }))).toBe(true)
    expect(matchesEvent(SLACK_EVENT, slackSub({ mentions: ['U_NOBODY'] }))).toBe(false)
  })

  it('AND-combines every present field — one failing field rejects the whole match', () => {
    expect(
      matchesEvent(SLACK_EVENT, slackSub({ keywords: ['down'], inChannels: ['C_RANDOM'] })),
    ).toBe(false)
    expect(
      matchesEvent(SLACK_EVENT, slackSub({ keywords: ['down'], inChannels: ['C_INCIDENTS'] })),
    ).toBe(true)
  })

  it('drops a bot-authored event by default (no fromBots opt-in)', () => {
    const bot: DispatchEvent = { ...SLACK_EVENT, isBot: true }
    expect(matchesEvent(bot, slackSub())).toBe(false)
    expect(matchesEvent(bot, slackSub({ keywords: ['down'] }))).toBe(false)
  })

  it('fires a bot-authored event only when the subscription sets fromBots', () => {
    const bot: DispatchEvent = { ...SLACK_EVENT, isBot: true }
    expect(matchesEvent(bot, slackSub({ fromBots: true }))).toBe(true)
    // fromBots opens the gate but the other fields still AND in.
    expect(matchesEvent(bot, slackSub({ fromBots: true, keywords: ['deploy'] }))).toBe(false)
  })
})

describe('[COMP:workflow/event-trigger] createWorkflowEventDispatcher', () => {
  it('starts a run for every workflow with a matching subscription', async () => {
    const started: string[] = []
    const dispatcher = createWorkflowEventDispatcher({
      findEventTriggeredWorkflows: async () => [
        { workflowId: 'wf1', workspaceId: 'ws1', sources: [slackSub()] },
        { workflowId: 'wf2', workspaceId: 'ws1', sources: [slackSub({ keywords: ['down'] })] },
      ],
      startWorkflowRun: async ({ workflowId }) => {
        started.push(workflowId)
      },
    })
    await dispatcher.dispatch(SLACK_EVENT)
    expect(started).toEqual(['wf1', 'wf2'])
  })

  it('skips a workflow whose subscriptions do not match the event', async () => {
    const started: string[] = []
    const dispatcher = createWorkflowEventDispatcher({
      findEventTriggeredWorkflows: async () => [
        { workflowId: 'match', workspaceId: 'ws1', sources: [slackSub({ keywords: ['down'] })] },
        { workflowId: 'miss', workspaceId: 'ws1', sources: [slackSub({ keywords: ['deploy'] })] },
      ],
      startWorkflowRun: async ({ workflowId }) => {
        started.push(workflowId)
      },
    })
    await dispatcher.dispatch(SLACK_EVENT)
    expect(started).toEqual(['match'])
  })

  it('fires a multi-source workflow exactly once when several sources match', async () => {
    let starts = 0
    const dispatcher = createWorkflowEventDispatcher({
      findEventTriggeredWorkflows: async () => [
        {
          workflowId: 'wf1',
          workspaceId: 'ws1',
          sources: [slackSub({ keywords: ['down'] }), slackSub({ inChannels: ['C_INCIDENTS'] })],
        },
      ],
      startWorkflowRun: async () => {
        starts += 1
      },
    })
    await dispatcher.dispatch(SLACK_EVENT)
    expect(starts).toBe(1)
  })

  it('passes a channel-shaped WorkflowEventInput to the run', async () => {
    let input: WorkflowEventInput | null = null
    const dispatcher = createWorkflowEventDispatcher({
      findEventTriggeredWorkflows: async () => [
        { workflowId: 'wf1', workspaceId: 'ws1', sources: [slackSub()] },
      ],
      startWorkflowRun: async (p) => {
        input = p.input
      },
    })
    await dispatcher.dispatch(SLACK_EVENT)
    expect(input).toEqual({
      trigger: {
        sourceType: 'channel',
        provider: 'slack',
        channelIntegrationId: 'ci-slack',
        channelId: 'C_INCIDENTS',
        actorId: 'U_MONITOR',
      },
      event: SLACK_EVENT.payload,
    })
  })

  it('passes a connector-shaped WorkflowEventInput to the run', async () => {
    let input: WorkflowEventInput | null = null
    const ev: DispatchEvent = {
      ...SLACK_EVENT,
      source: { type: 'connector', connectorInstanceId: 'gh1', provider: 'github' },
    }
    const dispatcher = createWorkflowEventDispatcher({
      findEventTriggeredWorkflows: async () => [
        {
          workflowId: 'wf1',
          workspaceId: 'ws1',
          sources: [{ source: { type: 'connector', connectorInstanceId: 'gh1', provider: 'github' } }],
        },
      ],
      startWorkflowRun: async (p) => {
        input = p.input
      },
    })
    await dispatcher.dispatch(ev)
    expect(input).toEqual({
      trigger: {
        sourceType: 'connector',
        provider: 'github',
        connectorInstanceId: 'gh1',
        channelId: 'C_INCIDENTS',
        actorId: 'U_MONITOR',
      },
      event: ev.payload,
    })
  })

  it('is a no-op when the workspace has no event-triggered workflow', async () => {
    let starts = 0
    const dispatcher = createWorkflowEventDispatcher({
      findEventTriggeredWorkflows: async () => [],
      startWorkflowRun: async () => {
        starts += 1
      },
    })
    await expect(dispatcher.dispatch(SLACK_EVENT)).resolves.toBeUndefined()
    expect(starts).toBe(0)
  })

  it('isolates a per-workflow start failure — siblings still start, onError fires', async () => {
    const started: string[] = []
    const errors: WorkflowEventDispatchError[] = []
    const dispatcher = createWorkflowEventDispatcher({
      findEventTriggeredWorkflows: async () => [
        { workflowId: 'wf1', workspaceId: 'ws1', sources: [slackSub()] },
        { workflowId: 'wf2', workspaceId: 'ws1', sources: [slackSub()] },
        { workflowId: 'wf3', workspaceId: 'ws1', sources: [slackSub()] },
      ],
      startWorkflowRun: async ({ workflowId }) => {
        if (workflowId === 'wf2') throw new Error('boom')
        started.push(workflowId)
      },
      onError: (_err, ctx) => {
        errors.push(ctx)
      },
    })
    await expect(dispatcher.dispatch(SLACK_EVENT)).resolves.toBeUndefined()
    expect(started).toEqual(['wf1', 'wf3'])
    expect(errors).toEqual([{ workspaceId: 'ws1', workflowId: 'wf2' }])
  })

  it('swallows a finder failure via onError and never throws', async () => {
    let errCtx: WorkflowEventDispatchError | null = null
    let starts = 0
    const dispatcher = createWorkflowEventDispatcher({
      findEventTriggeredWorkflows: async () => {
        throw new Error('db down')
      },
      startWorkflowRun: async () => {
        starts += 1
      },
      onError: (_err, ctx) => {
        errCtx = ctx
      },
    })
    await expect(dispatcher.dispatch(SLACK_EVENT)).resolves.toBeUndefined()
    expect(starts).toBe(0)
    expect(errCtx).toEqual({ workspaceId: 'ws1' })
  })

  it('does not throw when onError is omitted and a start fails', async () => {
    const dispatcher = createWorkflowEventDispatcher({
      findEventTriggeredWorkflows: async () => [
        { workflowId: 'wf1', workspaceId: 'ws1', sources: [slackSub()] },
      ],
      startWorkflowRun: async () => {
        throw new Error('boom')
      },
    })
    await expect(dispatcher.dispatch(SLACK_EVENT)).resolves.toBeUndefined()
  })
})
