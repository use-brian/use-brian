/**
 * Lightweight Microsoft Bot Framework Connector client (Teams channel).
 *
 * Unlike Slack (one static bot token) or Discord (one static `Bot <token>`),
 * a Teams bot has NO static outbound credential. To send an activity it must:
 *
 *   1. mint an OAuth2 access token via the client-credentials flow against the
 *      workspace's Azure tenant (single-tenant BYO — see
 *      docs/architecture/channels/msteams.md §2), and
 *   2. POST that token to the per-conversation `serviceUrl` captured from the
 *      inbound Activity (`{serviceUrl}/v3/conversations/{id}/activities`).
 *
 * Tokens are cached until ~1min before expiry. The `serviceUrl` is per-region
 * and is supplied by the caller (from the inbound Activity on the interactive
 * path, or from `channel_integrations.connection_metadata` on the proactive /
 * scheduled path).
 */

/** OAuth scope for the Bot Connector service. */
export const BOT_CONNECTOR_SCOPE = 'https://api.botframework.com/.default'

/** Default Azure AD login host (single-tenant token endpoint is `${host}/${tenantId}/oauth2/v2.0/token`). */
export const AZURE_LOGIN_BASE = 'https://login.microsoftonline.com'

export type MsTeamsActivity = Record<string, unknown> & { type: string }

export type MsTeamsApiOptions = {
  /** Azure AD application (bot) id — the `client_id` for the token mint. */
  appId: string
  /** Client secret ("app password"). */
  appPassword: string
  /** Azure tenant id — single-tenant token authority. */
  tenantId: string
  /**
   * Per-conversation Bot Connector base URL, captured from the inbound
   * Activity's `serviceUrl` (or stored for proactive delivery). Required to
   * send/update/typing; a sender-only adapter with no serviceUrl throws on send.
   */
  serviceUrl?: string
  /** Override the fetch implementation (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Override the Azure login base (tests / sovereign clouds). */
  loginBaseUrl?: string
}

export function createMsTeamsApi(options: MsTeamsApiOptions) {
  const doFetch: typeof fetch = options.fetchImpl ?? ((input, init) => fetch(input as string, init))
  const loginBase = (options.loginBaseUrl ?? AZURE_LOGIN_BASE).replace(/\/$/, '')

  let cached: { token: string; expiresAt: number } | null = null

  /**
   * Mint (or return a cached) Bot Connector access token via the
   * client-credentials flow. Cached until 60s before expiry so a long turn
   * never sends with a token that expires mid-flight.
   */
  async function getToken(): Promise<string> {
    if (cached && cached.expiresAt > Date.now()) return cached.token

    const url = `${loginBase}/${encodeURIComponent(options.tenantId)}/oauth2/v2.0/token`
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: options.appId,
        client_secret: options.appPassword,
        scope: BOT_CONNECTOR_SCOPE,
      }).toString(),
    })
    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string
      expires_in?: number
      error?: string
      error_description?: string
    }
    if (!res.ok || !data.access_token) {
      // Surface the AAD error string (e.g. AADSTS7000215 invalid secret) so the
      // connect route can show the operator why validation failed. Never log the
      // secret itself.
      throw new Error(`MS Teams token: ${data.error_description ?? data.error ?? `HTTP ${res.status}`}`)
    }
    cached = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000 }
    return data.access_token
  }

  function requireServiceUrl(): string {
    if (!options.serviceUrl) {
      throw new Error('MS Teams: no serviceUrl bound to this adapter (cannot send)')
    }
    return options.serviceUrl.replace(/\/$/, '')
  }

  async function post(path: string, body: unknown, method: 'POST' | 'PUT'): Promise<{ id?: string }> {
    const token = await getToken()
    const res = await doFetch(`${requireServiceUrl()}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`MS Teams ${method} ${path}: HTTP ${res.status}${detail ? ` ${detail.slice(0, 200)}` : ''}`)
    }
    const data = (await res.json().catch(() => ({}))) as { id?: string }
    return { id: data.id }
  }

  return {
    getToken,

    /** POST a new activity to a conversation. Returns the created activity id. */
    sendActivity: (conversationId: string, activity: MsTeamsActivity) =>
      post(`/v3/conversations/${encodeURIComponent(conversationId)}/activities`, activity, 'POST'),

    /** PUT (edit-in-place) an existing activity. */
    updateActivity: async (conversationId: string, activityId: string, activity: MsTeamsActivity): Promise<void> => {
      await post(
        `/v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}`,
        activity,
        'PUT',
      )
    },

    /** Fire a typing indicator (best-effort keepalive). */
    sendTyping: async (conversationId: string): Promise<void> => {
      await post(`/v3/conversations/${encodeURIComponent(conversationId)}/activities`, { type: 'typing' }, 'POST')
    },
  }
}

export type MsTeamsApi = ReturnType<typeof createMsTeamsApi>
