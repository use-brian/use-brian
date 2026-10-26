/** Sign the final MCP HTTP envelope, including SDK-auth header merges. [COMP:api/connector-actor-context] */
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CONNECTOR_ACTOR_HEADER } from '@use-brian/brian-app/connector'
import type { ExecutionContext } from '@use-brian/core'
import { ApplicationPlatformError } from '@use-brian/shared'
import { actorIdentityHeaders, isReservedConnectorHeader, isValidHeaderValue, type ActorIdentity } from '../mcp/auth-headers.js'
import { mintConnectorActorAssertion, type ConnectorActorBinding, type ConnectorActorMintingPorts } from './connector-actor-context.js'

function bodyBytes(body: RequestInit['body']): Uint8Array {
  if (body === undefined || body === null) return new Uint8Array()
  if (typeof body === 'string') return Buffer.from(body, 'utf8')
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0))
  if (ArrayBuffer.isView(body)) return Uint8Array.from(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
  throw new ApplicationPlatformError('invalid_value', 'Connector requests require serialized bytes.')
}
export function createConnectorActorFetch(execution: ExecutionContext, sourceUrl: string, binding: ConnectorActorBinding,
  ports: ConnectorActorMintingPorts, options: { fetch?: FetchLike; readableIdentity?: Pick<ActorIdentity, 'id' | 'email' | 'org'> } = {}): FetchLike {
  // sourceUrl is the host's URL-validated connector binding, never a tool argument or result URL.
  const destination = new URL(sourceUrl), pinned = Object.freeze({ ...binding }), send = options.fetch ?? globalThis.fetch
  const identity = Object.freeze({ ...options.readableIdentity })
  if (!['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password || destination.hash) {
    throw new ApplicationPlatformError('invalid_value', 'The connector target is invalid.')
  }
  return async (rawUrl, init = {}) => {
    const url = new URL(rawUrl)
    if (url.href !== destination.href || init.signal?.aborted) throw new ApplicationPlatformError('access_unavailable', 'The connector target is unavailable.')
    const bytes = bodyBytes(init.body), method = (init.method ?? 'GET').toUpperCase()
    if (bytes.byteLength > 8 * 1024 * 1024) throw new ApplicationPlatformError('invalid_value', 'The connector request is too large.')
    const headers = new Headers(init.headers)
    for (const name of [...headers.keys()]) if (isReservedConnectorHeader(name)) headers.delete(name)
    const asserted = actorIdentityHeaders({ ...identity, channel: execution.lifecycle.transport ?? execution.lifecycle.channelType,
      userId: execution.security.access.userId, assistantId: execution.assistant.id })
    for (const [name, value] of Object.entries(asserted)) if (isValidHeaderValue(value)) headers.set(name, value)
    headers.set(CONNECTOR_ACTOR_HEADER, await mintConnectorActorAssertion(execution, pinned,
      { method, target: `${url.pathname}${url.search}`, body: bytes }, ports))
    // This exact byte array was hashed above. SDK serialization/auth happened before this callback.
    const response = await send(url, { ...init, method, headers, body: init.body === undefined || init.body === null ? undefined : bytes,
      redirect: 'manual' })
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {})
      throw new ApplicationPlatformError('source_unavailable', 'The connector destination changed. Review its configuration before retrying.')
    }
    try {
      await execution.security.authority.assertCurrent()
      if (execution.lifecycle.abortSignal.aborted) throw new ApplicationPlatformError('access_unavailable', 'The connector response is unavailable.')
    } catch (error) {
      await response.body?.cancel().catch(() => {})
      throw error
    }
    return response
  }
}
