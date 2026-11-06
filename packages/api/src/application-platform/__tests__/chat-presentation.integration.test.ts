import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { boundScopeSources } from '@use-brian/core'
import { authSessionStore } from '../../db/auth-session-store.js'
import { getAppPool, getPool } from '../../db/client.js'
import { addSessionMessage, createPersonalWebSession } from '../../db/sessions.js'
import { createDbMemoryStore } from '../../db/memory-store.js'
import { readAdmittedSessionQuery } from '../../db/session-query-reader.js'
import { publishNativeSessionMessageBatch } from '../../db/session-message-publication.js'
import { resolveSessionTitleAuthority } from '../../routes/session-title-authority.js'
import { sessionRoutes } from '../../routes/sessions.js'
import { createTokens } from '../../auth/jwt.js'
import { requireAuth } from '../../auth/middleware.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

const secret = 'fictional-chat-presentation-secret'
const app = express()
app.use('/api/sessions', requireAuth(secret), sessionRoutes())
type PresentationRow = { id: string; sequence: number; role: string; content: Array<Record<string, unknown>>;
  attachments: unknown[]; replyToText: string | null; senderUserId: string | null; senderAssistantId: string | null }

describe.sequential('[COMP:api/session-display-history] primary private chat history HTTP presentation', () => {
  let fixture: Awaited<ReturnType<typeof persistentContextFixture>> | undefined
  afterEach(async () => { await fixture?.cleanup(); fixture = undefined })
  afterAll(async () => { await getAppPool().end(); await getPool().end() })

  async function setup(member = false) {
    fixture = await persistentContextFixture('confidential')
    const f = fixture, actor = member ? f.secondId : f.ownerId
    await f.pool.query('UPDATE workspaces SET department_read_v2=true WHERE id=$1', [f.workspaceId])
    const device = await authSessionStore.create(actor, { deviceLabel: 'Fictional history browser', userAgent: 'Fixture', ipAddress: '127.0.0.1' })
    if (!device) throw new Error('Fixture device missing')
    const claims = { userId: actor, sessionId: device.id, authVersion: device.authVersion }
    const session = await createPersonalWebSession({ assistantId: f.assistantId, userId: actor, workspaceId: f.workspaceId,
      channelType: 'web', channelId: randomUUID(), appOrigin: 'chat' },
    { actorUserId: actor, authSessionId: device.id, authVersion: device.authVersion })
    const scope = { ...f.envelope, userId: actor, assistantId: null }
    const append = (params: Omit<Parameters<typeof addSessionMessage>[0], 'sessionId' | 'scope'>) =>
      addSessionMessage({ ...params, sessionId: session.id, scope })
    const input = await append({ role: 'user', content: [{ type: 'text', text: 'Fictional original request' }], senderUserId: actor })
    const memory = await f.memory('Fictional original supporting fact', actor)
    const authority = await resolveSessionTitleAuthority({ claims, sessionId: session.id, readOnly: false })
    const history = await readAdmittedSessionQuery({ sessionId: session.id, throughSequence: input.sequenceNum, authority })
    const index = await createDbMemoryStore().getIndex(authority.execution.security.access, false, authority)
    const sources = [...boundScopeSources(history), ...boundScopeSources(index)]
    const [reply] = await publishNativeSessionMessageBatch({ sessionId: session.id, authority, derivationTarget: scope,
      derivation: { producer: 'fixture:private-chat-presentation', sources },
      messages: [{ role: 'assistant', senderAssistantId: f.assistantId, content: [{ type: 'text', text: 'Fictional original answer' }] }] })
    const token = createTokens(actor, secret, device).accessToken
    const read = (credential = token) => request(app).get(`/api/sessions/${session.id}/messages`).set('Authorization', `Bearer ${credential}`)
    return { f, actor, claims, device, session, scope, input, reply, memory, append, read }
  }

  it.each([false, true])('keeps the primary HTTP transcript readable after source changes for an ordinary member: %s', async member => {
    const c = await setup(member)
    const before = await c.read()
    expect(before.status, before.text).toBe(200)
    expect(before.headers['cache-control']).toBe('no-store')
    expect(before.body.map((row: PresentationRow) => row.id)).toEqual([c.input.id, c.reply.id])
    await c.f.memory('Fictional new source after publication', c.actor)
    await c.f.pool.query('UPDATE memories SET scope_held=true WHERE id=$1', [c.memory.id])
    const heldSource = await c.read()
    expect(heldSource.status, heldSource.text).toBe(200)
    expect(heldSource.body).toEqual(before.body)
    await c.f.pool.query('DELETE FROM memories WHERE id=$1', [c.memory.id])
    const deletedSource = await c.read()
    expect(deletedSource.status, deletedSource.text).toBe(200)
    expect(deletedSource.body).toEqual(before.body)
    expect(JSON.stringify(deletedSource.body)).not.toContain('resourceKind')
  })

  it('serves primary history when the canonical source evaluator would cancel the request', async () => {
    const c = await setup(), signature = 'public.application_session_eval_scope(uuid,text,uuid,text,jsonb)'
    const original = (await c.f.pool.query<{ definition: string }>('SELECT pg_get_functiondef($1::regprocedure) AS definition', [signature])).rows[0].definition
    // This failure is confined to this disposable fixture workspace. Restoring
    // the original definition remains mandatory even if the HTTP assertion fails.
    const changed = original.replace('\nBEGIN\n', `\nBEGIN\n IF w='${c.f.workspaceId}'::uuid THEN RAISE EXCEPTION 'fictional_history_evaluator_timeout' USING ERRCODE='57014'; END IF;\n`)
    expect(changed).not.toBe(original)
    try {
      await c.f.pool.query(changed)
      await expect(c.f.pool.query("SELECT application_session_eval_scope($1,'session_message',$2,'1','{}'::jsonb)",
        [c.f.workspaceId, c.reply.id])).rejects.toMatchObject({ code: '57014' })
      const result = await c.read()
      expect(result.status, result.text).toBe(200)
      expect(result.body.map((row: PresentationRow) => row.id)).toEqual([c.input.id, c.reply.id])
      expect(JSON.stringify(result.body)).toContain('Fictional original answer')
    } finally { await c.f.pool.query(original) }
  })

  it('withholds a directly held message, keeps the remaining conversation, and enforces session privacy', async () => {
    const c = await setup()
    await c.f.pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1', [c.reply.id])
    const held = await c.read()
    expect(held.status, held.text).toBe(200)
    expect(held.body.find((row: PresentationRow) => row.id === c.input.id).content).toEqual([{ type: 'text', text: 'Fictional original request' }])
    expect(held.body.find((row: PresentationRow) => row.id === c.reply.id)).toMatchObject({ available: false,
      content: [], attachments: [], replyToText: null, senderUserId: null, senderAssistantId: null })
    expect(held.text).not.toContain('Fictional original answer')
    await c.f.pool.query('UPDATE sessions SET recording_privacy_held=true WHERE id=$1', [c.session.id])
    const privateSession = await c.read()
    expect([403, 404]).toContain(privateSession.status)
    expect(privateSession.text).not.toContain('Fictional original request')
  })

  it('denies another member and a revoked native device at the actual history endpoint', async () => {
    const c = await setup(true)
    const otherDevice = await authSessionStore.create(c.f.ownerId, { deviceLabel: 'Fictional other browser', userAgent: 'Fixture', ipAddress: null })
    if (!otherDevice) throw new Error('Fixture other device missing')
    const other = await c.read(createTokens(c.f.ownerId, secret, otherDevice).accessToken)
    expect([403, 404]).toContain(other.status)
    expect(other.text).not.toContain('Fictional original answer')
    expect((await c.read()).status).toBe(200)
    await authSessionStore.revokeForUser(c.actor, c.device.id)
    const revoked = await c.read()
    expect(revoked.status).toBe(401)
    expect(revoked.text).not.toContain('Fictional original answer')
  })

  it('denies history after the owning member leaves the workspace', async () => {
    const c = await setup(true)
    await c.f.pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [c.f.workspaceId, c.actor])
    const response = await c.read()
    expect([403, 404]).toContain(response.status)
    expect(response.text).not.toContain('Fictional original answer')
  })

  it('preserves upload previews, delivered artifacts, quotes and activity without exposing source payloads', async () => {
    const c = await setup(), uploadId = randomUUID(), pageId = randomUUID(), fileId = randomUUID()
    const upload = await c.append({ role: 'user', senderUserId: c.actor, content: [
      { type: 'text', text: `<attached_file id="${uploadId}" name="sample.png" type="image/png">HIDDEN_UPLOADED_BODY</attached_file>` },
      { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=', name: 'sample.png' },
    ] })
    const call = await c.append({ role: 'assistant', senderAssistantId: c.f.assistantId, content: [
      { type: 'text', text: 'Fictional activity before delivery' },
      { type: 'tool_use', id: 'document-call', name: 'presentDocument', input: { title: 'Fictional document', content: 'Delivered document text', format: 'text', privateExtra: 'HIDDEN_DOCUMENT_EXTRA' } },
      { type: 'tool_use', id: 'page-call', name: 'renderPage', input: { content: 'HIDDEN_PAGE_INPUT' } },
      { type: 'thinking', thinking: 'HIDDEN_REASONING', signature: 'HIDDEN_SIGNATURE' },
    ] })
    const receipt = await c.append({ role: 'user', content: [
      { type: 'tool_result', toolUseId: 'document-call', name: 'presentDocument', content: 'HIDDEN_DOCUMENT_RECEIPT', isError: false },
      { type: 'tool_result', toolUseId: 'page-call', name: 'renderPage', content: JSON.stringify({ pageId, privateData: 'HIDDEN_PAGE_OUTPUT' }), isError: false },
    ] })
    const file = { fileId, workspaceId: c.f.workspaceId, path: '/fictional/result.txt', name: 'result.txt', mime: 'text/plain', sizeBytes: 24 }
    const final = await c.append({ role: 'assistant', senderAssistantId: c.f.assistantId,
      content: [{ type: 'text', text: 'Fictional delivered answer' }], attachments: [file], replyToText: 'Fictional quoted request' })
    const response = await c.read()
    expect(response.status, response.text).toBe(200)
    const rows = response.body as PresentationRow[], byId = (id: string) => rows.find(row => row.id === id)!
    expect(byId(upload.id).content).toEqual([
      { type: 'text', text: `<attached_file id="${uploadId}" name="sample.png" type="image/png"></attached_file>` },
      { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=', name: 'sample.png' },
    ])
    expect(byId(call.id).content).toContainEqual({ type: 'tool_use', id: `${call.id}:document-call`, name: 'presentDocument',
      input: { title: 'Fictional document', content: 'Delivered document text', format: 'text' } })
    expect(byId(receipt.id).content).toContainEqual({ type: 'tool_result', toolUseId: `${call.id}:page-call`, name: 'renderPage', isError: false,
      content: JSON.stringify({ pageIds: [pageId] }) })
    expect(byId(final.id)).toMatchObject({ attachments: [file], replyToText: 'Fictional quoted request', senderAssistantId: c.f.assistantId })
    expect(response.text).not.toContain('HIDDEN_')
  })

  it('does not pair a later reused tool id across a held authored turn', async () => {
    const c = await setup()
    await c.append({ role: 'assistant', content: [{ type: 'tool_use', id: 'reused-call', name: 'presentDocument',
      input: { title: 'Undelivered document', content: 'HIDDEN_UNDELIVERED_DOCUMENT' } }] })
    const boundary = await c.append({ role: 'user', senderUserId: c.actor, content: [{ type: 'text', text: 'HIDDEN_INTERVENING_PROMPT' }] })
    await c.append({ role: 'user', content: [{ type: 'tool_result', toolUseId: 'reused-call', name: 'presentDocument', content: '{}', isError: false }] })
    await c.f.pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1', [boundary.id])
    const response = await c.read()
    expect(response.status, response.text).toBe(200)
    expect(response.text).not.toContain('HIDDEN_')
    expect(response.text).not.toContain('Undelivered document')
  })

  it('reads more than one SQL page and pairs a delivered document across the page boundary', async () => {
    const c = await setup(), ids = [c.input.id, c.reply.id]
    // The first SQL page ends with a tool call; its readable result is on the
    // second page. Both pagination and cross-page receipt pairing are exercised.
    for (let index = 0; index < 97; index++) {
      const row = await c.append({ role: 'user', senderUserId: c.actor, content: [{ type: 'text', text: `Fictional pagination input ${index}` }] })
      ids.push(row.id)
    }
    const call = await c.append({ role: 'assistant', content: [{ type: 'tool_use', id: 'boundary-document', name: 'presentDocument',
      input: { title: 'Boundary document', content: 'Delivered across pages' } }] })
    const result = await c.append({ role: 'user', content: [{ type: 'tool_result', toolUseId: 'boundary-document', name: 'presentDocument', content: '{}', isError: false }] })
    ids.push(call.id, result.id)
    const response = await c.read()
    expect(response.status, response.text).toBe(200)
    expect(response.body.map((row: PresentationRow) => row.id)).toEqual(ids)
    expect(new Set(response.body.map((row: PresentationRow) => row.id)).size).toBe(101)
    expect(response.body.find((row: PresentationRow) => row.id === call.id).content[0]).toMatchObject({
      type: 'tool_use', name: 'presentDocument', input: { content: 'Delivered across pages' },
    })
  }, 120_000)
})
