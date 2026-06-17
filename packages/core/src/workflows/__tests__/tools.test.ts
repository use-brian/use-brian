/**
 * Unit tests for the workflow brain-write tools (WU-6.11).
 * Component tag: [COMP:workflows/brain-tools].
 *
 * Fakes the `EntityStore` / `EntityLinksStore` / `WorkflowMemorySupersedePort`
 * ports and verifies `createEntity` / `createEdge` / `supersedeMemory`:
 * argument mapping from the workflow ToolContext, the success payloads,
 * and the fail-soft `isError` path.
 */

import { describe, it, expect, vi } from 'vitest'
import { createWorkflowBrainTools } from '../tools.js'
import type { ToolContext } from '../../tools/types.js'
import type { EntityLinksStore, EntityStore } from '../../entities/types.js'

const ctx: ToolContext = {
  userId: 'u-1',
  assistantId: 'a-1',
  sessionId: 'workflow_run_run-1',
  appId: 'sidanclaw',
  channelType: 'workflow',
  channelId: 'run-1',
  workspaceId: 'ws-1',
  abortSignal: new AbortController().signal,
}

function makeDeps() {
  const entities = {
    create: vi.fn(async (p: Record<string, unknown>) => ({
      id: 'e-1',
      kind: p.kind as string,
      displayName: p.displayName as string,
    })),
  }
  const entityLinks = {
    create: vi.fn(async (p: Record<string, unknown>) => ({
      id: 'edge-1',
      edgeType: p.edgeType as string,
    })),
  }
  const memories = {
    supersedeByTags: vi.fn(
      async (_p: { workspaceId: string; tags: string[]; now: Date }) => 3,
    ),
  }
  return { entities, entityLinks, memories }
}

function build(deps: ReturnType<typeof makeDeps>) {
  const tools = createWorkflowBrainTools({
    entities: deps.entities as unknown as EntityStore,
    entityLinks: deps.entityLinks as unknown as EntityLinksStore,
    memories: deps.memories,
  })
  return new Map(tools.map((t) => [t.name, t]))
}

describe('[COMP:workflows/brain-tools] createWorkflowBrainTools', () => {
  it('exposes exactly createEntity / createEdge / supersedeMemory', () => {
    const tools = build(makeDeps())
    expect([...tools.keys()].sort()).toEqual(['createEdge', 'createEntity', 'supersedeMemory'])
  })

  it('the three tools are writes (not read-only, not concurrency-safe)', () => {
    for (const tool of build(makeDeps()).values()) {
      expect(tool.isReadOnly).toBe(false)
      expect(tool.isConcurrencySafe).toBe(false)
    }
  })

  it('createEntity attributes the entity to the workflow actor + workspace', async () => {
    const deps = makeDeps()
    const result = await build(deps).get('createEntity')!.execute(
      { kind: 'product', name: 'Pretext', attributes: { tagline: 'x' } },
      ctx,
    )
    expect(deps.entities.create).toHaveBeenCalledWith({
      kind: 'product',
      displayName: 'Pretext',
      attributes: { tagline: 'x' },
      workspaceId: 'ws-1',
      createdByUserId: 'u-1',
      userId: 'u-1',
      assistantId: 'a-1',
      source: 'user',
    })
    expect(result.data).toEqual({
      id: 'e-1',
      kind: 'product',
      displayName: 'Pretext',
      linksCreated: 0,
      linksFailed: 0,
    })
  })

  it('createEntity defaults attributes to {} when omitted', async () => {
    const deps = makeDeps()
    await build(deps).get('createEntity')!.execute({ kind: 'project', name: 'P' }, ctx)
    expect(deps.entities.create.mock.calls[0][0].attributes).toEqual({})
  })

  it('createEdge maps the source/target/edge_type fields', async () => {
    const deps = makeDeps()
    const result = await build(deps).get('createEdge')!.execute(
      {
        source_kind: 'entity',
        source_id: 'e-1',
        edge_type: 'documented_by',
        target_kind: 'file',
        target_id: 'f-1',
      },
      ctx,
    )
    expect(deps.entityLinks.create).toHaveBeenCalledWith({
      sourceKind: 'entity',
      sourceId: 'e-1',
      targetKind: 'file',
      targetId: 'f-1',
      edgeType: 'documented_by',
      attributes: {},
      workspaceId: 'ws-1',
      userId: 'u-1',
      assistantId: 'a-1',
      source: 'user',
    })
    expect(result.data).toEqual({ id: 'edge-1', edgeType: 'documented_by' })
  })

  it('supersedeMemory passes the workspace + tags through and returns the count', async () => {
    const deps = makeDeps()
    const result = await build(deps).get('supersedeMemory')!.execute(
      { tags: ['commitment:goal', 'commitment:open'] },
      ctx,
    )
    const call = deps.memories.supersedeByTags.mock.calls[0][0]
    expect(call.workspaceId).toBe('ws-1')
    expect(call.tags).toEqual(['commitment:goal', 'commitment:open'])
    expect(call.now).toBeInstanceOf(Date)
    expect(result.data).toEqual({ superseded: 3 })
  })

  it('returns isError when the store throws (fail-soft)', async () => {
    const deps = makeDeps()
    deps.entities.create.mockRejectedValueOnce(new Error('kind=person is CRM-specialized'))
    const result = await build(deps).get('createEntity')!.execute(
      { kind: 'person', name: 'Alice' },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('CRM-specialized')
  })

  it('returns isError when invoked without a workspace context', async () => {
    const deps = makeDeps()
    const noWorkspace = { ...ctx, workspaceId: null }
    const result = await build(deps).get('supersedeMemory')!.execute(
      { tags: ['commitment:open'] },
      noWorkspace,
    )
    expect(result.isError).toBe(true)
    expect(deps.memories.supersedeByTags).not.toHaveBeenCalled()
  })
})
