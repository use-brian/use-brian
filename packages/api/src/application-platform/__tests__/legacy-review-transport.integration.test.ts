/** Genuine pre-retirement IDs, using one maintained primary fixture for all pools. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import type { Pool, PoolClient } from 'pg'
import { getAppPool, getPool } from '../../db/client.js'
import { createDbWorkspaceGroupStore } from '../../db/workspace-group-store.js'
import { authSessionStore } from '../../db/auth-session-store.js'
import { createTokens } from '../../auth/jwt.js'
import { requireAuth } from '../../auth/middleware.js'
import { applicationPlatformRoutes } from '../../routes/application-platform.js'
import { ApplicationManagementService } from '../management.js'
import { ApplicationPlatformService } from '../service.js'
import { executeWorkspaceScopeReview, getWorkspaceScopeInventory, getWorkspaceScopeReview } from '../../workspace-access/scope-review.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
type Review = { id: string; version: string; payloadHash: string; status: string; items: Array<{ status: string; replacementId: string | null }> }
type Case = { workspaceId: string; actorId: string; memberId: string; foreignId: string; assistantId: string; otherAssistantId: string; departmentId: string | null; sourceId: string; ids: string[]; review: Review }
if (!process.env.BRIAN_ASSURANCE_LEGACY_CASES) throw new Error('Run through the genuine pre8121 legacy review fixture')
const cases = JSON.parse(process.env.BRIAN_ASSURANCE_LEGACY_CASES) as Record<string, Case>
const owner = getPool(), app = getAppPool(), platform = new ApplicationPlatformService([]), secret = 'fictional-retained-review-transport'
const management = new ApplicationManagementService(platform), tokens = new Map<string, string>()
function router(service = management) {
 const http = express(); http.use(express.json()); http.use('/api/applications', applicationPlatformRoutes({ service: platform,
  management: { service, requireAuth: requireAuth(secret), origins: ['https://host.example'] } })); return http
}
const http = router(), selected = (name: string) => cases['transport-' + name]
const envelope = (f: Case, kind = 'legacy.apply', review = f.review) => ({ kind, reviewId: review.id, expectedVersion: review.version, payloadHash: review.payloadHash, assistantId: f.assistantId })
const command = (f: Case, body: unknown, actor = f.actorId, server = http) => request(server).post(`/api/applications/workspaces/${f.workspaceId}/management/commands`)
 .set('Authorization', 'Bearer ' + tokens.get(actor)).set('Origin', 'https://host.example').send(body as object)
async function rpc(f: Case, method: string, params?: unknown, actor = f.actorId) {
 const response = await request(http).post(`/api/applications/workspaces/${f.workspaceId}/management/mcp`).query({ assistantId: f.assistantId })
  .set('Authorization', 'Bearer ' + tokens.get(actor)).set('Accept', 'application/json, text/event-stream').set('MCP-Protocol-Version', '2025-11-25')
  .send({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) })
 const event = response.text.split('\n').find(line => line.startsWith('data: ')); return { response, value: event ? JSON.parse(event.slice(6)) : response.body }
}
async function tool(f: Case, body: unknown, actor = f.actorId) {
 const { response, value } = await rpc(f, 'tools/call', { name: 'applicationManage', arguments: { command: body } }, actor)
 return { response, reply: value, value: value.result?.content?.[0]?.text ? JSON.parse(value.result.content[0].text) : null }
}
async function reload(f: Case): Promise<Review> {
 const result = await command(f, { kind: 'legacy.view', reviewId: f.review.id, assistantId: f.assistantId })
 expect(result.status, JSON.stringify(result.body)).toBe(200); return result.body
}
const replacements = async (f: Case) => (await owner.query('SELECT count(*)::int AS n FROM memories WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND superseded_by IS NOT NULL', [f.workspaceId, f.ids])).rows[0].n

/** Lose only a real commit acknowledgement after the selected canonical SQL. */
function lostAcknowledgement(functionName: 'application_legacy_review_view' | 'application_legacy_review_apply') {
 let calls = 0, lost = false
 const pool = new Proxy(app, { get(target, key) {
  if (key === 'connect') return async () => {
   const client = await target.connect(); let executed = false
   return new Proxy(client, { get(connection, property) {
    if (property === 'query') return async (...args: unknown[]) => {
     const sql = String(args[0]); if (sql.includes('SELECT ' + functionName + '(')) { executed = true; calls++ }
     const result = await (connection.query as (...values: unknown[]) => Promise<unknown>)(...args)
     if (sql === 'COMMIT' && executed && !lost) { lost = true; throw new Error('fictional_commit_ack_lost') }
     return result
    }
    const value = Reflect.get(connection, property); return typeof value === 'function' ? value.bind(connection) : value
   } }) as PoolClient
  }
  const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
 } }) as Pool
 return { service: new ApplicationManagementService(platform, pool), calls: () => calls }
}

