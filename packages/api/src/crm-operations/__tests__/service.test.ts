import { describe, expect, it, vi } from 'vitest'
import { CrmOperationsError, type CrmOperationsContext } from '@use-brian/core'
import { createCrmOperationsService } from '../service.js'
import type {
  CrmOperationsStore,
  CrmOperationsTransaction,
  StoredIntakeDefinition,
} from '../../db/crm-operations-store.js'

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'
const CREDENTIAL_ID = '33333333-3333-4333-8333-333333333333'
const DEFINITION_ID = '44444444-4444-4444-8444-444444444444'
const DEFINITION_VERSION_ID = '55555555-5555-4555-8555-555555555555'
const CONTACT_ID = '66666666-6666-4666-8666-666666666666'
const SUBMISSION_ID = '77777777-7777-4777-8777-777777777777'
const TASK_ID = '88888888-8888-4888-8888-888888888888'
const PURPOSE_ID = '99999999-9999-4999-8999-999999999999'

const context: CrmOperationsContext = {
  workspaceId: WORKSPACE_ID,
  actor: { kind: 'intake_key', credentialId: CREDENTIAL_ID, definitionId: DEFINITION_ID },
  authority: { role: 'system', canWrite: true, canConfigure: false, trustedIdentitySources: [] },
}

const definition: StoredIntakeDefinition = {
  id: DEFINITION_ID,
  workspaceId: WORKSPACE_ID,
  definitionKey: 'contact_form',
  label: 'Contact form',
  active: true,
  currentVersion: 1,
  versionId: DEFINITION_VERSION_ID,
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true, mapping: { kind: 'base_field', field: 'name' } },
    { key: 'email', label: 'Email', type: 'email', required: true, mapping: { kind: 'base_field', field: 'email' } },
    { key: 'interests', label: 'Interests', type: 'string_array', required: false, mapping: { kind: 'base_field', field: 'tags' } },
    { key: 'newsletter', label: 'Newsletter', type: 'boolean', required: true, mapping: { kind: 'submission_only' } },
    { key: 'private_note', label: 'Private note', type: 'text', required: false, mapping: { kind: 'custom_field', fieldKey: 'intake_note' } },
  ],
  identityPolicy: 'trusted_verified_email',
  allowedIdentityProvider: null,
  consentMappings: [{ fieldKey: 'newsletter', grantedValue: true, purposeKey: 'newsletter' }],
  queueKey: 'general',
  ownerUserId: USER_ID,
  followUpTaskTemplate: { title: 'Review contact form', description: 'Review the new form.', priority: 'medium', tags: ['intake'] },
  followUpDueMinutes: 60,
  maxPayloadBytes: 65_536,
  schemaHash: 'a'.repeat(64),
  schemaSnapshot: { fields: ['name', 'email'] },
  createdByUserId: USER_ID,
}

