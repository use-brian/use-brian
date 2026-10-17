/** Node-only source identity verifier. Source business authority stays in its own callback. */
import { createHash, verify, type KeyObject } from 'node:crypto'

export const CONNECTOR_ACTOR_HEADER = 'X-UseBrian-Actor-Assertion'
export const CONNECTOR_ACTOR_TYPE = 'ub-connector-actor+jwt'
export const CONNECTOR_ACTOR_VERSION = 'ub.actor.v1'
export const CONNECTOR_ACTOR_LIFETIME_SECONDS = 60

export type ConnectorActor =
  | { kind: 'human'; userId: string; authenticationKind: 'native_session' | 'verified_channel' | 'application_oauth' | 'delegation' }
  | { kind: 'service'; serviceUserId: string }
export type ConnectorActorClaims = {
  version: typeof CONNECTOR_ACTOR_VERSION
  iss: string
  aud: string
  iat: number
  nbf: number
  exp: number
  jti: string
  workspaceId: string
  connectorInstanceId: string
  executingAssistantId: string
  executionKind: 'attended' | 'programmatic' | 'delegated' | 'system'
  bindingRevision: string
  actor: ConnectorActor
  delegation?: { initiatorUserId: string; effectiveActorUserId: string; delegatorUserId: string; delegationId: string }
  request: { method: string; target: string; bodySha256: string }
}
export type ConnectorRequestBytes = { method: string; target: string; body: Uint8Array }
export type ConnectorActorErrorCode = 'assertion_invalid' | 'assertion_replayed' | 'assertion_unavailable'
  | 'transport_unauthorized' | 'source_access_denied'
export class ConnectorActorError extends Error {
  constructor(readonly code: ConnectorActorErrorCode) { super(code); this.name = 'ConnectorActorError' }
}
function invalid(): never { throw new ConnectorActorError('assertion_invalid') }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const encoded = /^[A-Za-z0-9_-]+$/
const isString = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximum
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const record = value as Record<string, unknown>
  if (required.some(key => !Object.hasOwn(record, key)) || Object.keys(record).some(key => !required.includes(key) && !optional.includes(key))) return invalid()
  return record
}
function identifier(value: unknown): asserts value is string { if (typeof value !== 'string' || !uuid.test(value)) invalid() }
function httpsIdentity(value: unknown): asserts value is string {
  if (!isString(value, 2048)) invalid()
  let url: URL
  try { url = new URL(value) } catch { return invalid() }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) invalid()
}

