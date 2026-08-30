import { describe, expect, it } from 'vitest'
import { crmDomainEventToDispatchEvent, redactCrmDomainEventPayload } from '../crm-event-trigger.js'
import { createWorkflowEventDispatcher, matchesEvent, type WorkflowEventInput } from '../event-trigger.js'

const envelope = {
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  eventType: 'crm.submission.received' as const,
  subjectKind: 'submission',
  subjectId: '33333333-3333-4333-8333-333333333333',
  actorKind: 'intake_key',
  occurredAt: '2026-08-30T12:00:00.000Z',
  payload: {
    submissionId: '33333333-3333-4333-8333-333333333333',
    contactId: '44444444-4444-4444-8444-444444444444',
    definitionKey: 'website_contact',
    email: 'person@example.test',
    submittedFields: { privateNote: 'never expose this' },
    tags: ['also', 'private'],
  },
}

describe('[COMP:crm/domain-events] CRM workflow event adapter', () => {
  it('projects only pointer-safe scalar fields and closed catalog tags', () => {
    expect(redactCrmDomainEventPayload(envelope.payload)).toEqual({
      submissionId: envelope.payload.submissionId,
      contactId: envelope.payload.contactId,
      definitionKey: 'website_contact',
    })
    const event = crmDomainEventToDispatchEvent(envelope)
    expect(event).toMatchObject({
      source: { type: 'crm' },
      channelId: 'crm.submission.received',
      tags: ['website_contact'],
      isBot: true,
      mentions: [envelope.subjectId],
    })
    expect(JSON.stringify(event.payload)).not.toContain('person@example.test')
    expect(JSON.stringify(event.payload)).not.toContain('never expose this')
  })

  it('matches event type and stable catalog key and admits a pointer-only input', async () => {
    const event = crmDomainEventToDispatchEvent({ ...envelope, actorKind: 'provider' })
    expect(matchesEvent(event, {
      source: { type: 'crm' },
      match: { inChannels: ['crm.submission.received'], tags: ['website_contact'] },
    })).toBe(true)

    let admitted: WorkflowEventInput | null = null
    const dispatcher = createWorkflowEventDispatcher({
      findEventTriggeredWorkflows: async () => [{
        workflowId: 'workflow-1', workspaceId: envelope.workspaceId,
        sources: [{ source: { type: 'crm' }, match: { inChannels: ['crm.submission.received'] } }],
      }],
      startWorkflowRun: async ({ input }) => { admitted = input },
    })
    await dispatcher.dispatchStrict(event)
    expect((admitted as WorkflowEventInput | null)?.trigger).toMatchObject({ sourceType: 'crm', provider: 'crm' })
    expect((admitted as WorkflowEventInput | null)?.event).toMatchObject({ domainEventId: envelope.id, definitionKey: 'website_contact' })
  })

  it('strict delivery rejects after attempting every matching workflow', async () => {
    const started: string[] = []
    const dispatcher = createWorkflowEventDispatcher({
      findEventTriggeredWorkflows: async () => [
        { workflowId: 'first', workspaceId: envelope.workspaceId, sources: [{ source: { type: 'crm' } }] },
        { workflowId: 'second', workspaceId: envelope.workspaceId, sources: [{ source: { type: 'crm' } }] },
      ],
      startWorkflowRun: async ({ workflowId }) => {
        started.push(workflowId)
        if (workflowId === 'first') throw new Error('temporary admission failure')
      },
    })
    await expect(dispatcher.dispatchStrict(crmDomainEventToDispatchEvent({ ...envelope, actorKind: 'user' })))
      .rejects.toThrow('1 subscriber')
    expect(started).toEqual(['first', 'second'])
  })
})
