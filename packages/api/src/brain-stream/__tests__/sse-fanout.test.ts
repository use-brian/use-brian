/**
 * Local-dispatch tests for the brain LISTEN/NOTIFY fan-out.
 * [COMP:api/brain-stream-fanout]
 *
 * The Postgres path is exercised by integration / smoke (running the API
 * against a live Postgres). These tests cover the in-process subscriber
 * registry — subscribe / unsubscribe semantics and workspace-id partitioning
 * — using `_dispatchLocalForTests`, which fires the same code path the
 * Postgres notification handler runs but without a Postgres round-trip.
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  _dispatchLocalForTests,
  _getBrainSubscriberCount,
  _shutdownBrainStreamFanout,
  subscribeToBrainChanges,
  type BrainChangePayload,
} from '../sse-fanout.js'

afterEach(async () => {
  await _shutdownBrainStreamFanout()
})

describe('[COMP:api/brain-stream-fanout] subscribeToBrainChanges', () => {
  it('delivers a payload to every subscriber for the same workspace', () => {
    const received: BrainChangePayload[][] = [[], []]
    subscribeToBrainChanges('ws-a', (p) => received[0].push(p))
    subscribeToBrainChanges('ws-a', (p) => received[1].push(p))

    const payload: BrainChangePayload = {
      workspaceId: 'ws-a',
      primitive: 'memory',
      action: 'update',
    }
    _dispatchLocalForTests(payload)

    expect(received[0]).toEqual([payload])
    expect(received[1]).toEqual([payload])
  })

  it('does not leak across workspaces', () => {
    const received: BrainChangePayload[] = []
    subscribeToBrainChanges('ws-a', (p) => received.push(p))

    _dispatchLocalForTests({
      workspaceId: 'ws-b',
      primitive: 'memory',
      action: 'update',
    })

    expect(received).toEqual([])
  })

  it('unsubscribe stops further deliveries', () => {
    const received: BrainChangePayload[] = []
    const unsubscribe = subscribeToBrainChanges('ws-a', (p) => received.push(p))

    _dispatchLocalForTests({
      workspaceId: 'ws-a',
      primitive: 'task',
      action: 'update',
    })
    expect(received).toHaveLength(1)

    unsubscribe()
    _dispatchLocalForTests({
      workspaceId: 'ws-a',
      primitive: 'task',
      action: 'update',
    })
    expect(received).toHaveLength(1)
    expect(_getBrainSubscriberCount()).toBe(0)
  })

  it('a throwing subscriber does not block the others', () => {
    const received: BrainChangePayload[] = []
    subscribeToBrainChanges('ws-a', () => {
      throw new Error('boom')
    })
    subscribeToBrainChanges('ws-a', (p) => received.push(p))

    const payload: BrainChangePayload = {
      workspaceId: 'ws-a',
      primitive: 'deal',
      action: 'update',
    }
    _dispatchLocalForTests(payload)

    expect(received).toEqual([payload])
  })
})
