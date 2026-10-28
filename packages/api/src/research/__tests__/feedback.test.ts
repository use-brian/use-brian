import { describe, expect, it, vi } from 'vitest'
import type { ResearchActivity, ResearchArtifactLink, ResearchFeedback } from '../../db/research-store.js'
import { captureResearchFollowup, outputKeyFor, ownFollowupText, replayResearchFollowups, type FollowupMessage, type ResearchFeedbackDeps } from '../feedback.js'

const WS = '00000000-0000-4000-8000-000000000001'
const MEMBER = '00000000-0000-4000-8000-000000000002'
const OTHER = '00000000-0000-4000-8000-000000000003'

const activity = (id: string, over: Partial<ResearchActivity> = {}): ResearchActivity => ({
  id, workspaceId: WS, sessionId: 's1', requestMessageId: `req-${id}`, outputMessageId: `out-${id}`, actorUserId: MEMBER,
  assistantId: 'a1', projectId: 'p1', taskId: null, predecessorActivityId: null, entry: 'explicit', status: 'saved',
  plannedPageId: null, runtime: {}, sources: [], gaps: [], findingsCount: 1, summary: null, saveError: null,
  sensitivity: 'internal', compartments: ['team:x'], revision: 2, createdAt: new Date(), completedAt: new Date(), ...over,
})
const link = (activityId: string, version: number | null = 1): ResearchArtifactLink => ({
  id: `l-${activityId}`, activityId, kind: 'page', artifactId: `page-${activityId}`, version, relation: 'output', toolName: 'renderPage', verifiedAt: new Date(),
})
const message = (over: Partial<FollowupMessage> = {}): FollowupMessage => ({
  id: 'msg-1', version: 1, role: 'user', content: [{ type: 'text', text: 'You missed the regulatory angle' }],
  senderUserId: MEMBER, sensitivity: 'confidential', compartments: ['team:y'], ...over,
})

function fakeDeps(activities: ResearchActivity[], hidden: string[] = []) {
  const rows = new Map<string, ResearchFeedback>()
  const record = vi.fn<ResearchFeedbackDeps['record']>(async (input) => {
    const existing = rows.get(input.messageId)
    if (existing) return { feedback: existing, inserted: false }
    const fb = { id: `fb-${input.messageId}`, ...input, currentRevision: 1, version: 1, origin: 'machine', decisionEventId: 'ev', createdAt: new Date() } as unknown as ResearchFeedback
    rows.set(input.messageId, fb)
    return { feedback: fb, inserted: true }
  })
  const deps: ResearchFeedbackDeps = {
    listSessionActivities: vi.fn(async () => activities.filter((a) => !hidden.includes(a.id))),
    getActivity: vi.fn(async (_actor, _ws, id) => {
      const a = activities.find((x) => x.id === id && !hidden.includes(id))
      return a ? { activity: a, artifacts: [link(a.id)] } : null
    }),
    record,
  }
  return { deps, record, rows }
}

