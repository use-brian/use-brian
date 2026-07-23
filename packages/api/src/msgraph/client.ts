/**
 * Microsoft Graph client — thin fetch-based wrappers, READ ONLY.
 *
 * No heavy SDK, and no projection: every method returns the RAW Graph JSON
 * body. Shaping rows for the model is the core tool layer's job
 * (`packages/core/src/tools/base/msgraph.ts` via `_connector-result.ts`),
 * exactly as notion/client.ts + core/tools/base/notion.ts already split it.
 * This module owns transport only — auth, pagination, query building, errors.
 *
 * Token acquisition/refresh is the caller's job: `getAccessToken` is injected.
 * Retry/backoff defaults to `fetchWithRetry` (./backoff.ts) and stays
 * injectable, so tests can drive transport without real timers.
 *
 * There are no write methods and none may be added: Graph cannot post as a
 * bot, so sending stays on the shipped Teams bot channel.
 * See docs/plans/msteams-connector.md (D1) and
 * docs/research/external/microsoft-teams-connector-2026.md §2.
 */

import { fetchWithRetry } from './backoff.js'

const GRAPH_API = 'https://graph.microsoft.com/v1.0'

/**
 * Hard stop on `@odata.nextLink` walking. Graph enforces ~1 rps per app per
 * tenant on channel-message reads (research §7.1), so an unbounded walk is a
 * throttling incident, not a feature. Same shape as notion/client.ts's
 * MAX_BLOCK_PAGES.
 */
const MAX_PAGES = 10

/**
 * `$top` ceilings, per endpoint — they are NOT uniform, and sending a value
 * over the ceiling is a 400. Channel/chat messages and replies cap at 50;
 * rosters and `/users` default to 100 and cap at 999 (research §2.1, §2.3).
 * A caller asking for more gets the ceiling, not an error.
 */
const MAX_TOP_MESSAGES = 50
const MAX_TOP_CHATS = 50
const MAX_TOP_MEMBERS = 999
const MAX_TOP_USERS = 999

/** `/search/query` page size when the caller does not ask for one. */
const DEFAULT_SEARCH_SIZE = 25

// ── Errors ────────────────────────────────────────────────────

/**
 * Any non-OK Graph response. Carries the HTTP status so a caller can branch
 * without parsing the message. `MsGraphAuthError` is the one subclass that
 * means "the credential is dead" — everything else (403 per-resource refusal,
 * 404, 429, 5xx) stays generic and must NOT kill the connector.
 *
 * The message is what the model ends up reading (the core tools flatten a
 * rejection into `Microsoft Teams error: <message>`), so it carries the status
 * and, on a throttle, the `Retry-After` the service asked for.
 */
export class MsGraphError extends Error {
  constructor(readonly status: number, detail: string) {
    super(`Microsoft Graph API error (${status}): ${detail}`)
    this.name = 'MsGraphError'
  }
}

/**
 * A 401 from Graph — the delegated credential is dead and only the user
 * reconnecting can fix it. Tagged so the caller can flip the
 * `connector_instance` to `auth_failed` without string-matching; the message
 * ALSO carries `(401)` and "invalid or expired" so the repo-wide
 * `classifyConnectorAuthError` (mcp/connector-health.ts) agrees when the error
 * has already been flattened to a string by a tool result.
 */
export class MsGraphAuthError extends MsGraphError {
  constructor(detail: string) {
    super(
      401,
      `Microsoft 365 token is invalid or expired. ` +
        `Please reconnect Microsoft Teams in Settings > Connectors. ${detail}`,
    )
    this.name = 'MsGraphAuthError'
  }
}

// ── Client ────────────────────────────────────────────────────

export interface MsGraphClientDeps {
  getAccessToken: () => Promise<string>
  fetchImpl?: typeof fetch
  retry?: (doFetch: () => Promise<Response>) => Promise<Response>
}

/**
 * The port the core tool layer declares for itself. Every method returns the
 * raw Graph body; collections come back as `{ value: [...] }` with any
 * `@odata.nextLink` pages already concatenated.
 */
export interface MsGraphApi {
  listTeams(params: { search?: string; limit?: number }): Promise<unknown>
  listChannels(params: { teamId: string; limit?: number }): Promise<unknown>
  listChannelMessages(params: {
    teamId: string
    channelId: string
    limit?: number
  }): Promise<unknown>
  listMessageReplies(params: {
    teamId: string
    channelId: string
    messageId: string
    limit?: number
  }): Promise<unknown>
  listChats(params: { limit?: number }): Promise<unknown>
  listChatMessages(params: { chatId: string; limit?: number }): Promise<unknown>
  listMembers(params: {
    teamId: string
    channelId?: string
    limit?: number
  }): Promise<unknown>
  searchMessages(params: { query: string; limit?: number }): Promise<unknown>
  findPeople(params: { query: string; teamId?: string; limit?: number }): Promise<unknown>
}

