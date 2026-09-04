import { describe, expect, it } from 'vitest'
import {
  buildEmailDraftAnchorPrompt,
  createCrmEmailDraftTools,
  formatActiveEmailDraftContext,
  type CrmEmailDraft,
  type CrmEmailDraftStore,
} from '../email-drafts.js'

/** [COMP:crm/email-drafts] Durable canonical email-draft anchors. */

const WORKSPACE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FIRST_DRAFT_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_DRAFT_ID = '22222222-2222-4222-8222-222222222222'

function makeStore(): CrmEmailDraftStore & { versions: CrmEmailDraft[] } {
  const drafts = new Map<string, CrmEmailDraft>()
  const active = new Map<string, string>()
  const versions: CrmEmailDraft[] = []
  let nextId = 0

  return {
    versions,
    async saveRevision(params) {
      const existing = params.draftId ? drafts.get(params.draftId) : null
      if (params.draftId && (!existing || existing.workspaceId !== params.workspaceId)) return null
      const now = new Date(`2026-08-27T00:00:0${versions.length}.000Z`)
      const row: CrmEmailDraft = {
        id: existing?.id ?? [FIRST_DRAFT_ID, SECOND_DRAFT_ID][nextId++]!,
        workspaceId: params.workspaceId,
        status: 'draft',
        revision: (existing?.revision ?? 0) + 1,
        from: params.from ?? null,
        to: [...params.to],
        cc: [...(params.cc ?? [])],
        bcc: [...(params.bcc ?? [])],
        subject: params.subject,
        body: params.body,
        attachments: [...(params.attachments ?? [])],
        createdByUserId: params.userId,
        createdByAssistantId: params.assistantId,
        sourceSessionId: params.sessionId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      drafts.set(row.id, row)
      active.set(`${params.workspaceId}:${params.sessionId}`, row.id)
      versions.push({ ...row, to: [...row.to], cc: [...row.cc], bcc: [...row.bcc], attachments: [...row.attachments] })
      return row
    },
    async getById(params) {
      const row = drafts.get(params.draftId)
      return row?.workspaceId === params.workspaceId ? row : null
    },
    async getActiveForSession(params) {
      const id = active.get(`${params.workspaceId}:${params.sessionId}`)
      return id ? drafts.get(id) ?? null : null
    },
    async list(params) {
      return [...drafts.values()]
        .filter((row) => row.workspaceId === params.workspaceId)
        .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())
        .slice(0, params.limit ?? 25)
    },
  }
}

const context = {
  assistantId: 'assistant-1',
  userId: 'user-1',
  sessionId: 'session-1',
  appId: 'Use Brian',
  channelType: 'telegram',
  channelId: 'chat-1',
  workspaceId: WORKSPACE_ID,
  abortSignal: new AbortController().signal,
}