describe.sequential('[COMP:api/application-legacy-review] current native retained recovery transports', () => {
 beforeAll(async () => {
  expect((await owner.query('SELECT current_database() AS name')).rows).toEqual([{ name: 'brian_assurance' }])
  expect((await app.query('SELECT current_database() AS name,current_user,session_user,r.rolsuper,r.rolbypassrls FROM pg_roles r WHERE rolname=current_user')).rows)
   .toEqual([{ name: 'brian_assurance', current_user: 'app_user', session_user: 'app_user', rolsuper: false, rolbypassrls: false }])
  for (const f of Object.values(cases)) for (const actor of [f.actorId, f.memberId, f.foreignId]) {
   const session = await authSessionStore.create(actor, { deviceLabel: 'Fictional recovery browser', userAgent: 'Fixture', ipAddress: '127.0.0.1' })
   expect(session).toBeTruthy(); tokens.set(actor, createTokens(actor, secret, session!).accessToken)
  }
 })
 afterAll(async () => { await app.end(); await owner.end() })
 it('rejects retired authoring in HTTP and the published MCP schema without creating a review', async () => {
  const f = selected('private'), before = (await owner.query('SELECT count(*)::int AS n FROM workspace_scope_reviews WHERE workspace_id=$1', [f.workspaceId])).rows[0].n
  const listed = await rpc(f, 'tools/list'), schema = JSON.stringify(listed.value.result)
  expect(schema).toContain('legacy.view'); expect(schema).not.toContain('legacy.inventory'); expect(schema).not.toContain('legacy.preview')
  for (const kind of ['legacy.inventory', 'legacy.preview']) {
   const body = { kind, input: kind === 'legacy.inventory' ? {} : { resourceKind: 'memory', resourceIds: f.ids, action: 'release', reason: 'Fictional retired authoring' } }
   const result = await command(f, body); expect(result.status).toBe(400); expect(result.body).toMatchObject({ error: 'invalid_value', effect: 'none' })
   const mcp = await rpc(f, 'tools/call', { name: 'applicationManage', arguments: { command: body } }); expect(mcp.value.result?.isError).toBe(true); expect(JSON.stringify(mcp.value.result)).toContain('-32602')
  }
  expect((await owner.query('SELECT count(*)::int AS n FROM workspace_scope_reviews WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(before)
 })
 it('reloads exact metadata and hides application reviews from all native review entry points', async () => {
  const f = selected('private'), original = await reload(f)
  expect(original).toEqual(f.review); expect(JSON.stringify(original)).not.toMatch(/source_snapshot|content_snapshot|applicationRepair|Fictional held content/)
  const mcp = await tool(f, { kind: 'legacy.view', reviewId: f.review.id, assistantId: f.otherAssistantId })
  expect(mcp.reply.result?.isError).not.toBe(true); expect(mcp.value).toEqual(original)
  const inventory = await getWorkspaceScopeInventory(f.workspaceId, f.actorId)
  expect(inventory.recentReviews.map(review => review.id)).not.toContain(f.review.id)
  await expect(getWorkspaceScopeReview(f.workspaceId, f.actorId, f.review.id)).rejects.toMatchObject({ code: 'not_found' })
  await expect(getWorkspaceScopeInventory(f.workspaceId, f.actorId, 'memory', undefined, f.review.id)).rejects.toMatchObject({ code: 'not_found' })
  await expect(getWorkspaceScopeInventory(f.workspaceId, f.actorId, 'memory', undefined, undefined, f.review.id)).rejects.toMatchObject({ code: 'not_found' })
  for (const type of ['scope.review.apply', 'scope.review.cancel']) await expect(executeWorkspaceScopeReview(f.workspaceId, f.actorId,
   { type, reviewId: f.review.id, expectedVersion: f.review.version, payloadHash: f.review.payloadHash })).rejects.toMatchObject({ code: 'not_found' })
  expect(await reload(f)).toEqual(original)
 })
 it.each(['private', 'shared'])('retains exact %s original IDs/hash and applies through HTTP once with current metadata replay', async name => {
  const f = selected(name), result = await command(f, envelope(f))
  expect(result.status).toBe(200); expect(result.body).toMatchObject({ id: f.review.id, payloadHash: f.review.payloadHash, status: 'complete' })
  const applied = await reload(f); expect(applied).toEqual(result.body); expect(applied).toMatchObject({ id: f.review.id, payloadHash: f.review.payloadHash, status: 'complete' })
  expect(applied.items[0].replacementId).toBeTruthy(); expect(await replacements(f)).toBe(1)
  const replay = await tool(f, envelope(f)); expect(replay.reply.result?.isError).not.toBe(true); expect(replay.value).toEqual(applied); expect(await replacements(f)).toBe(1)
 })
 it('pages the original envelope, rejects future CAS, replays and cancels only remaining work', async () => {
  const f = selected('pages'), future = await command(f, { ...envelope(f), expectedVersion: '999' })
  expect(future.status).toBe(409); expect(future.body).toMatchObject({ error: 'record_version_conflict', effect: 'none' })
  const result = await tool(f, envelope(f)); expect(result.reply.result?.isError).not.toBe(true); expect(result.value).toMatchObject({ id: f.review.id, payloadHash: f.review.payloadHash, status: 'running' })
  const page = await reload(f); expect(page).toEqual(result.value); expect(page.status).toBe('running'); expect(page.items.filter(item => item.status === 'applied')).toHaveLength(25)
  const replay = await command(f, envelope(f)); expect(replay.status).toBe(200); expect(replay.body).toEqual(page)
  const cancelled = await tool(f, envelope(f, 'legacy.cancel', page)); expect(cancelled.reply.result?.isError).not.toBe(true)
  expect(cancelled.value.status).toBe('cancelled'); expect(cancelled.value.items.filter((item: { status: string }) => item.status === 'cancelled')).toHaveLength(1)
  expect(await replacements(f)).toBe(25); expect(await reload(f)).toEqual(cancelled.value)
 })
 it('rechecks creator, selected assistant, workspace, current native administrator and placement', async () => {
  const f = selected('admin')
  await owner.query("UPDATE workspace_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.memberId])
  for (const actor of [f.memberId, f.foreignId]) {
   expect((await command(f, { kind: 'legacy.view', reviewId: f.review.id, assistantId: f.assistantId }, actor)).status).toBe(403)
   const denied = await tool(f, { kind: 'legacy.view', reviewId: f.review.id }, actor)
   if (actor === f.memberId) { expect(denied.response.status).toBe(200); expect(denied.value).toEqual({ error: 'access_unavailable', effect: 'none', retrySafe: true }) }
   else { expect(denied.response.status).toBe(403); expect(denied.response.body).toMatchObject({ error: 'access_unavailable', effect: 'none' }) }
  }
  expect((await command(f, { kind: 'legacy.view', reviewId: selected('private').review.id, assistantId: f.assistantId })).status).toBe(403)
  expect((await command(f, { kind: 'legacy.view', reviewId: f.review.id, assistantId: f.otherAssistantId })).status).toBe(403)
  await owner.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.actorId])
  for (const body of [{ kind: 'legacy.view', reviewId: f.review.id, assistantId: f.assistantId }, envelope(f)]) expect((await command(f, body)).status).toBe(403)
  await owner.query("UPDATE workspace_members SET role='owner' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.actorId])
  expect((await reload(f)).status).toBe('preview')
  const placed = selected('assistant')
  expect(await createDbWorkspaceGroupStore().archiveTeam(placed.actorId, placed.departmentId!)).toBe(true)
  expect((await command(placed, { kind: 'legacy.view', reviewId: placed.review.id, assistantId: placed.assistantId })).status).toBe(403)
  expect((await command(f, { kind: 'legacy.view', reviewId: f.review.id, assistantId: randomUUID() })).status).toBe(403)
  expect((await request(http).post(`/api/applications/workspaces/${f.workspaceId}/management/commands`).send({ kind: 'legacy.view', reviewId: f.review.id })).status).toBe(401)
 })
 it.each(['source', 'policy'])('keeps changed current %s stale through the actual management caller', async kind => {
  const f = selected(kind)
  if (kind === 'source') await owner.query('UPDATE memories SET summary=$2 WHERE id=$1', [f.sourceId, 'Fictional source changed before transport apply'])
  else await owner.query('UPDATE workspace_access_policies SET revision=revision+1 WHERE workspace_id=$1', [f.workspaceId])
  const result = await command(f, envelope(f)); expect(result.status).toBe(200); expect(result.body.status).toBe('stale'); expect(await replacements(f)).toBe(0)
 })
 it('reports real lost apply acknowledgement as uncertain and reloads without retrying its committed effect', async () => {
  const f = selected('uncertain'), fault = lostAcknowledgement('application_legacy_review_apply')
  const result = await command(f, envelope(f), f.actorId, router(fault.service))
  expect(result.status).toBe(409); expect(result.body).toEqual({ error: 'outcome_uncertain', effect: 'uncertain', retrySafe: false }); expect(fault.calls()).toBe(1)
  const saved = await reload(f); expect(saved.status).toBe('complete'); expect(await replacements(f)).toBe(1)
  const replay = await command(f, envelope(f)); expect(replay.status).toBe(200); expect(replay.body).toEqual(saved); expect(await replacements(f)).toBe(1)
 })
 it('keeps a lost view acknowledgement effect-free without changing progress', async () => {
  const f = selected('admin'), before = await reload(f), fault = lostAcknowledgement('application_legacy_review_view')
  const result = await command(f, { kind: 'legacy.view', reviewId: f.review.id, assistantId: f.assistantId }, f.actorId, router(fault.service))
  expect(result.status).toBe(503); expect(result.body).toEqual({ error: 'access_unavailable', effect: 'none', retrySafe: false }); expect(fault.calls()).toBe(1)
  expect(await reload(f)).toEqual(before)
 })
})
