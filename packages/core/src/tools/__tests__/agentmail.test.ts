import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAgentmailTools, type AgentmailToolApi } from '../base/agentmail.js'
import type { Tool, ToolContext } from '../types.js'

function makeApi(overrides: Partial<AgentmailToolApi> = {}): AgentmailToolApi {
  return {
    listInboxes: vi.fn(async () => [
      { address: 'ada@agentmail.to', isDefault: true },
      { address: 'ops@mail.acme.com', isDefault: false },
    ]),
    send: vi.fn(async () => ({ messageId: 'm1', threadId: 't1' })),
    searchThreads: vi.fn(async () => [
      {
        threadId: 't1',
        inbox: 'ada@agentmail.to',
        subject: 'Q3',
        preview: 'hello',
        senders: ['sarah@acme.com'],
        timestamp: '2026-07-15T00:00:00Z',
        messageCount: 3,
      },
    ]),
    createDraft: vi.fn(async () => ({ draftId: 'd1', sendAt: null })),
    ...overrides,
  }
}

function toolByName(tools: Tool[], name: string): Tool {
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`missing tool ${name}`)
  return tool
}

const CTX = { workspaceId: 'ws-1' } as unknown as ToolContext
const CONFIDENTIAL_CTX = {
  workspaceId: 'ws-1',
  sensitivity: { max: 'confidential' },
} as unknown as ToolContext

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:tools/agentmail] Assistant Email tools', () => {
  it('declares the identity contract: own-address sends, ask-gated, never a silent Gmail fallback', () => {
    const tools = createAgentmailTools(makeApi())
    const send = toolByName(tools, 'agentmailSendMessage')
    expect(send.description).toContain("assistant's OWN email address")
    expect(send.description).toContain("NOT the user's")
    expect(send.description).toMatch(/never silently substitute/i)
    expect(send.requiresConfirmation).toBe(true)
    expect(send.isReadOnly).toBe(false)

    const search = toolByName(tools, 'agentmailSearchThreads')
    expect(search.isReadOnly).toBe(true)
    expect(search.requiresConfirmation).toBeFalsy()

    const draft = toolByName(tools, 'agentmailCreateDraft')
    expect(draft.requiresConfirmation).toBe(true)
  })

  it('sends from the default inbox and reports which address was used', async () => {
    const api = makeApi()
    const send = toolByName(createAgentmailTools(api), 'agentmailSendMessage')
    const result = await send.execute(
      { to: ['x@y.z'], subject: 'hi', body: 'hello' },
      CTX,
    )
    expect(result.isError).toBeFalsy()
    expect(result.data).toEqual({ sentFrom: 'ada@agentmail.to', messageId: 'm1', threadId: 't1' })
    expect(api.send).toHaveBeenCalledWith(
      expect.objectContaining({ inboxAddress: 'ada@agentmail.to', to: ['x@y.z'] }),
    )
  })

  it('honors fromInbox and rejects an unknown inbox listing the real ones', async () => {
    const api = makeApi()
    const send = toolByName(createAgentmailTools(api), 'agentmailSendMessage')
    await send.execute(
      { to: ['x@y.z'], subject: 'hi', body: 'b', fromInbox: 'OPS@mail.acme.com' },
      CTX,
    )
    expect(api.send).toHaveBeenCalledWith(expect.objectContaining({ inboxAddress: 'ops@mail.acme.com' }))

    const bad = await send.execute(
      { to: ['x@y.z'], subject: 'hi', body: 'b', fromInbox: 'ghost@nowhere.io' },
      CTX,
    )
    expect(bad.isError).toBe(true)
    expect(bad.data).toContain('ada@agentmail.to')
    expect(api.send).toHaveBeenCalledTimes(1)
  })

  it('refuses send AND scheduled draft on a confidential turn (egress gate)', async () => {
    const api = makeApi()
    const tools = createAgentmailTools(api)
    const send = await toolByName(tools, 'agentmailSendMessage').execute(
      { to: ['x@y.z'], subject: 's', body: 'b' },
      CONFIDENTIAL_CTX,
    )
    expect(send.isError).toBe(true)
    expect(send.data).toContain('confidential')
    const draft = await toolByName(tools, 'agentmailCreateDraft').execute(
      { to: ['x@y.z'], subject: 's', body: 'b', sendAt: '2026-07-16T09:00:00Z' },
      CONFIDENTIAL_CTX,
    )
    expect(draft.isError).toBe(true)
    expect(api.send).not.toHaveBeenCalled()
    expect(api.createDraft).not.toHaveBeenCalled()
  })

  it('errors honestly when the workspace has no inbox yet', async () => {
    const api = makeApi({ listInboxes: vi.fn(async () => []) })
    const send = toolByName(createAgentmailTools(api), 'agentmailSendMessage')
    const result = await send.execute({ to: ['x@y.z'], subject: 's', body: 'b' }, CTX)
    expect(result.isError).toBe(true)
    expect(result.data).toContain('no assistant inbox')
  })

  it('searchThreads returns the projected thread summaries', async () => {
    const api = makeApi()
    const search = toolByName(createAgentmailTools(api), 'agentmailSearchThreads')
    const result = await search.execute({ subjectContains: 'Q3', limit: 5 }, CTX)
    expect(result.isError).toBeFalsy()
    expect(result.data).toEqual({
      inbox: 'ada@agentmail.to',
      threads: [
        expect.objectContaining({ threadId: 't1', subject: 'Q3', senders: ['sarah@acme.com'] }),
      ],
    })
    expect(api.searchThreads).toHaveBeenCalledWith(
      expect.objectContaining({ inboxAddress: 'ada@agentmail.to', subjectContains: 'Q3', limit: 5 }),
    )
  })

  it('createDraft distinguishes scheduled sends from review drafts', async () => {
    const api = makeApi({
      createDraft: vi.fn(async (p: { sendAt?: string }) => ({ draftId: 'd2', sendAt: p.sendAt ?? null })),
    })
    const draft = toolByName(createAgentmailTools(api), 'agentmailCreateDraft')

    const review = await draft.execute({ to: ['x@y.z'], subject: 's', body: 'b' }, CTX)
    expect(review.data).toMatchObject({ draftId: 'd2', status: 'awaiting review' })

    const scheduled = await draft.execute(
      { to: ['x@y.z'], subject: 's', body: 'b', sendAt: '2026-07-16T09:00:00Z' },
      CTX,
    )
    expect(scheduled.data).toMatchObject({ status: 'scheduled', sendAt: '2026-07-16T09:00:00Z' })
  })

  it('surfaces vendor errors as tool errors, never throws', async () => {
    const api = makeApi({ send: vi.fn(async () => { throw new Error('vendor 500') }) })
    const send = toolByName(createAgentmailTools(api), 'agentmailSendMessage')
    const result = await send.execute({ to: ['x@y.z'], subject: 's', body: 'b' }, CTX)
    expect(result.isError).toBe(true)
    expect(result.data).toContain('vendor 500')
  })
})
