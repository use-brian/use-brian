import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { readFileSync } from 'node:fs'
import { createTokens } from '../../auth/jwt.js'
import { packMsGraphTokens } from '../../msgraph/token.js'
import { CALENDAR_KEY_PROPERTY } from '../client.js'
import { createCalendarCredentials } from '../credentials.js'
import { externalAppCalendarRoutes } from '../routes.js'

const userId = '10000000-0000-4000-8000-000000000001', workspaceId = '10000000-0000-4000-8000-000000000002'
const connectorInstanceId = '10000000-0000-4000-8000-000000000003', sessionId = '10000000-0000-4000-8000-000000000004'
const secret = 'calendar-local-test-signing-secret'
const token = createTokens(userId, secret, { id: sessionId, authVersion: 1 }).accessToken
const path = `/api/external-app/workspaces/${workspaceId}/outlook-calendar/${connectorInstanceId}/events`
const input = { stableKey: 'example-booking-1', providerId: null as string | null, expectedVersion: null as string | null,
  event: { subject: 'Example review', body: 'Review appointment', start: '2026-10-01T09:00:00+08:00', end: '2026-10-01T10:00:00+08:00' } }
function fixture() {
  const state = { revoked: false, member: true, exposed: true, lost: false, concurrent: false, drift: false, denyAfterRead: false, status: 0 }
  const instance = { id: connectorInstanceId, provider: 'msgraph', scope: 'user', userId, connected: true, healthStatus: 'ok',
    config: { externalAppCalendar: { enabled: true, calendarId: 'configured-calendar' } } }
  let blob = packMsGraphTokens({ accessToken: 'server-oauth-token', refreshToken: 'server-refresh-token', expiresAt: new Date(Date.now() + 3600000).toISOString(), appClientId: 'server-app', appClientSecret: 'server-app-secret' })
  const instances = {
    setConfig: vi.fn(async (_userId, _id, config) => { instance.config = { ...instance.config, ...config } }),
    getAuthCredentialsSystem: vi.fn(async () => ({ client_id: 'msgraph_oauth', client_secret: blob })),
    updateCredentialsSystem: vi.fn(async (_id, value) => { blob = value.client_secret }),
  }
  const listUsable = vi.fn(async () => state.exposed ? [{ instance, source: 'personal' }] as never : [])
  const getRole = vi.fn(async () => state.member ? 'member' as const : null)
  const events = new Map<string, Record<string, any>>()
  let version = 1
  const graph = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const target = new URL(String(url))
    expect(init?.redirect).toBe('error')
    if (target.hostname === 'login.microsoftonline.com') {
      expect(String(init?.body)).toContain('refresh_token=server-refresh-token')
      return Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600 })
    }
    expect(target.origin).toBe('https://graph.microsoft.com')
    expect(target.pathname).toContain('/me/calendars/configured-calendar/events')
    const headers = new Headers(init?.headers)
    expect(['Bearer server-oauth-token', 'Bearer rotated-access']).toContain(headers.get('authorization'))
    expect(headers.get('x-correlation-id')).toBe('calendar-test-1')
    expect(headers.get('prefer')).toContain('ImmutableId')
    if (state.status) return Response.json({ error: { message: 'private provider text' } }, { status: state.status })
    const id = target.pathname.split('/events/')[1]
    if (init?.method === 'GET') {
      expect(target.searchParams.get('$expand')).toContain(CALENDAR_KEY_PROPERTY)
      if (state.denyAfterRead) state.member = false
      if (id) return events.has(id) ? Response.json(events.get(id)) : new Response(null, { status: 404 })
      const hash = /ep\/value eq '([a-f0-9]+)'/.exec(target.searchParams.get('$filter') ?? '')?.[1]
      return Response.json({ value: [...events.values()].filter(e => e.singleValueExtendedProperties.some((p: any) => p.id === CALENDAR_KEY_PROPERTY && p.value === hash)) })
    }
    const body = JSON.parse(String(init?.body))
    if (init?.method === 'POST') {
      expect(body.transactionId).toMatch(/^[a-f0-9-]{36}$/)
      const old = [...events.values()].find(e => e.transactionId === body.transactionId)
      const event = old ?? { ...body, id: `provider-${events.size + 1}`, '@odata.etag': `W/"${version++}"` }
      events.set(event.id, event)
      if (state.lost) { state.lost = false; throw Error('lost after Graph accepted') }
      return Response.json({ id: event.id }, { status: 201 })
    }
    expect(init?.method).toBe('PATCH')
    expect(body).not.toHaveProperty('transactionId')
    const old = events.get(id!)!
    if (state.concurrent) old['@odata.etag'] = 'W/"concurrent"'
    if (headers.get('if-match') !== old['@odata.etag']) return Response.json({}, { status: 412 })
    events.set(id!, { ...old, ...body, '@odata.etag': `W/"${version++}"` })
    if (state.drift) events.get(id!)!.subject = 'Concurrent edit after patch'
    return Response.json({ id })
  })
  const withCalendar = createCalendarCredentials({ workspaceStore: { getRole }, instances: instances as never, listUsable, fetchImpl: graph })
  const validateAccess = vi.fn(async claims => claims.userId === userId && claims.sessionId === sessionId && claims.authVersion === 1 && !state.revoked)
  const app = express(); app.use(express.json()); app.use('/api/external-app', externalAppCalendarRoutes({ jwtSecret: secret, sessions: { validateAccess }, withCalendar }))
  const send = (action: string, data: unknown, bearer = token) => request(app).post(`${path}/${action}`).set('Authorization', `Bearer ${bearer}`).set('X-Correlation-ID', 'calendar-test-1').send(data as object)
  const configure = (data: object) => request(app).put(path.replace('/events', '/configuration')).set('Authorization', `Bearer ${token}`).set('X-Correlation-ID', 'calendar-test-1').send(data)
  const writes = () => graph.mock.calls.filter(([, init]) => init?.method !== 'GET' && !String(init?.body).includes('grant_type'))
  return { state, instance, instances, listUsable, getRole, graph, events, send, configure, writes, validateAccess,
    expire: () => { blob = packMsGraphTokens({ accessToken: 'expired', refreshToken: 'server-refresh-token', expiresAt: '2000-01-01T00:00:00Z', appClientId: 'server-app', appClientSecret: 'server-app-secret' }) } }
}

