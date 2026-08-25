import { describe, expect, it } from 'vitest'

import {
  DECISION_EVENT_KINDS,
  parseDecisionEventWrite,
} from '../types.js'

const UUID = {
  workspace: '00000000-0000-4000-8000-000000000001',
  actor: '00000000-0000-4000-8000-000000000002',
  assistant: '00000000-0000-4000-8000-000000000003',
  source: '00000000-0000-4000-8000-000000000004',
  replacement: '00000000-0000-4000-8000-000000000005',
}

function base(eventKind: string, payload: unknown) {
  return {
    idempotencyKey: `test:${eventKind}`,
    workspaceId: UUID.workspace,
    actorUserId: UUID.actor,
    assistantId: UUID.assistant,
    eventKind,
    schemaVersion: 1,
    sourceKind: 'test',
    sourceId: UUID.source,
    declaredScope: 'instance',
    visibility: 'owner',
    sensitivity: 'internal',
    payload,
  }
}

describe('[COMP:brain/decision-event-schema] typed decision event registry', () => {
  it('keeps the initial event-kind registry closed and versioned', () => {
    expect(DECISION_EVENT_KINDS).toEqual([
      'approval.decided',
      'email.draft_revised',
      'crm.entities_merged',
      'crm.merge_undone',
      'crm.entities_kept_separate',
      'crm.separation_retired',
      'brain.verification_recorded',
      'task.rejected',
      'playbook.rule_decided',
    ])
    expect(() => parseDecisionEventWrite(base('unknown.event', {}))).toThrow()
    expect(() => parseDecisionEventWrite({
      ...base('approval.decided', {
        approvalId: UUID.source,
        approvalKind: 'tool_invocation',
        resolution: 'deny',
      }),
      schemaVersion: 2,
    })).toThrow()
  })

  it('validates scope and trims/caps the direct member reason', () => {
    const parsed = parseDecisionEventWrite({
      ...base('approval.decided', {
        approvalId: UUID.source,
        approvalKind: 'tool_invocation',
        toolName: 'sendMessage',
        resolution: 'deny',
      }),
      declaredScope: 'tool',
      reason: '  Show me the draft first.  ',
    })
    expect(parsed.reason).toBe('Show me the draft first.')
    expect(() => parseDecisionEventWrite({ ...parsed, declaredScope: 'company' })).toThrow()
    expect(() => parseDecisionEventWrite({ ...parsed, reason: 'x'.repeat(1_001) })).toThrow()
  })

  it('rejects email content, recipients, subjects, and tool arguments from minimized payloads', () => {
    const safe = base('email.draft_revised', {
      previousApprovalId: UUID.source,
      replacementApprovalId: UUID.replacement,
      previousRevision: 1,
      newRevision: 2,
      accountKey: 'mailbox-primary',
    })
    expect(parseDecisionEventWrite(safe).eventKind).toBe('email.draft_revised')
    for (const forbidden of ['body', 'recipient', 'subject', 'arguments']) {
      expect(() => parseDecisionEventWrite({
        ...safe,
        payload: { ...(safe.payload as object), [forbidden]: 'private content' },
      })).toThrow()
    }
  })

  it('requires stable CRM identity namespaces to be complete and bounded', () => {
    const event = base('crm.entities_merged', {
      mergeId: UUID.source,
      survivingEntityId: UUID.actor,
      mergedEntityId: UUID.assistant,
      bindingNamespaces: [{
        provider: 'slack',
        providerInstanceKey: 'workspace-installation',
        subjectId: 'U012345',
      }],
    })
    expect(parseDecisionEventWrite(event).payload).toMatchObject({
      bindingNamespaces: [{ provider: 'slack', subjectId: 'U012345' }],
    })
    expect(() => parseDecisionEventWrite({
      ...event,
      payload: {
        ...(event.payload as object),
        bindingNamespaces: [{ provider: 'slack', subjectId: 'U012345' }],
      },
    })).toThrow()
  })
})
