/**
 * Unit tests for the external-sink fan-out.
 * Component tag: [COMP:brain/ingest-outbox].
 *
 * Verifies the mode semantics (X5 — `all` receives events NO rule matched
 * and even rule-`drop` events; `rule_filtered` receives only matched,
 * non-drop events) and the D10 atomic landing: brain batch row + outbox
 * rows commit in ONE transaction, and an enqueue failure rolls the whole
 * capture back.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CanonicalIngestMessage } from '@use-brian/shared'
import {
  createExternalSinkFanout,
  sinkAcceptsEvent,
} from '../external-sink-fanout.js'
import type { IngestExternalSink } from '../../db/ingest-sink-store.js'

function makeSink(over: Partial<IngestExternalSink> = {}): IngestExternalSink {
  return {
    id: 'sink-1',
    connectorInstanceId: 'ci-1',
    workspaceId: 'ws-1',
    endpointUrl: 'https://archive.example.com/append',
    authKind: 'hmac',
    mode: 'all',
    enabled: true,
    hasSecret: true,
    lastAckCursor: null,
    lastDeliveredAt: null,
    createdAt: new Date('2026-07-23T00:00:00Z'),
    ...over,
  }
}

const MESSAGE: CanonicalIngestMessage = {
  provider_message_id: 'm1',
  conversation_id: 'room-1',
  sender_id: 'wxid_1',
  sender_display: 'Alice',
  sent_at: '2026-07-23T08:00:00Z',
  direction: 'inbound',
  kind: 'text',
  body_text: 'hello',
  media_ref: null,
  reply_to_provider_id: null,
  raw_provider_blob: null,
}

function makeEvent(over: Record<string, unknown> = {}) {
  return {
    connectorInstanceId: 'ci-1',
    workspaceId: 'ws-1',
    ownerUserId: 'user-1',
    source: 'wechat',
    messages: [MESSAGE],
    sourceCursor: { offset: 7 },
    ...over,
  }
}

describe('[COMP:brain/ingest-outbox] sink mode semantics', () => {
  it("mode='all' accepts unmatched, dropped, and engine-less events (X5)", () => {
    expect(sinkAcceptsEvent('all', undefined)).toBe(true)
    expect(sinkAcceptsEvent('all', null)).toBe(true)
    expect(sinkAcceptsEvent('all', { matched: false, routing_mode: 'drop' })).toBe(true)
    expect(sinkAcceptsEvent('all', { matched: true, routing_mode: 'drop' })).toBe(true)
  })

  it("mode='rule_filtered' accepts only matched, non-drop decisions", () => {
    expect(sinkAcceptsEvent('rule_filtered', { matched: true, routing_mode: 'realtime' })).toBe(true)
    expect(sinkAcceptsEvent('rule_filtered', { matched: true, routing_mode: 'scheduled' })).toBe(true)
    expect(sinkAcceptsEvent('rule_filtered', { matched: true, routing_mode: 'drop' })).toBe(false)
    expect(sinkAcceptsEvent('rule_filtered', { matched: false, routing_mode: 'drop' })).toBe(false)
    expect(sinkAcceptsEvent('rule_filtered', undefined)).toBe(false)
  })

  it("delivers an event NO ingest_rule matched to the mode='all' sink only", async () => {
    const enqueue = vi.fn(async (params: Record<string, unknown>) => ({ id: 'ob-1', ...params }))
    const fanout = createExternalSinkFanout({
      sinks: {
        listEnabledByInstance: async () => [
          makeSink({ id: 'sink-all', mode: 'all' }),
          makeSink({ id: 'sink-filtered', mode: 'rule_filtered' }),
        ],
      },
      outbox: { enqueue: enqueue as never },
    })
    const result = await fanout.fanout(
      makeEvent({ decision: { matched: false, routing_mode: 'drop' } }) as never,
    )
    expect(result.enqueued).toHaveLength(1)
    expect(enqueue).toHaveBeenCalledOnce()
    expect(enqueue.mock.calls[0][0]).toMatchObject({
      sinkId: 'sink-all',
      connectorInstanceId: 'ci-1',
      workspaceId: 'ws-1',
      ownerUserId: 'user-1',
      source: 'wechat',
      sourceCursor: { offset: 7 },
    })
  })

  it('enqueues nothing for an empty message batch', async () => {
    const listEnabledByInstance = vi.fn()
    const fanout = createExternalSinkFanout({
      sinks: { listEnabledByInstance },
      outbox: { enqueue: vi.fn() as never },
    })
    const result = await fanout.fanout(makeEvent({ messages: [] }) as never)
    expect(result.enqueued).toEqual([])
    expect(listEnabledByInstance).not.toHaveBeenCalled()
  })
})

describe('[COMP:brain/ingest-outbox] landIngestEvent — atomic capture (D10)', () => {
  const clientQueries: string[] = []
  const fakeClient = {
    query: vi.fn(async (text: string) => {
      clientQueries.push(text)
      if (text.includes('SELECT id FROM pending_ingest_batches')) {
        return { rows: [], rowCount: 0 }
      }
      if (text.includes('INSERT INTO pending_ingest_batches')) {
        return { rows: [{ id: 'batch-row-1', chars: 42 }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }),
    release: vi.fn(),
  }
  const fakePool = { connect: vi.fn(async () => fakeClient) }

  beforeEach(() => {
    clientQueries.length = 0
    fakeClient.query.mockClear()
    fakeClient.release.mockClear()
  })

  it('commits the brain batch row and the outbox rows in ONE transaction', async () => {
    const enqueue = vi.fn(async (_params: unknown, client: { query: (t: string) => unknown }) => {
      await client.query('INSERT INTO ingest_outbox (test)')
      return { id: 'ob-1' }
    })
    const fanout = createExternalSinkFanout({
      sinks: { listEnabledByInstance: async () => [makeSink()] },
      outbox: { enqueue: enqueue as never },
    })

    await fanout.landIngestEvent(
      {
        event: makeEvent() as never,
        batch: {
          workspaceId: 'ws-1',
          ruleId: 'rule-1',
          source: 'wechat',
          firesAt: new Date('2026-07-23T09:00:00Z'),
          event: { text: 'hello' },
        },
      },
      fakePool as never,
    )

    expect(clientQueries[0]).toBe('BEGIN')
    expect(clientQueries[clientQueries.length - 1]).toBe('COMMIT')
    const batchIdx = clientQueries.findIndex((t) => t.includes('INSERT INTO pending_ingest_batches'))
    const outboxIdx = clientQueries.findIndex((t) => t.includes('INSERT INTO ingest_outbox'))
    expect(batchIdx).toBeGreaterThan(0)
    expect(outboxIdx).toBeGreaterThan(batchIdx)
    expect(clientQueries).not.toContain('ROLLBACK')
    // the outbox enqueue rode the SAME transaction client
    expect(enqueue.mock.calls[0][1]).toBe(fakeClient)
    expect(fakeClient.release).toHaveBeenCalledOnce()
  })

  it('rolls the WHOLE capture back when the outbox enqueue fails', async () => {
    const fanout = createExternalSinkFanout({
      sinks: { listEnabledByInstance: async () => [makeSink()] },
      outbox: {
        enqueue: vi.fn(async () => {
          throw new Error('disk full')
        }) as never,
      },
    })

    await expect(
      fanout.landIngestEvent(
        {
          event: makeEvent() as never,
          batch: {
            workspaceId: 'ws-1',
            ruleId: 'rule-1',
            source: 'wechat',
            firesAt: new Date('2026-07-23T09:00:00Z'),
            event: { text: 'hello' },
          },
        },
        fakePool as never,
      ),
    ).rejects.toThrow('disk full')

    expect(clientQueries).toContain('ROLLBACK')
    expect(clientQueries).not.toContain('COMMIT')
    expect(fakeClient.release).toHaveBeenCalledOnce()
  })

  it('lands sink-only events (no brain batch) without touching pending_ingest_batches', async () => {
    const enqueue = vi.fn(async () => ({ id: 'ob-1' }))
    const fanout = createExternalSinkFanout({
      sinks: { listEnabledByInstance: async () => [makeSink()] },
      outbox: { enqueue: enqueue as never },
    })
    await fanout.landIngestEvent({ event: makeEvent() as never, batch: null }, fakePool as never)
    expect(clientQueries.some((t) => t.includes('pending_ingest_batches'))).toBe(false)
    expect(clientQueries[0]).toBe('BEGIN')
    expect(clientQueries[clientQueries.length - 1]).toBe('COMMIT')
  })
})
