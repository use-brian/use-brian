/**
 * Notion tools — search, read, and create/update pages and databases.
 *
 * Read tools are concurrency-safe; write tools require confirmation.
 * The `api` callback object is injected by the API layer so core stays
 * free of network/OAuth deps.
 *
 * See docs/architecture/integrations/notion.md.
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../types.js'
import { type Json, str, obj, asRows, projectList } from './_connector-result.js'

// ── Notion result projections ──────────────────────────────────
// Notion objects are the heaviest connector payloads: every property is a
// rich object (arrays of rich_text runs with per-run annotations, colors,
// hrefs), plus parent / created_by / last_edited_by / icon / cover / URL
// spam. A search or query of a few rows can run tens of KB. These projections
// flatten properties to plain values and keep only the fields the model uses.
// See `_connector-result.ts`.

/** Join a rich_text / title array down to its plain text. */
function plainText(arr: unknown): string {
  return asRows(arr).map((r) => str(r, 'plain_text') ?? '').join('')
}

/** Flatten a single Notion property object to a plain JS value. */
function plainProp(prop: Json): unknown {
  const type = str(prop, 'type')
  if (!type) return undefined
  const v = prop[type]
  switch (type) {
    case 'title':
    case 'rich_text':
      return plainText(v)
    case 'number':
    case 'checkbox':
    case 'url':
    case 'email':
    case 'phone_number':
      return v
    case 'select':
    case 'status':
      return str((v ?? {}) as Json, 'name')
    case 'multi_select':
      return asRows(v).map((o) => str(o, 'name'))
    case 'date':
      return v ? { start: str(v as Json, 'start'), end: str(v as Json, 'end') } : null
    case 'people':
      return asRows(v).map((p) => str(p, 'name') ?? str(p, 'id'))
    case 'relation':
      return asRows(v).map((r) => str(r, 'id'))
    case 'formula':
    case 'rollup':
      return v && typeof v === 'object' ? (v as Json)[str(v as Json, 'type') ?? ''] : undefined
    default:
      return undefined // files, created_by, etc. — drop
  }
}

/** Extract a page's display title from its `properties` map. */
function pageTitle(props: Json): string | undefined {
  for (const key of Object.keys(props)) {
    const p = props[key]
    if (typeof p === 'object' && p !== null && str(p as Json, 'type') === 'title') {
      return plainText((p as Json).title)
    }
  }
  return undefined
}

/** A search hit (page or database) → id, type, title, url. */
function searchRow(o: Json) {
  const isDb = str(o, 'object') === 'database'
  return {
    id: str(o, 'id'),
    object: str(o, 'object'),
    url: str(o, 'url'),
    title: isDb ? plainText(o.title) : pageTitle(obj(o, 'properties') ?? {}),
    last_edited_time: str(o, 'last_edited_time'),
  }
}

/** A database row → id, url, and flattened property values. */
function dbRow(o: Json) {
  const props = obj(o, 'properties') ?? {}
  const flat: Json = {}
  for (const key of Object.keys(props)) flat[key] = plainProp(props[key] as Json)
  return { id: str(o, 'id'), url: str(o, 'url'), properties: flat }
}

export type NotionApi = {
  search(params: {
    query?: string
    filter?: 'page' | 'database'
    pageSize?: number
  }): Promise<unknown>

  getPage(pageId: string): Promise<unknown>

  getDatabase(databaseId: string): Promise<unknown>

  queryDatabase(
    databaseId: string,
    params: {
      filter?: Record<string, unknown>
      sorts?: Array<{ property: string; direction: 'ascending' | 'descending' }>
      pageSize?: number
    },
  ): Promise<unknown>

  createPage(params: {
    parentId: string
    parentType: 'page' | 'database'
    title: string
    properties?: Record<string, unknown>
    content?: string
  }): Promise<unknown>

  updatePage(
    pageId: string,
    params: {
      properties?: Record<string, unknown>
      archived?: boolean
    },
  ): Promise<unknown>

  appendBlocks(pageId: string, content: string): Promise<unknown>
}

