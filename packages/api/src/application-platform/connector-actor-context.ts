/** Host-only request-bound actor minting. No model/header-derived identity. [COMP:api/connector-actor-context] */
import { randomBytes, sign, type KeyObject } from 'node:crypto'
import type { ExecutionContext } from '@use-brian/core'
import { ApplicationPlatformError } from '@use-brian/shared'
import { CONNECTOR_ACTOR_LIFETIME_SECONDS, CONNECTOR_ACTOR_TYPE, CONNECTOR_ACTOR_VERSION,
  connectorRequestBinding, parseConnectorActorClaims, type ConnectorActor, type ConnectorActorClaims,
  type ConnectorRequestBytes } from '@use-brian/brian-app/connector'
import { getApplicationExecutionBinding } from './execution-context.js'

export type ConnectorActorBinding = {
  issuer: string
  audience: string
  workspaceId: string
  connectorInstanceId: string
}
export type ConnectorActorAdmission = {
  bindingRevision: string
  actor: ConnectorActor
  delegation?: ConnectorActorClaims['delegation']
}
export type ConnectorActorSigningKey = {
  kid: string
  privateKey: KeyObject
  notBefore: number
  notAfter?: number
}
export type ConnectorActorMintingPorts = {
  /** Reload current initiator, assistant, connector, credential and protected-profile admission. No positive cache. */
  admit: (execution: ExecutionContext, binding: ConnectorActorBinding) => Promise<ConnectorActorAdmission | null>
  loadActiveKey: (issuer: string) => Promise<ConnectorActorSigningKey | null>
  /** Recheck revocation after key decryption and live admission; never mint with a retired private key. */
  keyCurrent: (kid: string) => Promise<boolean>
  now?: () => number
}
function denied(): never { throw new ApplicationPlatformError('access_unavailable', 'Connector identity is unavailable.') }
function actorMatchesExecution(execution: ExecutionContext, admission: ConnectorActorAdmission) {
  const { actor, delegation } = admission, identity = execution.identity, actual = execution.security.access.userId
  if (identity.kind === 'attended') return actor.kind === 'human' && actor.userId === actual
    && identity.principal.userId === actual && !delegation
    && actor.authenticationKind === (identity.principal.kind === 'workspace_member' ? 'native_session' : 'verified_channel')
  if (identity.kind === 'delegated') return actor.kind === 'human' && actor.userId === actual
    && actor.authenticationKind === 'delegation' && delegation?.effectiveActorUserId === actual
    && delegation.delegationId === identity.delegationId && identity.actorUserId === actual
  if (identity.kind === 'programmatic' && identity.principal.kind === 'application') {
    const proof = getApplicationExecutionBinding(execution)
    if (!proof || proof.state.principal.userId !== actual || identity.principal.actorUserId !== actual || delegation) return false
    return identity.principal.subjectKind === 'service'
      ? actor.kind === 'service' && actor.serviceUserId === actual && identity.principal.serviceUserId === actual
      : actor.kind === 'human' && actor.userId === actual && actor.authenticationKind === 'application_oauth'
  }
  // A background lane needs an explicitly persisted named service. It cannot invent a human initiator.
  return identity.kind === 'system' && actor.kind === 'service' && actor.serviceUserId === actual && !delegation
}

/** Called only at actual HTTP dispatch, after serialization. The caller retains business idempotency separately. */
export async function mintConnectorActorAssertion(execution: ExecutionContext, rawBinding: ConnectorActorBinding,
  rawRequest: ConnectorRequestBytes, ports: ConnectorActorMintingPorts): Promise<string> {
  const binding = Object.freeze({ ...rawBinding }), request = connectorRequestBinding({ ...rawRequest, body: Uint8Array.from(rawRequest.body) })
  if (execution.ownership.kind !== 'workspace' || execution.ownership.workspaceId !== binding.workspaceId
    || execution.security.access.workspaceId !== binding.workspaceId || execution.assistant.id !== execution.security.access.assistantId
    || execution.lifecycle.abortSignal.aborted) denied()
  await execution.security.authority.assertCurrent()
  const admitted = await ports.admit(execution, binding)
  if (!admitted || !actorMatchesExecution(execution, admitted)) denied()
  const initial = JSON.stringify(admitted), key = await ports.loadActiveKey(binding.issuer)
  if (!key || !/^[A-Za-z0-9_-]{1,128}$/.test(key.kid) || key.privateKey.type !== 'private' || key.privateKey.asymmetricKeyType !== 'ed25519') denied()
  const current = await ports.admit(execution, binding)
  if (!current || !actorMatchesExecution(execution, current) || JSON.stringify(current) !== initial) denied()
  const finalAdmission = structuredClone(current)
  if (!await ports.keyCurrent(key.kid)) denied()
  await execution.security.authority.assertCurrent()
  if (execution.lifecycle.abortSignal.aborted) denied()
  const now = Math.floor((ports.now?.() ?? Date.now()) / 1000)
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(key.notBefore) || now < key.notBefore
    || key.notAfter !== undefined && (!Number.isSafeInteger(key.notAfter) || now + CONNECTOR_ACTOR_LIFETIME_SECONDS > key.notAfter)) denied()
  const claims = parseConnectorActorClaims({ version: CONNECTOR_ACTOR_VERSION, iss: binding.issuer, aud: binding.audience,
    iat: now, nbf: now, exp: now + CONNECTOR_ACTOR_LIFETIME_SECONDS, jti: randomBytes(24).toString('base64url'),
    workspaceId: binding.workspaceId, connectorInstanceId: binding.connectorInstanceId, executingAssistantId: execution.assistant.id,
    executionKind: execution.identity.kind, bindingRevision: finalAdmission.bindingRevision, actor: finalAdmission.actor,
    ...(finalAdmission.delegation ? { delegation: finalAdmission.delegation } : {}), request })
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: CONNECTOR_ACTOR_TYPE, kid: key.kid })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url'), input = `${header}.${payload}`
  const assertion = `${input}.${sign(null, Buffer.from(input), key.privateKey).toString('base64url')}`
  if (assertion.length > 8192) throw new ApplicationPlatformError('invalid_value', 'The connector identity request is too large.')
  return assertion
}
