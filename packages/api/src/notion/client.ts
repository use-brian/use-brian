/**
 * Notion API client — thin fetch-based wrappers.
 *
 * No heavy SDK. Each function takes an access token and makes a single
 * API call. Notion tokens are long-lived (no refresh step).
 *
 * See docs/architecture/integrations/notion.md.
 */

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

  if (!res.ok) {
    const err = await res.text()
    if (res.status === 401) {
      throw new Error('Notion token is invalid or expired. Please reconnect Notion in Settings > Connectors.')
    }
    throw new Error(`Notion API error (${res.status}): ${err}`)
  }

  return res.json()
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
