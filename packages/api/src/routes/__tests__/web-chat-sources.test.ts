import { describe, it, expect, vi, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { readFileSync } from 'node:fs'
import { webChatSourcesHandler, WEB_CHAT_SOURCE_SQL, type WebChatSourceSession } from '../_web-chat-sources.js'
import { dispatchPersistedWebInput } from '../_incoming-chat-event.js'
import { setMessageEventDispatcher } from '../../message-events.js'
import { matchesEvent, type DispatchEvent } from '../../../../core/src/workflow/event-trigger.js'
import { decideSessionRead } from '../../session-read-access.js'

// Exercise the real read predicate without importing the full core barrel.
vi.mock('@use-brian/core', async () => ({
  ...await import('../../../../core/src/security/sensitivity.js'),
  ...await import('../../../../core/src/security/context-scope.js'),
}))
const WS = '11111111-1111-1111-1111-111111111111'
const session = (overrides: Partial<WebChatSourceSession> = {}): WebChatSourceSession => ({
  id: 'session-uuid', workspaceId: WS, assistantId: 'assistant', userId: 'user',
  channelType: 'web', title: 'My chat', appOrigin: 'workflow', visibility: 'workspace',
  mode: null, effectiveClearance: 'public', contextCompartments: [], contextGroupId: null, contextProjectId: null,
  ...overrides,
})
function setup(rows = [session()], authenticated = true, member = true) {
  const deps = {
    isWorkspaceMember: vi.fn().mockResolvedValue(member),
    listCandidates: vi.fn().mockResolvedValue(rows),
    canReadSession: vi.fn(async (userId: string, s: WebChatSourceSession) => decideSessionRead({
      callerUserId: userId, session: s, assistantWorkspaceId: s.workspaceId,
      membershipClearance: 'internal', membershipCompartments: [], membershipProjectIds: [],
    }).readable),
  }
  const app = express()
  if (authenticated) app.use((req, _res, next) => { Object.assign(req, { userId: 'user' }); next() })
  app.get('/sources', webChatSourcesHandler(deps))
  return { app, deps }
}
afterEach(() => setMessageEventDispatcher(undefined))

describe('web chat event sources', () => {
  it.each(['workflow', 'assistant', null])('selectable %s chat matches the dispatched source exactly', async (appOrigin) => {
    const s = session({ appOrigin })
    const { app, deps } = setup([s])
    const { body } = await request(app).get(`/sources?workspaceId=${WS}`).expect(200)
    expect(deps.listCandidates).toHaveBeenCalledWith(WS, 'user')
    expect(body.sources).toEqual([{ id: s.id, channelType: 'web', displayName: expect.stringContaining('My chat') }])
    const option = body.sources[0]
    const selected = { source: { type: 'channel' as const, channelIntegrationId: option.id, channel: option.channelType } }
    const dispatch = vi.fn<(event: DispatchEvent) => Promise<void>>().mockResolvedValue(undefined)
    setMessageEventDispatcher({ dispatch })
    dispatchPersistedWebInput({ workspaceId: WS, session: s, userId: 'user', text: 'hello', stored: { id: 'msg', createdAt: new Date() } })
    expect(dispatch).toHaveBeenCalledOnce()
    const event = dispatch.mock.calls[0][0]
    expect(matchesEvent(event, selected)).toBe(true)
    expect(matchesEvent(event, { source: { ...selected.source, channelIntegrationId: 'different-session' } })).toBe(false)
  })

  it('requires authentication and membership before enumeration', async () => {
    for (const [authenticated, member, status] of [[false, true, 401], [true, false, 403]] as const) {
      const { app, deps } = setup(undefined, authenticated, member)
      await request(app).get(`/sources?workspaceId=${WS}`).expect(status)
      expect(deps.listCandidates).not.toHaveBeenCalled()
    }
  })

  it('rejects missing/invalid workspace ids before querying', async () => {
    const { app, deps } = setup()
    await request(app).get('/sources').expect(400)
    await request(app).get('/sources?workspaceId=invalid').expect(400)
    expect(deps.isWorkspaceMember).not.toHaveBeenCalled()
  })

  it('omits foreign/private/public/workflow and unreadable shared-session labels', async () => {
    const { app } = setup([
      session(), session({ id: 'private', userId: 'other', visibility: 'owner' }),
      session({ id: 'own-private', visibility: 'owner' }),
      session({ id: 'internal', effectiveClearance: 'internal' }),
      session({ id: 'null-clearance', effectiveClearance: null }),
      session({ id: 'group-only', contextGroupId: 'hidden-team' }),
      session({ id: 'draft', mode: 'draft' }),
      session({ id: 'foreign', workspaceId: 'other-workspace' }),
      session({ id: 'public', channelType: 'api' }),
      session({ id: 'generated', channelType: 'workflow' }),
      session({ id: 'high', visibility: 'workspace', effectiveClearance: 'confidential' }),
      session({ id: 'team', visibility: 'workspace', contextCompartments: ['team:hidden'] }),
      session({ id: 'project', visibility: 'workspace', contextProjectId: 'hidden' }),
      session({ id: 'room', visibility: 'workspace', userId: 'other' }),
    ])
    const { body } = await request(app).get(`/sources?workspaceId=${WS}`).expect(200)
    expect(body.sources.map((s: { id: string }) => s.id)).toEqual(['session-uuid', 'room'])
  })

  it('read permission, even for an owner/admin, cannot expose restricted sources', async () => {
    const { app, deps } = setup([
      session({ visibility: 'owner' }),
      session({ contextCompartments: ['secret'] }),
      session({ contextProjectId: 'secret' }),
      session({ effectiveClearance: 'internal' }),
      session({ effectiveClearance: null }),
    ])
    deps.canReadSession.mockResolvedValue(true)
    const { body } = await request(app).get(`/sources?workspaceId=${WS}`).expect(200)
    expect(body.sources).toEqual([])
    expect(deps.canReadSession).not.toHaveBeenCalled()
  })

  it('does not discover incomplete scope projections even when the caller can read them', async () => {
    for (const field of ['visibility', 'mode', 'effectiveClearance', 'contextGroupId', 'contextProjectId', 'contextCompartments']) {
      const projected = { ...session() } as Record<string, unknown>
      delete projected[field]
      const { app, deps } = setup([projected as WebChatSourceSession])
      deps.canReadSession.mockResolvedValue(true)
      const { body } = await request(app).get(`/sources?workspaceId=${WS}`).expect(200)
      expect(body.sources).toEqual([])
    }
  })

  it('production wiring uses assistant access and the existing full session gate', () => {
    const source = readFileSync(new URL('../sessions.ts', import.meta.url), 'utf8')
    expect(source).toContain("router.get('/incoming-event-sources', webChatSourcesHandler({")
    expect(source).toContain('getWorkspaceRoleSystem(userId, workspaceId)')
    expect(source).toContain('getUserAssistant(userId, session.assistantId) &&')
    expect(source).toContain('!(await gateSessionRead(userId, session))')
    expect(WEB_CHAT_SOURCE_SQL).toContain("a.workspace_id = $1 AND s.channel_type = 'web'")
    expect(WEB_CHAT_SOURCE_SQL).not.toContain('s.app_origin =')
    expect(WEB_CHAT_SOURCE_SQL).toContain("s.visibility = 'workspace' AND s.mode IS NULL")
    expect(WEB_CHAT_SOURCE_SQL).toContain("s.effective_clearance = 'public'")
    expect(WEB_CHAT_SOURCE_SQL).toContain('s.context_group_id IS NULL AND s.context_project_id IS NULL')
    expect(WEB_CHAT_SOURCE_SQL).toContain('s.context_compartments = ARRAY[]::text[]')
    expect(WEB_CHAT_SOURCE_SQL).toContain('s.context_group_id AS "contextGroupId"')
  })
})
