/**
 * searchEmailArchive tool — owner/instance are injection-bound (never model
 * inputs), routing honesty in the description, and the global-seam gating.
 *
 * [COMP:tools/email-archive-search]
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  createSearchEmailArchiveTool,
  setGlobalMailboxArchiveDeps,
  getGlobalMailboxArchiveDeps,
} from '../archive-search-tool.js'
import type { ToolContext } from '@use-brian/core'

const CTX = {} as unknown as ToolContext

afterEach(() => {
  setGlobalMailboxArchiveDeps(null)
})

describe('[COMP:tools/email-archive-search] searchEmailArchive tool', () => {
  it('binds owner + instance in the closure — the model cannot pivot to another archive', async () => {
    const search = vi.fn(async () => [])
    const tool = createSearchEmailArchiveTool({
      ownerUserId: 'owner-1',
      accounts: [{ instanceId: 'inst-1', email: 'me@corp.com', isPrimary: true }],
      deps: { search: search as never },
    })
    await tool.execute({ query: 'deposit terms', topK: 5 }, CTX)
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: 'owner-1', instanceId: 'inst-1', query: 'deposit terms', topK: 5 }),
      undefined,
    )
    // The input schema exposes no owner/instance knobs.
    const shape = Object.keys((tool.inputSchema as unknown as { shape: Record<string, unknown> }).shape)
    expect(shape).not.toContain('ownerUserId')
    expect(shape).not.toContain('instanceId')
  })

  it('routes to the primary archive by default and to a named account, never model-controlled instance', async () => {
    const search = vi.fn(async () => [])
    const tool = createSearchEmailArchiveTool({
      ownerUserId: 'owner-1',
      accounts: [
        { instanceId: 'inst-primary', email: 'me@corp.com', isPrimary: true },
        { instanceId: 'inst-other', email: 'other@corp.com', isPrimary: false },
      ],
      deps: { search: search as never },
    })
    // Default → primary archive.
    await tool.execute({ query: 'q1' }, CTX)
    expect(search).toHaveBeenNthCalledWith(1, expect.objectContaining({ instanceId: 'inst-primary' }), undefined)
    // account → the named archive.
    await tool.execute({ query: 'q2', account: 'other@corp.com' }, CTX)
    expect(search).toHaveBeenNthCalledWith(2, expect.objectContaining({ instanceId: 'inst-other' }), undefined)
    // Unknown account → honest error, no store call.
    const miss = await tool.execute({ query: 'q3', account: 'ghost@corp.com' }, CTX)
    expect(miss.isError).toBe(true)
    expect(miss.data).toContain('other@corp.com')
    expect(search).toHaveBeenCalledTimes(2)
  })

  it('states the routing contract: archive for semantic recall, live imap tools for fresh mail, searchBrain for cross-source', () => {
    const tool = createSearchEmailArchiveTool({
      ownerUserId: 'o',
      accounts: [{ instanceId: 'i', email: 'me@corp.com', isPrimary: true }],
      deps: { search: vi.fn() as never },
    })
    expect(tool.isReadOnly).toBe(true)
    expect(tool.requiresConfirmation).toBeFalsy()
    expect(tool.description).toMatch(/imapSearchMessages/)
    expect(tool.description).toMatch(/searchBrain/)
    expect(tool.description).toMatch(/syncs on a delay/i)
  })

  it('passes the embedder through and surfaces store failures honestly', async () => {
    const embedder = { embed: async () => [[0.1]] }
    const search = vi.fn(async (..._args: unknown[]) => {
      throw new Error('archive down')
    })
    const tool = createSearchEmailArchiveTool({
      ownerUserId: 'o',
      accounts: [{ instanceId: 'i', email: 'me@corp.com', isPrimary: true }],
      deps: { search: search as never, embedder },
    })
    const result = await tool.execute({ query: 'x' }, CTX)
    expect(result.isError).toBe(true)
    expect(result.data).toContain('archive down')
    expect(search.mock.calls[0][1]).toEqual({ embedder })
  })

  it('global seam: unset means the injector leaves the tool out', () => {
    expect(getGlobalMailboxArchiveDeps()).toBeNull()
    setGlobalMailboxArchiveDeps({})
    expect(getGlobalMailboxArchiveDeps()).toEqual({})
  })
})
