/** Complete traversal of an authorized SQL selection, ordered by creation/id.
 * [COMP:crm/operations-pagination]
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { QueryResultRow } from 'pg'
import { CrmOperationsError } from '@use-brian/core/crm/operations-types.js'
import { CrmPageQuerySchema, type CrmPage, type CrmPageQuery } from '@use-brian/core/crm/pagination.js'

type Query = <T extends QueryResultRow>(sql: string, values: unknown[]) => Promise<{ rows: T[] }>
const Instant = z.string().datetime({ offset: true }).refine((value) => !value.startsWith('0000-') && Number.isFinite(Date.parse(value)))
const Tuple = z.object({ at: Instant, id: z.string().min(1).max(512) }).strict()
const Cursor = z.object({ v: z.literal(1), binding: z.string().regex(/^[0-9a-f]{64}$/),
  upper: Tuple, after: Tuple, evaluatedAt: Instant }).strict()
type CursorValue = z.infer<typeof Cursor>

function invalid(message = 'Invalid CRM cursor for this workspace, resource or query.'): never {
  throw new CrmOperationsError('invalid_input', message)
}
export function crmPageInstant(value: string): string {
  if (!Instant.safeParse(value).success) return invalid('Invalid CRM page instant.')
  const fraction = /\.(\d+)/.exec(value)?.[1] ?? ''
  if (fraction.length > 6) return invalid('CRM page instants support up to six fractional digits.')
  return `${new Date(value).toISOString().slice(0, 19)}.${fraction.padEnd(6, '0')}Z`
}
function canonical(value: unknown): unknown {
  if (value instanceof Date) return crmPageInstant(value.toISOString())
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, canonical(item)]))
  return value
}
function tupleKey(tuple: z.infer<typeof Tuple>): string { return `${crmPageInstant(tuple.at)}:${tuple.id.toLowerCase()}` }
const timestamp = (expression: string) => `to_char(${expression} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`

/** `sql` must select a unique UUID `id` (or a text key with idType=text) and timestamptz `createdAt`, without a
 * collection ORDER/LIMIT. It must already enforce workspace and read authority.
 * Domain predicates may use (SELECT at FROM crm_page_context) for stable DB time.
 */
export async function queryCrmPage<Key extends string, Item extends QueryResultRow = Record<string, unknown>>(
  run: Query,
  options: { workspaceId: string; resource: string; key: Key; sql: string; params: unknown[]; query?: CrmPageQuery; idType?: 'uuid' | 'text' },
): Promise<CrmPage<Key, Item>> {
  const input = CrmPageQuerySchema.parse(options.query ?? {})
  const createdAfter = input.createdAfter ? crmPageInstant(input.createdAfter) : null
  const createdBefore = input.createdBefore ? crmPageInstant(input.createdBefore) : null
  if (createdAfter && createdBefore && createdAfter >= createdBefore) invalid('createdAfter must precede createdBefore.')
  const binding = createHash('sha256').update(JSON.stringify(canonical({ workspaceId: options.workspaceId,
    resource: options.resource, sql: options.sql, idType: options.idType ?? 'uuid', params: options.params, createdAfter, createdBefore }))).digest('hex')
  let cursor: CursorValue | undefined
  if (input.cursor) {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(input.cursor)) invalid()
      cursor = Cursor.parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')))
      if (cursor.binding !== binding) invalid()
      if (crmPageInstant(cursor.after.at) > crmPageInstant(cursor.upper.at)) invalid()
      if (options.idType !== 'text' && (!z.string().uuid().safeParse(cursor.after.id).success
        || !z.string().uuid().safeParse(cursor.upper.id).success || tupleKey(cursor.after) > tupleKey(cursor.upper))) invalid()
    } catch { invalid() }
  }
  const idType = options.idType ?? 'uuid'
  const idExpression = idType === 'text' ? 'candidate.id COLLATE "C"' : 'candidate.id'
  const boundId = (placeholder: string) => idType === 'text' ? `${placeholder}::text COLLATE "C"` : `${placeholder}::uuid`
  const params = [...options.params]
  const parameter = (value: unknown) => { params.push(value); return `$${params.length}` }
  const evaluatedAt = parameter(cursor?.evaluatedAt ?? null)
  const lower = parameter(createdAfter), upperTime = parameter(createdBefore)
  const upperAt = parameter(cursor?.upper.at ?? null), upperId = parameter(cursor?.upper.id ?? null)
  const afterAt = parameter(cursor?.after.at ?? null), afterId = parameter(cursor?.after.id ?? null)
  const limit = parameter(input.limit + 1)
  const result = await run<Item & { id: string; __cursorAt: string; __evaluatedAt: string }>(`
    WITH crm_page_context AS (SELECT coalesce(${evaluatedAt}::timestamptz,statement_timestamp()) AS at)
    SELECT candidate.*,${timestamp('candidate."createdAt"')} AS "__cursorAt",
      ${timestamp('(SELECT at FROM crm_page_context)')} AS "__evaluatedAt"
    FROM (${options.sql}) candidate
    WHERE (${lower}::timestamptz IS NULL OR candidate."createdAt">=${lower}::timestamptz)
      AND (${upperTime}::timestamptz IS NULL OR candidate."createdAt"<${upperTime}::timestamptz)
      AND (${upperAt}::timestamptz IS NULL OR (candidate."createdAt",${idExpression})<=(${upperAt}::timestamptz,${boundId(upperId)}))
      AND (${afterAt}::timestamptz IS NULL OR (candidate."createdAt",${idExpression})<(${afterAt}::timestamptz,${boundId(afterId)}))
    ORDER BY candidate."createdAt" DESC,${idExpression} DESC LIMIT ${limit}`, params)
  const rows = result.rows.slice(0, input.limit), first = rows[0], last = rows.at(-1)
  let nextCursor: string | null = null
  if (result.rows.length > input.limit && first && last) {
    const next: CursorValue = { v: 1, binding, upper: cursor?.upper ?? { at: first.__cursorAt, id: first.id },
      after: { at: last.__cursorAt, id: last.id }, evaluatedAt: cursor?.evaluatedAt ?? first.__evaluatedAt }
    Cursor.parse(next)
    nextCursor = Buffer.from(JSON.stringify(next)).toString('base64url')
  }
  return { [options.key]: rows.map(({ __cursorAt: _at, __evaluatedAt: _time, ...row }) => row), nextCursor } as CrmPage<Key, Item>
}