describe('[COMP:crm/email-drafts] canonical draft tools', () => {
  it('revises the active conversation draft with a stable id and complete body plus attachments', async () => {
    const store = makeStore()
    const tools = createCrmEmailDraftTools(store)

    const first = await tools.saveEmailDraft.execute({
      from: 'Team <team@example.test>',
      to: ['Dana <dana@example.test>'],
      cc: ['Colleague <colleague@example.test>'],
      bcc: [],
      subject: 'Implementation update',
      body: 'Hello Dana,\n\nOriginal complete draft.\n\nRegards,\nTeam',
      attachments: ['/travel/itinerary.pdf'],
    }, context)
    const revised = await tools.saveEmailDraft.execute({
      from: 'Team <team@example.test>',
      to: ['Dana <dana@example.test>'],
      cc: ['Colleague <colleague@example.test>'],
      bcc: [],
      subject: 'Implementation update',
      body: 'Hello Dana,\n\nOriginal complete draft with only one reference changed.\n\nRegards,\nTeam',
      attachments: ['/travel/itinerary.pdf', '/travel/receipt.pdf'],
    }, context)

    expect(first.isError).not.toBe(true)
    expect(revised.data).toMatchObject({
      draft_id: FIRST_DRAFT_ID,
      revision: 2,
      crm_path: `/w/${WORKSPACE_ID}/crm?review=email&draft=${FIRST_DRAFT_ID}`,
      body: 'Hello Dana,\n\nOriginal complete draft with only one reference changed.\n\nRegards,\nTeam',
      attachments: ['/travel/itinerary.pdf', '/travel/receipt.pdf'],
    })
    expect(store.versions.map((row) => ({ id: row.id, revision: row.revision, body: row.body, attachments: row.attachments })))
      .toEqual([
        { id: FIRST_DRAFT_ID, revision: 1, body: 'Hello Dana,\n\nOriginal complete draft.\n\nRegards,\nTeam', attachments: ['/travel/itinerary.pdf'] },
        { id: FIRST_DRAFT_ID, revision: 2, body: 'Hello Dana,\n\nOriginal complete draft with only one reference changed.\n\nRegards,\nTeam', attachments: ['/travel/itinerary.pdf', '/travel/receipt.pdf'] },
      ])
  })

  it('starts another draft only when explicitly requested and can read either exact draft', async () => {
    const store = makeStore()
    const tools = createCrmEmailDraftTools(store)
    const envelope = {
      to: ['first@example.test'], cc: [], bcc: [], subject: 'First', body: 'First complete body',
    }
    await tools.saveEmailDraft.execute(envelope, context)
    await tools.saveEmailDraft.execute({
      ...envelope,
      start_new: true,
      to: ['second@example.test'],
      subject: 'Second',
      body: 'Second complete body',
    }, context)

    expect((await tools.getEmailDraft.execute({}, context)).data)
      .toMatchObject({ draft_id: SECOND_DRAFT_ID, subject: 'Second', body: 'Second complete body' })
    expect((await tools.getEmailDraft.execute({ draft_id: FIRST_DRAFT_ID }, context)).data)
      .toMatchObject({ draft_id: FIRST_DRAFT_ID, subject: 'First', body: 'First complete body' })
    expect((await tools.listEmailDrafts.execute({}, context)).data).toEqual([
      expect.objectContaining({ draft_id: SECOND_DRAFT_ID, subject: 'Second' }),
      expect.objectContaining({ draft_id: FIRST_DRAFT_ID, subject: 'First' }),
    ])
  })

  it('round-trips attachment refs through the schema, reads, and explicit removal', async () => {
    const store = makeStore()
    const tools = createCrmEmailDraftTools(store)
    const envelope = { to: [], subject: 'Supporting documents', body: 'Complete draft body' }
    const attachments = ['/documents/photo.jpg', '33333333-3333-4333-8333-333333333333']
    const input = tools.saveEmailDraft.inputSchema.parse({ ...envelope, attachments })

    await tools.saveEmailDraft.execute(input, context)
    expect((await tools.getEmailDraft.execute({}, context)).data)
      .toMatchObject({ attachments, revision: 1 })
    expect((await tools.listEmailDrafts.execute({}, context)).data)
      .toEqual([expect.objectContaining({ attachment_count: 2 })])

    await tools.saveEmailDraft.execute({ ...envelope, attachments: [] }, context)
    expect((await tools.getEmailDraft.execute({}, context)).data)
      .toMatchObject({ attachments: [], revision: 2 })
    expect(store.versions[0]?.attachments).toEqual(attachments)
    expect(store.versions[1]?.attachments).toEqual([])
  })

  it('accepts legacy drafts without attachments and rejects invalid or oversized lists', async () => {
    const tools = createCrmEmailDraftTools(makeStore())
    const envelope = { to: [], subject: 'Working draft', body: 'Complete draft body' }
    expect((await tools.saveEmailDraft.execute(envelope, context)).data)
      .toMatchObject({ attachments: [] })
    expect(tools.saveEmailDraft.inputSchema.safeParse({ ...envelope, attachments: [''] }).success).toBe(false)
    expect(tools.saveEmailDraft.inputSchema.safeParse({
      ...envelope, attachments: Array.from({ length: 11 }, (_, i) => `/documents/${i}.pdf`),
    }).success).toBe(false)
  })

  it('anchors an early draft before a recipient has been chosen', async () => {
    const tools = createCrmEmailDraftTools(makeStore())
    const parsed = tools.saveEmailDraft.inputSchema.safeParse({
      to: [],
      cc: [],
      bcc: [],
      subject: 'Recipient pending',
      body: 'Complete working body while the recipient is still undecided.',
    })

    expect(parsed.success).toBe(true)
    const saved = await tools.saveEmailDraft.execute(parsed.success ? parsed.data : ({} as never), context)
    expect(saved.data).toMatchObject({ to: [], subject: 'Recipient pending', revision: 1 })
  })

  it('keeps the prompt tool-aware and reattaches the exact full saved revision', () => {
    const tools = createCrmEmailDraftTools(makeStore())
    expect(tools.saveEmailDraft.requiresCapability).toBe('crm')
    expect(tools.getEmailDraft.requiresCapability).toBe('crm')
    expect(tools.listEmailDrafts.requiresCapability).toBe('crm')
    expect(buildEmailDraftAnchorPrompt(new Map())).toBe('')
    expect(buildEmailDraftAnchorPrompt(new Map([['saveEmailDraft', tools.saveEmailDraft]])))
      .toContain('complete current envelope, body, and Brain-file attachment list')

    const body = 'Hello,\n\nKeep every line exactly.\nReference: ABC-123\n\nRegards'
    const rendered = formatActiveEmailDraftContext({
      id: FIRST_DRAFT_ID,
      workspaceId: WORKSPACE_ID,
      status: 'draft',
      revision: 7,
      from: 'team@example.test',
      to: ['recipient@example.test'],
      cc: [],
      bcc: [],
      subject: 'Exact draft',
      body,
      attachments: ['/travel/receipt.pdf'],
      createdByUserId: 'user-1',
      createdByAssistantId: 'assistant-1',
      sourceSessionId: 'session-1',
      createdAt: new Date('2026-08-27T00:00:00.000Z'),
      updatedAt: new Date('2026-08-27T00:01:00.000Z'),
    })
    expect(rendered).toContain(`Draft ID: ${FIRST_DRAFT_ID}`)
    expect(rendered).toContain(`CRM path: /w/${WORKSPACE_ID}/crm?review=email&draft=${FIRST_DRAFT_ID}`)
    expect(rendered).toContain(body)
    expect(rendered).toContain('Attachments: ["/travel/receipt.pdf"]')
    expect(rendered).toContain('--- BEGIN SAVED EMAIL BODY ---')
    expect(rendered).toContain('--- END SAVED EMAIL BODY ---')
  })
})
