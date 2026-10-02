import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dispatchPersistedWebInput } from '../_incoming-chat-event.js'
import { setMessageEventDispatcher } from '../../message-events.js'
import { createWorkflowEventDispatcher } from '../../../../core/src/workflow/event-trigger.js'
import { isWorkspaceWideWebChat, type WebChatEventScope } from '../_web-chat-event-scope.js'

const input = () => ({
  workspaceId: 'workspace-1',
  session: {
    id: '11111111-1111-1111-1111-111111111111', channelType: 'web', visibility: 'workspace',
    mode: null as string | null, effectiveClearance: 'public',
    contextGroupId: null as string | null, contextProjectId: null as string | null,
    contextCompartments: [] as string[],
  },
  userId: 'authenticated-user',
  stored: { id: 'persisted-message', createdAt: new Date('2026-01-02T03:04:05.123Z') },
  text: 'human input',
})

afterEach(() => { setMessageEventDispatcher(undefined); vi.restoreAllMocks() })

describe('persisted web input → normalized dispatcher', () => {
  it.each([null, 'chat', 'workflow', 'assistant', 'brain'])('includes human appOrigin=%s with stable session identity', (appOrigin) => {
    const dispatch = vi.fn().mockResolvedValue(undefined)
    setMessageEventDispatcher({ dispatch })
    const value = input()
    dispatchPersistedWebInput({ ...value, session: { ...value.session, ...{ appOrigin, channelId: 'untrusted-alias' } } })
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      workspaceId: 'workspace-1',
      source: { type: 'channel', channel: 'web', channelIntegrationId: input().session.id },
      channelId: input().session.id, actorId: 'authenticated-user', text: 'human input',
      occurredAt: '2026-01-02T03:04:05.123Z', isBot: false, isGroupChat: true,
      payload: expect.objectContaining({ message_id: 'persisted-message' }),
    }))
  })

  it.each([
    { visibility: 'owner' },
    { visibility: null },
    { effectiveClearance: 'internal' },
    { effectiveClearance: 'confidential' },
    { effectiveClearance: null },
    { effectiveClearance: undefined },
    { effectiveClearance: 'unknown' },
    { contextCompartments: ['team:private'] },
    { contextCompartments: null },
    { contextCompartments: undefined },
    { contextProjectId: 'private-project' },
    { contextProjectId: undefined },
    { contextGroupId: 'private-team' },
    { contextGroupId: undefined },
    { mode: 'draft' },
    { mode: undefined },
  ])('blocks known source UUID subscriptions for restricted/incomplete scope %j', async (restricted) => {
    const value = input()
    const find = vi.fn().mockResolvedValue([{
      workflowId: 'manual-subscription', workspaceId: value.workspaceId,
      sources: [{ source: { type: 'channel', channel: 'web', channelIntegrationId: value.session.id } }],
    }])
    const start = vi.fn().mockResolvedValue(undefined)
    // Real matching + run dispatch, not just a mocked normalization function.
    setMessageEventDispatcher(createWorkflowEventDispatcher({
      findEventTriggeredWorkflows: find, startWorkflowRun: start,
    }))
    const session = { ...value.session, ...restricted } as WebChatEventScope & { id: string }
    dispatchPersistedWebInput({ ...value, session, text: 'private secret' })
    await Promise.resolve()
    expect(find).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    // The same known UUID really IS subscribed. Only the producer's audience
    // guard prevents the leak, not picker filtering or source mismatch.
    dispatchPersistedWebInput(value)
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: 'manual-subscription',
      input: expect.objectContaining({ event: expect.objectContaining({ text: 'human input' }) }),
    }))
  })

  it('fails closed when a scope field was omitted from a projection', () => {
    for (const key of ['visibility', 'mode', 'effectiveClearance', 'contextGroupId', 'contextProjectId', 'contextCompartments']) {
      const projected = { ...input().session } as Record<string, unknown>
      delete projected[key]
      expect(isWorkspaceWideWebChat(projected as WebChatEventScope)).toBe(false)
    }
  })

  it('marks silent workspace room inputs as group messages', () => {
    const dispatch = vi.fn().mockResolvedValue(undefined)
    setMessageEventDispatcher({ dispatch })
    const value = input()
    dispatchPersistedWebInput({ ...value, session: { ...value.session, visibility: 'workspace' } })
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ isGroupChat: true }))
  })

  it('excludes replay/edit, workflow channel echoes, and missing workspace', () => {
    const dispatch = vi.fn()
    setMessageEventDispatcher({ dispatch })
    dispatchPersistedWebInput({ ...input(), replay: true })
    dispatchPersistedWebInput({ ...input(), workspaceId: null })
    dispatchPersistedWebInput({ ...input(), session: { ...input().session, channelType: 'workflow' } })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('does not break chat if dispatcher is absent or fails', async () => {
    expect(() => dispatchPersistedWebInput(input())).not.toThrow()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    setMessageEventDispatcher({ dispatch: vi.fn().mockRejectedValue(new Error('offline')) })
    expect(() => dispatchPersistedWebInput(input())).not.toThrow()
    await Promise.resolve()
    expect(log).toHaveBeenCalled()
  })
})

