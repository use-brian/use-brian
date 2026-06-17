import { describe, expect, it } from 'vitest'

import type { IngestContext, IngestEngineDeps, IngestRule } from '../engine.js'
import {
  createIngestAlertTrigger,
  INGEST_ALERT_TRIGGER_KIND,
  type DedicatedAssistantResolver,
  type IngestAlertPayload,
  type ScheduledJobInserter,
} from '../engine-triggers.js'
import type { IngestEvent } from '../filters.js'

// ── Fakes ────────────────────────────────────────────────────────────

type InsertedJob = Parameters<ScheduledJobInserter>[0]

function makeInserter() {
  const calls: InsertedJob[] = []
  const insert: ScheduledJobInserter = async (params) => {
    calls.push(params)
  }
  return { insert, calls }
}

function makeResolver(returnValue: string | null) {
  const calls: string[] = []
  const resolver: DedicatedAssistantResolver = async (connectorInstanceId) => {
    calls.push(connectorInstanceId)
    return returnValue
  }
  return { resolver, calls }
}

const CTX: IngestContext = {
  workspace_id: 'ws-1',
  connector_instance_id: 'ci-1',
}

const EVENT: IngestEvent = {
  source: 'gmail',
  normalized: { sender: 'alice@acme.com' },
}

const RULE: IngestRule = {
  id: 'rule-1',
  connector_instance_id: 'ci-1',
  source: 'gmail',
  rule_order: 0,
  filter_type: 'always',
  filter_params: {},
  routing_mode: 'realtime',
  routing_schedule: null,
  routing_timezone: 'UTC',
  alert: true,
  episode_sensitivity: null,
}

const FIXED_NOW = new Date('2026-05-14T12:00:00Z')

/** A representative Episode id the engine threads into `onAlert`. */
const EPISODE_ID = 'ep-42'

// ── Cases ────────────────────────────────────────────────────────────

describe('[COMP:brain/event-triggered-turn] Event-triggered assistant turn dispatcher', () => {
  it('inserts a scheduled_jobs row when a dedicated assistant is bound', async () => {
    const { insert, calls } = makeInserter()
    const { resolver } = makeResolver('asst-7')

    const onAlert = createIngestAlertTrigger({
      insertScheduledJob: insert,
      resolveDedicatedAssistant: resolver,
      now: () => FIXED_NOW,
    })

    await onAlert(EVENT, CTX, RULE, EPISODE_ID)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      workspace_id: 'ws-1',
      channel_type: 'cron',
      fires_at: FIXED_NOW,
      payload: {
        trigger_kind: INGEST_ALERT_TRIGGER_KIND,
        dedicated_assistant_id: 'asst-7',
        episode_id: EPISODE_ID,
      } satisfies IngestAlertPayload,
    })
  })

  it('stamps the threaded episode_id onto the payload (WU-3.11 idempotency key)', async () => {
    const { insert, calls } = makeInserter()
    const { resolver } = makeResolver('asst-7')

    const onAlert = createIngestAlertTrigger({
      insertScheduledJob: insert,
      resolveDedicatedAssistant: resolver,
      now: () => FIXED_NOW,
    })

    await onAlert(EVENT, CTX, RULE, 'ep-99')

    expect(calls[0].payload.episode_id).toBe('ep-99')
  })

  it('payload.episode_id is null when the engine has no Episode handle', async () => {
    const { insert, calls } = makeInserter()
    const { resolver } = makeResolver('asst-7')

    const onAlert = createIngestAlertTrigger({
      insertScheduledJob: insert,
      resolveDedicatedAssistant: resolver,
      now: () => FIXED_NOW,
    })

    // A `scheduled` / `drop`-routed alert has no Episode at alert time.
    await onAlert(EVENT, CTX, RULE, null)

    expect(calls).toHaveLength(1)
    expect(calls[0].payload.episode_id).toBeNull()
  })

  it('does NOT insert when the connector has no dedicated assistant', async () => {
    const { insert, calls } = makeInserter()
    const { resolver } = makeResolver(null)

    const onAlert = createIngestAlertTrigger({
      insertScheduledJob: insert,
      resolveDedicatedAssistant: resolver,
      now: () => FIXED_NOW,
    })

    await onAlert(EVENT, CTX, RULE, EPISODE_ID)

    expect(calls).toEqual([])
  })

  it("passes the context's connector_instance_id to the resolver", async () => {
    const { insert } = makeInserter()
    const { resolver, calls: resolverCalls } = makeResolver('asst-7')

    const onAlert = createIngestAlertTrigger({
      insertScheduledJob: insert,
      resolveDedicatedAssistant: resolver,
    })

    await onAlert(
      EVENT,
      { workspace_id: 'ws-9', connector_instance_id: 'ci-xyz' },
      RULE,
      EPISODE_ID,
    )

    expect(resolverCalls).toEqual(['ci-xyz'])
  })

  it('propagates inserter errors (matches engine await-semantics)', async () => {
    const { resolver } = makeResolver('asst-7')
    const boom: ScheduledJobInserter = async () => {
      throw new Error('db down')
    }

    const onAlert = createIngestAlertTrigger({
      insertScheduledJob: boom,
      resolveDedicatedAssistant: resolver,
    })

    await expect(onAlert(EVENT, CTX, RULE, EPISODE_ID)).rejects.toThrow(/db down/)
  })

  it('defaults fires_at to the current time when `now` is not injected', async () => {
    const { insert, calls } = makeInserter()
    const { resolver } = makeResolver('asst-7')

    const onAlert = createIngestAlertTrigger({
      insertScheduledJob: insert,
      resolveDedicatedAssistant: resolver,
    })

    const before = Date.now()
    await onAlert(EVENT, CTX, RULE, EPISODE_ID)
    const after = Date.now()

    expect(calls).toHaveLength(1)
    const firesAt = calls[0].fires_at.getTime()
    expect(firesAt).toBeGreaterThanOrEqual(before)
    expect(firesAt).toBeLessThanOrEqual(after)
  })

  it("structurally satisfies the engine's onEvent port", () => {
    const { insert } = makeInserter()
    const { resolver } = makeResolver('asst-7')

    const onAlert = createIngestAlertTrigger({
      insertScheduledJob: insert,
      resolveDedicatedAssistant: resolver,
    })

    // Compile-time check: assignable to the engine's port type. The
    // `alert`-gated dispatch is internal to this reference design; the
    // engine just sees an `onEvent`-shaped callback.
    const _port: NonNullable<IngestEngineDeps['onEvent']> = onAlert
    expect(typeof _port).toBe('function')
  })
})
