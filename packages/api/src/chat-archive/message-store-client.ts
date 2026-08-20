/**
 * HTTP client for `brian-message-store`.
 *
 * The archive now runs against its own database, so the platform can no longer
 * reach chat messages with SQL. Every interaction goes through the versioned
 * contracts below. That is the point of the split: platform changes cannot break
 * the archive, and the archive can be deployed and upgraded on its own schedule
 * — which on-premise it will be, often lagging the platform by weeks.
 *
 * Two signing schemes, matching the service:
 *  - JSON requests sign the exact body, because the body IS the payload.
 *  - Media transfers sign "<METHOD>\n<request-uri>", because the body is a byte
 *    stream that must not be buffered into memory to be authenticated. Every
 *    authorization-relevant field travels in the URI, and content integrity is
 *    covered separately by the declared SHA-256.
 *
 * [COMP:integrations/message-store]
 */

import { createHash, createHmac } from 'node:crypto'

/** Contract identifiers. Bump deliberately; the store may be an old build. */
export const SEARCH_CONTRACT_V1 = 'ub.chat.search.v1'
export const CONTACTS_CONTRACT_V1 = 'ub.chat.contacts.v1'

export type ChatArchiveHit = {
  segment_id: string
  message_id: string
  instance_id: string
  source: string
  provider_message_id: string
  conversation_id: string
  sender_id: string
  sender_display?: string
  /** The owner's saved name for this sender, from the synced contact directory. */
  sender_contact_name?: string
  sent_at: string
  direction: string
  kind: string
  body_text?: string
  reply_to_provider_id?: string
  segment_index: number
  segment_text: string
  media_sha256?: string
  media_mime?: string
  extraction_status?: string
}

export type ChatArchiveCoverage = {
  partial: boolean
  pending: number
  capped: boolean
  note: string
}

export type ChatArchiveSearchResult = {
  hits: ChatArchiveHit[]
  embedding_coverage: ChatArchiveCoverage
}

export type ChatArchiveSearchInput = {
  ownerUserId: string
  query: string
  /** Opaque "<instanceId>:<conversationId>" handle from a prior result. */
  channel?: string
  since?: string
  until?: string
  topK?: number
}

export type ChatChannel = {
  /** Opaque handle to pass straight back into a search. */
  channel: string
  instance_id: string
  conversation_id: string
  source: string
  message_count: number
  first_sent_at: string
  last_sent_at: string
  last_message_preview: string
  last_sender_id?: string
  last_sender_display?: string
  /** The owner's saved name for the last sender, from the synced contact directory. */
  last_sender_contact_name?: string
  last_direction: string
}

export type ListChannelsInput = {
  ownerUserId: string
  query?: string
  since?: string
  until?: string
  limit?: number
}

export type UploadMediaInput = {
  workspaceId: string
  instanceId: string
  ownerUserId: string
  source: string
  providerMessageId: string
  kind: 'image' | 'video' | 'voice' | 'file'
  filename: string
  mime: string
  bytes: Buffer
}

/** What a caller needs to hand an uploader that holds the bytes but not the secret. */
export type MediaUploadTargetInput = Omit<UploadMediaInput, 'bytes'> & { sha256: string }

export type UploadMediaStreamInput = MediaUploadTargetInput & {
  /** Node request stream or another fetch-compatible async byte stream. */
  body: AsyncIterable<Uint8Array>
  sizeBytes: number
}

/** A one-asset, pre-signed destination for an uploader outside this process. */
export type MediaUploadTarget = {
  url: string
  headers: Record<string, string>
}

export type UploadedMedia = {
  asset_id: string
  sha256: string
  size_bytes: number
  deduped: boolean
}

export type EnrichmentWindow = {
  window_id: string
  source_ref: Record<string, unknown>
  owner_user_id: string
  workspace_id: string
  rendered_text: string
  message_count: number
  window_start: string
  window_end: string
  attempt_count: number
  lease_expires_at: string
}

