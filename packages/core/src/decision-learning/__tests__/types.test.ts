import { describe, expect, it } from 'vitest'

import {
  DECISION_EVENT_KINDS,
  parseDecisionEventWrite,
  stableExternalIdentityFromCrmRef,
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
  it('accepts only GitHub.com numeric account references', () => {
    expect(stableExternalIdentityFromCrmRef({ provider: 'github', host: 'github.com', id: '101', login: 'example' })).toEqual({
      provider: 'github', providerInstanceKey: 'github.com', subjectId: '101',
    })
    for (const id of ['example', 'https://github.com/example', '0', '-1', '1.5', '01', '9007199254740992']) {
      expect(stableExternalIdentityFromCrmRef({ provider: 'github', host: 'github.com', id })).toBeNull()
    }
    expect(stableExternalIdentityFromCrmRef({ provider: 'github', id: '101' })).toBeNull()
    expect(stableExternalIdentityFromCrmRef({ provider: 'github', host: 'git.example', id: '101' })).toBeNull()
  })

  it('keeps the event-kind registry closed and versioned', () => {
    expect(DECISION_EVENT_KINDS).toEqual([
      'feed.linkedin_delivery_reconciled', 'feed.linkedin_manual_published', 'feed.draft_revised', 'feed.proposal_decided', 'feed.post_confirmed', 'feed.confirmation_revoked',
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

  it.each([
    ['feed.draft_revised', { previousRevision: 1, revision: 2, mutationId: UUID.source }],
    ['feed.proposal_decided', { suggestionId: UUID.source, revision: 2, outcome: 'accepted' }],
    ['feed.post_confirmed', { confirmationId: UUID.source, revision: 2 }],
    ['feed.confirmation_revoked', { confirmationId: UUID.source, revision: 2 }],
  ])('admits bounded Feed references and rejects copied source content: %s', (kind, payload) => {
    const event = base(kind as string, payload)
    expect(parseDecisionEventWrite(event).eventKind).toBe(kind)
    for (const forbidden of ['body', 'transcript', 'prompt', 'composition']) {
      expect(() => parseDecisionEventWrite({ ...event, payload: { ...(payload as object), [forbidden]: 'private content' } })).toThrow()
    }
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

  it('promotes only provider-complete Slack references to stable identity', () => {
    expect(stableExternalIdentityFromCrmRef({
      provider: 'Slack', id: 'U012345', team_id: 'T000001', url: 'https://example.test/profile',
    })).toEqual({
      provider: 'slack', providerInstanceKey: 'T000001', subjectId: 'U012345',
    })
    expect(stableExternalIdentityFromCrmRef({ provider: 'slack', id: 'U012345' })).toBeNull()
    expect(stableExternalIdentityFromCrmRef({ provider: 'email', id: 'person@example.test' })).toBeNull()
    expect(stableExternalIdentityFromCrmRef({ provider: 'unknown', id: '42', team_id: 'tenant' })).toBeNull()
  })

  it('promotes only instance-scoped WhatsApp references to stable identity', () => {
    expect(stableExternalIdentityFromCrmRef({
      provider: 'WhatsApp', id: '85292052939@s.whatsapp.net', instance_id: '4478940f',
    })).toEqual({
      provider: 'whatsapp', providerInstanceKey: '4478940f', subjectId: '85292052939@s.whatsapp.net',
    })
    // A privacy id is as much a subject as a phone JID.
    expect(stableExternalIdentityFromCrmRef({
      provider: 'whatsapp', id: '176450292473999@lid', instance_id: '4478940f',
    })).toEqual({
      provider: 'whatsapp', providerInstanceKey: '4478940f', subjectId: '176450292473999@lid',
    })
    // Without the connector instance the JID is only metadata: the same subject
    // under another linked account is a different person's address book.
    expect(stableExternalIdentityFromCrmRef({
      provider: 'whatsapp', id: '85292052939@s.whatsapp.net',
    })).toBeNull()
    // Slack's namespace key must not be read for a WhatsApp ref.
    expect(stableExternalIdentityFromCrmRef({
      provider: 'whatsapp', id: '85292052939@s.whatsapp.net', team_id: 'T000001',
    })).toBeNull()
  })
})
