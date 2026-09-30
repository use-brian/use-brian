/** Narrow delegated Outlook transport. [COMP:api/external-app-outlook-calendar] */
import { createHash } from 'node:crypto'
import { z } from 'zod'

const OpaqueId = z.string().min(1).max(1024).refine(value => !/[\r\n\x00]/.test(value))
const Version = z.string().min(3).max(1024).regex(/^(?:W\/)?"[^"\r\n]+"$/)
const StableKey = z.string().trim().min(1).max(200)
export const CalendarEventInput = z.object({
  subject: z.string().trim().min(1).max(255), body: z.string().max(20_000),
  start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }),
}).strict().refine(value => Date.parse(value.end) > Date.parse(value.start), 'end must follow start')
export const CalendarUpsertInput = z.object({
  stableKey: StableKey, providerId: OpaqueId.nullable(), expectedVersion: Version.nullable(), event: CalendarEventInput,
}).strict().refine(value => (value.providerId === null) === (value.expectedVersion === null), 'providerId and expectedVersion must be supplied together')
export const CalendarReconcileInput = z.object({ stableKey: StableKey, providerId: OpaqueId.nullable() }).strict()
export type CalendarUpsert = z.infer<typeof CalendarUpsertInput>
export type CalendarReconcile = z.infer<typeof CalendarReconcileInput>
export type CalendarContext = { userId: string; workspaceId: string; connectorInstanceId: string; calendarId: string; correlationId: string }
export type CalendarReceipt = {
  status: 'created' | 'updated' | 'reconciled' | 'not_found'
  event: null | { providerId: string; version: string; stableKey: string; contentHash: string; subject: string; start: string; end: string }
  correlationId: string
}
export class CalendarError extends Error {
  constructor(readonly code: string, readonly status = 503, readonly outcome: 'rejected' | 'unknown' = 'rejected', readonly retryAfter?: string) {
    super(code); this.name = 'CalendarError'
  }
}
// App-owned MAPI named properties, not caller-selected property definitions.
export const CALENDAR_KEY_PROPERTY = 'String {6cb08de4-1824-4ed0-9c04-57b7b6eb7b17} Name ExternalAppCalendarKey'
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const transactionId = (hash: string) => `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
function normalize(event: z.infer<typeof CalendarEventInput>) {
  return { subject: event.subject, body: event.body, start: new Date(event.start).toISOString(), end: new Date(event.end).toISOString() }
}
const GraphEvent = z.object({
  id: OpaqueId, '@odata.etag': Version,
  subject: z.string(), body: z.object({ contentType: z.string(), content: z.string() }),
  start: z.object({ dateTime: z.string(), timeZone: z.literal('UTC') }),
  end: z.object({ dateTime: z.string(), timeZone: z.literal('UTC') }),
  singleValueExtendedProperties: z.array(z.object({ id: z.string(), value: z.string() })),
}).passthrough()
type ProviderEvent = z.infer<typeof GraphEvent>
function instant(value: string): string {
  const at = new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}Z`)
  if (!Number.isFinite(at.getTime())) throw new CalendarError('calendar_provider_response_invalid', 502)
  return at.toISOString()
}
function property(event: ProviderEvent, key: string) {
  const matches = event.singleValueExtendedProperties.filter(item => item.id === key)
  return matches.length === 1 ? matches[0]!.value : null
}
function currentHash(event: ProviderEvent) {
  if (event.body.contentType.toLowerCase() !== 'text') throw new CalendarError('calendar_provider_response_invalid', 502)
  return digest({ subject: event.subject, body: event.body.content, start: instant(event.start.dateTime), end: instant(event.end.dateTime) })
}