beforeEach(() => { vi.restoreAllMocks(); vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}) })
describe('[COMP:api/external-app-outlook-calendar] authenticated route and controlled Graph binding', () => {
  it('creates once, binds configured calendar/transactionId and reconciles the same stable event', async () => {
    const f = fixture(), created = await f.send('upsert', input)
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ status: 'created', event: { providerId: 'provider-1', version: 'W/"1"', stableKey: input.stableKey, start: '2026-10-01T01:00:00.000Z' } })
    expect(created.body.event.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect((await f.send('upsert', input)).body.status).toBe('reconciled')
    expect((await f.send('reconcile', { stableKey: input.stableKey, providerId: null })).body.event.providerId).toBe('provider-1')
    expect(f.writes()).toHaveLength(1)
    expect(f.instances.getAuthCredentialsSystem).toHaveBeenCalledWith(connectorInstanceId)
    expect(JSON.stringify(created.body)).not.toContain('server-oauth')
  })
  it('serializes concurrent same-instance retries and emits one provider creation', async () => {
    const f = fixture()
    const replies = await Promise.all([f.send('upsert', input), f.send('upsert', input)])
    expect(replies.map(result => result.body.status).sort()).toEqual(['created', 'reconciled'])
    expect(f.writes()).toHaveLength(1)
  })
  it('updates only a bound provider ID using exact If-Match and returns new version', async () => {
    const f = fixture(); const created = (await f.send('upsert', input)).body
    const update = { ...input, providerId: created.event.providerId, expectedVersion: created.event.version, event: { ...input.event, subject: 'Amended review' } }
    const updated = await f.send('upsert', update)
    expect(updated.body).toMatchObject({ status: 'updated', event: { providerId: 'provider-1', version: 'W/"2"', subject: 'Amended review' } })
    expect(new Headers(f.writes()[1]![1]!.headers).get('if-match')).toBe('W/"1"')
    expect((await f.send('upsert', update)).body.status).toBe('reconciled')
    expect(f.writes()).toHaveLength(2)
  })
  it('does not overwrite Outlook edits just because a prior idempotency key matches', async () => {
    const f = fixture(); await f.send('upsert', input)
    f.events.get('provider-1')!.subject = 'Human edit'
    expect((await f.send('upsert', input)).status).toBe(409)
    expect(f.writes()).toHaveLength(1)
  })
  it('rejects stale versions and races with provider 412 without retry', async () => {
    const f = fixture(); await f.send('upsert', input)
    const update = { ...input, providerId: 'provider-1', expectedVersion: 'W/"stale"', event: { ...input.event, subject: 'Change' } }
    expect((await f.send('upsert', update)).status).toBe(409)
    f.state.concurrent = true
    expect((await f.send('upsert', { ...update, expectedVersion: 'W/"1"' })).status).toBe(412)
    expect(f.writes()).toHaveLength(2)
  })
  it('retains unknown after accepted-but-lost create; read-only reconciliation recovers without duplicate', async () => {
    const f = fixture(); f.state.lost = true
    expect((await f.send('upsert', input)).body).toMatchObject({ outcome: 'unknown', error: 'calendar_provider_unavailable' })
    expect((await f.send('reconcile', { stableKey: input.stableKey, providerId: null })).body).toMatchObject({ status: 'reconciled', event: { providerId: 'provider-1' } })
    expect(f.writes()).toHaveLength(1)
  })
  it('does not report confirmed success when post-write read detects a concurrent change', async () => {
    const f = fixture(); await f.send('upsert', input); f.state.drift = true
    const res = await f.send('upsert', { ...input, providerId: 'provider-1', expectedVersion: 'W/"1"', event: { ...input.event, subject: 'Change' } })
    expect(res.body).toMatchObject({ error: 'calendar_write_unconfirmed', outcome: 'unknown' })
  })
  it('reconcile not_found never creates, and update missing event never recreates', async () => {
    const f = fixture()
    expect((await f.send('reconcile', { stableKey: input.stableKey, providerId: 'missing' })).body).toMatchObject({ status: 'not_found', event: null })
    expect((await f.send('upsert', { ...input, providerId: 'missing', expectedVersion: 'W/"1"' })).status).toBe(404)
    expect(f.writes()).toHaveLength(0)
  })
  it('refuses unrelated provider IDs and duplicate property matches', async () => {
    const f = fixture(); await f.send('upsert', input)
    expect((await f.send('reconcile', { stableKey: 'another-key', providerId: 'provider-1' })).status).toBe(409)
    f.events.set('provider-2', { ...f.events.get('provider-1')!, id: 'provider-2' })
    expect((await f.send('reconcile', { stableKey: input.stableKey, providerId: null })).body.error).toBe('calendar_duplicate_binding')
  })
  it('rejects forged/refresh/revoked/machine bearer before any connector credential access', async () => {
    const f = fixture()
    for (const bearer of ['sk_crm_example', createTokens(userId, 'wrong').accessToken, createTokens(userId, secret).refreshToken]) expect((await f.send('upsert', input, bearer)).status).toBe(401)
    f.state.revoked = true; expect((await f.send('upsert', input)).status).toBe(401)
    expect(f.instances.getAuthCredentialsSystem).not.toHaveBeenCalled(); expect(f.graph).not.toHaveBeenCalled()
  })
  it('checks membership, exposure and personal ownership instead of broad connector authority', async () => {
    for (const alter of [(f: ReturnType<typeof fixture>) => { f.state.member = false }, (f: ReturnType<typeof fixture>) => { f.state.exposed = false }, (f: ReturnType<typeof fixture>) => { f.instance.userId = workspaceId }]) {
      const f = fixture(); alter(f)
      expect((await f.send('upsert', input)).status).toBe(403)
      expect(f.instances.getAuthCredentialsSystem).not.toHaveBeenCalled()
    }
  })
  it('rechecks membership after lookup before the actual provider write', async () => {
    const f = fixture(); f.state.denyAfterRead = true
    expect((await f.send('upsert', input)).status).toBe(403)
    expect(f.writes()).toHaveLength(0)
  })
  it('reports missing OAuth configuration and rejects caller credential/authority injection', async () => {
    const f = fixture(); f.instance.config = {} as never
    expect((await f.send('upsert', input)).body.error).toBe('calendar_oauth_configuration_missing')
    for (const extra of [{ token: 'caller-token' }, { calendarId: 'caller-calendar' }, { actor: userId }, { workspaceId }]) expect((await f.send('upsert', { ...input, ...extra })).status).toBe(400)
    expect(f.graph).not.toHaveBeenCalled()
  })
  it('exposes owner/member/exposure-gated calendar configuration without accepting credentials', async () => {
    const f = fixture(); f.instance.config = {} as never
    expect((await f.configure({ enabled: true, calendarId: 'configured-calendar' })).status).toBe(200)
    expect(f.instances.setConfig).toHaveBeenCalledWith(userId, connectorInstanceId, { externalAppCalendar: { enabled: true, calendarId: 'configured-calendar' } })
    expect((await f.send('upsert', input)).status).toBe(201)
    expect((await f.configure({ enabled: true, calendarId: 'x', token: 'injected' })).status).toBe(400)
    f.state.exposed = false; expect((await f.configure({ enabled: true, calendarId: 'x' })).status).toBe(403)
  })
  it('requires an expected version for updates and validates dates and narrow fields', async () => {
    const f = fixture()
    for (const bad of [{ ...input, providerId: 'provider-1' }, { ...input, event: { ...input.event, end: input.event.start } }, { ...input, event: { ...input.event, attendees: ['other@example.com'] } }]) expect((await f.send('upsert', bad)).status).toBe(400)
    expect(f.graph).not.toHaveBeenCalled()
  })
  it('reuses real OAuth refresh manager and persists rotated envelope before Graph', async () => {
    const f = fixture(); f.expire()
    expect((await f.send('upsert', input)).status).toBe(201)
    expect(f.instances.updateCredentialsSystem).toHaveBeenCalledWith(connectorInstanceId, expect.objectContaining({ client_secret: expect.stringContaining('rotated-refresh') }))
    expect(f.graph.mock.calls.filter(([url]) => String(url).includes('login.microsoftonline.com'))).toHaveLength(1)
  })
  it.each([401, 403, 429, 503])('does not leak Graph failure text or retry %s', async status => {
    const f = fixture(); f.state.status = status
    const result = await f.send('upsert', input)
    expect(result.status).toBe(status)
    expect(JSON.stringify(result.body)).not.toContain('private provider text')
    expect(f.graph).toHaveBeenCalledTimes(1)
  })
  it('mounts the OSS route with real server-owned credential and exposure dependencies', () => {
    const boot = readFileSync(new URL('../../boot.ts', import.meta.url), 'utf8')
    expect(boot).toContain("app.use('/api/external-app', externalAppCalendarRoutes({")
    expect(boot).toContain('withCalendar: createCalendarCredentials({')
    expect(boot).toContain('instances: connectorInstanceStore')
    expect(boot).toContain('listUsableWorkspaceConnectors({ connectorInstanceStore, connectorGrantStore, userId, workspaceId })')
  })
})