// Wiring checks complement runtime envelope tests without loading the massive
// model/tool dependency graph. They are NOT full HTTP authorization tests.
const source = (name: string) => readFileSync(new URL(`../${name}.ts`, import.meta.url), 'utf8')
describe('route persistence boundaries', () => {
  it('covers chat room posts, ordinary inputs, and consumed mid-turn inputs only', () => {
    const chat = source('chat')
    expect(chat.match(/dispatchPersistedWebInput\(\{/g)).toHaveLength(3)
    expect(chat).toMatch(/stored, text: rawMessage \?\? '', replay: !!truncateFromMessageId/)
    expect(chat).toContain('replay: !!prePersistedUserMsg || !!truncateFromMessageId')
    expect(chat).toContain('stored: storedQueued, text: queuedInput.text')
    for (const [persist, hook] of [
      ['const stored = await addSessionMessage({', 'stored, text: rawMessage'],
      ['const storedUserMsg = prePersistedUserMsg ?? await addSessionMessage({', 'stored: storedUserMsg, text: rawMessage'],
      ['const storedQueued = await authority.execute(() => addSessionMessage({', 'stored: storedQueued, text: queuedInput.text'],
    ]) expect(chat.indexOf(hook)).toBeGreaterThan(chat.indexOf(persist))
  })

  it('dispatches silent posts after authorization/save, never PATCH edits', () => {
    const sessions = source('sessions')
    const post = sessions.slice(sessions.indexOf("router.post('/:id/messages'"), sessions.indexOf("router.patch('/:id/messages/:messageId'"))
    expect(post.indexOf('dispatchPersistedWebInput({')).toBeGreaterThan(post.indexOf('const denied = await gateSessionRead'))
    expect(post.indexOf('dispatchPersistedWebInput({')).toBeGreaterThan(post.indexOf('const stored = await addSessionMessage'))
    expect(sessions.match(/dispatchPersistedWebInput\(\{/g)).toHaveLength(1)
  })

  it('every producer passes the full Session; all loader paths project security fields', () => {
    for (const name of ['chat', 'sessions']) {
      const calls = source(name).match(/dispatchPersistedWebInput\(\{[\s\S]*?\n\s*\}\)/g) ?? []
      expect(calls.length).toBe(name === 'chat' ? 3 : 1)
      for (const call of calls) expect(call).toContain('session, userId: user.id')
    }
    const db = readFileSync(new URL('../../db/sessions.ts', import.meta.url), 'utf8')
    // findOrCreateSession is a thin wrapper: its SQL lives in the unexported
    // insertSession, reached through findOrCreateSessionInternal. Assert on the
    // function that holds the projection, and that the wrapper still reaches it.
    const body = (declaration: string) => {
      // Slice after the function declaration so the split cannot match itself.
      const start = db.indexOf(`${declaration}(`)
      expect(start).toBeGreaterThan(-1)
      const next = db.indexOf('\nexport async function ', start + 1)
      return db.slice(start, next < 0 ? undefined : next)
    }
    expect(body('export async function findOrCreateSession')).toContain('findOrCreateSessionInternal(')
    expect(body('async function findOrCreateSessionInternal')).toContain('insertSession(')
    for (const loader of ['async function insertSession', 'export async function findSessionByChannel', 'export async function findSessionById']) {
      const implementation = body(loader)
      for (const field of ['effectiveClearance', 'contextGroupId', 'contextProjectId', 'contextCompartments']) {
        expect(implementation).toContain(`as "${field}"`)
      }
    }
  })

  it('keeps public/client-isolated turns out of unscoped workspace automation', () => {
    const publicTurn = source('public-turn')
    expect(publicTurn).not.toMatch(/dispatch(?:PersistedWebInput|IncomingMessageEvent)\(/)
    expect(publicTurn).toContain('until dispatch supports scoped authority')
  })
})
