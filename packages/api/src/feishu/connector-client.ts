/**
 * API-side lifecycle client for apps/feishu-connector.
 *
 * [COMP:channels/feishu-connector-client]
 */

import type { FeishuBrand } from '@use-brian/channels'

export type FeishuConnectorStatus = {
  channelId: string
  brand: FeishuBrand
  status: 'connecting' | 'connected' | 'disconnected'
  botOpenId?: string
  botName?: string
  connectedAt?: number
  lastEventAt?: number
  reconnectCount: number
  rejectCount: number
  lastErrorCode?: string
  connection?: unknown
}

export type FeishuConnectorClient = {
  connect(channelId: string, input: {
    appId: string
    appSecret: string
    brand: FeishuBrand
  }): Promise<FeishuConnectorStatus>
  disconnect(channelId: string): Promise<void>
  status(channelId: string): Promise<FeishuConnectorStatus | null>
}

export type FeishuConnectorClientOptions = {
  connectorUrl: string
  connectorSecret: string
  fetchImpl?: typeof fetch
}

export function createFeishuConnectorClient(
  options: FeishuConnectorClientOptions,
): FeishuConnectorClient {
  const base = options.connectorUrl.replace(/\/$/, '')
  const fetchImpl = options.fetchImpl ?? fetch

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        'X-Connector-Secret': options.connectorSecret,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) {
      const responseBody = await response.text().catch(() => '')
      throw new Error(
        `feishu-connector ${method} ${path} failed: ${response.status} ${responseBody}`.trim(),
      )
    }
    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
  }

  return {
    connect(channelId, input) {
      return call<FeishuConnectorStatus>(
        'POST',
        `/connect/${encodeURIComponent(channelId)}`,
        input,
      )
    },
    async disconnect(channelId) {
      await call<{ ok: boolean }>('POST', `/disconnect/${encodeURIComponent(channelId)}`)
    },
    async status(channelId) {
      try {
        return await call<FeishuConnectorStatus>(
          'GET',
          `/status/${encodeURIComponent(channelId)}`,
        )
      } catch (error) {
        if (error instanceof Error && error.message.includes('404')) return null
        throw error
      }
    },
  }
}