export function createMsGraphClient(deps: MsGraphClientDeps): MsGraphApi {
  const doFetch = deps.fetchImpl ?? fetch
  const retry = deps.retry ?? fetchWithRetry

  async function graphRequest(
    url: string,
    init?: RequestInit,
  ): Promise<Record<string, unknown>> {
    const token = await deps.getAccessToken()
    const res = await retry(() =>
      doFetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init?.headers as Record<string, string> | undefined),
        },
      }),
    )

    if (!res.ok) {
      const detail = await res.text()
      if (res.status === 401) throw new MsGraphAuthError(detail)
      // A 429 reaching here means the injected retry gave up; pass the
      // service's own wait hint through so the model can say how long.
      const retryAfter = res.headers.get('retry-after')
      throw new MsGraphError(
        res.status,
        retryAfter ? `retry after ${retryAfter}s. ${detail}` : detail,
      )
    }

    return (await res.json()) as Record<string, unknown>
  }

  /**
   * Walk an OData collection and return the combined rows under `value`.
   * `@odata.nextLink` is an opaque absolute URL carrying a `$skiptoken` — it is
   * followed verbatim, never reconstructed (research "could not confirm" item
   * 9: `/teams` documents no `$top` default or ceiling, so the link is the only
   * reliable cursor).
   *
   * `maxRows` stops the walk early. It makes a caller's `limit` authoritative
   * whether or not the endpoint honored `$top`, and keeps a small request from
   * paging through a large collection.
   */
  async function collect(
    firstUrl: string,
    maxRows?: number,
  ): Promise<{ value: unknown[] }> {
    const out: unknown[] = []
    let url: string | undefined = firstUrl

    for (let page = 0; url && page < MAX_PAGES; page++) {
      const body: Record<string, unknown> = await graphRequest(url)
      out.push(...((body.value ?? []) as unknown[]))
      if (maxRows !== undefined && out.length >= maxRows) break
      url = body['@odata.nextLink'] as string | undefined
    }

    return { value: maxRows === undefined ? out : out.slice(0, maxRows) }
  }

  return {
    async listTeams({ search, limit }) {
      // `/me` is delegated-only, and joinedTeams accepts no OData parameters
      // at all — so both `search` and `limit` are applied here rather than as
      // `$filter` / `$top`. With no search, `limit` can still brake the walk;
      // with one, every page has to be read because a match can sit on any.
      const { value } = await collect(
        `${GRAPH_API}/me/joinedTeams`,
        search ? undefined : limit,
      )
      const matched = search ? value.filter((row) => matchesText(row, search)) : value
      return { value: limit ? matched.slice(0, limit) : matched }
    },

    async listChannels({ teamId, limit }) {
      // `$top` is not documented on the channel-list endpoint (its own table
      // lists only `$filter` and `$select`), so `limit` is applied client-side.
      return collect(`${GRAPH_API}/teams/${enc(teamId)}/channels`, limit)
    },

    async listChannelMessages({ teamId, channelId, limit }) {
      return collect(
        `${GRAPH_API}/teams/${enc(teamId)}/channels/${enc(channelId)}/messages` +
          query({ $top: top(limit, MAX_TOP_MESSAGES) }),
        limit,
      )
    },

    async listChats({ limit }) {
      // A one-on-one chat has `topic: null` and is identifiable only by its
      // members, so members are expanded here rather than costing the caller a
      // second round trip. Documented limitation: `$expand=members` returns at
      // most 25 member items regardless of `$top`.
      return collect(
        `${GRAPH_API}/me/chats` +
          query({ $expand: 'members', $top: top(limit, MAX_TOP_CHATS) }),
        limit,
      )
    },

    async findPeople({ query: q, teamId, limit }) {
      const guid = isGuid(q) ? q.toLowerCase() : undefined

      if (teamId) {
        // Guests exist only on a roster, never in the directory. The roster
        // $filter Graph documents is `eq` (exact), which cannot serve the
        // partial name this takes, so the roster is listed and matched here.
        const { value } = await collect(`${GRAPH_API}/teams/${enc(teamId)}/members`)
        const matched = value.filter((row) =>
          guid ? matchesEntraId(row, guid) : matchesText(row, q),
        )
        return { value: limit ? matched.slice(0, limit) : matched }
      }

      if (guid) {
        // An Entra object id is not matchable by `startsWith`, so a GUID is
        // addressed as a resource.
        //
        // A 404 is returned as DATA, not as a throw, and that is load-bearing:
        // the tool layer turns an empty collection into `matched: 0` ("nobody
        // matched"), but turns a rejection into `isError: true` with the raw
        // status, which a model reads as a broken tool and answers by retrying
        // or giving up. "No such user" is an ordinary answer to a lookup. Do
        // not "fix" this into a throw.
        const user = await graphRequest(`${GRAPH_API}/users/${enc(guid)}`).catch(
          (err: unknown) => {
            if (err instanceof MsGraphError && err.status === 404) return undefined
            throw err
          },
        )
        return { value: user ? [user] : [] }
      }

      // `startsWith` on these three is "Default+Advanced", so it needs no
      // ConsistencyLevel header — unlike `$search` (research §2.3).
      const lit = odataString(q)
      const filter = [
        `startsWith(displayName,${lit})`,
        `startsWith(mail,${lit})`,
        `startsWith(userPrincipalName,${lit})`,
      ].join(' or ')

      return collect(
        `${GRAPH_API}/users` +
          query({ $filter: filter, $top: top(limit, MAX_TOP_USERS) }),
        limit,
      )
    },

    async searchMessages({ query: queryString, limit }) {
      // Search is delegated-only and has no application-permission path
      // (research §2.1). The response is returned exactly as Graph sent it:
      // hits nest under value[0].hitsContainers[0], and `moreResultsAvailable`
      // lives on the container, so collection pagination must not touch it.
      return graphRequest(`${GRAPH_API}/search/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [
            {
              entityTypes: ['chatMessage'],
              query: { queryString },
              from: 0,
              size: limit ?? DEFAULT_SEARCH_SIZE,
            },
          ],
        }),
      })
    },

    async listMembers({ teamId, channelId, limit }) {
      const base = channelId
        ? `${GRAPH_API}/teams/${enc(teamId)}/channels/${enc(channelId)}/members`
        : `${GRAPH_API}/teams/${enc(teamId)}/members`
      return collect(base + query({ $top: top(limit, MAX_TOP_MEMBERS) }), limit)
    },

    async listChatMessages({ chatId, limit }) {
      return collect(
        `${GRAPH_API}/chats/${enc(chatId)}/messages` +
          query({ $top: top(limit, MAX_TOP_MESSAGES) }),
        limit,
      )
    },

    async listMessageReplies({ teamId, channelId, messageId, limit }) {
      return collect(
        `${GRAPH_API}/teams/${enc(teamId)}/channels/${enc(channelId)}` +
          `/messages/${enc(messageId)}/replies` +
          query({ $top: top(limit, MAX_TOP_MESSAGES) }),
        limit,
      )
    },
  }
}

// ── Query helpers ─────────────────────────────────────────────

/** Percent-encode one path segment. Channel ids carry `:` and `@`. */
function enc(segment: string): string {
  return encodeURIComponent(segment)
}

/**
 * Quote a value as an OData string literal. A single quote inside the value
 * must be doubled — otherwise it terminates the literal early, which is both a
 * 400 and the injection seam on every `$filter` this client builds.
 */
function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** Clamp a caller's `limit` to an endpoint's documented `$top` ceiling. */
function top(limit: number | undefined, max: number): number | undefined {
  return limit ? Math.min(limit, max) : undefined
}

/**
 * Build a query string, dropping undefined values. Keys stay literal (`$top`,
 * `$filter`) and values are percent-encoded, so an OData filter carrying
 * spaces and quotes survives transport.
 */
function query(parts: Record<string, string | number | undefined>): string {
  const entries = Object.entries(parts).filter(([, v]) => v !== undefined)
  if (entries.length === 0) return ''
  return '?' + entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')
}

/** An Entra object id, as it appears in `from.user.id` and on roster rows. */
function isGuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim())
}

/**
 * Exact match on a row's Entra object id, whichever of its three spellings the
 * row happens to carry: `userId` is Graph's aadUserConversationMember,
 * `objectId` the Bot Framework roster, `aadObjectId` the Activity. A directory
 * row has none of them and its plain `id` IS the Entra id; a roster row's `id`
 * is the opaque membership id, so `id` is only consulted when no explicit
 * object-id field is present.
 */
function matchesEntraId(row: unknown, guid: string): boolean {
  const o = row as Record<string, unknown>
  const explicit = [o.userId, o.objectId, o.aadObjectId].find((v) => typeof v === 'string')
  const candidate = explicit ?? o.id
  return typeof candidate === 'string' && candidate.toLowerCase() === guid
}

/**
 * Case-insensitive substring match across the name/address fields a Graph row
 * might carry. Used where the endpoint has no server-side filter to lean on.
 */
function matchesText(row: unknown, needle: string): boolean {
  const o = row as Record<string, unknown>
  const hay = needle.trim().toLowerCase()
  return [o.displayName, o.email, o.mail, o.userPrincipalName].some(
    (f) => typeof f === 'string' && f.toLowerCase().includes(hay),
  )
}
