/**
 * Notion API client — thin fetch-based wrappers.
 *
 * No heavy SDK. Each function takes an access token and makes a single
 * API call. Notion tokens are long-lived (no refresh step).
 *
 * See docs/architecture/integrations/notion.md.
 */

import { ConnectorApiError, type ConnectorFailureKind } from '@use-brian/core'

const NOTION_API = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'
const MAX_BLOCK_PAGES = 5 // Cap block pagination at ~500 blocks

function headers(accessToken: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${accessToken}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  }
}

async function notionFetch(
  accessToken: string,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const res = await fetch(`${NOTION_API}${path}`, {
    ...init,
    headers: { ...headers(accessToken), ...(init?.headers as Record<string, string> | undefined) },
  })

  if (!res.ok) throw await notionApiError(res)

  return res.json()
}

/**
 * Turn a non-2xx Notion response into a structured `ConnectorApiError`
 * (core `_connector-result.ts`), rendered by the tools through
 * `connectorError()`. Notion's body is `{ object: 'error', status, code,
 * message }` and `message` already carries the property path on a
 * `validation_error` (`body.properties.Status.select.name should be …`), so
 * it is kept verbatim (capped). The code maps onto the failure kind:
 * `object_not_found` / `restricted_resource` (the integration was not shared
 * the page — a 404 in Notion's model), `unauthorized` / `invalid_grant`,
 * `rate_limited` (with `Retry-After`), `conflict_error`,
 * `internal_server_error` / `service_unavailable`. The 401 keeps `(401)` +
 * `invalid or expired` for the health classifier.
 */
export async function notionApiError(res: Response): Promise<ConnectorApiError> {
  let raw = ''
  try { raw = await res.text() } catch { raw = '' }
  let message = raw
  let code: string | undefined
  try {
    const parsed = JSON.parse(raw) as { message?: unknown; code?: unknown }
    if (typeof parsed.message === 'string' && parsed.message) message = parsed.message
    if (typeof parsed.code === 'string') code = parsed.code
  } catch {
    // non-JSON body — raw text is the message
  }
  const KIND: Record<string, ConnectorFailureKind> = {
    unauthorized: 'auth',
    invalid_grant: 'auth',
    restricted_resource: 'not_found',
    object_not_found: 'not_found',
    rate_limited: 'rate_limit',
    conflict_error: 'conflict',
    validation_error: 'validation',
    invalid_json: 'validation',
    invalid_request_url: 'validation',
    invalid_request: 'validation',
    missing_version: 'validation',
    internal_server_error: 'transient',
    service_unavailable: 'transient',
    database_connection_unavailable: 'transient',
    gateway_timeout: 'transient',
  }
  let kind = code ? KIND[code] : undefined
  if (res.status === 401) {
    kind = 'auth'
    message = `Notion token is invalid or expired: ${message}`
  }
  const retryAfter = res.headers?.get?.('retry-after')
  return new ConnectorApiError({
    provider: 'Notion',
    status: res.status,
    code,
    message,
    kind,
    retryAfterSec: retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined,
  })
}

// ── Search ───────────────────────────────────────────────────

export async function searchNotion(
  accessToken: string,
  params: {
    query?: string
    filter?: 'page' | 'database'
    pageSize?: number
  },
): Promise<unknown> {
  const body: Record<string, unknown> = {}
  if (params.query) body.query = params.query
  if (params.filter) body.filter = { value: params.filter, property: 'object' }
  if (params.pageSize) body.page_size = params.pageSize

  return notionFetch(accessToken, '/search', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

// ── Pages ────────────────────────────────────────────────────

export async function getNotionPage(
  accessToken: string,
  pageId: string,
): Promise<{ page: unknown; blocks: unknown[] }> {
  // Fetch page properties and block children in parallel
  const [page, blocks] = await Promise.all([
    notionFetch(accessToken, `/pages/${encodeURIComponent(pageId)}`),
    fetchAllBlocks(accessToken, pageId),
  ])

  return { page, blocks }
}

async function fetchAllBlocks(
  accessToken: string,
  blockId: string,
): Promise<unknown[]> {
  const allBlocks: unknown[] = []
  let cursor: string | undefined

  for (let i = 0; i < MAX_BLOCK_PAGES; i++) {
    const qs = cursor ? `?start_cursor=${cursor}` : ''
    const data = await notionFetch(
      accessToken,
      `/blocks/${encodeURIComponent(blockId)}/children${qs}`,
    ) as { results: unknown[]; has_more: boolean; next_cursor: string | null }

    allBlocks.push(...data.results)
    if (!data.has_more || !data.next_cursor) break
    cursor = data.next_cursor
  }

  return allBlocks
}

export async function createNotionPage(
  accessToken: string,
  params: {
    parentId: string
    parentType: 'page' | 'database'
    title: string
    properties?: Record<string, unknown>
    content?: string
  },
): Promise<unknown> {
  const parent = params.parentType === 'database'
    ? { database_id: params.parentId }
    : { page_id: params.parentId }

  const properties = params.parentType === 'database'
    ? { ...params.properties, title: { title: [{ text: { content: params.title } }] } }
    : { title: { title: [{ text: { content: params.title } }] } }

  const body: Record<string, unknown> = { parent, properties }

  if (params.content) {
    body.children = textToBlocks(params.content)
  }

  return notionFetch(accessToken, '/pages', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function updateNotionPage(
  accessToken: string,
  pageId: string,
  params: {
    properties?: Record<string, unknown>
    archived?: boolean
  },
): Promise<unknown> {
  const body: Record<string, unknown> = {}
  if (params.properties) body.properties = params.properties
  if (params.archived !== undefined) body.archived = params.archived

  return notionFetch(accessToken, `/pages/${encodeURIComponent(pageId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export async function appendNotionBlocks(
  accessToken: string,
  pageId: string,
  content: string,
): Promise<unknown> {
  return notionFetch(accessToken, `/blocks/${encodeURIComponent(pageId)}/children`, {
    method: 'PATCH',
    body: JSON.stringify({ children: textToBlocks(content) }),
  })
}

// ── Databases ────────────────────────────────────────────────

export async function getNotionDatabase(
  accessToken: string,
  databaseId: string,
): Promise<unknown> {
  return notionFetch(accessToken, `/databases/${encodeURIComponent(databaseId)}`)
}

export async function queryNotionDatabase(
  accessToken: string,
  databaseId: string,
  params: {
    filter?: Record<string, unknown>
    sorts?: Array<{ property: string; direction: 'ascending' | 'descending' }>
    pageSize?: number
  },
): Promise<unknown> {
  const body: Record<string, unknown> = {}
  if (params.filter) body.filter = params.filter
  if (params.sorts) body.sorts = params.sorts
  if (params.pageSize) body.page_size = params.pageSize

  return notionFetch(accessToken, `/databases/${encodeURIComponent(databaseId)}/query`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * Convert plain text to Notion block objects.
 * Splits on double newlines into paragraphs.
 */
function textToBlocks(text: string): unknown[] {
  return text.split(/\n\n+/).map((paragraph) => ({
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [{ type: 'text', text: { content: paragraph.trim() } }],
    },
  }))
}
