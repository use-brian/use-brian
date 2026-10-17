import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { CONNECTOR_ACTOR_TYPE, connectorRequestBinding, createBoundedConnectorReplayConsumer, createConnectorActorVerifier,
  handleSourceSidecar, parseSourceEnvelope, parseSourceCapabilities, parseSourceAuthorizationRequest, parseSourceAuthorizationResponse,
  requireSourceAuthorization, parseSourceReconcileResponse, sourceAuthorizationDigest, sourceSubjectFromActor,
  type ConnectorActorClaims, type SourceAuthorizationRequest, type SourceAuthorizationResponse, type SourceCapabilities,
  type SourceEnvelope } from '../connector.js'

describe('[COMP:shared/brian-app-sdk] independent source evidence and sidecar contract', () => {
  const now = 1_800_000_000_000, user = randomUUID(), assistant = randomUUID(), tenant = 'fictional-source-tenant'
  const subject = { kind: 'human' as const, id: user, executingAssistantId: assistant }
  const ref = { type: 'purchase', id: 'synthetic-purchase-1', contentVersion: '5', policyVersion: '12' }
  const capabilities: SourceCapabilities = { version: 'ub.source.v1', tenant, fieldEvidence: true, reconciliation: true, retentionModes: ['governed','ephemeral'] }
  function envelope(): SourceEnvelope {
    return { version: 'ub.source.v1', tenant, resources: [{ resource: { ...ref }, fields: ['description','cost'],
      labels: { sensitivity: 'confidential', compartments: [`team:${randomUUID()}`], projectIds: [] }, subjects: [{ ...subject }],
      actions: ['read','context','retain'], retention: { mode: 'governed' }, export: { model: true, destinations: [] } }] }
  }
  function request(): SourceAuthorizationRequest {
    return { version: 'ub.source.v1', operationId: randomUUID(), items: [{ itemId: randomUUID(), resource: { ...ref },
      fields: ['cost','description'], action: 'context', retentionMode: 'governed' }], recipients: [{ recipientId: randomUUID(), subject: { ...subject } }] }
  }
  function response(input: SourceAuthorizationRequest): SourceAuthorizationResponse {
    return { version: 'ub.source.v1', tenant, operationId: input.operationId, decisions: input.items.flatMap(item => input.recipients.map(recipient => ({
      itemId: item.itemId, recipientId: recipient.recipientId, allowed: true as const, receipt: { id: randomUUID(), issuedAt: now, expiresAt: now + 5_000 } }))) }
  }
  it('detaches complete resource, field, audience and retention evidence', () => {
    const input = envelope(), parsed = parseSourceEnvelope(input)
    input.resources[0].fields.push('hidden'); input.resources[0].subjects.length = 0
    expect(parsed.resources[0].fields).toEqual(['description','cost']); expect(parsed.resources[0].subjects).toHaveLength(1)
    expect(parseSourceCapabilities(capabilities)).toEqual(capabilities)
  })
  it.each(['fields','labels','subjects','actions','retention','export'] as const)('refuses absent %s instead of inferring broader rights', key => {
    const input = envelope(); delete (input.resources[0] as unknown as Record<string, unknown>)[key]
    expect(() => parseSourceEnvelope(input)).toThrow('source_protocol_invalid')
  })
  it('rejects unknown/duplicate resources, fields, subjects and unversioned content', () => {
    const invalid = [() => ({ ...envelope(), scopeEvidence: {} }), () => ({ ...envelope(), version: 'future' }),
      () => { const input = envelope(); input.resources.push(structuredClone(input.resources[0])); return input },
      () => { const input = envelope(); input.resources[0].fields.push('cost'); return input },
      () => { const input = envelope(); input.resources[0].subjects.push({ ...subject }); return input },
      () => { const input = envelope(); input.resources[0].resource.policyVersion = ''; return input },
      () => { const input = envelope(); (input.resources[0].labels as unknown as Record<string, unknown>).roles = ['owner']; return input }]
    for (const value of invalid) expect(() => parseSourceEnvelope(value())).toThrow('source_protocol_invalid')
    expect(() => parseSourceCapabilities({ ...capabilities, fieldEvidence: false })).toThrow('source_protocol_invalid')
    expect(() => parseSourceEnvelope({ ...envelope(), resources: [] })).toThrow('source_protocol_invalid')
  })
  it('requires explicit independently retained snapshot receipt and expiry', () => {
    const input = envelope(); input.resources[0].retention = { mode: 'released_snapshot', releaseId: 'independent-release', expiresAt: now + 60_000 }
    expect(parseSourceEnvelope(input)).toEqual(input)
    expect(() => parseSourceEnvelope({ ...input, resources: [{ ...input.resources[0], retention: { mode: 'released_snapshot' } }] })).toThrow()
    expect(() => parseSourceEnvelope({ ...input, resources: [{ ...input.resources[0], retention: { mode: 'governed', releaseId: 'invented-release' } }] })).toThrow()
  })
  it.each(['private:finance','team:unknown','project:unknown'])('refuses an unmapped or malformed native source label %s', label => {
    const input = envelope(); input.resources[0].labels.compartments = [label]
    expect(() => parseSourceEnvelope(input)).toThrow('source_protocol_invalid')
  })
  it('binds authorization to each operation/resource/version/field/action/recipient', () => {
    const input = request(), digest = sourceAuthorizationDigest(input), valid = response(input)
    expect(requireSourceAuthorization(valid, input, tenant, now)).toEqual(valid)
    for (const change of [() => { const next = request(); next.operationId = input.operationId; return next },
      () => ({ ...input, items: [{ ...input.items[0], fields: ['description'] }] }),
      () => ({ ...input, items: [{ ...input.items[0], resource: { ...ref, policyVersion: '13' } }] }),
      () => ({ ...input, recipients: [{ ...input.recipients[0], subject: { ...subject, id: randomUUID() } }] })]) {
      expect(sourceAuthorizationDigest(change())).not.toBe(digest)
    }
    expect(sourceAuthorizationDigest({ ...input, items: [{ ...input.items[0], fields: ['description','cost'] }] })).toBe(digest)
    expect(() => parseSourceAuthorizationResponse({ ...valid, tenant: 'foreign-tenant' }, input, tenant, now)).toThrow()
    expect(() => parseSourceAuthorizationResponse({ ...valid, operationId: randomUUID() }, input, tenant, now)).toThrow()
  })
  it('treats absent/denied decisions as denial and refuses unknown or duplicate pairs', () => {
    const input = request(), valid = response(input), denied = { ...valid, decisions: [{ itemId: input.items[0].itemId, recipientId: input.recipients[0].recipientId, allowed: false as const }] }
    expect(() => requireSourceAuthorization({ ...valid, decisions: [] }, input, tenant, now)).toThrow('source_access_denied')
    expect(() => requireSourceAuthorization(denied, input, tenant, now)).toThrow('source_access_denied')
    expect(() => parseSourceAuthorizationResponse({ ...valid, decisions: [valid.decisions[0],valid.decisions[0]] }, input, tenant, now)).toThrow()
    expect(() => parseSourceAuthorizationResponse({ ...valid, decisions: [{ ...valid.decisions[0], recipientId: randomUUID() }] }, input, tenant, now)).toThrow()
    expect(() => parseSourceAuthorizationRequest({ ...input, items: Array(101).fill(input.items[0]) })).toThrow()
    expect(() => parseSourceAuthorizationRequest({ ...input, recipients: [{ ...input.recipients[0] },{ ...input.recipients[0], recipientId: randomUUID() }] })).toThrow()
  })
  it.each([{ issuedAt: now, expiresAt: now + 5_001 }, { issuedAt: now + 1, expiresAt: now + 5_000 },
    { issuedAt: now - 5_000, expiresAt: now }, { issuedAt: now, expiresAt: Number.POSITIVE_INFINITY }])('rejects stale/future/unbounded receipts: %j', times => {
    const input = request(), valid = response(input), decision = valid.decisions[0]
    expect(() => parseSourceAuthorizationResponse({ ...valid, decisions: [{ ...decision, receipt: { id: 'opaque-proof', ...times } }] }, input, tenant, now)).toThrow()
  })
  it('reconciles without inventing an effect or accepting unscoped result evidence', () => {
    expect(parseSourceReconcileResponse({ version: 'ub.source.v1', tenant, state: 'uncertain' }, tenant).state).toBe('uncertain')
    expect(() => parseSourceReconcileResponse({ version: 'ub.source.v1', tenant, state: 'applied' }, tenant)).toThrow()
    expect(() => parseSourceReconcileResponse({ version: 'ub.source.v1', tenant, state: 'not_applied', receipt: 'invented' }, tenant)).toThrow()
    expect(() => parseSourceReconcileResponse({ version: 'ub.source.v1', tenant, state: 'applied', receipt: 'effect-1', evidence: { ...envelope(), tenant: 'foreign' } }, tenant)).toThrow()
  })
  function sidecar(endpoint: 'capabilities' | 'authorize' | 'reconcile', body: unknown) {
    const key = generateKeyPairSync('ed25519'), workspaceId = randomUUID(), connectorInstanceId = randomUUID(), issuer = 'https://brain.example', audience = 'https://source.example'
    const bytes = { method: 'POST', target: `/usebrian/source/${endpoint}`, body: Buffer.from(JSON.stringify(body)) }
    const actor: ConnectorActorClaims = { version: 'ub.actor.v1', iss: issuer, aud: audience, iat: now / 1000, nbf: now / 1000, exp: now / 1000 + 60,
      jti: randomBytes(24).toString('base64url'), workspaceId, connectorInstanceId, executingAssistantId: assistant, executionKind: 'attended', bindingRevision: '1',
      actor: { kind: 'human', userId: user, authenticationKind: 'native_session' }, request: connectorRequestBinding(bytes) }
    const signed = [Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: CONNECTOR_ACTOR_TYPE, kid: 'source_key' })).toString('base64url'), Buffer.from(JSON.stringify(actor)).toString('base64url')].join('.')
    const assertion = `${signed}.${sign(null, Buffer.from(signed), key.privateKey).toString('base64url')}`
    return { actor, input: { endpoint, request: bytes, assertion, authenticateTransport: vi.fn(async () => true), verifyActor: createConnectorActorVerifier({ issuer, audience,
      workspaceId, connectorInstanceId, trustedKey: async () => ({ key: key.publicKey }), now: () => now, consumeReplay: createBoundedConnectorReplayConsumer() }) } }
  }
  it('authenticates transport and verifies bound actor before source canonical callbacks; replay is denied', async () => {
    const input = request(), fixture = sidecar('authorize', input)
    const ports = { capabilities: vi.fn(async actor => { expect(sourceSubjectFromActor(actor)).toEqual(subject); return capabilities }),
      authorize: vi.fn(async (actor, body) => { expect(actor).toEqual(fixture.actor); expect(body).toEqual(input); return response(body) }), reconcile: vi.fn(), now: () => now }
    expect(await handleSourceSidecar(fixture.input, ports)).toEqual(expect.objectContaining({ operationId: input.operationId }))
    await expect(handleSourceSidecar(fixture.input, ports)).rejects.toMatchObject({ code: 'assertion_replayed' })
    expect(ports.authorize).toHaveBeenCalledTimes(1)
    const other = sidecar('authorize', input); other.input.authenticateTransport.mockResolvedValue(false)
    await expect(handleSourceSidecar(other.input, ports)).rejects.toMatchObject({ code: 'transport_unauthorized' })
    expect(ports.capabilities).toHaveBeenCalledTimes(1)
  })
  it('refuses authenticated but unmapped subjects and keeps uncertain effects explicit', async () => {
    const fixture = sidecar('capabilities', { version: 'ub.source.v1' }), authorize = vi.fn(), reconcile = vi.fn()
    await expect(handleSourceSidecar(fixture.input, { capabilities: async () => null, authorize, reconcile })).rejects.toMatchObject({ code: 'source_access_denied' })
    expect(authorize).not.toHaveBeenCalled(); expect(reconcile).not.toHaveBeenCalled()
    const effect = sidecar('reconcile', { version: 'ub.source.v1', idempotencyKey: 'command-1' })
    await expect(handleSourceSidecar(effect.input, { capabilities: async () => capabilities, authorize, reconcile: async () => { throw new Error('private provider failure') } })).rejects.toMatchObject({ code: 'source_effect_uncertain' })
  })
  it('emits an explicit denial for every omitted canonical callback decision', async () => {
    const input = request(), fixture = sidecar('authorize', input)
    expect(await handleSourceSidecar(fixture.input, { capabilities: async () => capabilities, reconcile: vi.fn(), now: () => now,
      authorize: async () => ({ version: 'ub.source.v1', tenant, operationId: input.operationId, decisions: [] }) })).toMatchObject({
      decisions: [{ itemId: input.items[0].itemId, recipientId: input.recipients[0].recipientId, allowed: false }],
    })
  })
})
