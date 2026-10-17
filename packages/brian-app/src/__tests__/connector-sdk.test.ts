import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { authorizeConnectorRequest, CONNECTOR_ACTOR_TYPE, connectorRequestBinding, createBoundedConnectorReplayConsumer,
  createConnectorActorVerifier, parseConnectorActorClaims, type ConnectorActorClaims } from '../connector.js'

describe('[COMP:shared/brian-app-sdk] source actor verifier', () => {
  const key = generateKeyPairSync('ed25519'), workspaceId = randomUUID(), connectorInstanceId = randomUUID(), executingAssistantId = randomUUID()
  const issuer = 'https://installation.example', audience = 'https://source.example/mcp', now = 1_800_000_000
  const request = { method: 'POST', target: '/mcp?tenant=one%2Ftwo&x=%2f', body: Buffer.from('{"jsonrpc":"2.0","method":"tools/call","params":{"arguments":{"name":"日本語"}}}') }
  function claims(patch: Partial<ConnectorActorClaims> = {}): ConnectorActorClaims {
    return { version: 'ub.actor.v1', iss: issuer, aud: audience, iat: now, nbf: now, exp: now + 60, jti: randomBytes(24).toString('base64url'),
      workspaceId, connectorInstanceId, executingAssistantId, executionKind: 'attended', bindingRevision: '4',
      actor: { kind: 'human', userId: randomUUID(), authenticationKind: 'native_session' }, request: connectorRequestBinding(request), ...patch }
  }
  function token(payload: unknown, header: unknown = { alg: 'EdDSA', typ: CONNECTOR_ACTOR_TYPE, kid: 'key_one' }, privateKey = key.privateKey) {
    const encoded = [header, payload].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.')
    return `${encoded}.${sign(null, Buffer.from(encoded), privateKey).toString('base64url')}`
  }
  function verifier(overrides: Partial<Parameters<typeof createConnectorActorVerifier>[0]> = {}) {
    return createConnectorActorVerifier({ issuer, audience, workspaceId, connectorInstanceId, now: () => now * 1000,
      trustedKey: async kid => kid === 'key_one' ? { key: key.publicKey } : null,
      consumeReplay: createBoundedConnectorReplayConsumer(), ...overrides })
  }
  it('verifies exact UTF-8 bytes and encoded path/query, freezes identity, and consumes one replay ID', async () => {
    const verify = verifier(), payload = claims(), signed = token(payload)
    const result = await verify(signed, request)
    expect(result).toEqual(payload); expect(Object.isFrozen(result.actor)).toBe(true)
    await expect(verify(signed, request)).rejects.toMatchObject({ code: 'assertion_replayed' })
    expect(() => { result.request.target = '/other' }).toThrow()
  })
  it.each([
    ['issuer', () => ({ iss: 'https://other.example' })], ['audience', () => ({ aud: 'https://other.example/mcp' })],
    ['workspace', () => ({ workspaceId: randomUUID() })], ['instance', () => ({ connectorInstanceId: randomUUID() })],
    ['expired', () => ({ iat: now - 65, nbf: now - 65, exp: now - 5 })],
    ['future', () => ({ iat: now + 6, nbf: now + 6, exp: now + 66 })],
    ['long lifetime', () => ({ exp: now + 61 })], ['unbound not-before', () => ({ nbf: now - 1 })],
    ['unknown payload key', () => ({ roles: ['owner'] })], ['invalid revision', () => ({ bindingRevision: '0' })],
  ] as const)('denies %s', async (_name, patch) => {
    await expect(verifier()(token(claims(patch())), request)).rejects.toMatchObject({ code: 'assertion_invalid' })
  })
  it.each([
    { alg: 'HS256', typ: CONNECTOR_ACTOR_TYPE, kid: 'key_one' }, { alg: 'none', typ: CONNECTOR_ACTOR_TYPE, kid: 'key_one' },
    { alg: 'EdDSA', typ: 'JWT', kid: 'key_one' }, { alg: 'EdDSA', typ: CONNECTOR_ACTOR_TYPE, kid: 'unknown' },
    { alg: 'EdDSA', typ: CONNECTOR_ACTOR_TYPE, kid: 'key_one', jku: 'https://attacker.example/keys' },
    { alg: 'EdDSA', typ: CONNECTOR_ACTOR_TYPE, kid: 'key_one', x5u: 'https://attacker.example/cert' },
  ])('pins algorithm, type and out-of-band key ID: %j', async header => {
    await expect(verifier()(token(claims(), header), request)).rejects.toMatchObject({ code: 'assertion_invalid' })
  })
  it('rejects forged signatures and user/assistant swaps without consuming valid tokens', async () => {
    const verify = verifier(), payload = claims(), signed = token(payload), parts = signed.split('.')
    for (const changed of [{ ...payload, executingAssistantId: randomUUID() }, { ...payload, actor: { ...payload.actor, userId: randomUUID() } }]) {
      const forged = `${parts[0]}.${Buffer.from(JSON.stringify(changed)).toString('base64url')}.${parts[2]}`
      await expect(verify(forged, request)).rejects.toMatchObject({ code: 'assertion_invalid' })
    }
    await expect(verify(token(payload, undefined, generateKeyPairSync('ed25519').privateKey), request)).rejects.toMatchObject({ code: 'assertion_invalid' })
    expect(await verify(signed, request)).toEqual(payload)
  })
  it('rejects body, method, encoding or query changes while preserving replay admission for the exact request', async () => {
    const verify = verifier(), signed = token(claims())
    for (const changed of [{ ...request, method: 'GET' }, { ...request, target: request.target.replace('%2f', '%2F') },
      { ...request, target: '/mcp?x=%2f&tenant=one%2Ftwo' }, { ...request, body: Buffer.from(request.body.toString() + ' ') }]) {
      await expect(verify(signed, changed)).rejects.toMatchObject({ code: 'assertion_invalid' })
    }
    expect(await verify(signed, request)).toBeDefined()
  })
  it('requires canonical compact encoding and rejects duplicate keys or whitespace ambiguity', async () => {
    const payload = claims(), head = Buffer.from('{"alg":"none","alg":"EdDSA","typ":"ub-connector-actor+jwt","kid":"key_one"}').toString('base64url')
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url'), data = `${head}.${body}`
    await expect(verifier()(`${data}.${sign(null, Buffer.from(data), key.privateKey).toString('base64url')}`, request)).rejects.toMatchObject({ code: 'assertion_invalid' })
    const signed = token(payload)
    await expect(verifier()(signed + '=', request)).rejects.toMatchObject({ code: 'assertion_invalid' })
  })
  it('accepts retired public keys for the last assertion window but denies revoked, wrong-type and invalid-time keys', async () => {
    const signed = token(claims())
    expect(await verifier({ trustedKey: async () => ({ key: key.publicKey, notBefore: now - 10, notAfter: now + 60 }) })(signed, request)).toBeDefined()
    for (const trusted of [{ key: key.publicKey, revoked: true }, { key: key.privateKey },
      { key: generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey }, { key: key.publicKey, notAfter: now + 59 },
      { key: key.publicKey, notBefore: now + 1 }, { key: key.publicKey, notBefore: NaN }]) {
      await expect(verifier({ trustedKey: async () => trusted })(signed, request)).rejects.toMatchObject({ code: 'assertion_invalid' })
    }
  })
  it('rechecks expiry after asynchronous key or replay storage work', async () => {
    let elapsed = 0
    const signed = token(claims())
    const verify = verifier({ now: () => (now + elapsed) * 1000, trustedKey: async () => { elapsed = 65; return { key: key.publicKey } } })
    await expect(verify(signed, request)).rejects.toMatchObject({ code: 'assertion_invalid' })
    elapsed = 0
    const replay = verifier({ now: () => (now + elapsed) * 1000, consumeReplay: async () => { elapsed = 65; return true } })
    await expect(replay(signed, request)).rejects.toMatchObject({ code: 'assertion_invalid' })
  })
  it('consumes atomically across concurrent calls and refuses unexpired capacity exhaustion', async () => {
    let clock = now
    const verify = verifier({ consumeReplay: createBoundedConnectorReplayConsumer(1), now: () => clock * 1000 }), signed = token(claims())
    const results = await Promise.allSettled([verify(signed, request), verify(signed, request)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    await expect(verify(token(claims()), request)).rejects.toMatchObject({ code: 'assertion_unavailable' })
    clock += 65
    expect(await verify(token(claims({ iat: clock, nbf: clock, exp: clock + 60 })), request)).toBeDefined()
    expect(() => createConnectorActorVerifier({ issuer, audience, workspaceId, connectorInstanceId, clockSkewSeconds: 6,
      trustedKey: async () => null, consumeReplay: createBoundedConnectorReplayConsumer() })).toThrow()
  })
  it('separates service identity from humans and requires complete explicit delegation', () => {
    const service = claims({ executionKind: 'system', actor: { kind: 'service', serviceUserId: randomUUID() } })
    expect(parseConnectorActorClaims(service)).toEqual(service)
    expect(() => parseConnectorActorClaims({ ...service, actor: { ...service.actor, userId: randomUUID() } })).toThrow()
    const actorId = randomUUID(), delegation = { initiatorUserId: randomUUID(), effectiveActorUserId: actorId, delegatorUserId: randomUUID(), delegationId: randomUUID() }
    const delegated = claims({ executionKind: 'delegated', actor: { kind: 'human', userId: actorId, authenticationKind: 'delegation' }, delegation })
    expect(parseConnectorActorClaims(delegated)).toEqual(delegated)
    expect(() => parseConnectorActorClaims({ ...delegated, delegation: { ...delegation, effectiveActorUserId: randomUUID() } })).toThrow()
    expect(() => parseConnectorActorClaims({ ...delegated, delegation: undefined })).toThrow()
  })
  it('authenticates transport first, then requires the source current canonical grant and mapping', async () => {
    const verify = vi.fn(verifier()), authorize = vi.fn().mockResolvedValue({ allowed: false })
    const base = { assertion: token(claims()), request, verifyActor: verify, authorize }
    await expect(authorizeConnectorRequest({ ...base, authenticateTransport: async () => false })).rejects.toMatchObject({ code: 'transport_unauthorized' })
    expect(verify).not.toHaveBeenCalled(); expect(authorize).not.toHaveBeenCalled()
    await expect(authorizeConnectorRequest({ ...base, authenticateTransport: async () => true })).rejects.toMatchObject({ code: 'source_access_denied' })
    expect(authorize).toHaveBeenCalledTimes(1)
    authorize.mockResolvedValue({ allowed: true, value: { id: 'source-order', fields: ['title'] } })
    expect((await authorizeConnectorRequest({ ...base, assertion: token(claims()), authenticateTransport: async () => true })).value).toEqual({ id: 'source-order', fields: ['title'] })
  })
})
