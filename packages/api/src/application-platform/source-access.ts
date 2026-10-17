/** Fresh authenticated sidecar checks. No provider ACL vocabulary and no positive cache. [COMP:api/external-source-access] */
import { randomUUID } from 'node:crypto'
import type { ExecutionContext, McpServerConfig } from '@use-brian/core'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { SOURCE_PROTOCOL_VERSION, SOURCE_TIMEOUT_MS, SourceProtocolError,
  parseSourceEnvelope, parseSourceCapabilities, parseSourceAuthorizationRequest, requireSourceAuthorization,
  parseSourceReconcileRequest, parseSourceReconcileResponse, sourceSubjectKey, sourceAuthorizationDigest,
  type SourceEnvelope, type SourceAuthorizationRequest, type SourceAuthorizationResponse, type SourceCapabilities,
  type SourceReconcileRequest, type SourceReconcileResponse, type SourceRetentionMode, type SourceSubject } from '@use-brian/brian-app/connector'
import type { ConnectorActorBinding, ConnectorActorMintingPorts } from './connector-actor-context.js'
import { createConnectorActorFetch } from './connector-actor-transport.js'
import { callRemoteMcpToolEnvelope, discoverMcpServer } from '../mcp/client.js'

export type SourceAccessProfile = ConnectorActorBinding & {
  /** Existing connector URL validation pins these host-owned destinations before constructing this client. */
  mcpUrl: string
  sourceBaseUrl: string
  /** Adapter-owned HTTP read destination. Never accepted from tool text or source metadata. */
  httpReadPath?: string
  tenant: string
  bindingRevision: string
  subject: SourceSubject
}
export type SourceOperationProof = { request: SourceAuthorizationRequest; response: SourceAuthorizationResponse; requestDigest: string }
export type SourceAccessClient = {
  capabilities: () => Promise<SourceCapabilities>
  discoverMcp: (name: string) => Promise<McpServerConfig>
  authorize: (request: SourceAuthorizationRequest) => Promise<SourceOperationProof>
  reconcile: (request: SourceReconcileRequest) => Promise<SourceReconcileResponse>
  readMcp: (tool: string, input: Record<string, unknown>, retentionMode?: SourceRetentionMode) => Promise<TrustedSourceRead>
  readHttp: (input: Record<string, unknown>, retentionMode?: SourceRetentionMode) => Promise<TrustedSourceRead>
}
export type TrustedSourceRead = { result: CallToolResult }
const sourceReads = new WeakMap<TrustedSourceRead, { execution: ExecutionContext; envelope: SourceEnvelope; proof: SourceOperationProof }>()
const sourceProofs = new WeakMap<SourceOperationProof, { execution: ExecutionContext; profile: SourceAccessProfile; proof: SourceOperationProof; assertCurrent: () => Promise<void> }>()
/** Only the exact authenticated operation object can be pinned into a host transaction. */
export function trustedSourceOperationProof(proof: SourceOperationProof, execution: ExecutionContext) {
  const binding = sourceProofs.get(proof)
  return binding?.execution === execution ? { ...structuredClone({ profile: binding.profile, proof: binding.proof }), assertCurrent: binding.assertCurrent } : undefined
}
/** JSON fields cannot create this binding. Persistence adapters resolve observations before any display conversion. */
export function trustedSourceEnvelope(read: TrustedSourceRead): SourceEnvelope | undefined {
  const binding = sourceReads.get(read); return binding ? structuredClone(binding.envelope) : undefined
}
export function trustedSourceReadBinding(read: TrustedSourceRead, execution: ExecutionContext) {
  const binding = sourceReads.get(read)
  return binding?.execution === execution ? { envelope: structuredClone(binding.envelope), proof: binding.proof } : undefined
}
function denied(): never { throw new SourceProtocolError('source_access_denied') }
function unavailable(): never { throw new SourceProtocolError('source_unavailable') }

