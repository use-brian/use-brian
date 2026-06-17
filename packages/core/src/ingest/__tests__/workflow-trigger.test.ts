import { describe, it, expect } from 'vitest'

import {
  createIngestWorkflowTrigger,
  ingestEventToDispatchEvent,
} from '../workflow-trigger.js'
import type { IngestContext, IngestRule } from '../engine.js'
import type { IngestEvent } from '../filters.js'
import type { DispatchEvent, WorkflowEventDispatcher } from '../../workflow/event-trigger.js'

const CTX: IngestContext = { workspace_id: 'ws1', connector_instance_id: 'ci1' }

// `createIngestWorkflowTrigger` ignores `rule` / `episodeId`; a stub suffices.
const RULE = { id: 'rule1' } as unknown as IngestRule

describe('[COMP:brain/ingest-workflow-trigger] ingestEventToDispatchEvent', () => {
  it('maps a Slack-shaped ingest event onto a connector DispatchEvent', () => {
    const event: IngestEvent = {
      source: 'slack',
      normalized: { text: 'prod is down', channel_id: 'C1', actor_id: 'U1', mentions: ['U2'] },
    }
    expect(ingestEventToDispatchEvent(event, CTX)).toEqual({
      workspaceId: 'ws1',
      source: { type: 'connector', connectorInstanceId: 'ci1', provider: 'slack' },
      text: 'prod is down',
      actorId: 'U1',
      channelId: 'C1',
      mentions: ['U2'],
      isBot: false,
      payload: event.normalized,
    })
  })

  it('reads the nested GitHub shape — actor.login, repo, actor.is_bot', () => {
    const event: IngestEvent = {
      source: 'github',
      normalized: {
        text: 'PR #4 merged in acme/api',
        repo: 'acme/api',
        actor: { login: 'dependabot[bot]', is_bot: true },
      },
    }
    const d = ingestEventToDispatchEvent(event, CTX)
    expect(d.actorId).toBe('dependabot[bot]')
    expect(d.channelId).toBe('acme/api')
    expect(d.isBot).toBe(true)
    expect(d.text).toBe('PR #4 merged in acme/api')
  })

  it('falls back text → title → summary and defaults missing matchable fields', () => {
    const event: IngestEvent = { source: 'fathom', normalized: { title: 'Weekly sync' } }
    const d = ingestEventToDispatchEvent(event, CTX)
    expect(d.text).toBe('Weekly sync')
    expect(d.actorId).toBe(null)
    expect(d.channelId).toBe(null)
    expect(d.mentions).toEqual([])
    expect(d.isBot).toBe(false)
  })

  it('detects a bot from the flat bot_id key', () => {
    const event: IngestEvent = { source: 'slack', normalized: { text: 'x', bot_id: 'B1' } }
    expect(ingestEventToDispatchEvent(event, CTX).isBot).toBe(true)
  })
})

describe('[COMP:brain/ingest-workflow-trigger] createIngestWorkflowTrigger', () => {
  it('forwards a normalized connector DispatchEvent to the shared dispatcher', async () => {
    const dispatched: DispatchEvent[] = []
    const dispatcher: WorkflowEventDispatcher = {
      dispatch: async (e) => {
        dispatched.push(e)
      },
    }
    const onEvent = createIngestWorkflowTrigger(dispatcher)
    const event: IngestEvent = {
      source: 'github',
      normalized: { text: 'push to main', repo: 'acme/api', actor: { login: 'alice' } },
    }
    await onEvent(event, CTX, RULE, 'ep1')

    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].source).toEqual({
      type: 'connector',
      connectorInstanceId: 'ci1',
      provider: 'github',
    })
    expect(dispatched[0].channelId).toBe('acme/api')
    expect(dispatched[0].workspaceId).toBe('ws1')
  })

  it('resolves to undefined — the adapter just forwards, the dispatcher owns errors', async () => {
    const dispatcher: WorkflowEventDispatcher = { dispatch: async () => {} }
    const onEvent = createIngestWorkflowTrigger(dispatcher)
    await expect(
      onEvent({ source: 'slack', normalized: {} }, CTX, RULE, null),
    ).resolves.toBeUndefined()
  })
})
