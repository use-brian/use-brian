import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createExecutionContext } from '@use-brian/core'
import { CONNECTOR_ACTOR_HEADER, createBoundedConnectorReplayConsumer, createConnectorActorVerifier, SOURCE_PROTOCOL_VERSION,
  type SourceAuthorizationRequest } from '@use-brian/brian-app/connector'
import { createSourceAccessClient, trustedSourceOperationProof, type SourceAccessProfile } from '../source-access.js'
import type { ConnectorActorMintingPorts } from '../connector-actor-context.js'

describe('[COMP:api/external-source-access] authenticated sidecar coordinator', () => {
  const key = generateKeyPairSync('ed25519'), userId = randomUUID(), workspaceId = randomUUID(), assistantId = randomUUID(), instanceId = randomUUID()
  const now = 1_800_000_000_000
  function fixture() {
    const assertCurrent = vi.fn(async () => {}), controller = new AbortController()
    const execution = createExecutionContext({ identity: { kind: 'attended', principal: { kind: 'workspace_member', userId } },
      ownership: { kind: 'workspace', workspaceId }, access: { workspaceId, userId, assistantId, assistantKind: 'primary', clearance: 'internal',
        compartments: [], mutationCompartments: [], projectIds: [], visibilityAssistantIds: [] },
      authority: { assertCurrent, execute: async operation => operation() }, writeDefaults: { compartments: [], projectIds: [] },
      lifecycle: { sessionId: randomUUID(), channelId: 'fixture', channelType: 'web', abortSignal: controller.signal } })
    const profile: SourceAccessProfile = { issuer: 'https://brain.example', audience: 'https://source.example', workspaceId,
      connectorInstanceId: instanceId, mcpUrl: 'https://source.example/mcp', sourceBaseUrl: 'https://source.example', tenant: 'synthetic-tenant',
      bindingRevision: '3', subject: { kind: 'human', id: userId, executingAssistantId: assistantId } }
    const ports: ConnectorActorMintingPorts = { now: () => now, admit: vi.fn(async () => ({ bindingRevision: '3',
      actor: { kind: 'human' as const, userId, authenticationKind: 'native_session' as const } })), loadActiveKey: async () => ({
      kid: 'source_key', privateKey: key.privateKey, notBefore: now / 1000 - 1 }), keyCurrent: async () => true }
    const verify = createConnectorActorVerifier({ issuer: profile.issuer, audience: profile.audience, workspaceId, connectorInstanceId: instanceId,
      now: () => now, consumeReplay: createBoundedConnectorReplayConsumer(), trustedKey: async () => ({ key: key.publicKey }) })
    const received: string[] = []
    const respond = vi.fn<(request: SourceAuthorizationRequest) => unknown>(request => ({ version: SOURCE_PROTOCOL_VERSION, tenant: profile.tenant,
      operationId: request.operationId, decisions: request.items.flatMap(item => request.recipients.map(recipient => ({ itemId: item.itemId,
        recipientId: recipient.recipientId, allowed: true, receipt: { id: randomUUID(), issuedAt: now, expiresAt: now + 5_000 } }))) }))
    const fetch = vi.fn(async (target: string | URL, init?: RequestInit) => {
      const url = new URL(target), headers = new Headers(init?.headers), bytes = Buffer.from(init?.body as Uint8Array)
      const actor = await verify(headers.get(CONNECTOR_ACTOR_HEADER)!, { method: init!.method!, target: `${url.pathname}${url.search}`, body: bytes })
      expect(actor.actor).toMatchObject({ userId }); expect(actor.executingAssistantId).toBe(assistantId)
      expect(headers.get('authorization')).toBe('Bearer synthetic-transport'); expect(init?.redirect).toBe('manual')
      received.push(actor.jti)
      return new Response(JSON.stringify(respond(JSON.parse(bytes.toString()) as SourceAuthorizationRequest)), { headers: { 'Content-Type': 'application/json' } })
    })
    const options = { headers: { Authorization: 'Bearer synthetic-transport' }, fetch, now: () => now }
    return { execution, profile, ports, received, fetch, respond, assertCurrent, controller, client: createSourceAccessClient(execution, profile, ports, options), options }
  }
  function request(): SourceAuthorizationRequest {
    return { version: SOURCE_PROTOCOL_VERSION, operationId: randomUUID(), items: [{ itemId: randomUUID(), resource: { type: 'case', id: 'fixture-1',
      contentVersion: '5', policyVersion: '2' }, fields: ['description'], action: 'context', retentionMode: 'governed' }],
      recipients: [{ recipientId: randomUUID(), subject: { kind: 'human', id: userId, executingAssistantId: assistantId } }] }
  }
  it('checks each protected boundary with fresh bound assertions and nonserializable proof authority', async () => {
    const f = fixture(), input = request(), first = await f.client.authorize(input), second = await f.client.authorize(input)
    expect(f.received).toHaveLength(2); expect(f.received[0]).not.toBe(f.received[1])
    expect(first.requestDigest).toBe(second.requestDigest)
    expect(trustedSourceOperationProof(first, f.execution)?.proof).toEqual(first)
    expect(trustedSourceOperationProof(structuredClone(first), f.execution)).toBeUndefined()
    first.request.items[0].fields.push('hidden')
    expect(trustedSourceOperationProof(first, f.execution)?.proof.request.items[0].fields).toEqual(['description'])
    expect(f.fetch.mock.calls.every(([url]) => String(url) === 'https://source.example/usebrian/source/authorize')).toBe(true)
  })
  it('refuses tenant/operation/field authority mismatches, missing decisions and observed binding changes', async () => {
    const f = fixture(), input = request()
    f.respond.mockImplementation(body => ({ version: SOURCE_PROTOCOL_VERSION, tenant: f.profile.tenant, operationId: body.operationId, decisions: [] }))
    await expect(f.client.authorize(input)).rejects.toMatchObject({ code: 'source_access_denied' })
    f.respond.mockImplementation(body => ({ version: SOURCE_PROTOCOL_VERSION, tenant: 'foreign', operationId: body.operationId, decisions: [] }))
    await expect(f.client.authorize(input)).rejects.toMatchObject({ code: 'source_protocol_invalid' })
    vi.mocked(f.ports.admit).mockResolvedValue({ bindingRevision: '4', actor: { kind: 'human', userId, authenticationKind: 'native_session' } })
    const count = f.fetch.mock.calls.length
    await expect(f.client.authorize(input)).rejects.toMatchObject({ code: 'source_unavailable' })
    expect(f.fetch).toHaveBeenCalledTimes(count)
  })
  it('withholds after local authority contracts while the authenticated response body is arriving', async () => {
    const f = fixture()
    f.respond.mockImplementation(() => { f.assertCurrent.mockRejectedValue(new Error('revoked')); return {} })
    await expect(f.client.authorize(request())).rejects.toMatchObject({ code: 'source_unavailable' })
  })
  it('pins sidecar origin/path before network and does not forward transport or assertions through redirects', async () => {
    const f = fixture()
    expect(() => createSourceAccessClient(f.execution, { ...f.profile, sourceBaseUrl: 'https://other.example' }, f.ports, f.options)).toThrow('source_unavailable')
    expect(() => createSourceAccessClient(f.execution, { ...f.profile, sourceBaseUrl: 'https://source.example?redirect=foreign' }, f.ports, f.options)).toThrow('source_unavailable')
    f.fetch.mockImplementation(async () => new Response(null, { status: 307, headers: { Location: 'https://other.example' } }))
    await expect(f.client.authorize(request())).rejects.toMatchObject({ code: 'source_unavailable' })
    expect(f.fetch).toHaveBeenCalledTimes(1)
  })
  it('keeps unknown effect outcomes explicit without retrying the command', async () => {
    const f = fixture(); f.fetch.mockRejectedValue(new Error('network unavailable'))
    await expect(f.client.reconcile({ version: SOURCE_PROTOCOL_VERSION, idempotencyKey: 'effect-1' })).rejects.toMatchObject({ code: 'source_effect_uncertain' })
    expect(f.fetch).toHaveBeenCalledTimes(1)
  })
})
