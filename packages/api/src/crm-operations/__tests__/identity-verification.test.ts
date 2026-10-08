import { describe, expect, it } from 'vitest'
import { CrmOperationsCommandSchema, crmOperationsSha256, type CrmOperationsContext, type RecordCrmSubmissionCommand } from '@use-brian/core'
import { assertIntakeVerificationConfiguration, verifyIntakeIdentity } from '../identity-verification.js'
import { intakeProofFixture } from './intake-proof-fixture.js'

const workspaceId = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'
const context: CrmOperationsContext = { workspaceId, actor: { kind: 'user', userId }, authority: { role: 'owner', canWrite: true, canConfigure: true, trustedIdentitySources: [] } }
const now = new Date('2026-09-08T12:00:00Z')
const request: RecordCrmSubmissionCommand = {
  kind: 'record_submission', definitionKey: 'fixture', idempotencyKey: 'fixture_submission',
  fields: { email: 'verified@example.com' },
  attachments: [{ key: 'business_card', name: 'card.png', mimeType: 'image/png', contentBase64: 'aGVsbG8=' }],
}
const hash = (command: RecordCrmSubmissionCommand) => crmOperationsSha256({ definitionKey: command.definitionKey, fields: command.fields,
  ...(command.attachments?.length ? { attachments: command.attachments } : {}),
  externalIdentity: command.externalIdentity ?? null, submittedAt: command.submittedAt ?? null, campaignAttribution: command.campaignAttribution ?? null })
function setup() {
  const signer = intakeProofFixture()
  const definition: Parameters<typeof verifyIntakeIdentity>[1] = { identityPolicy: 'trusted_verified_email', currentVersion: 1, definitionKey: 'fixture',
    schemaSnapshot: { identityVerification: signer.config }, verificationAcknowledgedByUserId: userId }
  return { signer, definition, command: { ...request, identityProof: signer.proof(workspaceId, request, now.toISOString()) } }
}

describe('[COMP:crm/intake-verification] Trusted intake proof admission', () => {
  it('verifies a backend assertion and preserves its evidence without adding identity to the proof', () => {
    const { definition, command } = setup()
    expect(verifyIntakeIdentity(context, definition, command, hash(command), now)).toEqual({ ...command.identityProof, requestHash: hash(command) })
    expect(JSON.stringify(command.identityProof)).not.toContain('verified@example.com')
  })
  it.each(['missing', 'signature', 'expired', 'future', 'version', 'key', 'workspace', 'source', 'fields', 'attachments'] as const)('refuses %s proof before trusted matching', (kind) => {
    const { definition, command, signer } = setup()
    let ctx = context
    if (kind === 'missing') delete (command as RecordCrmSubmissionCommand).identityProof
    if (kind === 'signature') command.identityProof.signature = 'A'.repeat(86)
    if (kind === 'expired') command.identityProof = signer.proof(workspaceId, request, '2026-09-08T10:59:59Z')
    if (kind === 'future') command.identityProof = signer.proof(workspaceId, request, '2026-09-08T12:00:01Z')
    if (kind === 'version') command.identityProof.definitionVersion = 2
    if (kind === 'key') command.identityProof.keyId = 'other_key'
    if (kind === 'workspace') ctx = { ...context, workspaceId: userId }
    if (kind === 'source') command.idempotencyKey = 'other_submission'
    if (kind === 'fields') command.fields = { email: 'someoneelse@example.com' }
    if (kind === 'attachments') command.attachments = [{ ...request.attachments![0], contentBase64: 'dGFtcGVyZWQ=' }]
    expect(() => verifyIntakeIdentity(ctx, definition, command, hash(command), now)).toThrow(expect.objectContaining({ code: 'not_authorized' }))
  })
  it('refuses legacy unconfigured identity policies instead of silently trusting their bearer', () => {
    const { definition, command } = setup()
    definition.verificationAcknowledgedByUserId = null
    expect(() => verifyIntakeIdentity(context, definition, command, hash(command), now)).toThrow(expect.objectContaining({ details: { reason: 'identity_verification_unconfigured' } }))
    definition.schemaSnapshot = {}
    expect(() => verifyIntakeIdentity(context, definition, command, hash(command), now)).toThrow(expect.objectContaining({ details: { reason: 'identity_verification_unconfigured' } }))
  })
  it('requires bounded signed occurrence time and refuses claimed time on unverified forms', () => {
    const { definition, signer } = setup()
    for (const submittedAt of ['2026-09-08T10:59:59Z', '2026-09-08T12:00:01Z']) {
      const command = { ...request, submittedAt }
      expect(() => verifyIntakeIdentity(context, definition, { ...command, identityProof: signer.proof(workspaceId, command, now.toISOString()) }, hash(command), now))
        .toThrow(expect.objectContaining({ details: { reason: 'occurrence_time_out_of_window' } }))
    }
    definition.identityPolicy = 'new_or_review'
    expect(() => verifyIntakeIdentity(context, definition, { ...request, submittedAt: now.toISOString() }, hash(request), now))
      .toThrow(expect.objectContaining({ details: { reason: 'occurrence_time_requires_verification' } }))
    expect(verifyIntakeIdentity(context, definition, request, hash(request), now)).toBeNull()
  })
  it('requires direct owner/admin acknowledgement with an explicit window and public key', () => {
    const { signer } = setup()
    const definition = CrmOperationsCommandSchema.parse({ kind: 'save_intake_definition', definitionKey: 'fixture', label: 'Fixture', definition: {
      identityPolicy: 'trusted_verified_email', identityVerification: signer.config,
      fields: [{ key: 'email', label: 'Email', type: 'email', required: true, mapping: { kind: 'base_field', field: 'email' } }],
    } })
    if (definition.kind !== 'save_intake_definition') throw new Error('Unexpected command')
    expect(() => assertIntakeVerificationConfiguration(context, definition.definition)).not.toThrow()
    expect(() => assertIntakeVerificationConfiguration({ ...context, actor: { kind: 'assistant', assistantId: userId, sessionId: workspaceId, userId } }, definition.definition)).toThrow(expect.objectContaining({ code: 'not_authorized' }))
    expect(() => assertIntakeVerificationConfiguration({ ...context, authority: { ...context.authority, role: 'member' } }, definition.definition)).toThrow(expect.objectContaining({ code: 'not_authorized' }))
    expect(() => assertIntakeVerificationConfiguration(context, { ...definition.definition, identityVerification: undefined })).toThrow(expect.objectContaining({ code: 'invalid_input' }))
  })
  it('rejects nested verification flags and client-supplied private key material', () => {
    expect(CrmOperationsCommandSchema.safeParse({ ...request, externalIdentity: { provider: 'fixture', subject: 'subject', verified: true } }).success).toBe(false)
    expect(CrmOperationsCommandSchema.safeParse({ ...request, identityProof: { ...setup().command.identityProof, privateKey: 'never_accept' } }).success).toBe(false)
  })
})
