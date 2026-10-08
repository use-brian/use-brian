/** Synthetic backend only. Never validates real email or provider accounts. */
import { generateKeyPairSync, sign } from 'node:crypto'
import { canonicalCrmRequest, crmOperationsSha256, type RecordCrmSubmissionCommand } from '@use-brian/core'

export function intakeProofFixture() {
  const keys = generateKeyPairSync('ed25519')
  const config = { keyId: 'fixture_backend', publicKey: keys.publicKey.export({ format: 'jwk' }).x!, maxAgeSeconds: 3600, acknowledged: true as const }
  return {
    config,
    proof(workspaceId: string, command: RecordCrmSubmissionCommand, verifiedAt = new Date().toISOString(), definitionVersion = 1) {
      const requestHash = crmOperationsSha256({ definitionKey: command.definitionKey, fields: command.fields,
        ...(command.attachments?.length ? { attachments: command.attachments } : {}),
        externalIdentity: command.externalIdentity ?? null, submittedAt: command.submittedAt ?? null, campaignAttribution: command.campaignAttribution ?? null })
      const envelope = { protocol: 'crm-intake-identity-v1', workspaceId, definitionKey: command.definitionKey,
        definitionVersion, idempotencyKey: command.idempotencyKey, requestHash, keyId: config.keyId, verifiedAt }
      return { keyId: config.keyId, definitionVersion, verifiedAt,
        signature: sign(null, Buffer.from(canonicalCrmRequest(envelope)), keys.privateKey).toString('base64url') }
    },
  }
}
