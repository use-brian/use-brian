import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  WORKSPACE_SEARCH_FAMILIES, normalizeWorkspaceSearchText,
  type WorkspaceSearchFamily, type WorkspaceSearchItem, type WorkspaceSearchRequest,
  type WorkspaceSearchResponse,
} from '@use-brian/shared'

/** Each adapter returns canonical, authorized rows in this common order. */
export type SearchCandidate = WorkspaceSearchItem & { relevance: number }
export type SearchScope = { userId: string; workspaceId: string }
export type SearchAdapter = (input: SearchScope & {
  query: string; offset: number; limit: number; signal: AbortSignal
}) => Promise<SearchCandidate[]>
export type SearchAdapters = Record<WorkspaceSearchFamily, SearchAdapter>

const MATCH_ORDER = { exact: 0, prefix: 1, tokens: 2, partial: 3, body: 4 }
export function compareSearchCandidates(a: SearchCandidate, b: SearchCandidate): number {
  return MATCH_ORDER[a.match] - MATCH_ORDER[b.match]
    || b.relevance - a.relevance
    || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
}

export class InvalidSearchRequest extends Error {
  constructor() { super('Invalid workspace search request') }
}

export function parseSearchRequest(raw: Record<string, unknown>): Required<Pick<WorkspaceSearchRequest, 'q' | 'limit'>> & WorkspaceSearchRequest {
  if (Object.keys(raw).some(key => !['q', 'kind', 'limit', 'cursor'].includes(key))) throw new InvalidSearchRequest()
  if (typeof raw.q !== 'string') throw new InvalidSearchRequest()
  const q = raw.q.trim()
  if (!q || [...q].length > 500) throw new InvalidSearchRequest()
  if (raw.kind !== undefined && !(WORKSPACE_SEARCH_FAMILIES as readonly unknown[]).includes(raw.kind)) throw new InvalidSearchRequest()
  if (raw.limit !== undefined && (typeof raw.limit !== 'string' || !/^\d+$/.test(raw.limit))) throw new InvalidSearchRequest()
  const limit = raw.limit === undefined ? 30 : Number(raw.limit)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new InvalidSearchRequest()
  if (raw.cursor !== undefined && (typeof raw.cursor !== 'string' || !raw.cursor || raw.cursor.length > 4096)) throw new InvalidSearchRequest()
  return { q, limit, kind: raw.kind as WorkspaceSearchFamily | undefined, cursor: raw.cursor as string | undefined }
}

type Cursor = { version: 1; binding: string; offsets: Partial<Record<WorkspaceSearchFamily, number>> }
const processKey = randomBytes(32)

/** No query or result text in cursors, logs, or errors; every page rechecks access. */
export function createWorkspaceSearchService(adapters: SearchAdapters, options: { key?: Buffer; deadlineMs?: number } = {}) {
  const key = options.key ?? processKey
  const sign = (value: string) => createHmac('sha256', key).update(value).digest('base64url')
  const encode = (value: Cursor) => {
    const payload = Buffer.from(JSON.stringify(value)).toString('base64url')
    return `${payload}.${sign(payload)}`
  }
  const decode = (token: string, binding: string): Cursor => {
    try {
      const [payload, mac, extra] = token.split('.')
      if (!payload || !mac || extra) throw new InvalidSearchRequest()
      const expected = Buffer.from(sign(payload)), actual = Buffer.from(mac)
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new InvalidSearchRequest()
      const value = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Cursor
      if (value.version !== 1 || value.binding !== binding || !value.offsets || typeof value.offsets !== 'object') throw new InvalidSearchRequest()
      for (const [family, offset] of Object.entries(value.offsets)) {
        if (!(WORKSPACE_SEARCH_FAMILIES as readonly string[]).includes(family) || !Number.isSafeInteger(offset) || offset < 0) throw new InvalidSearchRequest()
      }
      return value
    } catch { throw new InvalidSearchRequest() }
  }
  return async (scope: SearchScope, request: WorkspaceSearchRequest, signal?: AbortSignal): Promise<WorkspaceSearchResponse> => {
    const query = normalizeWorkspaceSearchText(request.q)
    const limit = request.limit ?? 30
    const binding = sign(JSON.stringify([scope.userId, scope.workspaceId, query, request.kind ?? null, 1]))
    const state = request.cursor ? decode(request.cursor, binding) : { version: 1 as const, binding, offsets: {} as Cursor['offsets'] }
    const families = request.kind ? [request.kind] : [...WORKSPACE_SEARCH_FAMILIES]
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) controller.abort()
    const timer = setTimeout(abort, options.deadlineMs ?? 2000)
    try {
      const results = await Promise.all(families.map(async family => {
        let remove = () => {}
        try {
          const cancelled = new Promise<never>((_, reject) => {
            const fail = () => reject(new Error('Search cancelled'))
            remove = () => controller.signal.removeEventListener('abort', fail)
            if (controller.signal.aborted) fail()
            else controller.signal.addEventListener('abort', fail, { once: true })
          })
          const rows = await Promise.race([cancelled, adapters[family]({ ...scope, query, offset: state.offsets[family] ?? 0, limit: limit + 1, signal: controller.signal })])
          return { family, rows }
        } catch { return { family, rows: null } }
        finally { remove() }
      }))
      const unavailableFamilies = results.filter(result => result.rows === null).map(result => result.family)
      const candidates = results.flatMap(result => (result.rows ?? []).map(row => ({ family: result.family, row })))
        .sort((a, b) => compareSearchCandidates(a.row, b.row))
      const selected = candidates.slice(0, limit)
      const offsets = { ...state.offsets }
      for (const item of selected) offsets[item.family] = (offsets[item.family] ?? 0) + 1
      const hasMore = candidates.length > selected.length || results.some(result => result.rows?.length === limit + 1)
      return {
        items: selected.map(({ row: { relevance: _relevance, ...row } }) => ({ ...row, snippet: [...row.snippet].slice(0, 240).join('') })),
        nextCursor: hasMore || unavailableFamilies.length ? encode({ version: 1, binding, offsets }) : null,
        completeness: unavailableFamilies.length ? 'partial' : 'complete', unavailableFamilies,
      }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }
}
