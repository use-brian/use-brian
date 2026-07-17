import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the retrieval store's `search` so the tool's wiring (pinned actor,
// error-in-band, input forwarding) is asserted without a DB.
const searchMock = vi.hoisted(() => vi.fn())
vi.mock('../../db/retrieval-store.js', () => ({
  search: searchMock,
}))

import { createBrainSourceTool } from '../brain-source-tool.js'
import type { RetrievalActor, ToolContext } from '@use-brian/core'

const ACTOR: RetrievalActor = {
  workspaceId: 'ws-1',
  userId: 'u-1',
  assistantId: 'a-1',
  assistantKind: 'standard',
  clearance: 'internal',
  compartments: null,
}

// The synthesis loop's synthetic context never sets `clearance` — the tool must
// not depend on it (the read ceiling lives on the pinned actor instead).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CTX = {} as ToolContext

describe('[COMP:api/brain-source-tool] createBrainSourceTool', () => {
  beforeEach(() => {
    searchMock.mockReset().mockResolvedValue({ data: [{ primitive: 'company', row_id: 'c-1' }] })
  })

  it('is a read-only core tool named searchSource', () => {
    const tool = createBrainSourceTool({ actor: ACTOR })
    expect(tool.name).toBe('searchSource')
    expect(tool.isReadOnly).toBe(true)
    expect(tool.requiresConfirmation).toBe(false)
  })

  it('searches the brain under the PINNED actor (clearance not taken from context)', async () => {
    const tool = createBrainSourceTool({ actor: ACTOR })
    const res = await tool.execute({ query: 'what does Acme do' }, CTX)
    expect(searchMock).toHaveBeenCalledTimes(1)
    const [actorArg, inputArg] = searchMock.mock.calls[0]
    // The actor (with its clearance ceiling) is the one passed at construction,
    // independent of the empty loop context.
    expect(actorArg).toEqual(ACTOR)
    expect(inputArg).toMatchObject({ query: 'what does Acme do' })
    expect(res.isError).toBeFalsy()
    expect(res.data).toEqual({ data: [{ primitive: 'company', row_id: 'c-1' }] })
  })

  it('forwards scope + limit and the embedder store deps', async () => {
    const embedder = { embed: vi.fn() }
    const tool = createBrainSourceTool({ actor: ACTOR, storeDeps: { embedder } })
    await tool.execute({ query: 'deals', scope: 'deal', limit: 5 }, CTX)
    const [, inputArg, depsArg] = searchMock.mock.calls[0]
    expect(inputArg).toMatchObject({ query: 'deals', scope: 'deal', limit: 5 })
    expect(depsArg).toEqual({ embedder })
  })

  it('returns the error in-band so a brain miss degrades the loop, not aborts it', async () => {
    searchMock.mockRejectedValue(new Error('boom'))
    const tool = createBrainSourceTool({ actor: ACTOR })
    const res = await tool.execute({ query: 'x' }, CTX)
    expect(res.isError).toBe(true)
    expect(String(res.data)).toContain('searchSource failed: boom')
  })
})