describe('[COMP:api/research-feedback] Research follow-up capture', () => {
  it('R05: links a single same-chat result with its output version and the max-of-sources floor', async () => {
    const { deps, record } = fakeDeps([activity('a1')])
    const r = await captureResearchFollowup(deps, { workspaceId: WS, sessionId: 's1', assistantId: 'a1', message: message(), externalPrincipal: false })
    expect(r.outcome).toBe('recorded')
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      activityId: 'a1', association: 'same_chat_continuation', outputKey: 'page:page-a1:1', kind: 'missing_coverage', uncertain: false,
      actorUserId: MEMBER, projectId: 'p1', sensitivity: 'confidential', compartments: ['team:x', 'team:y'], messageVersion: 1,
    }))
  })

  it('R05: exact reply and explicit selection pick the right one of several outputs; otherwise nothing links', async () => {
    const two = [activity('a2'), activity('a1')]
    let { deps, record } = fakeDeps(two)
    expect((await captureResearchFollowup(deps, { workspaceId: WS, sessionId: 's1', assistantId: 'a1', message: message(), externalPrincipal: false })).outcome).toBe('unlinked')
    expect(record).not.toHaveBeenCalled()
    await captureResearchFollowup(deps, { workspaceId: WS, sessionId: 's1', assistantId: 'a1', message: message({ id: 'm2' }), externalPrincipal: false, replyToMessageId: 'out-a1' })
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ activityId: 'a1', association: 'explicit_reply' }))
    ;({ deps, record } = fakeDeps(two))
    await captureResearchFollowup(deps, { workspaceId: WS, sessionId: 's9', assistantId: 'a1', message: message({ id: 'm3' }), externalPrincipal: false, selectedActivityId: 'a2' })
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ activityId: 'a2', association: 'explicit_selection' }))
  })

  it('R05: a hidden activity cannot be selected, and an unrelated message in a research chat stays unlinked', async () => {
    const { deps, record } = fakeDeps([activity('a1')], ['a1'])
    expect((await captureResearchFollowup(deps, { workspaceId: WS, sessionId: 's1', assistantId: 'a1', message: message(), externalPrincipal: false, selectedActivityId: 'a1' })).outcome).toBe('no_research')
    const visible = fakeDeps([activity('a1')])
    expect((await captureResearchFollowup(visible.deps, { workspaceId: WS, sessionId: 's1', assistantId: 'a1',
      message: message({ content: 'what time is it in Tokyo' }), externalPrincipal: false })).outcome).toBe('unlinked')
    expect(record).not.toHaveBeenCalled()
    expect(visible.record).not.toHaveBeenCalled()
  })

  it('R06: an explicit follow-up with no clear meaning is recorded as uncertain, not as a verdict', async () => {
    const { deps, record } = fakeDeps([activity('a1')])
    await captureResearchFollowup(deps, { workspaceId: WS, sessionId: 's1', assistantId: 'a1', message: message({ content: 'hmm ok' }), externalPrincipal: false, replyToMessageId: 'out-a1' })
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'uncertain', uncertain: true }))
  })

  it('R07: records once across replay; external principals, assistants and quoted text cannot speak for the member', async () => {
    const { deps, record } = fakeDeps([activity('a1')])
    const params = { workspaceId: WS, sessionId: 's1', assistantId: 'a1', message: message(), externalPrincipal: false }
    expect((await captureResearchFollowup(deps, params)).outcome).toBe('recorded')
    expect((await captureResearchFollowup(deps, params)).outcome).toBe('replayed')
    expect(record).toHaveBeenCalledTimes(2)
    expect((await captureResearchFollowup(deps, { ...params, externalPrincipal: true })).outcome).toBe('not_member')
    expect((await captureResearchFollowup(deps, { ...params, message: message({ role: 'assistant' }) })).outcome).toBe('not_member')
    expect((await captureResearchFollowup(deps, { ...params, message: message({ senderUserId: null }) })).outcome).toBe('not_member')
    // A forwarded quote and a tool result are not the member's own words.
    expect((await captureResearchFollowup(deps, { ...params, message: message({ id: 'q', content: '> That is wrong, the figure is 8%' }) }))).toMatchObject({ outcome: 'not_member', reason: 'no_member_text' })
    expect((await captureResearchFollowup(deps, { ...params, message: message({ id: 't', content: [{ type: 'tool_result', toolUseId: 'x', name: 'n', content: 'wrong' }] }) })).outcome).toBe('not_member')
    // The research request itself is never its own follow-up.
    expect((await captureResearchFollowup(deps, { ...params, message: message({ id: 'req-a1' }) })).outcome).toBe('no_research')
  })

  it('R07: replay records a missed member follow-up once and skips other speakers', async () => {
    const { deps, record } = fakeDeps([activity('a1')])
    const listMessagesAfter = vi.fn(async () => [message({ id: 'm1' }), message({ id: 'm2', senderUserId: OTHER }), message({ id: 'm3', content: 'Too long, use bullet points' })])
    expect(await replayResearchFollowups({ ...deps, listMessagesAfter }, { workspaceId: WS, sessionId: 's1', assistantId: 'a1', actorUserId: MEMBER })).toBe(2)
    expect(await replayResearchFollowups({ ...deps, listMessagesAfter }, { workspaceId: WS, sessionId: 's1', assistantId: 'a1', actorUserId: MEMBER })).toBe(0)
    expect(listMessagesAfter).toHaveBeenCalledWith('s1', 'out-a1', 10)
    expect(record.mock.calls.map((c) => c[0].messageId)).toEqual(['m1', 'm3', 'm1', 'm3'])
  })

  it('reads only text blocks and keys the output by its saved artifact version', () => {
    expect(ownFollowupText([{ type: 'text', text: 'a\n> quoted\nb' }, { type: 'image', source: {} }])).toBe('a\nb')
    expect(outputKeyFor(activity('a1'), [link('a1', null)])).toBe('page:page-a1:latest')
    expect(outputKeyFor(activity('a1'), [])).toBe('message:out-a1')
  })

  it('does not replace an explicitly selected hidden activity with another same-chat result', async () => {
    const { deps,record }=fakeDeps([activity('local'),activity('hidden')],['hidden'])
    expect(await captureResearchFollowup(deps,{workspaceId:WS,sessionId:'s1',assistantId:'a1',message:message(),
      externalPrincipal:false,selectedActivityId:'hidden'})).toMatchObject({outcome:'unlinked',reason:'not_visible'})
    expect(record).not.toHaveBeenCalled()
  })

})
