/** [COMP:tools/chat-archive] Native owner-bound chat history tools. */

import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@use-brian/core'
import { createChatArchiveTools } from '../chat-tools.js'
import { CHAT_ARCHIVE_SEARCH_TOOL } from '../tool-catalog.js'

const context = { userId: 'owner-from-context' } as ToolContext

describe('[COMP:tools/chat-archive] native chat archive tools', () => {
  it('exposes exactly one search tool', () => {
    const names = createChatArchiveTools().map((tool) => tool.name)
    expect(names).toEqual(['searchChatHistory'])
  })

  it('routes personal identity questions to chat history before public sources', () => {
    expect(CHAT_ARCHIVE_SEARCH_TOOL.description).toContain('Who is X?')
    expect(CHAT_ARCHIVE_SEARCH_TOOL.description).toContain('before using public web search')
  })

  it('binds search ownership from ToolContext and returns coverage disclosure', async () => {
    const search = vi.fn(async (_input: unknown) => ({
      hits: [{ message_id: 'm-1' }],
      embeddingCoverage: { partial: true, unembeddedInScope: 5, capped: false, note: 'partial' },
	  mediaCoverage: { total: 2, ready: 1, pending: 1, missing: 0, failed: 0, unsupported: 0 },
    }))
    const tool = createChatArchiveTools({ search: search as never })[0]!
    const result = await tool.execute({ query: 'deposit', source: 'whatsapp', kind: 'text' }, context)
    expect(search.mock.calls[0]?.[0]).toMatchObject({
      ownerUserId: 'owner-from-context',
      query: 'deposit',
      source: 'whatsapp',
      kind: 'text',
    })
	expect(result.data).toEqual({
		hits: [{ message_id: 'm-1' }],
		embeddingCoverage: 'partial',
		mediaCoverage: { total: 2, ready: 1, pending: 1, missing: 0, failed: 0, unsupported: 0 },
	})
  })

  it('rejects an invalid time before calling the store, naming the field and the accepted shapes', async () => {
    const search = vi.fn()
    const tool = createChatArchiveTools({ search: search as never })[0]!
    const result = await tool.execute({ query: 'deposit', since: 'not-a-date' }, context)
    expect(result.isError).toBe(true)
    expect(search).not.toHaveBeenCalled()
    const body = String(result.data)
    expect(body).toContain('`since` is not a date this tool can read')
    expect(body).toContain('not-a-date')
    expect(body).toContain('YYYY-MM-DD')
    expect(body).toContain('the same value will fail the same way')
  })

  // docs/architecture/engine/tool-executor.md → "Failure copy". The old
  // wrapper was `searchChatHistory failed: ${err.message}` — the provider's
  // sentence and nothing else, so a store error read as "there is no history".
  it('a store failure names the tool, the query, a next step and the retry verdict', async () => {
    const search = vi.fn(async () => {
      throw new Error('relation "chat_messages" does not exist')
    })
    const tool = createChatArchiveTools({ search: search as never })[0]!
    const result = await tool.execute({ query: 'deposit', source: 'whatsapp' }, context)
    expect(result.isError).toBe(true)
    const body = String(result.data)
    expect(body).toContain('searchChatHistory')
    expect(body).toContain('query "deposit"')
    expect(body).toContain('relation "chat_messages" does not exist')
    expect(body).toContain('only chats that have been synced')
    expect(body).toContain('never present a public-web answer as if it came from')
  })

  it('a transient store blip is marked retryable rather than "fix your arguments"', async () => {
    const search = vi.fn(async () => {
      throw new Error('Connection terminated unexpectedly')
    })
    const tool = createChatArchiveTools({ search: search as never })[0]!
    const result = await tool.execute({ query: 'deposit' }, context)
    expect(result.isError).toBe(true)
    const body = String(result.data)
    expect(body).toContain('transient infrastructure error')
    expect(body).toContain('Retry once')
  })
})