export function createNotionTools(api: NotionApi): Tool[] {
  const search = buildTool({
    name: 'notionSearch',
    description:
      'Search pages and databases in the user\'s Notion workspace. ' +
      'Returns titles, IDs, and snippets. Use the ID from results to read full content with notionGetPage.',
    inputSchema: z.object({
      query: z.string().optional().describe('Search query. Omit to list recent pages.'),
      filter: z.enum(['page', 'database']).optional().describe('Filter results by type.'),
      pageSize: z.number().optional().describe('Max results to return (default 10).'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const data = await api.search({
          query: input.query,
          filter: input.filter,
          pageSize: input.pageSize,
        })
        return { data: projectList(asRows(((data ?? {}) as Json).results), input.pageSize ?? 10, searchRow) }
      } catch (err) {
        return { data: `Notion error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const getPage = buildTool({
    name: 'notionGetPage',
    description:
      'Get a Notion page with its properties and content blocks. ' +
      'Use a page ID from notionSearch results.',
    inputSchema: z.object({
      pageId: z.string().describe('The Notion page ID.'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const data = await api.getPage(input.pageId)
        const p = (data ?? {}) as Json
        const props = obj(p, 'properties') ?? {}
        const flat: Json = {}
        for (const key of Object.keys(props)) flat[key] = plainProp(props[key] as Json)
        return { data: {
          id: str(p, 'id'),
          url: str(p, 'url'),
          title: pageTitle(props),
          created_time: str(p, 'created_time'),
          last_edited_time: str(p, 'last_edited_time'),
          properties: flat,
          // Preserve page body if the adapter inlined it (blocks / content / children).
          content: p.content ?? p.blocks ?? p.children,
        } }
      } catch (err) {
        return { data: `Notion error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const getDatabase = buildTool({
    name: 'notionGetDatabase',
    description:
      'Get a Notion database schema — its title, properties (columns), and their types. ' +
      'Use this to understand the structure before querying with notionQueryDatabase.',
    inputSchema: z.object({
      databaseId: z.string().describe('The Notion database ID.'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 10_000,

    async execute(input) {
      try {
        const data = await api.getDatabase(input.databaseId)
        const d = (data ?? {}) as Json
        const props = obj(d, 'properties') ?? {}
        const schema: Json = {}
        for (const key of Object.keys(props)) schema[key] = str(props[key] as Json, 'type')
        return { data: { id: str(d, 'id'), url: str(d, 'url'), title: plainText(d.title), properties: schema } }
      } catch (err) {
        return { data: `Notion error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const queryDatabase = buildTool({
    name: 'notionQueryDatabase',
    description:
      'Query a Notion database with optional filters and sorts. ' +
      'First use notionGetDatabase to understand the schema, then build filters based on property names and types.',
    inputSchema: z.object({
      databaseId: z.string().describe('The Notion database ID.'),
      filter: z.record(z.unknown()).optional().describe('Notion filter object. See Notion API docs for filter syntax.'),
      sorts: z.array(z.object({
        property: z.string(),
        direction: z.enum(['ascending', 'descending']),
      })).optional().describe('Sort order.'),
      pageSize: z.number().optional().describe('Max results to return (default 100).'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const data = await api.queryDatabase(input.databaseId, {
          filter: input.filter,
          sorts: input.sorts,
          pageSize: input.pageSize,
        })
        return { data: projectList(asRows(((data ?? {}) as Json).results), input.pageSize ?? 100, dbRow) }
      } catch (err) {
        return { data: `Notion error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const createPage = buildTool({
    name: 'notionCreatePage',
    description:
      'Create a new page in Notion. Can be a child of another page or a new row in a database. ' +
      'For database pages, include properties matching the database schema. ' +
      'Call this tool directly — the user will see an Approve/Deny prompt.',
    inputSchema: z.object({
      parentId: z.string().describe('Parent page ID or database ID.'),
      parentType: z.enum(['page', 'database']).describe('Whether the parent is a page or database.'),
      title: z.string().describe('Page title.'),
      properties: z.record(z.unknown()).optional().describe('Additional properties (for database pages).'),
      content: z.string().optional().describe('Page body text. Will be added as paragraph blocks.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const data = await api.createPage({
          parentId: input.parentId,
          parentType: input.parentType,
          title: input.title,
          properties: input.properties,
          content: input.content,
        })
        const p = (data ?? {}) as Json
        return { data: { id: str(p, 'id'), url: str(p, 'url') } }
      } catch (err) {
        return { data: `Notion error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const updatePage = buildTool({
    name: 'notionUpdatePage',
    description:
      'Update properties of an existing Notion page. Can also archive (soft-delete) a page. ' +
      'Call this tool directly — the user will see an Approve/Deny prompt.',
    inputSchema: z.object({
      pageId: z.string().describe('The Notion page ID to update.'),
      properties: z.record(z.unknown()).optional().describe('Properties to update.'),
      archived: z.boolean().optional().describe('Set to true to archive the page.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 10_000,

    async execute(input) {
      try {
        const data = await api.updatePage(input.pageId, {
          properties: input.properties,
          archived: input.archived,
        })
        const p = (data ?? {}) as Json
        return { data: { id: str(p, 'id'), url: str(p, 'url'), archived: p.archived } }
      } catch (err) {
        return { data: `Notion error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const appendBlocks = buildTool({
    name: 'notionAppendBlocks',
    description:
      'Append content to an existing Notion page. Adds new paragraph blocks at the end. ' +
      'Call this tool directly — the user will see an Approve/Deny prompt.',
    inputSchema: z.object({
      pageId: z.string().describe('The Notion page ID to append to.'),
      content: z.string().describe('Text content to append. Separate paragraphs with blank lines.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const data = await api.appendBlocks(input.pageId, input.content)
        const r = (data ?? {}) as Json
        return { data: { ok: true, appended: asRows(r.results).length || undefined } }
      } catch (err) {
        return { data: `Notion error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  return [search, getPage, getDatabase, queryDatabase, createPage, updatePage, appendBlocks]
}
