import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createCrmOperationsTools,
  type CrmOperationsContext,
  type CrmOperationsReadPort,
  type CrmOperationsServicePort,
  type ToolContext,
} from '../../index.js'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'
const USER_ID = '00000000-0000-4000-8000-000000000002'
const ASSISTANT_ID = '00000000-0000-4000-8000-000000000003'
const SESSION_ID = '00000000-0000-4000-8000-000000000004'
const CONTACT_ID = '00000000-0000-4000-8000-000000000005'
const CREDENTIAL_ID = '00000000-0000-4000-8000-000000000006'

function context(patch: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: USER_ID,
    assistantId: ASSISTANT_ID,
    sessionId: SESSION_ID,
    appId: ASSISTANT_ID,
    channelType: 'web',
    channelId: 'channel-1',
    workspaceId: WORKSPACE_ID,
    abortSignal: new AbortController().signal,
    ...patch,
  }
}

const reads: CrmOperationsReadPort = {
  listIntakeDefinitions: vi.fn(async () => [{ definitionKey: 'website_contact' }]),
  listSubmissions: vi.fn(async () => [{ id: 'submission-1' }]),
  getSubmission: vi.fn(async () => ({ id: 'submission-1' })),
  listConsentPurposes: vi.fn(async () => [{ purposeKey: 'marketing' }]),
  getConsent: vi.fn(async () => ({ purposes: [], events: [], suppressions: [] })),
  checkSendability: vi.fn(async () => ({
    verdict: 'unknown' as const,
    reasons: ['consent_not_recorded' as const],
    effectiveSuppressionEventIds: [],
  })),
  listSegments: vi.fn(async () => ({ segments: [], catalog: [] })),
  getSegment: vi.fn(async () => null),
  previewSegment: vi.fn(async () => ({ rows: [], count: 0, snapshotIds: [] })),
}
const execute = vi.fn<CrmOperationsServicePort['execute']>(async (_ctx, command) => ({
  command: command.kind,
  record: { id: 'record-1' },
  created: true,
  duplicate: false,
  emittedEventIds: [],
}))
const tools = createCrmOperationsTools({ reads, service: { execute } })

beforeEach(() => vi.clearAllMocks())

describe('[COMP:crm/operations-tools] canonical CRM operation tools', () => {
  it('registers the closed CRM operations surface under the CRM capability', () => {
    expect(Object.keys(tools)).toEqual([
      'listCrmIntakeDefinitions', 'listCrmSubmissions', 'getCrmSubmission',
      'listCrmConsentPurposes', 'getCrmConsent', 'checkCrmSendability',
      'listCrmSegments', 'previewCrmSegment',
      'recordCrmSubmission', 'updateCrmSubmission', 'recordCrmConsent',
      'recordCrmSuppression', 'saveCrmSegment', 'archiveCrmSegment',
    ])
    expect(Object.values(tools).every((tool) => tool.requiresCapability === 'crm')).toBe(true)
    expect(tools.listCrmSubmissions.isReadOnly).toBe(true)
    expect(tools.updateCrmSubmission.isReadOnly).toBe(false)
  })

  it('passes bounded read filters to the workspace-scoped read port', async () => {
    const output = await tools.listCrmSubmissions.execute({
      status: 'new', definition_key: 'website_contact', limit: 20,
    }, context())
    expect(output.isError).toBeFalsy()
    expect(reads.listSubmissions).toHaveBeenCalledWith(WORKSPACE_ID, {
      status: 'new', definitionKey: 'website_contact', ownerUserId: undefined, limit: 20,
    })
  })

  it('derives the assistant actor and authority instead of accepting them as input', async () => {
    await tools.updateCrmSubmission.execute({
      submission_id: CONTACT_ID,
      status: 'in_progress',
    }, context())
    const [serviceContext, command] = execute.mock.calls[0] as [CrmOperationsContext, Record<string, unknown>]
    expect(serviceContext).toMatchObject({
      workspaceId: WORKSPACE_ID,
      actor: { kind: 'assistant', assistantId: ASSISTANT_ID, userId: USER_ID, sessionId: SESSION_ID },
      authority: { canWrite: true, canConfigure: false },
    })
    expect(command).toMatchObject({ kind: 'update_submission', submissionId: CONTACT_ID, status: 'in_progress' })
    expect(command).not.toHaveProperty('workspaceId')
    expect(command).not.toHaveProperty('actor')
  })

  it('preserves the authenticated Brain credential family in service audit context', async () => {
    await tools.recordCrmConsent.execute({
      contact_id: CONTACT_ID,
      purpose_key: 'marketing',
      action: 'granted',
      source: 'brain_mcp',
      metadata: {},
    }, context({
      channelType: 'programmatic',
      channelId: CREDENTIAL_ID,
      programmaticPrincipal: {
        kind: 'oauth_token', credentialId: CREDENTIAL_ID, userId: USER_ID,
      },
    }))
    expect(execute.mock.calls[0]?.[0].actor).toEqual({
      kind: 'oauth_token', credentialId: CREDENTIAL_ID, userId: USER_ID,
    })
  })

  it('confirmation-gates withdrawal and suppression release without gating safer inverses', async () => {
    await expect(tools.recordCrmConsent.resolveConfirmation!(context(), {
      contact_id: CONTACT_ID, purpose_key: 'marketing', action: 'withdrawn', source: 'manual', metadata: {},
    })).resolves.toBe(true)
    await expect(tools.recordCrmConsent.resolveConfirmation!(context(), {
      contact_id: CONTACT_ID, purpose_key: 'marketing', action: 'granted', source: 'manual', metadata: {},
    })).resolves.toBe(false)
    await expect(tools.recordCrmSuppression.resolveConfirmation!(context(), {
      contact_id: CONTACT_ID, channel: 'email', action: 'released', reason_code: 'manual_do_not_contact', source: 'manual', metadata: {},
    })).resolves.toBe(true)
  })
})
