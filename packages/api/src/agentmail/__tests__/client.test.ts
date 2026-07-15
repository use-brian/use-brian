import { describe, it, expect, vi } from 'vitest'
import { createAgentmailClient, AgentmailApiError } from '../client.js'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('[COMP:api/agentmail-client] AgentMail REST client', () => {
  it('creates an inbox with Bearer auth and returns the parsed inbox', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        inbox_id: 'ada@agentmail.to',
        email: 'ada@agentmail.to',
        display_name: 'Ada',
        client_id: 'ck-1',
        created_at: '2026-07-15T00:00:00Z',
      }),
    )
    const client = createAgentmailClient({ apiKey: 'am-key', fetchImpl })

    const inbox = await client.createInbox({ username: 'ada', client_id: 'ck-1' })

    expect(inbox.inbox_id).toBe('ada@agentmail.to')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.agentmail.to/v0/inboxes')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer am-key')
    expect(JSON.parse(init.body)).toEqual({ username: 'ada', client_id: 'ck-1' })
  })

  it('URL-encodes path params (inbox ids are email addresses)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { message_id: 'm1', thread_id: 't1' }),
    )
    const client = createAgentmailClient({ apiKey: 'k', fetchImpl })

    await client.replyToMessage('ada@agentmail.to', 'msg/1', { text: 'hi' })

    const [url] = fetchImpl.mock.calls[0]
    expect(url).toBe(
      'https://api.agentmail.to/v0/inboxes/ada%40agentmail.to/messages/msg%2F1/reply',
    )
  })

  it('serializes repeated query params for thread filters', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { threads: [], count: 0 }),
    )
    const client = createAgentmailClient({ apiKey: 'k', fetchImpl })

    await client.listThreads('ada@agentmail.to', {
      limit: 10,
      senders: ['a@x.com', 'b@y.com'],
    })

    const [url] = fetchImpl.mock.calls[0]
    const parsed = new URL(url)
    expect(parsed.searchParams.get('limit')).toBe('10')
    expect(parsed.searchParams.getAll('senders')).toEqual(['a@x.com', 'b@y.com'])
  })

  it('returns null on 404 for get endpoints', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('not found', { status: 404 }))
    const client = createAgentmailClient({ apiKey: 'k', fetchImpl })
    expect(await client.getMessage('ada@agentmail.to', 'missing')).toBeNull()
    expect(await client.getInbox('missing@agentmail.to')).toBeNull()
    expect(await client.getDomain('missing')).toBeNull()
  })

  it('throws a reconnect-worded AgentmailApiError on 401/403', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }))
    const client = createAgentmailClient({ apiKey: 'bad', fetchImpl })
    await expect(client.getInbox('a@b.c')).rejects.toThrow(/API key/)
    await expect(client.getInbox('a@b.c')).rejects.toBeInstanceOf(AgentmailApiError)
  })

  it('throws with status + truncated body on other errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('boom'.repeat(200), { status: 500 }))
    const client = createAgentmailClient({ apiKey: 'k', fetchImpl })
    await expect(client.sendMessage('a@b.c', { to: 'x@y.z', text: 'hi' })).rejects.toThrow(
      /AgentMail API error \(500\)/,
    )
  })

  it('rejects a response that fails schema validation', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { message_id: 42 }))
    const client = createAgentmailClient({ apiKey: 'k', fetchImpl })
    await expect(client.sendMessage('a@b.c', { to: 'x@y.z', text: 'hi' })).rejects.toThrow()
  })
})
