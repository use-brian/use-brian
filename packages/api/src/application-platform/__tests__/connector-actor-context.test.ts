import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createExecutionContext, type CreateExecutionContextInput } from '@use-brian/core'
import { createConnectorActorVerifier, createBoundedConnectorReplayConsumer } from '@use-brian/brian-app/connector'
import { mintConnectorActorAssertion, type ConnectorActorMintingPorts } from '../connector-actor-context.js'
import { createConnectorActorFetch } from '../connector-actor-transport.js'
import { actorIdentityHeaders, buildConnectorAuthHeaders, mergeHostConnectorIdentityHeaders, mergeValidatedHeaders } from '../../mcp/auth-headers.js'

describe('[COMP:api/connector-actor-context] host minting and dispatch', () => {
  const userId = randomUUID(), workspaceId = randomUUID(), assistantId = randomUUID(), instance = randomUUID()
  const binding = { issuer: 'https://installation.example', audience: 'https://source.example/mcp', workspaceId, connectorInstanceId: instance }
  const key = generateKeyPairSync('ed25519'), now = 1_800_000_000
  const request = { method: 'POST', target: '/mcp', body: Buffer.from('{"method":"tools/list"}') }
  function execution(identity: CreateExecutionContextInput['identity'] = { kind: 'attended', principal: { kind: 'workspace_member', userId } }) {
    const assertCurrent = vi.fn().mockResolvedValue(undefined)
    return createExecutionContext({ identity, ownership: { kind: 'workspace', workspaceId },
      access: { workspaceId, userId, assistantId, assistantKind: 'primary', clearance: 'internal', compartments: [], mutationCompartments: [], projectIds: [], visibilityAssistantIds: [] },
      authority: { assertCurrent, execute: async operation => operation() }, writeDefaults: { compartments: [], projectIds: [] },
      lifecycle: { sessionId: randomUUID(), channelId: 'fixture', channelType: 'web', abortSignal: new AbortController().signal } })
  }
  function ports(): ConnectorActorMintingPorts {
    return { now: () => now * 1000, admit: vi.fn().mockResolvedValue({ bindingRevision: '3', actor: { kind: 'human', userId, authenticationKind: 'native_session' } }),
      loadActiveKey: vi.fn().mockResolvedValue({ kid: 'key_one', privateKey: key.privateKey, notBefore: now - 1 }), keyCurrent: vi.fn().mockResolvedValue(true) }
  }
  function verifier() { return createConnectorActorVerifier({ issuer: binding.issuer, audience: binding.audience, workspaceId, connectorInstanceId: instance,
    now: () => now * 1000, trustedKey: async () => ({ key: key.publicKey }), consumeReplay: createBoundedConnectorReplayConsumer() }) }
  it('signs actual initiator/assistant and a fresh replay ID for each exact request', async () => {
    const context = execution(), provider = ports(), verify = verifier()
    const first = await verify(await mintConnectorActorAssertion(context, binding, request, provider), request)
    const second = await verify(await mintConnectorActorAssertion(context, binding, request, provider), request)
    expect(first).toMatchObject({ workspaceId, connectorInstanceId: instance, executingAssistantId: assistantId, actor: { kind: 'human', userId } })
    expect(first.jti).not.toBe(second.jti); expect(provider.admit).toHaveBeenCalledTimes(4)
  })
  it('denies substituted actors, namespaces, workspaces, missing proof and changed admission before signing', async () => {
    const context = execution(), provider = ports()
    await expect(mintConnectorActorAssertion(context, { ...binding, workspaceId: randomUUID() }, request, provider)).rejects.toMatchObject({ code: 'access_unavailable' })
    for (const actor of [{ kind: 'human', userId: randomUUID(), authenticationKind: 'native_session' }, { kind: 'service', serviceUserId: userId }]) {
      provider.admit = vi.fn().mockResolvedValue({ bindingRevision: '3', actor })
      await expect(mintConnectorActorAssertion(context, binding, request, provider)).rejects.toMatchObject({ code: 'access_unavailable' })
    }
    provider.admit = vi.fn().mockResolvedValueOnce({ bindingRevision: '3', actor: { kind: 'human', userId, authenticationKind: 'native_session' } }).mockResolvedValueOnce(null)
    await expect(mintConnectorActorAssertion(context, binding, request, provider)).rejects.toMatchObject({ code: 'access_unavailable' })
    const programmatic = execution({ kind: 'programmatic', principal: { kind: 'application', credentialId: randomUUID(), actorUserId: userId,
      applicationId: randomUUID(), subjectKind: 'member' }, credentialOwnerUserId: randomUUID() })
    await expect(mintConnectorActorAssertion(programmatic, binding, request, ports())).rejects.toMatchObject({ code: 'access_unavailable' })
  })
  it('keeps system services distinct and refuses a fictitious initiating human', async () => {
    const context = execution({ kind: 'system', purpose: 'workflow', jobId: randomUUID() }), provider = ports()
    await expect(mintConnectorActorAssertion(context, binding, request, provider)).rejects.toMatchObject({ code: 'access_unavailable' })
    provider.admit = async () => ({ bindingRevision: '2', actor: { kind: 'service', serviceUserId: userId } })
    expect((await verifier()(await mintConnectorActorAssertion(context, binding, request, provider), request)).actor).toEqual({ kind: 'service', serviceUserId: userId })
  })
  it('rechecks current key and immutable authority after admission/decryption awaits', async () => {
    const provider = ports(), context = execution()
    provider.keyCurrent = async () => false
    await expect(mintConnectorActorAssertion(context, binding, request, provider)).rejects.toMatchObject({ code: 'access_unavailable' })
    const changed = ports(); changed.loadActiveKey = async () => {
      vi.mocked(context.security.authority.assertCurrent).mockRejectedValue(new Error('authority revoked'))
      return { kid: 'key_one', privateKey: key.privateKey, notBefore: now - 1 }
    }
    await expect(mintConnectorActorAssertion(context, binding, request, changed)).rejects.toThrow('authority revoked')
  })
  it('refuses a key retired during the final native authority await', async () => {
    const context = execution(), provider = ports()
    let keyActive = true, checks = 0
    vi.mocked(context.security.authority.assertCurrent).mockImplementation(async () => { if (++checks === 2) keyActive = false })
    provider.keyCurrent = async () => keyActive
    await expect(mintConnectorActorAssertion(context, binding, request, provider)).rejects.toMatchObject({ code: 'access_unavailable' })
  })
  it('signs the final serialized bytes after header merges and pins both actor and assistant readable IDs', async () => {
    const received: Array<{ init: RequestInit; assertion: string }> = [], verify = verifier()
    const send = createConnectorActorFetch(execution(), binding.audience, binding, ports(), { fetch: async (_url, init) => {
      const headers = new Headers(init!.headers), assertion = headers.get('X-UseBrian-Actor-Assertion')!
      received.push({ init: init!, assertion })
      expect(await verify(assertion, { method: init!.method!, target: '/mcp', body: Buffer.from(init!.body as Uint8Array) })).toMatchObject({ actor: { userId }, executingAssistantId: assistantId })
      expect(headers.get('Authorization')).toBe('Bearer separate-transport-credential')
      expect(headers.get('X-UseBrian-User-Id')).toBe(userId); expect(headers.get('X-UseBrian-Assistant-Id')).toBe(assistantId)
      expect(init!.redirect).toBe('manual')
      return new Response('{}')
    } })
    const headers = { Authorization: 'Bearer separate-transport-credential', 'X-UseBrian-Actor-Assertion': 'forged', 'X-Sidanclaw-User-Id': 'forged', 'X-UseBrian-Assistant-Id': 'forged' }
    await send(binding.audience, { method: 'POST', headers, body: '{"name":"日本語","method":"tools/call"}' })
    await send(binding.audience, { method: 'POST', headers, body: '{"name":"日本語","method":"tools/call"}' })
    expect(received[0].assertion).not.toBe(received[1].assertion)
  })
  it('never forwards credentials/assertions to another target or follows redirects and rejects unserialized streams', async () => {
    const network = vi.fn().mockResolvedValue(new Response(null, { status: 307, headers: { Location: 'https://other.example' } }))
    const send = createConnectorActorFetch(execution(), binding.audience, binding, ports(), { fetch: network })
    await expect(send('https://other.example/mcp', { headers: { Authorization: 'secret' } })).rejects.toMatchObject({ code: 'access_unavailable' })
    expect(network).not.toHaveBeenCalled()
    await expect(send(binding.audience, { method: 'POST', body: new URLSearchParams({ data: 'x' }) })).rejects.toMatchObject({ code: 'invalid_value' })
    expect(network).not.toHaveBeenCalled()
    await expect(send(binding.audience)).rejects.toMatchObject({ code: 'source_unavailable' })
    expect(network).toHaveBeenCalledTimes(1)
  })
  it('withholds returned content when authority contracts during the network await', async () => {
    const context = execution(), send = createConnectorActorFetch(context, binding.audience, binding, ports(), { fetch: async () => {
      vi.mocked(context.security.authority.assertCurrent).mockRejectedValue(new Error('authority revoked'))
      return new Response('protected bytes')
    } })
    await expect(send(binding.audience)).rejects.toThrow('authority revoked')
  })
  it('reserves identity/assertion namespaces from stored auth and hook overrides but retains transport auth', () => {
    expect(buildConnectorAuthHeaders({ type: 'custom_header', header: 'x-usebrian-actor-assertion', value: 'forged' })).toEqual({})
    const host = mergeHostConnectorIdentityHeaders({ Authorization: 'Bearer transport' }, actorIdentityHeaders({ channel: 'web', userId, assistantId }))
    const merged = mergeValidatedHeaders(host, { authorization: 'Bearer upstream', 'x-usebrian-user-id': 'forged', 'X-Sidanclaw-Assistant-Id': 'forged' })!
    expect(merged['X-UseBrian-User-Id']).toBe(userId); expect(merged['X-Sidanclaw-Assistant-Id']).toBe(assistantId)
    expect(merged.authorization).toBe('Bearer upstream')
  })
})
