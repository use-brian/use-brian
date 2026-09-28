/** Backend attestation admission, before any trusted identity resolution.
 * [COMP:crm/intake-verification]
 */
import { createPublicKey, verify } from 'node:crypto'
import {
  CrmIntakeVerificationConfigSchema, CrmOperationsError, canonicalCrmRequest, isUnverifiedIdentityPolicy,
  type CrmOperationsContext, type CrmIntakeDefinitionVersionInput, type CrmIntakeIdentityProof,
  type RecordCrmSubmissionCommand,
} from '@use-brian/core'
import type { StoredIntakeDefinition } from '../db/crm-operations-store.js'

function publicKey(value: string) {
  if (Buffer.from(value, 'base64url').toString('base64url') !== value) throw new Error('Noncanonical key')
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: value }, format: 'jwk' })
}

export function assertIntakeVerificationConfiguration(context: CrmOperationsContext, definition: CrmIntakeDefinitionVersionInput): void {
  if (isUnverifiedIdentityPolicy(definition.identityPolicy)) {
    if (definition.identityVerification) throw new CrmOperationsError('invalid_input', 'Unverified intake must not configure a trusted identity key.')
    return
  }
  if (context.actor.kind !== 'user' || !['owner', 'admin'].includes(context.authority.role)) {
    throw new CrmOperationsError('not_authorized', 'Trusted identity configuration requires a member-authenticated owner or admin acknowledgement.')
  }
  const config = CrmIntakeVerificationConfigSchema.safeParse(definition.identityVerification)
  if (!config.success) throw new CrmOperationsError('invalid_input', 'Configure a verification key, validity window and explicit backend verification acknowledgement.')
  try { publicKey(config.data.publicKey) } catch {
    throw new CrmOperationsError('invalid_input', 'The verification public key must be canonical Ed25519 base64url.')
  }
  if (definition.identityPolicy === 'trusted_verified_email' && !definition.fields.some((field) =>
    field.type === 'email' && field.required && field.mapping.kind === 'base_field' && field.mapping.field === 'email')) {
    throw new CrmOperationsError('invalid_input', 'Trusted email intake requires a required email field mapped to the contact email.')
  }
}

export function verifyIntakeIdentity(
  context: CrmOperationsContext, definition: Pick<StoredIntakeDefinition, 'identityPolicy' | 'schemaSnapshot' | 'verificationAcknowledgedByUserId' | 'currentVersion' | 'definitionKey'>,
  command: RecordCrmSubmissionCommand, requestHash: string, now: Date,
): (CrmIntakeIdentityProof & { requestHash: string }) | null {
  if (isUnverifiedIdentityPolicy(definition.identityPolicy)) {
    if (command.identityProof) throw new CrmOperationsError('invalid_input', 'This intake definition does not accept identity proof.')
    if (command.submittedAt) throw new CrmOperationsError('invalid_input', 'Caller occurrence time requires verified backend admission.', { reason: 'occurrence_time_requires_verification' })
    return null
  }
  const parsed = CrmIntakeVerificationConfigSchema.safeParse(definition.schemaSnapshot.identityVerification)
  if (!parsed.success || !definition.verificationAcknowledgedByUserId) {
    throw new CrmOperationsError('conflict', 'An owner must configure backend identity verification for this definition.', { reason: 'identity_verification_unconfigured' })
  }
  const proof = command.identityProof
  if (!proof) throw new CrmOperationsError('not_authorized', 'Backend verification proof is required.', { reason: 'identity_verification_required' })
  const config = parsed.data, verifiedAt = Date.parse(proof.verifiedAt)
  const earliest = now.getTime() - config.maxAgeSeconds * 1000
  let valid = proof.keyId === config.keyId && proof.definitionVersion === definition.currentVersion
    && verifiedAt >= earliest && verifiedAt <= now.getTime()
  try {
    const signature = Buffer.from(proof.signature, 'base64url')
    const envelope = {
      protocol: 'crm-intake-identity-v1', workspaceId: context.workspaceId,
      definitionKey: definition.definitionKey, definitionVersion: proof.definitionVersion,
      idempotencyKey: command.idempotencyKey, requestHash, keyId: proof.keyId, verifiedAt: proof.verifiedAt,
    }
    valid = valid && signature.length === 64 && signature.toString('base64url') === proof.signature
      && verify(null, Buffer.from(canonicalCrmRequest(envelope)), publicKey(config.publicKey), signature)
  } catch { valid = false }
  if (!valid) throw new CrmOperationsError('not_authorized', 'Backend verification proof is invalid or expired.', { reason: 'identity_verification_invalid' })
  if (command.submittedAt) {
    const occurredAt = Date.parse(command.submittedAt)
    if (occurredAt < earliest || occurredAt > now.getTime()) {
      throw new CrmOperationsError('invalid_input', 'Submission occurrence time is outside the configured verification window.', { reason: 'occurrence_time_out_of_window' })
    }
  }
  return { ...proof, requestHash }
}