export type MessageStoreClientOptions = {
  baseUrl: string
  secret: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/** Signs a JSON body. */
function signBody(raw: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`
}

/** Signs a request line, for endpoints whose body is a stream. */
function signRequest(method: string, requestUri: string, secret: string): string {
  const canonical = `${method.toUpperCase()}\n${requestUri}`
  return `sha256=${createHmac('sha256', secret).update(canonical).digest('hex')}`
}

export class MessageStoreClient {
  private readonly baseUrl: string
  private readonly secret: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(options: MessageStoreClientOptions) {
    const base = options.baseUrl.trim().replace(/\/+$/, '')
    if (!base) throw new Error('message store base url is required')
    if (!options.secret.trim()) throw new Error('message store hmac secret is required')
    this.baseUrl = base
    this.secret = options.secret
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /**
   * Runs a person-scoped archive query.
   *
   * Raw query text is sent rather than a vector: the store embeds the query with
   * the same client that embedded the stored segments. Cosine distance is only
   * meaningful within one vector space, and keeping both sides behind one
   * implementation makes that structural instead of a convention two codebases
   * have to keep agreeing on.
   */
  async search(input: ChatArchiveSearchInput): Promise<ChatArchiveSearchResult> {
    return this.postJson<ChatArchiveSearchResult>('/search', {
      contract: SEARCH_CONTRACT_V1,
      owner_user_id: input.ownerUserId,
      query: input.query,
      ...(input.channel ? { channel: input.channel } : {}),
      ...(input.since ? { since: input.since } : {}),
      ...(input.until ? { until: input.until } : {}),
      ...(input.topK ? { top_k: input.topK } : {}),
    })
  }

  /**
   * Stores attachment bytes in the archive.
   *
   * Metadata travels in the query string and the bytes are the raw body, which
   * is what lets the signature cover every authorization-relevant field while
   * the payload streams. The store verifies the declared digest as it writes, so
   * a truncated or altered body cannot land at the signed address.
   */
  async uploadMedia(input: UploadMediaInput): Promise<UploadedMedia> {
    const sha256 = createHash('sha256').update(input.bytes).digest('hex')
    const params = new URLSearchParams({
      workspace_id: input.workspaceId,
      instance_id: input.instanceId,
      owner_user_id: input.ownerUserId,
      source: input.source,
      provider_message_id: input.providerMessageId,
      kind: input.kind,
      filename: input.filename,
      mime: input.mime,
      sha256,
    })
    const requestUri = `/media?${params.toString()}`

    const response = await this.send('POST', requestUri, {
      'Content-Type': input.mime || 'application/octet-stream',
      'X-UB-Signature': signRequest('POST', requestUri, this.secret),
    }, input.bytes)
    return (await response.json()) as UploadedMedia
  }

  /**
   * Pre-sign a `/media` upload so a process that holds the bytes — but must
   * never hold this secret — can send them straight to the store.
   *
   * Safe to hand out because the signature covers the whole request URI, and
   * every authorization-relevant field lives there: owner, workspace, instance,
   * provider message id, and the content digest. So it authorizes storing
   * exactly these bytes, for exactly this owner, against exactly this message —
   * it cannot be replayed to write different content or to write into anyone
   * else's archive. The store re-hashes the body as it writes and rejects a
   * mismatch, so a tampered payload cannot land at the signed address either.
   *
   * The digest must therefore be known before the upload starts, which is why
   * the caller hashes first and asks for a target second.
   */
  mediaUploadTarget(input: MediaUploadTargetInput): MediaUploadTarget {
    const params = new URLSearchParams({
      workspace_id: input.workspaceId,
      instance_id: input.instanceId,
      owner_user_id: input.ownerUserId,
      source: input.source,
      provider_message_id: input.providerMessageId,
      kind: input.kind,
      filename: input.filename,
      mime: input.mime,
      sha256: input.sha256.toLowerCase(),
    })
    const requestUri = `/media?${params.toString()}`
    return {
      url: `${this.baseUrl}${requestUri}`,
      headers: {
        'Content-Type': input.mime || 'application/octet-stream',
        'X-UB-Signature': signRequest('POST', requestUri, this.secret),
      },
    }
  }

  /**
   * Proxy an already-hashed raw stream into the store without buffering it in
   * the API. The signed URI commits to all metadata and the digest; the store
   * hashes again as it writes.
   */
  async uploadMediaStream(input: UploadMediaStreamInput): Promise<UploadedMedia> {
    const target = this.mediaUploadTarget(input)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(this.timeoutMs, 10 * 60_000))
    try {
      const init = {
        method: 'POST',
        headers: {
          ...target.headers,
          'Content-Length': String(input.sizeBytes),
        },
        body: input.body,
        // Required by Node fetch for a streaming request body.
        duplex: 'half',
        signal: controller.signal,
      } as unknown as RequestInit
      const response = await this.fetchImpl(target.url, init)
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(`message store POST /media failed: ${response.status} ${detail.slice(0, 500)}`)
      }
      return (await response.json()) as UploadedMedia
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Reads attachment bytes back out of the archive.
   *
   * Owner-bound: the store resolves the digest under the owner's row-level
   * security, and a digest belonging to someone else is a 404 deliberately
   * indistinguishable from a missing one. The digest comes from a search hit's
   * `media_sha256`; there is no lookup by asset id.
   *
   * `maxBytes` is enforced against Content-Length before buffering — archive
   * per-kind ceilings (512 MB video) are far above what any delivery path
   * accepts, so the caller must state its own bound.
   */
  async downloadMedia(input: {
    ownerUserId: string
    sha256: string
    maxBytes: number
  }): Promise<{ bytes: Buffer; mime: string }> {
    const digest = input.sha256.trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(digest)) {
      throw new Error('downloadMedia requires a 64-hex sha256 digest')
    }
    const params = new URLSearchParams({ owner_user_id: input.ownerUserId })
    const requestUri = `/media/${digest}?${params.toString()}`
    const response = await this.send('GET', requestUri, {
      'X-UB-Signature': signRequest('GET', requestUri, this.secret),
    })
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (declared > input.maxBytes) {
      throw new Error(`archive media is ${declared} bytes — over the ${input.maxBytes}-byte limit for this operation`)
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > input.maxBytes) {
      throw new Error(`archive media is ${bytes.length} bytes — over the ${input.maxBytes}-byte limit for this operation`)
    }
    return {
      bytes,
      mime: response.headers.get('content-type') ?? 'application/octet-stream',
    }
  }

  /**
   * Lists archived conversations, most recently active first.
   *
   * Nothing in the archive stores a human-readable channel name — provider
   * conversation ids are opaque and display names are absent on the live ingest
   * path — so this is how a caller turns "the group chat with Sarah" into a
   * handle it can narrow a search with.
   */
  async listChannels(input: ListChannelsInput): Promise<ChatChannel[]> {
    const params = new URLSearchParams({ owner_user_id: input.ownerUserId })
    if (input.query) params.set('query', input.query)
    if (input.since) params.set('since', input.since)
    if (input.until) params.set('until', input.until)
    if (input.limit) params.set('limit', String(input.limit))
    const requestUri = `/channels?${params.toString()}`

    const response = await this.send('GET', requestUri, {
      'X-UB-Signature': signRequest('GET', requestUri, this.secret),
    })
    const body = (await response.json()) as { channels?: ChatChannel[] }
    return body.channels ?? []
  }

  /**
   * Upserts the owner's contact directory for one channel connector.
   *
   * Names resolve at QUERY time (search/channels join the directory on
   * `sender_id`), so a directory entry that arrives after the messages did
   * still names every old row — the archive's raw `sender_display` stays
   * whatever the provider sent with each message.
   *
   * Empty strings never clobber a stored name; the store keeps the previous
   * non-empty value per column.
   */
  async upsertContacts(input: {
    workspaceId: string
    instanceId: string
    ownerUserId: string
    source: string
    contacts: Array<{
      contactId: string
      /** The owner's own address-book name for this contact (the strongest label). */
      savedName?: string | null
      /** The name the contact set for themselves (WhatsApp pushName). */
      pushName?: string | null
      /** Business-verified display name, when the platform provides one. */
      verifiedName?: string | null
    }>
  }): Promise<{ upserted: number }> {
    if (input.contacts.length === 0) return { upserted: 0 }
    return this.postJson<{ upserted: number }>('/contacts', {
      contract: CONTACTS_CONTRACT_V1,
      workspace_id: input.workspaceId,
      instance_id: input.instanceId,
      owner_user_id: input.ownerUserId,
      source: input.source,
      contacts: input.contacts.map((c) => ({
        contact_id: c.contactId,
        ...(c.savedName ? { saved_name: c.savedName } : {}),
        ...(c.pushName ? { push_name: c.pushName } : {}),
        ...(c.verifiedName ? { verified_name: c.verifiedName } : {}),
      })),
    })
  }

  /** Leases enrichment windows for Pipeline B. */
  async claimEnrichmentWindows(limit: number): Promise<EnrichmentWindow[]> {
    const requestUri = `/enrichment/windows?limit=${encodeURIComponent(String(limit))}`
    const response = await this.send('GET', requestUri, {
      'X-UB-Signature': signRequest('GET', requestUri, this.secret),
    })
    const body = (await response.json()) as { windows?: EnrichmentWindow[] }
    return body.windows ?? []
  }

  /** Reports a window successfully extracted. */
  async completeEnrichmentWindow(windowId: string, episodeId: string): Promise<void> {
    await this.postJson(`/enrichment/windows/${encodeURIComponent(windowId)}/complete`, {
      episode_id: episodeId,
    })
  }

  /** Reports a window that could not be processed, so the store can retry it. */
  async failEnrichmentWindow(windowId: string, reason: string): Promise<void> {
    await this.postJson(`/enrichment/windows/${encodeURIComponent(windowId)}/fail`, { reason })
  }

  /** Signals a deletion the archive's database can no longer cascade itself. */
  async deleteWorkspace(workspaceId: string): Promise<void> {
    const requestUri = `/workspace/${encodeURIComponent(workspaceId)}`
    await this.send('DELETE', requestUri, {
      'X-UB-Signature': signRequest('DELETE', requestUri, this.secret),
    })
  }

  private async postJson<T>(path: string, payload: unknown): Promise<T> {
    const raw = JSON.stringify(payload)
    const response = await this.send('POST', path, {
      'Content-Type': 'application/json',
      'X-UB-Signature': signBody(raw, this.secret),
    }, raw)
    return (await response.json()) as T
  }

  private async send(
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: string | Buffer,
  ): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body as never,
        signal: controller.signal,
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(`message store ${method} ${path} failed: ${response.status} ${detail.slice(0, 500)}`)
      }
      return response
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Builds a client from environment configuration, or returns null when the
 * archive is not deployed.
 *
 * Returning null rather than throwing keeps the archive optional: a deployment
 * without it simply has no chat history, rather than failing to boot.
 */
export function createMessageStoreClient(env: {
  BRIAN_MESSAGE_STORE_URL?: string
  BRIAN_MESSAGE_STORE_HMAC_SECRET?: string
}): MessageStoreClient | null {
  const baseUrl = env.BRIAN_MESSAGE_STORE_URL?.trim()
  const secret = env.BRIAN_MESSAGE_STORE_HMAC_SECRET?.trim()
  if (!baseUrl || !secret) return null
  return new MessageStoreClient({ baseUrl, secret })
}