/** Strict protocol parser shared by the host signer and source verifier. No roles or token-selected URLs. */
export function parseConnectorActorClaims(value: unknown): ConnectorActorClaims {
  const record = object(value, ['version','iss','aud','iat','nbf','exp','jti','workspaceId','connectorInstanceId',
    'executingAssistantId','executionKind','bindingRevision','actor','request'], ['delegation'])
  if (record.version !== CONNECTOR_ACTOR_VERSION) invalid()
  httpsIdentity(record.iss); httpsIdentity(record.aud)
  for (const key of ['workspaceId','connectorInstanceId','executingAssistantId']) identifier(record[key])
  for (const key of ['iat','nbf','exp']) if (!Number.isSafeInteger(record[key]) || Number(record[key]) < 0) invalid()
  if (record.nbf !== record.iat || Number(record.exp) - Number(record.iat) !== CONNECTOR_ACTOR_LIFETIME_SECONDS) invalid()
  if (!isString(record.jti, 128) || !encoded.test(record.jti) || record.jti.length < 16) invalid()
  if (!isString(record.bindingRevision, 128) || !/^[1-9][0-9]*$/.test(record.bindingRevision)) invalid()
  if (!['attended','programmatic','delegated','system'].includes(String(record.executionKind))) invalid()
  const actor = object(record.actor, ['kind'], ['userId','authenticationKind','serviceUserId'])
  if (actor.kind === 'human') {
    object(actor, ['kind','userId','authenticationKind']); identifier(actor.userId)
    if (!['native_session','verified_channel','application_oauth','delegation'].includes(String(actor.authenticationKind))) invalid()
    if (record.executionKind === 'system') invalid()
  } else if (actor.kind === 'service') {
    object(actor, ['kind','serviceUserId']); identifier(actor.serviceUserId)
    if (record.executionKind === 'attended' || record.executionKind === 'delegated' || record.delegation !== undefined) invalid()
  } else invalid()
  if (record.executionKind === 'delegated') {
    const delegation = object(record.delegation, ['initiatorUserId','effectiveActorUserId','delegatorUserId','delegationId'])
    for (const value of Object.values(delegation)) identifier(value)
    if (actor.kind !== 'human' || actor.userId !== delegation.effectiveActorUserId || actor.authenticationKind !== 'delegation') invalid()
  } else if (record.delegation !== undefined || actor.authenticationKind === 'delegation') invalid()
  const request = object(record.request, ['method','target','bodySha256'])
  if (!isString(request.method, 32) || !/^[A-Z]+$/.test(request.method)
    || !isString(request.target, 8192) || !request.target.startsWith('/') || /[\s#\r\n]/.test(request.target)
    || !isString(request.bodySha256, 43) || !encoded.test(request.bodySha256) || request.bodySha256.length !== 43
    || Buffer.from(request.bodySha256, 'base64url').toString('base64url') !== request.bodySha256) invalid()
  return structuredClone(record) as ConnectorActorClaims
}

export function connectorRequestBinding(request: ConnectorRequestBytes): ConnectorActorClaims['request'] {
  return { method: request.method.toUpperCase(), target: request.target,
    bodySha256: createHash('sha256').update(request.body).digest('base64url') }
}
export type ConnectorReplayConsumer = (entry: { key: string; expiresAt: number; now: number }) => Promise<boolean>
/** Single-process only. Clustered sources provide a shared atomic consumer with the same expiry contract. */
export function createBoundedConnectorReplayConsumer(maximumEntries = 10_000): ConnectorReplayConsumer {
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1 || maximumEntries > 1_000_000) throw new RangeError('Invalid replay capacity')
  const entries = new Map<string, number>()
  return async ({ key, expiresAt, now }) => {
    if (!isString(key, 128) || !Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(now) || expiresAt <= now) return false
    for (const [existing, expiration] of entries) if (expiration <= now) entries.delete(existing)
    if (entries.has(key)) return false
    if (entries.size >= maximumEntries) throw new ConnectorActorError('assertion_unavailable')
    // No await between check and insert; callers with multiple processes use a shared atomic store.
    entries.set(key, expiresAt)
    return true
  }
}
export type TrustedConnectorActorKey = {
  key: KeyObject
  revoked?: boolean
  /** Unix seconds. This key must cover the complete assertion lifetime. */
  notBefore?: number
  notAfter?: number
}
export type ConnectorActorVerifierOptions = {
  issuer: string
  audience: string
  workspaceId: string
  connectorInstanceId: string
  clockSkewSeconds?: number
  now?: () => number
  trustedKey: (kid: string) => Promise<TrustedConnectorActorKey | null>
  consumeReplay: ConnectorReplayConsumer
}
function decode(part: string): unknown {
  if (!encoded.test(part) || Buffer.from(part, 'base64url').toString('base64url') !== part) return invalid()
  try {
    const bytes = Buffer.from(part, 'base64url'), value: unknown = JSON.parse(bytes.toString('utf8'))
    // JSON.stringify preserves the parsed property order; rejecting re-encoding changes also rejects
    // duplicate keys, whitespace variants and invalid UTF-8 rather than interpreting ambiguous claims.
    if (Buffer.from(JSON.stringify(value)).toString('base64url') !== part) return invalid()
    return value
  } catch { return invalid() }
}
function frozen<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) frozen(item); Object.freeze(value) }
  return value
}

