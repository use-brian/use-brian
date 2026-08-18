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
  appId: 'Use Brian',
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

  it('returns isError when the store throws (fail-soft), naming the entity it tried to create', async () => {
    const deps = makeDeps()
    deps.entities.create.mockRejectedValueOnce(new Error('kind=person is CRM-specialized'))
    const result = await build(deps).get('createEntity')!.execute(
      { kind: 'person', name: 'Alice' },
      ctx,
    )
    expect(result.isError).toBe(true)
    const data = String(result.data)
    expect(data).toContain('CRM-specialized')
    expect(data).toContain('"Alice"')
    expect(data).toMatch(/Nothing was saved or changed/)
  })

  it('a rejected link is reported with the target id and the brain-id source, not just a count', async () => {
    const deps = makeDeps()
    // applyExplicitLinks is fire-and-forget: it counts + logs, never throws.
    deps.entityLinks.create.mockRejectedValueOnce(new Error('violates foreign key constraint'))
    const result = await build(deps).get('createEntity')!.execute(
      {
        kind: 'product',
        name: 'Pretext',
        links: [{ targetEntityId: '11111111-1111-4111-8111-111111111111', edgeType: 'depends_on' }],
      },
      ctx,
    )
    // The entity WAS written — this is a partial success, not a failure.
    expect(result.isError).toBeFalsy()
    const payload = result.data as { id: string; linksFailed: number; note?: string }
    expect(payload.id).toBe('e-1')
    expect(payload.linksFailed).toBe(1)
    expect(payload.note).toContain('11111111-1111-4111-8111-111111111111')
    expect(payload.note).toContain('existing brain row UUIDs')
    expect(payload.note).toContain('getEntity')
    expect(payload.note).toContain('createEdge')
    expect(payload.note).toMatch(/Do not re-run createEntity/i)
  })

  it('a clean links run carries no note', async () => {
    const deps = makeDeps()
    const result = await build(deps).get('createEntity')!.execute(
      {
        kind: 'product',
        name: 'Pretext',
        links: [{ targetEntityId: '11111111-1111-4111-8111-111111111111', edgeType: 'depends_on' }],
      },
      ctx,
    )
    expect((result.data as { note?: string }).note).toBeUndefined()
  })

  it('an entity-create failure names the entity and says nothing was written', async () => {
    const deps = makeDeps()
    deps.entities.create.mockRejectedValueOnce(new Error('violates unique constraint'))
    const result = await build(deps).get('createEntity')!.execute(
      { kind: 'product', name: 'Pretext' },
      ctx,
    )
    expect(result.isError).toBe(true)
    const data = String(result.data)
    expect(data).toContain('"Pretext"')
    expect(data).toMatch(/Nothing was saved or changed/)
    expect(data).toMatch(/no id from this call can be used as a link target/i)
  })

  it('createEdge echoes both ids and the edge type, and names how to re-resolve them', async () => {
    const deps = makeDeps()
    deps.entityLinks.create.mockRejectedValueOnce(new Error('violates foreign key constraint'))
    const result = await build(deps).get('createEdge')!.execute(
      {
        source_kind: 'entity',
        source_id: 'src-uuid',
        edge_type: 'works_at',
        target_kind: 'entity',
        target_id: 'tgt-uuid',
      },
      ctx,
    )
    expect(result.isError).toBe(true)
    const data = String(result.data)
    expect(data).toContain('src-uuid')
    expect(data).toContain('tgt-uuid')
    expect(data).toContain('works_at')
    expect(data).toContain('existing brain row UUIDs')
    expect(data).toContain('getEntity')
    expect(data).toMatch(/Nothing was saved or changed/)
  })

  it('supersedeMemory echoes the tags and refuses to let the model report a retirement', async () => {
    const deps = makeDeps()
    deps.memories.supersedeByTags.mockRejectedValueOnce(new Error('deadlock detected'))
    const result = await build(deps).get('supersedeMemory')!.execute(
      { tags: ['commitment:goal'] },
      ctx,
    )
    expect(result.isError).toBe(true)
    const data = String(result.data)
    expect(data).toContain('commitment:goal')
    expect(data).toMatch(/still active/i)
    expect(data).toMatch(/retry once/i)   // deadlock is transient
  })

  it('returns (not throws) a diagnosis when invoked without a workspace context', async () => {
    const deps = makeDeps()
    const noWorkspace = { ...ctx, workspaceId: null }
    for (const name of ['createEntity', 'createEdge', 'supersedeMemory']) {
      const result = await build(deps).get(name)!.execute(
        name === 'createEntity'
          ? { kind: 'product', name: 'P' }
          : name === 'createEdge'
            ? { source_kind: 'entity', source_id: 'a', edge_type: 'works_at', target_kind: 'entity', target_id: 'b' }
            : { tags: ['commitment:open'] },
        noWorkspace,
      )
      expect(result.isError).toBe(true)
      const data = String(result.data)
      expect(data).toContain(name)
      expect(data).toMatch(/no workspace/i)
      expect(data).toMatch(/no retry and no argument change can fix it/i)
      // The old shape leaked the internal throw through the generic catch.
      expect(data).not.toMatch(/workflow brain tool invoked without a workspace context/)
    }
    expect(deps.memories.supersedeByTags).not.toHaveBeenCalled()
    expect(deps.entities.create).not.toHaveBeenCalled()
    expect(deps.entityLinks.create).not.toHaveBeenCalled()
  })
})
