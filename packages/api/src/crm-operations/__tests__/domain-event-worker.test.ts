import { describe, expect, it, vi } from 'vitest'
import type { WorkflowEventInput } from '@use-brian/core'
import {
  crmWorkflowAdmission,
  createCrmDomainEventWorker,
  type CrmDomainEventOutboxStore,
  type LeasedCrmDomainEvent,
} from '../domain-event-worker.js'

function event(index = 1): LeasedCrmDomainEvent {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    workspaceId: '11111111-1111-4111-8111-111111111111',
    eventType: 'crm.submission.received', subjectKind: 'submission',
    subjectId: '22222222-2222-4222-8222-222222222222',
    payload: { submissionId: '22222222-2222-4222-8222-222222222222', definitionKey: 'website_contact' },
    actorKind: 'provider', occurredAt: '2026-08-30T12:00:00.000Z', attempts: 1,
  }
}

function store(rows: LeasedCrmDomainEvent[]) {
  return {
    leaseBatch: vi.fn(async () => rows),
    markDelivered: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
  } satisfies CrmDomainEventOutboxStore
}

describe('[COMP:crm/domain-events] durable outbox worker', () => {
  it('marks delivery only after strict workflow admission succeeds', async () => {
    const outbox = store([event()])
    const dispatchStrict = vi.fn(async () => undefined)
    const delivery = createCrmDomainEventWorker({ store: outbox, dispatcher: { dispatchStrict }, workerId: 'worker-1' })
    await expect(delivery.tick()).resolves.toBe(1)
    expect(dispatchStrict).toHaveBeenCalledWith(expect.objectContaining({ source: { type: 'crm' } }))
    expect(outbox.markDelivered).toHaveBeenCalledWith(event().id, 'worker-1')
    expect(outbox.markFailed).not.toHaveBeenCalled()
  })

  it('retains a failed event with bounded exponential retry state', async () => {
    const row = { ...event(), attempts: 3 }
    const outbox = store([row])
    const now = new Date('2026-08-30T12:00:00.000Z')
    const delivery = createCrmDomainEventWorker({
      store: outbox,
      dispatcher: { dispatchStrict: vi.fn(async () => { throw new Error('temporary') }) },
      workerId: 'worker-1', now: () => now,
    })
    await expect(delivery.tick()).resolves.toBe(1)
    expect(outbox.markDelivered).not.toHaveBeenCalled()
    expect(outbox.markFailed).toHaveBeenCalledWith(
      row.id, 'worker-1', 'temporary', new Date('2026-08-30T12:00:08.000Z'),
    )
  })

  it('caps import/event bursts to fifty leases per tick', async () => {
    const outbox = store(Array.from({ length: 50 }, (_value, index) => event(index + 1)))
    const delivery = createCrmDomainEventWorker({
      store: outbox,
      dispatcher: { dispatchStrict: vi.fn(async () => undefined) },
      workerId: 'worker-1', batchSize: 10_000,
    })
    await expect(delivery.tick()).resolves.toBe(50)
    expect(outbox.leaseBatch).toHaveBeenCalledWith('worker-1', 50, 60_000)
    expect(outbox.markDelivered).toHaveBeenCalledTimes(50)
  })

  it('derives a stable workflow admission key and digest from the domain event id', () => {
    const input: WorkflowEventInput = {
      trigger: { sourceType: 'crm', provider: 'crm', channelId: 'crm.submission.received', actorId: null },
      event: { domainEventId: event().id, eventType: 'crm.submission.received' },
    }
    const first = crmWorkflowAdmission(input)
    expect(first).toEqual({ idempotencyKey: `crm:${event().id}`, bodySha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(crmWorkflowAdmission(structuredClone(input))).toEqual(first)
    expect(crmWorkflowAdmission({ ...input, event: { ...input.event, eventType: 'crm.submission.updated' } }))
      .toMatchObject({ idempotencyKey: first!.idempotencyKey })
  })
})
