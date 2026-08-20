/**
 * Client for the Use Brian custom-channel bridge protocol
 * (`/bridge/v1/channels/:channelId/*`, bearer bridge token).
 * Spec: docs/architecture/channels/custom-channel.md.
 */
import type { BridgeInbound, BridgeState, HelloResponse, OutboxAckResult, OutboxItem } from './protocol-types.js'

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** A 401/404 from the API: wrong token or deleted channel. Not retryable; the process must exit. */
export class FatalConfigError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'FatalConfigError'
  }
}

export class BridgeHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    body: string,
  ) {
    super(`Use Brian ${path} responded ${status}: ${body.slice(0, 200)}`)
    this.name = 'BridgeHttpError'
  }
}

type InboundResult = { status: number; archivedOnly: boolean }
type StreamedMediaResult = {
  assetId: string
  sha256: string
  filename: string
  mime: string
  sizeBytes: number
}

export interface BrianBridgeClient {
  hello(): Promise<HelloResponse>
  putState(state: BridgeState): Promise<void>
  /** Resolves on 2xx; throws BridgeHttpError on 4xx/5xx and a network error otherwise. */
  postInbound(inbound: BridgeInbound): Promise<InboundResult>
  uploadMedia(input: {
    messageId: string
    peerId: string
    kind: 'image' | 'video' | 'voice' | 'file'
    mime: string
    filename: string
    sha256: string
    sizeBytes: number
    body: ReadableStream<Uint8Array>
  }): Promise<StreamedMediaResult>
  pollOutbox(opts?: { waitMs?: number; limit?: number; signal?: AbortSignal }): Promise<OutboxItem[]>
  ack(results: OutboxAckResult[]): Promise<void>
  heartbeat(): Promise<void>
}

export type BrianBridgeClientOptions = {
  apiUrl: string
  channelId: string
  token: string
  fetch?: FetchLike
}

export function createBrianBridgeClient(opts: BrianBridgeClientOptions): BrianBridgeClient {
  const base = `${opts.apiUrl.replace(/\/+$/, '')}/bridge/v1/channels/${encodeURIComponent(opts.channelId)}`
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init))
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.token}` }

  async function request(
    method: 'GET' | 'PUT' | 'POST',
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
    if (res.status === 401 || res.status === 404) {
      throw new FatalConfigError(
        res.status === 401
          ? 'Use Brian rejected the bridge token (401). Check BRIAN_BRIDGE_TOKEN and BRIAN_CHANNEL_ID, or rotate the token in Studio.'
          : 'Use Brian does not know this channel (404). It was deleted or BRIAN_CHANNEL_ID is wrong.',
        res.status,
      )
    }
    if (!res.ok) throw new BridgeHttpError(res.status, path, await res.text().catch(() => ''))
    return res
  }

  return {
    async hello() {
      const res = await request('GET', '/hello')
      return (await res.json()) as HelloResponse
    },
    async putState(state) {
      await request('PUT', '/state', state)
    },
    async postInbound(inbound) {
      const res = await request('POST', '/inbound', inbound)
      let archivedOnly = false
      try {
        const json = (await res.json()) as { archivedOnly?: boolean }
        archivedOnly = json.archivedOnly === true
      } catch {
        /* body is optional */
      }
      return { status: res.status, archivedOnly }
    },
    async uploadMedia(input) {
      const params = new URLSearchParams({
        peerId: input.peerId,
        kind: input.kind,
        mime: input.mime,
        filename: input.filename,
        sha256: input.sha256,
        size: String(input.sizeBytes),
      })
      const path = `/media/${encodeURIComponent(input.messageId)}?${params.toString()}`
      const init = {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${opts.token}`,
          'Content-Type': input.mime,
          'Content-Length': String(input.sizeBytes),
        },
        body: input.body,
        duplex: 'half',
      } as unknown as RequestInit
      const res = await doFetch(`${base}${path}`, init)
      if (res.status === 401 || res.status === 404) {
        throw new FatalConfigError(
          res.status === 401
            ? 'Use Brian rejected the bridge token (401). Check BRIAN_BRIDGE_TOKEN and BRIAN_CHANNEL_ID, or rotate the token in Studio.'
            : 'Use Brian does not know this channel (404). It was deleted or BRIAN_CHANNEL_ID is wrong.',
          res.status,
        )
      }
      if (!res.ok) throw new BridgeHttpError(res.status, path, await res.text().catch(() => ''))
      return (await res.json()) as StreamedMediaResult
    },
    async pollOutbox({ waitMs = 25_000, limit = 20, signal } = {}) {
      const res = await request('GET', `/outbox?wait=${waitMs}&limit=${limit}`, undefined, signal)
      const json = (await res.json()) as { items?: OutboxItem[] }
      return Array.isArray(json.items) ? json.items : []
    },
    async ack(results) {
      if (results.length === 0) return
      await request('POST', '/outbox/ack', { results })
    },
    async heartbeat() {
      await request('POST', '/heartbeat', {})
    },
  }
}