function makeTransaction(overrides: Partial<CrmOperationsTransaction> = {}) {
  let eventIndex = 0
  const tx = {
    getIntakeDefinition: vi.fn().mockResolvedValue(definition),
    intakeCredentialMayUse: vi.fn().mockResolvedValue(true),
    claimIdempotency: vi.fn().mockResolvedValue({ kind: 'claimed', claimId: 'claim-1' }),
    commitIdempotency: vi.fn().mockResolvedValue(undefined),
    resolveExternalIdentity: vi.fn().mockResolvedValue(null),
    findContactByEmail: vi.fn().mockResolvedValue(null),
    resolveAttributionUser: vi.fn().mockResolvedValue(USER_ID),
    createContact: vi.fn().mockResolvedValue({ id: CONTACT_ID }),
    updateContact: vi.fn().mockResolvedValue({ id: CONTACT_ID }),
    bindExternalIdentity: vi.fn().mockResolvedValue(undefined),
    createSubmission: vi.fn().mockResolvedValue({ id: SUBMISSION_ID, contactId: CONTACT_ID }),
    createFollowUpTask: vi.fn().mockResolvedValue({ id: TASK_ID }),
    attachFollowUpTask: vi.fn().mockResolvedValue(undefined),
    getConsentPurpose: vi.fn().mockResolvedValue({
      id: PURPOSE_ID,
      purposeKey: 'newsletter',
      wordingVersion: '2026-01',
      wordingHash: 'b'.repeat(64),
      wording: 'I agree to receive updates.',
      archivedAt: null,
    }),
    appendConsent: vi.fn().mockResolvedValue({ record: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, created: true }),
    appendSuppression: vi.fn(),
    updateSubmission: vi.fn(),
    saveIntakeDefinition: vi.fn(),
    createIntakeCredential: vi.fn(),
    revokeIntakeCredential: vi.fn(),
    saveConsentPurpose: vi.fn(),
    getSegmentCatalog: vi.fn().mockResolvedValue({
      fields: new Map([
        ['base:name', { family: 'base', operators: ['contains'], valueType: 'text' }],
      ]),
    }),
    saveSegment: vi.fn(),
    archiveSegment: vi.fn(),
    grantEntitlement: vi.fn(),
    updateEntitlement: vi.fn(),
    recordParticipation: vi.fn(),
    updateParticipation: vi.fn(),
    setDealPipelineStage: vi.fn(),
    appendDomainAudit: vi.fn().mockResolvedValue('domain-audit'),
    appendWorkspaceAudit: vi.fn().mockResolvedValue('workspace-audit'),
    emitDomainEvent: vi.fn().mockImplementation(async () => `event-${++eventIndex}`),
    ...overrides,
  }
  return tx as unknown as CrmOperationsTransaction & Record<string, ReturnType<typeof vi.fn>>
}

function makeStore(tx: CrmOperationsTransaction, onRollback?: () => void): CrmOperationsStore {
  return {
    async transaction(_context, run) {
      try {
        return await run(tx)
      } catch (error) {
        onRollback?.()
        throw error
      }
    },
  }
}

const submissionCommand = {
  kind: 'record_submission' as const,
  definitionKey: 'contact_form',
  idempotencyKey: 'request-1',
  fields: {
    name: 'Ari Example',
    email: 'ARI@EXAMPLE.COM',
    interests: ['events'],
    newsletter: true,
    private_note: 'Sensitive detail that must not enter events',
  },
}