export function createConnectorActorVerifier(options: ConnectorActorVerifierOptions) {
  options = Object.freeze({ ...options })
  httpsIdentity(options.issuer); httpsIdentity(options.audience)
  identifier(options.workspaceId); identifier(options.connectorInstanceId)
  const skew = options.clockSkewSeconds ?? 5
  if (!Number.isSafeInteger(skew) || skew < 0 || skew > 5) throw new RangeError('Invalid actor clock skew')
  return async (assertion: string, request: ConnectorRequestBytes): Promise<Readonly<ConnectorActorClaims>> => {
    if (!isString(assertion, 8192)) return invalid()
    const parts = assertion.split('.')
    if (parts.length !== 3 || !parts[2] || !encoded.test(parts[2]) || Buffer.from(parts[2], 'base64url').length !== 64
      || Buffer.from(parts[2], 'base64url').toString('base64url') !== parts[2]) return invalid()
    const header = object(decode(parts[0]), ['alg','typ','kid'])
    if (header.alg !== 'EdDSA' || header.typ !== CONNECTOR_ACTOR_TYPE || !isString(header.kid, 128) || !encoded.test(header.kid)) return invalid()
    const claims = parseConnectorActorClaims(decode(parts[1])), now = Math.floor((options.now?.() ?? Date.now()) / 1000)
    if (!Number.isSafeInteger(now) || claims.iss !== options.issuer || claims.aud !== options.audience
      || claims.workspaceId !== options.workspaceId || claims.connectorInstanceId !== options.connectorInstanceId
      || claims.iat > now + skew || claims.nbf > now + skew || claims.exp <= now - skew) return invalid()
    const binding = connectorRequestBinding(request)
    if (claims.request.method !== binding.method || claims.request.target !== binding.target || claims.request.bodySha256 !== binding.bodySha256) return invalid()
    let trusted: TrustedConnectorActorKey | null
    try { trusted = await options.trustedKey(header.kid) } catch { throw new ConnectorActorError('assertion_unavailable') }
    if (!trusted || trusted.revoked || trusted.key.type !== 'public' || trusted.key.asymmetricKeyType !== 'ed25519'
      || trusted.notBefore !== undefined && (!Number.isSafeInteger(trusted.notBefore) || claims.iat < trusted.notBefore)
      || trusted.notAfter !== undefined && (!Number.isSafeInteger(trusted.notAfter) || claims.exp > trusted.notAfter)) return invalid()
    try {
      if (!verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), trusted.key, Buffer.from(parts[2], 'base64url'))) return invalid()
    } catch { return invalid() }
    const currentTime = () => {
      const value = Math.floor((options.now?.() ?? Date.now()) / 1000)
      if (!Number.isSafeInteger(value)) return invalid()
      return value
    }
    if (claims.exp <= currentTime() - skew || claims.iat > currentTime() + skew) return invalid()
    let consumed: boolean
    try { consumed = await options.consumeReplay({ key: createHash('sha256').update(JSON.stringify([claims.iss,header.kid,claims.jti])).digest('base64url'),
      expiresAt: claims.exp + skew, now: currentTime() }) } catch { throw new ConnectorActorError('assertion_unavailable') }
    if (consumed !== true) throw new ConnectorActorError('assertion_replayed')
    if (claims.exp <= currentTime() - skew || claims.iat > currentTime() + skew) return invalid()
    return frozen(claims)
  }
}

/** Transport is authenticated before identity parsing. Valid Brian identity alone never authorizes source data. */
export async function authorizeConnectorRequest<T>(input: {
  authenticateTransport: () => Promise<boolean>
  verifyActor: ReturnType<typeof createConnectorActorVerifier>
  assertion: string
  request: ConnectorRequestBytes
  authorize: (actor: Readonly<ConnectorActorClaims>) => Promise<{ allowed: true; value: T } | { allowed: false }>
}): Promise<{ actor: Readonly<ConnectorActorClaims>; value: T }> {
  let transport = false
  try { transport = await input.authenticateTransport() } catch { /* Refuse without exposing credentials. */ }
  if (transport !== true) throw new ConnectorActorError('transport_unauthorized')
  const actor = await input.verifyActor(input.assertion, input.request)
  let decision: Awaited<ReturnType<typeof input.authorize>>
  try { decision = await input.authorize(actor) } catch { throw new ConnectorActorError('assertion_unavailable') }
  if (decision?.allowed !== true) throw new ConnectorActorError('source_access_denied')
  return { actor, value: decision.value }
}