export function createOutlookCalendarClient(deps: { getAccessToken(): Promise<string>; fetchImpl?: typeof fetch }) {
  const transport = deps.fetchImpl ?? fetch
  return (context: CalendarContext) => {
    const root = `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(context.calendarId)}/events`
    const identity = (stableKey: string) => digest([context.workspaceId, context.userId, context.connectorInstanceId, context.calendarId, stableKey])
    async function call(url: string, method = 'GET', body?: unknown, expectedVersion?: string): Promise<Response> {
      let token: string
      try { token = await deps.getAccessToken() } catch (error) {
        if (error instanceof CalendarError) throw error
        throw new CalendarError('calendar_oauth_unavailable')
      }
      if (!token) throw new CalendarError('calendar_oauth_configuration_missing')
      let response: Response
      try {
        response = await transport(url, { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
          headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC", outlook.body-content-type="text", IdType="ImmutableId"',
            'client-request-id': transactionId(digest(context.correlationId)), 'return-client-request-id': 'true', 'X-Correlation-ID': context.correlationId,
            ...(body ? { 'Content-Type': 'application/json' } : {}), ...(expectedVersion ? { 'If-Match': expectedVersion } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        })
      } catch { throw new CalendarError('calendar_provider_unavailable', 503, method === 'GET' ? 'rejected' : 'unknown') }
      if (!response.ok) {
        if (response.status === 404 && method === 'GET') return response
        const status = response.status
        const code = status === 401 ? 'calendar_oauth_reconnect_required' : status === 403 ? 'calendar_consent_or_access_denied' :
          status === 409 || status === 412 ? 'calendar_version_conflict' : status === 429 ? 'calendar_rate_limited' : 'calendar_provider_unavailable'
        throw new CalendarError(code, status, method !== 'GET' && (status >= 500 || status === 408) ? 'unknown' : 'rejected', response.headers.get('retry-after') ?? undefined)
      }
      return response
    }
    async function parse(response: Response): Promise<unknown> {
      try { return await response.json() } catch { throw new CalendarError('calendar_provider_response_invalid', 502) }
    }
    function validated(raw: unknown, stableKey: string): ProviderEvent {
      const parsed = GraphEvent.safeParse(raw)
      if (!parsed.success) throw new CalendarError('calendar_provider_response_invalid', 502)
      if (property(parsed.data, CALENDAR_KEY_PROPERTY) !== identity(stableKey)) throw new CalendarError('calendar_binding_conflict', 409)
      currentHash(parsed.data)
      return parsed.data
    }
    async function find(input: CalendarReconcile): Promise<ProviderEvent | null> {
      const params = new URLSearchParams({ '$expand': `singleValueExtendedProperties($filter=id eq '${CALENDAR_KEY_PROPERTY}')` })
      if (input.providerId) {
        const response = await call(`${root}/${encodeURIComponent(input.providerId)}?${params}`)
        if (response.status === 404) return null
        const result = validated(await parse(response), input.stableKey)
        if (result.id !== input.providerId) throw new CalendarError('calendar_binding_conflict', 409)
        return result
      }
      params.set('$filter', `singleValueExtendedProperties/Any(ep: ep/id eq '${CALENDAR_KEY_PROPERTY}' and ep/value eq '${identity(input.stableKey)}')`)
      params.set('$top', '2')
      const response = await call(`${root}?${params}`)
      // A missing calendar is configuration failure, not proof that an event is absent.
      if (response.status === 404) throw new CalendarError('calendar_target_unavailable', 404)
      const collection = z.object({ value: z.array(z.unknown()), '@odata.nextLink': z.string().optional() }).safeParse(await parse(response))
      if (!collection.success) throw new CalendarError('calendar_provider_response_invalid', 502)
      if (collection.data.value.length > 1 || collection.data['@odata.nextLink']) throw new CalendarError('calendar_duplicate_binding', 409)
      return collection.data.value.length ? validated(collection.data.value[0], input.stableKey) : null
    }
    function receipt(status: CalendarReceipt['status'], event: ProviderEvent | null, stableKey: string): CalendarReceipt {
      return { status, event: event ? { providerId: event.id, version: event['@odata.etag'], stableKey, contentHash: currentHash(event),
        subject: event.subject, start: instant(event.start.dateTime), end: instant(event.end.dateTime) } : null, correlationId: context.correlationId }
    }
    return {
      async reconcile(raw: CalendarReconcile): Promise<CalendarReceipt> {
        const input = CalendarReconcileInput.parse(raw), event = await find(input)
        return receipt(event ? 'reconciled' : 'not_found', event, input.stableKey)
      },
      async upsert(raw: CalendarUpsert): Promise<CalendarReceipt> {
        const input = CalendarUpsertInput.parse(raw), desired = normalize(input.event), contentHash = digest(desired)
        const current = await find(input)
        if (current) {
          if (currentHash(current) === contentHash) return receipt('reconciled', current, input.stableKey)
          if (!input.providerId || current['@odata.etag'] !== input.expectedVersion) throw new CalendarError('calendar_version_conflict', 409)
        } else if (input.providerId) throw new CalendarError('calendar_event_not_found', 404)
        const body = { subject: desired.subject, body: { contentType: 'text', content: desired.body },
          start: { dateTime: desired.start.slice(0, -1), timeZone: 'UTC' }, end: { dateTime: desired.end.slice(0, -1), timeZone: 'UTC' },
          singleValueExtendedProperties: [{ id: CALENDAR_KEY_PROPERTY, value: identity(input.stableKey) }],
          ...(!current ? { transactionId: transactionId(identity(input.stableKey)) } : {}),
        }
        const response = await call(current ? `${root}/${encodeURIComponent(current.id)}` : root, current ? 'PATCH' : 'POST', body, input.expectedVersion ?? undefined)
        // Once the mutation was accepted, ANY verification failure is unknown.
        try {
          const providerId = current?.id ?? z.object({ id: OpaqueId }).parse(await parse(response)).id
          const confirmed = await find({ stableKey: input.stableKey, providerId })
          if (!confirmed || currentHash(confirmed) !== contentHash) throw new Error('unconfirmed')
          return receipt(current ? 'updated' : 'created', confirmed, input.stableKey)
        } catch { throw new CalendarError('calendar_write_unconfirmed', 503, 'unknown') }
      },
    }
  }
}