export function createSourceAccessClient(execution: ExecutionContext, rawProfile: SourceAccessProfile,
  ports: ConnectorActorMintingPorts, options: { headers: Record<string, string>; fetch?: FetchLike; now?: () => number }): SourceAccessClient {
  const profile = structuredClone(rawProfile), headers = { ...options.headers }, now = options.now ?? Date.now
  const base = new URL(profile.sourceBaseUrl), mcp = new URL(profile.mcpUrl)
  const protectedTransport = (url: URL) => url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1','[::1]'].includes(url.hostname)
  if (!protectedTransport(base) || !protectedTransport(mcp) || base.username || base.password || base.hash || base.search
    || mcp.username || mcp.password || mcp.hash
    || base.origin !== mcp.origin || base.pathname !== '/' && base.pathname.endsWith('/') || !/^[1-9][0-9]*$/.test(profile.bindingRevision)) unavailable()
  if (profile.httpReadPath !== undefined && (!profile.httpReadPath.startsWith('/') || profile.httpReadPath.startsWith('//')
    || /[?#\s\\]/.test(profile.httpReadPath) || new URL(profile.httpReadPath, base).origin !== base.origin)) unavailable()
  sourceSubjectKey(profile.subject)
  if (profile.subject.id !== execution.security.access.userId || profile.subject.executingAssistantId !== execution.assistant.id) denied()
  const minting: ConnectorActorMintingPorts = { ...ports, admit: async (context, binding) => {
    const admission = await ports.admit(context, binding)
    if (!admission || admission.bindingRevision !== profile.bindingRevision) return null
    const actual: SourceSubject = { kind: admission.actor.kind, id: admission.actor.kind === 'human' ? admission.actor.userId : admission.actor.serviceUserId,
      executingAssistantId: context.assistant.id }
    return sourceSubjectKey(actual) === sourceSubjectKey(profile.subject) ? admission : null
  } }
  async function boundary<T>(url: string, operation: (send: FetchLike) => Promise<T>): Promise<T> {
    await execution.security.authority.assertCurrent()
    if (execution.lifecycle.abortSignal.aborted) denied()
    const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), SOURCE_TIMEOUT_MS)
    const wire: FetchLike = async (target, init = {}) => {
      const signals = [timeout.signal,execution.lifecycle.abortSignal,...(init.signal ? [init.signal] : [])]
      return await (options.fetch ?? globalThis.fetch)(target, { ...init, signal: AbortSignal.any(signals) })
    }
    try {
      const value = await operation(createConnectorActorFetch(execution, url, profile, minting, { fetch: wire }))
      await execution.security.authority.assertCurrent()
      // Re-admit after reading/parsing the complete response body as well as after header receipt.
      if (timeout.signal.aborted) unavailable()
      if (execution.lifecycle.abortSignal.aborted || !await minting.admit(execution, profile)) denied()
      return value
    } catch (error) {
      if (error instanceof SourceProtocolError) throw error
      return unavailable()
    } finally { clearTimeout(timer) }
  }
  async function postJson(url: string, body: unknown): Promise<unknown> {
    return boundary(url, async send => {
      const response = await send(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!response.ok) { await response.body?.cancel().catch(() => {}); return response.status === 403 ? denied() : unavailable() }
      // Bound actual bytes; Content-Length alone is not authority for streamed responses.
      const reader = response.body?.getReader(); if (!reader) return unavailable()
      const chunks: Uint8Array[] = []; let length = 0
      try {
        while (true) { const { value, done } = await reader.read(); if (done) break; length += value.byteLength
          if (length > 8 * 1024 * 1024) { await reader.cancel(); return unavailable() }; chunks.push(value) }
        return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
      } finally { reader.releaseLock() }
    })
  }
  const post = (endpoint: 'capabilities' | 'authorize' | 'reconcile', body: unknown) => postJson(`${base.href.replace(/\/$/,'')}/usebrian/source/${endpoint}`, body)
  async function admittedRead(result: CallToolResult, metadata: unknown, retentionMode: SourceRetentionMode): Promise<TrustedSourceRead> {
    const envelope = parseSourceEnvelope(metadata)
    if (envelope.tenant !== profile.tenant) denied()
    for (const resource of envelope.resources) {
      if (!resource.subjects.some(subject => sourceSubjectKey(subject) === sourceSubjectKey(profile.subject))
        || !resource.actions.includes('read') || !resource.actions.includes('context') || !resource.export.model
        || resource.retention.mode !== retentionMode || resource.retention.mode === 'released_snapshot' && resource.retention.expiresAt <= now()) denied()
    }
    const proof = await client.authorize({ version: SOURCE_PROTOCOL_VERSION, operationId: randomUUID(),
      items: envelope.resources.map(item => ({ itemId: randomUUID(), resource: item.resource, fields: item.fields, action: 'context', retentionMode })),
      recipients: [{ recipientId: randomUUID(), subject: profile.subject }] })
    const display = structuredClone(result); delete display._meta
    const read: TrustedSourceRead = { result: display }; sourceReads.set(read, { execution, envelope, proof })
    return read
  }
  const client: SourceAccessClient = {
    async capabilities() {
      const value = parseSourceCapabilities(await post('capabilities', { version: SOURCE_PROTOCOL_VERSION }))
      if (value.tenant !== profile.tenant) denied()
      return value
    },
    async discoverMcp(name) {
      await client.capabilities()
      return boundary(profile.mcpUrl, send => discoverMcpServer(profile.mcpUrl, name, headers, send))
    },
    async authorize(raw) {
      const request = parseSourceAuthorizationRequest(raw), rawResponse = await post('authorize', request)
      const response = requireSourceAuthorization(rawResponse as SourceAuthorizationResponse, request, profile.tenant, now())
      const proof = { request, response, requestDigest: sourceAuthorizationDigest(request) }
      const saved = structuredClone(proof)
      sourceProofs.set(proof, { execution, profile, proof: saved, assertCurrent: async () => {
        await execution.security.authority.assertCurrent()
        if (execution.lifecycle.abortSignal.aborted || !await minting.admit(execution, profile)) denied()
        requireSourceAuthorization(saved.response, saved.request, profile.tenant, now())
      } })
      return proof
    },
    async reconcile(raw) {
      const request = parseSourceReconcileRequest(raw)
      try { return parseSourceReconcileResponse(await post('reconcile', request), profile.tenant) }
      catch (error) { if (error instanceof SourceProtocolError && error.code === 'source_access_denied') throw error; throw new SourceProtocolError('source_effect_uncertain') }
    },
    async readMcp(tool, input, retentionMode = 'governed') {
      const capabilities = await client.capabilities()
      if (!capabilities.retentionModes.includes(retentionMode)) denied()
      const result = await boundary(profile.mcpUrl, send => callRemoteMcpToolEnvelope(profile.mcpUrl, tool, input, headers, send))
      if (result.isError) unavailable()
      // Reserved evidence stays out of display/model input. The trusted binding survives only object identity.
      return admittedRead(result, result._meta?.[SOURCE_PROTOCOL_VERSION], retentionMode)
    },
    async readHttp(input, retentionMode = 'governed') {
      if (!profile.httpReadPath || !(await client.capabilities()).retentionModes.includes(retentionMode)) denied()
      const raw = await postJson(new URL(profile.httpReadPath, base).href, input)
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['data','envelope'].includes(key))) unavailable()
      const { data, envelope } = raw as { data: unknown; envelope: unknown }
      if (!data || typeof data !== 'object' || Array.isArray(data)) unavailable()
      return admittedRead({ content: [], structuredContent: data as Record<string, unknown> }, envelope, retentionMode)
    },
  }
  return client
}