describe('[COMP:crm/operations-service] canonical CRM operations service', () => {
  it('commits the complete definition-driven intake and emits only redacted event payloads', async () => {
    const tx = makeTransaction()
    const service = createCrmOperationsService(makeStore(tx), {
      now: () => new Date('2026-08-30T12:00:00.000Z'),
    })

    const output = await service.execute(context, submissionCommand)

    expect(output).toMatchObject({
      command: 'record_submission',
      created: true,
      duplicate: false,
      record: { submissionId: SUBMISSION_ID, contactId: CONTACT_ID, followUpTaskId: TASK_ID },
    })
    expect(tx.createContact).toHaveBeenCalledWith({
      name: 'Ari Example',
      email: 'ari@example.com',
      phone: null,
      tags: ['events'],
      customFields: { intake_note: 'Sensitive detail that must not enter events' },
    }, { createdByUserId: USER_ID, createdByAssistantId: null })
    expect(tx.appendConsent).toHaveBeenCalledWith(expect.objectContaining({
      contactId: CONTACT_ID,
      action: 'granted',
      source: 'intake',
      purpose: expect.objectContaining({ purposeKey: 'newsletter' }),
    }))
    expect(tx.attachFollowUpTask).toHaveBeenCalledWith(SUBMISSION_ID, TASK_ID)
    expect(tx.commitIdempotency).toHaveBeenCalledWith({
      claimId: 'claim-1', submissionId: SUBMISSION_ID, contactId: CONTACT_ID, followUpTaskId: TASK_ID,
    })
    const eventCalls = (tx.emitDomainEvent as ReturnType<typeof vi.fn>).mock.calls as Array<[
      { payload: Record<string, unknown> },
    ]>
    const payloads = eventCalls.map((call) => call[0].payload)
    expect(JSON.stringify(payloads)).not.toContain('Sensitive detail')
    expect(JSON.stringify(payloads)).not.toContain('ari@example.com')
    expect(payloads).toEqual(expect.arrayContaining([
      expect.objectContaining({ submissionId: SUBMISSION_ID, definitionKey: 'contact_form' }),
      expect.objectContaining({ contactId: CONTACT_ID, purposeKey: 'newsletter', action: 'granted' }),
    ]))
  })

  it('returns the committed bounded response on an identical replay without any semantic write', async () => {
    const tx = makeTransaction({
      claimIdempotency: vi.fn().mockResolvedValue({
        kind: 'duplicate', claimId: 'claim-1', submissionId: SUBMISSION_ID,
        contactId: CONTACT_ID, followUpTaskId: TASK_ID,
      }),
    })
    const output = await createCrmOperationsService(makeStore(tx)).execute(context, submissionCommand)
    expect(output).toEqual({
      command: 'record_submission', created: false, duplicate: true, emittedEventIds: [],
      record: { submissionId: SUBMISSION_ID, contactId: CONTACT_ID, followUpTaskId: TASK_ID },
    })
    expect(tx.createContact).not.toHaveBeenCalled()
    expect(tx.createSubmission).not.toHaveBeenCalled()
    expect(tx.emitDomainEvent).not.toHaveBeenCalled()
  })

  it('rejects a changed-body idempotency conflict', async () => {
    const tx = makeTransaction({
      claimIdempotency: vi.fn().mockResolvedValue({ kind: 'conflict', claimId: 'claim-1', storedHash: 'old' }),
    })
    await expect(createCrmOperationsService(makeStore(tx)).execute(context, submissionCommand))
      .rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect(tx.createSubmission).not.toHaveBeenCalled()
  })

  it('serializes concurrent identical replays into one logical submission', async () => {
    let committed: { submissionId: string; contactId: string; followUpTaskId: string | null } | null = null
    const tx = makeTransaction({
      claimIdempotency: vi.fn().mockImplementation(async () => committed
        ? { kind: 'duplicate', claimId: 'claim-1', ...committed }
        : { kind: 'claimed', claimId: 'claim-1' }),
      commitIdempotency: vi.fn().mockImplementation(async (value) => {
        committed = {
          submissionId: value.submissionId,
          contactId: value.contactId,
          followUpTaskId: value.followUpTaskId,
        }
      }),
    })
    let tail = Promise.resolve()
    const serialStore: CrmOperationsStore = {
      transaction(_context, run) {
        const work = tail.then(() => run(tx))
        tail = work.then(() => undefined, () => undefined)
        return work
      },
    }
    const service = createCrmOperationsService(serialStore)
    const [left, right] = await Promise.all([
      service.execute(context, submissionCommand),
      service.execute(context, submissionCommand),
    ])
    expect([left.duplicate, right.duplicate].sort()).toEqual([false, true])
    expect(left.record).toEqual(right.record)
    expect(tx.createContact).toHaveBeenCalledOnce()
    expect(tx.createSubmission).toHaveBeenCalledOnce()
  })

  it('fails closed when an intake credential is not bound to the definition', async () => {
    const tx = makeTransaction({ intakeCredentialMayUse: vi.fn().mockResolvedValue(false) })
    await expect(createCrmOperationsService(makeStore(tx)).execute(context, submissionCommand))
      .rejects.toMatchObject({ code: 'credential_revoked' })
    expect(tx.claimIdempotency).not.toHaveBeenCalled()
  })

  it('rejects undeclared fields before creating CRM data', async () => {
    const tx = makeTransaction()
    await expect(createCrmOperationsService(makeStore(tx)).execute(context, {
      ...submissionCommand,
      fields: { ...submissionCommand.fields, ownerUserId: USER_ID },
    })).rejects.toBeInstanceOf(CrmOperationsError)
    expect(tx.claimIdempotency).not.toHaveBeenCalled()
    expect(tx.createContact).not.toHaveBeenCalled()
  })

  it.each([
    'createContact', 'createSubmission', 'appendConsent', 'createFollowUpTask',
    'appendDomainAudit', 'appendWorkspaceAudit', 'emitDomainEvent', 'commitIdempotency',
  ])('propagates a %s failure through the transaction rollback seam', async (method) => {
    let rolledBack = false
    const tx = makeTransaction({ [method]: vi.fn().mockRejectedValue(new Error(`fail:${method}`)) })
    await expect(createCrmOperationsService(makeStore(tx, () => { rolledBack = true })).execute(
      context,
      submissionCommand,
    )).rejects.toThrow(`fail:${method}`)
    expect(rolledBack).toBe(true)
  })

  it('returns a raw intake secret once while storing only its hash', async () => {
    const tx = makeTransaction({
      createIntakeCredential: vi.fn().mockResolvedValue({ id: CREDENTIAL_ID, label: 'Website' }),
    })
    const ownerContext: CrmOperationsContext = {
      workspaceId: WORKSPACE_ID,
      actor: { kind: 'user', userId: USER_ID },
      authority: { role: 'owner', canWrite: true, canConfigure: true, trustedIdentitySources: [] },
    }
    const output = await createCrmOperationsService(makeStore(tx), {
      randomCredentialId: () => CREDENTIAL_ID,
      randomSecret: () => 'one-time-material',
      hashCredentialSecret: async () => 'scrypt$test',
    }).execute(ownerContext, {
      kind: 'create_intake_credential', label: 'Website', definitionIds: [DEFINITION_ID],
    })
    expect(output.oneTimeSecret).toBe(`sk_intake_${CREDENTIAL_ID}_one-time-material`)
    expect(tx.createIntakeCredential).toHaveBeenCalledWith(expect.objectContaining({
      credentialId: CREDENTIAL_ID,
      secretPrefix: 'sk_intake_3333',
      secretHash: 'scrypt$test',
    }))
    const credentialCalls = (tx.createIntakeCredential as ReturnType<typeof vi.fn>).mock.calls
    expect(JSON.stringify(credentialCalls[0]![0])).not.toContain('one-time-material')
  })

  it('validates segment predicates against the transaction catalog before writing', async () => {
    const saved = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', version: 1 }
    const tx = makeTransaction({ saveSegment: vi.fn().mockResolvedValue({ record: saved, created: true }) })
    const memberContext: CrmOperationsContext = {
      workspaceId: WORKSPACE_ID,
      actor: { kind: 'user', userId: USER_ID },
      authority: { role: 'member', canWrite: true, canConfigure: false, trustedIdentitySources: [] },
    }
    await expect(createCrmOperationsService(makeStore(tx)).execute(memberContext, {
      kind: 'save_segment', segmentKey: 'named_examples', name: 'Named examples', description: '',
      entityKind: 'person', predicate: { type: 'group', combinator: 'and', items: [
        { type: 'rule', family: 'base', field: 'name', operator: 'contains', value: 'Example' },
      ] },
    })).resolves.toMatchObject({ command: 'save_segment', created: true, record: saved })
    expect(tx.getSegmentCatalog).toHaveBeenCalledWith('person')
    expect(tx.saveSegment).toHaveBeenCalledOnce()
  })

  it('returns enumerable segment catalog choices instead of guessing unknown fields', async () => {
    const tx = makeTransaction()
    const memberContext: CrmOperationsContext = {
      workspaceId: WORKSPACE_ID,
      actor: { kind: 'user', userId: USER_ID },
      authority: { role: 'member', canWrite: true, canConfigure: false, trustedIdentitySources: [] },
    }
    await expect(createCrmOperationsService(makeStore(tx)).execute(memberContext, {
      kind: 'save_segment', segmentKey: 'bad', name: 'Bad', description: '', entityKind: 'person',
      predicate: { type: 'group', combinator: 'and', items: [
        { type: 'rule', family: 'base', field: 'made_up', operator: 'contains', value: 'x' },
      ] },
    })).rejects.toMatchObject({
      code: 'catalog_key_invalid',
      details: { issues: [expect.objectContaining({ validValues: ['base:name'] })] },
    })
    expect(tx.saveSegment).not.toHaveBeenCalled()
  })

  it('commits entitlement and participation changes with redacted domain-event pointers', async () => {
    const tx = makeTransaction({
      grantEntitlement: vi.fn().mockResolvedValue({
        created: true,
        record: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', contactId: CONTACT_ID, planId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status: 'active' },
      }),
      recordParticipation: vi.fn().mockResolvedValue({
        created: true,
        record: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', contactId: CONTACT_ID, eventId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', status: 'registered' },
      }),
    })
    const memberContext: CrmOperationsContext = {
      workspaceId: WORKSPACE_ID,
      actor: { kind: 'user', userId: USER_ID },
      authority: { role: 'member', canWrite: true, canConfigure: false, trustedIdentitySources: [] },
    }
    const service = createCrmOperationsService(makeStore(tx), {
      now: () => new Date('2026-08-30T12:00:00.000Z'),
    })
    await service.execute(memberContext, {
      kind: 'grant_entitlement', contactId: CONTACT_ID,
      planId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', idempotencyKey: 'grant-1',
      status: 'active', startsAt: '2026-08-30T00:00:00.000Z', renewalMode: 'none',
    })
    await service.execute(memberContext, {
      kind: 'record_participation', contactId: CONTACT_ID,
      eventId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', sourceKind: 'manual',
      sourceId: 'attendance-1', status: 'registered', attendeeName: 'Example Person',
      attendeeEmail: 'person@example.com', metadata: { privateNote: 'do not emit' },
    })
    const payloads = (tx.emitDomainEvent as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0].payload)
    expect(payloads).toEqual([
      expect.objectContaining({ contactId: CONTACT_ID, status: 'active' }),
      expect.objectContaining({ contactId: CONTACT_ID, status: 'registered' }),
    ])
    expect(JSON.stringify(payloads)).not.toContain('person@example.com')
    expect(JSON.stringify(payloads)).not.toContain('do not emit')
  })

  it('emits one redacted domain event for a custom pipeline stage move', async () => {
    const pipelineId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const stageId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const tx = makeTransaction({
      setDealPipelineStage: vi.fn().mockResolvedValue({
        id: CONTACT_ID, updatedAt: '2026-08-30T12:00:00.000Z',
        pipeline: { pipelineName: 'Renewals', stageName: 'Review' },
      }),
    })
    const memberContext: CrmOperationsContext = {
      workspaceId: WORKSPACE_ID,
      actor: { kind: 'user', userId: USER_ID },
      authority: { role: 'member', canWrite: true, canConfigure: false, trustedIdentitySources: [] },
    }
    const output = await createCrmOperationsService(makeStore(tx), {
      now: () => new Date('2026-08-30T12:00:00.000Z'),
    }).execute(memberContext, {
      kind: 'set_deal_pipeline_stage', dealId: CONTACT_ID, pipelineId, stageId,
    })
    expect(output).toMatchObject({
      command: 'set_deal_pipeline_stage', emittedEventIds: ['event-1'],
    })
    expect(tx.emitDomainEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'crm.deal.stage_changed',
      payload: {
        dealId: CONTACT_ID, pipelineId, stageId,
        actorKind: 'user', occurredAt: '2026-08-30T12:00:00.000Z',
      },
    }))
  })

  it('does not duplicate audit or events when the requested stage is already current', async () => {
    const tx = makeTransaction({
      setDealPipelineStage: vi.fn().mockResolvedValue({
        id: CONTACT_ID, unchanged: true,
        pipeline: { pipelineName: 'Renewals', stageName: 'Review' },
      }),
    })
    const output = await createCrmOperationsService(makeStore(tx)).execute({
      workspaceId: WORKSPACE_ID,
      actor: { kind: 'user', userId: USER_ID },
      authority: { role: 'member', canWrite: true, canConfigure: false, trustedIdentitySources: [] },
    }, {
      kind: 'set_deal_pipeline_stage', dealId: CONTACT_ID,
      pipelineId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      stageId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    })
    expect(output.duplicate).toBe(true)
    expect(tx.appendDomainAudit).not.toHaveBeenCalled()
    expect(tx.appendWorkspaceAudit).not.toHaveBeenCalled()
    expect(tx.emitDomainEvent).not.toHaveBeenCalled()
  })
})
