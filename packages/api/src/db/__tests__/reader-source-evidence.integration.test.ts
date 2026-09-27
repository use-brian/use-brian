import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { boundScopeSource, ContextScopeAccumulator, createMemoryTools, scopeEvidenceFromRows,
  type AccessContext, type ScopeSource, type ToolContext } from '@use-brian/core'
import { getAppPool, getPool } from '../client.js'
import { createDbMemoryStore } from '../memory-store.js'
import { createDbWorkspaceFilesStore } from '../workspace-files-store.js'
import { createMemory, getMemoryByIdSystem } from '../memories.js'
import { noteAutomaticScopeEvidence } from '../../context-scope/resolve-turn-scope.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()

async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID(), assistantId = randomUUID(), projectId = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Reader fixture',$2)", [workspaceId, userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, userId])
  await pool.query("INSERT INTO assistants(id,name,workspace_id,owner_user_id,kind) VALUES($1,'Fixture assistant',$2,$3,'standard')", [assistantId, workspaceId, userId])
  await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Fixture','fixture',$3)", [projectId, workspaceId, userId])
  const ctx: AccessContext = { workspaceId, userId, assistantId, assistantKind: 'standard', clearance: 'confidential',
    compartments: ['finance'], projectIds: [projectId] }
  const store = createDbMemoryStore()
  const memory = await createMemory({ workspaceId, userId: null, assistantId, createdByUserId: userId,
    scope: 'workspace', summary: 'Canary budget policy', tags: ['self-profile', 'fixture'], sensitivity: 'confidential',
    compartments: ['finance'], projectIds: [projectId] })
  const canonical = async (kind: string, id: string): Promise<ScopeSource> => {
    const { held, validTo, retractedAt, ...source } = (await pool.query('SELECT read_scope_source($1,$2,$3) AS source',
      [workspaceId, kind, id])).rows[0].source
    expect({ held, validTo, retractedAt }).toEqual({ held: false, validTo: null, retractedAt: null })
    return source
  }
  return { ctx, memory, store, canonical }
}

describe('[COMP:api/reader-source-evidence] canonical tool and prompt provenance', () => {
  afterAll(async () => { await getAppPool().end(); await pool.end() })

  it('retains workspace memory scope and canonical versions across every attended projection', async () => {
    const f = await fixture(), expected = await f.canonical('memory', f.memory.id)
    const results = [
      [await f.store.getById(f.ctx, f.memory.id)],
      await f.store.searchTeam(f.ctx, { query: 'Canary' }),
      await f.store.searchTeam(f.ctx, { query: '', idPrefix: f.memory.id.slice(0, 8) }),
      await f.store.getWorkspaceIdentity(f.ctx),
      await f.store.getWorkspaceMemoriesByCategory(f.ctx, 'fixture'),
      await f.store.getWorkspaceIndex(f.ctx),
      (await f.store.getIndexRanked(f.ctx, 20)).rows,
    ]
    for (const rows of results) {
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ compartments: ['finance'], projectIds: f.ctx.projectIds })
      expect(boundScopeSource(rows[0]!)).toEqual(expected)
      const accumulator = new ContextScopeAccumulator()
      noteAutomaticScopeEvidence(accumulator, rows)
      expect(accumulator.evidence.sources).toEqual([expected])
    }
  })

  it('records only rows the viewer receives, including prefix and ranked reads', async () => {
    const f = await fixture(), restricted = { ...f.ctx, compartments: [] }
    expect(await f.store.getById(restricted, f.memory.id)).toBeNull()
    for (const rows of [await f.store.searchTeam(restricted, { query: 'Canary' }),
      await f.store.searchTeam(restricted, { query: '', idPrefix: f.memory.id.slice(0, 8) }),
      await f.store.getWorkspaceIndex(restricted), (await f.store.getIndexRanked(restricted, 20)).rows]) {
      expect(rows).toEqual([])
      expect(scopeEvidenceFromRows(rows).sources).toBeUndefined()
    }
  })

  it('carries getMemory evidence into an explicitly derived write and invalidates it on source change', async () => {
    const f = await fixture()
    const context: ToolContext = { ...f.ctx, sessionId: randomUUID(), appId: 'fixture', channelType: 'web', channelId: 'fixture', abortSignal: new AbortController().signal }
    const result = await createMemoryTools(f.store).getMemory.execute({ id: f.memory.id }, context)
    expect(result.isError).not.toBe(true)
    expect(result.scopeEvidence?.sources).toEqual([await f.canonical('memory', f.memory.id)])
    expect(JSON.stringify(result.data)).not.toContain('resourceKind')
    const derived = await createMemory({ workspaceId: f.ctx.workspaceId, userId: f.ctx.userId, assistantId: f.ctx.assistantId,
      createdByUserId: f.ctx.userId, summary: 'An explicitly derived policy', sensitivity: 'public',
      derivation: { producer: 'reader-fixture', sources: result.scopeEvidence!.sources! } })
    expect(derived).toMatchObject({ sensitivity: 'confidential', compartments: ['finance'], projectIds: f.ctx.projectIds })
    await pool.query("UPDATE memories SET summary='Revised budget policy' WHERE id=$1", [f.memory.id])
    expect(await getMemoryByIdSystem(derived.id)).toBeNull()
  })

  it('binds personal memory lookup, search and automatic indexes to their exact source', async () => {
    const f = await fixture()
    const memory = await f.store.create({ workspaceId: f.ctx.workspaceId, userId: f.ctx.userId, assistantId: f.ctx.assistantId,
      createdByUserId: f.ctx.userId, summary: 'Personal canary', sensitivity: 'internal', compartments: ['finance'], projectIds: f.ctx.projectIds! })
    const expected = await f.canonical('memory', memory.id)
    for (const rows of [[memory], await f.store.search(f.ctx, { query: 'Personal' }),
      await f.store.search(f.ctx, { query: '', idPrefix: memory.id.slice(0, 8) }), await f.store.getIndex(f.ctx)]) {
      const row = rows.find(row => row.id === memory.id)!
      expect(boundScopeSource(row)).toEqual(expected)
    }
  })

  it('returns the current memory ID and trusted source after a tool supersession', async () => {
    const f = await fixture()
    const context: ToolContext = { ...f.ctx, sessionId: randomUUID(), appId: 'fixture', channelType: 'web', channelId: 'fixture', abortSignal: new AbortController().signal }
    const result = await createMemoryTools(f.store).saveMemory.execute({ id: f.memory.id, detail: 'An authorized clarification' }, context)
    expect(result.isError).not.toBe(true)
    const source = result.scopeEvidence!.sources![0]
    expect(source.resourceId).not.toBe(f.memory.id)
    expect(result.data).toContain(`[${source.resourceId}]`)
    expect(result.data).not.toContain(`[${f.memory.id}]`)
    expect(source).toEqual(await f.canonical('memory', source.resourceId))
    expect(result.scopeEvidence).toMatchObject({ sensitivity: 'confidential', compartments: ['finance'], projectIds: f.ctx.projectIds })
  })

  it('binds compact file indexes without exposing private provenance in the serialized row', async () => {
    const f = await fixture(), files = createDbWorkspaceFilesStore()
    const file = await files.create(f.ctx.userId, { workspaceId: f.ctx.workspaceId, path: '/canary.txt', parentPath: '/',
      name: 'canary.txt', title: 'Canary file', mime: 'text/plain', sizeBytes: 1, storageUri: 'gs://fixture/canary', createdByUserId: f.ctx.userId,
      sensitivity: 'confidential', compartments: ['finance'], projectIds: f.ctx.projectIds! }, f.ctx)
    const expected = await f.canonical('workspace_file', file.id)
    for (const rows of [[file], [await files.getByPath(f.ctx, '/canary.txt')], await files.listByPath(f.ctx, { prefix: '/' }),
      await files.searchByText(f.ctx, { query: 'canary' }), await files.listIndexRanked(f.ctx, 20)]) {
      expect(rows).toHaveLength(1)
      expect(scopeEvidenceFromRows(rows).sources).toEqual([expected])
      expect(JSON.stringify(rows[0])).not.toContain('resourceKind')
    }
    expect(await files.listIndexRanked({ ...f.ctx, compartments: [] }, 20)).toEqual([])
  })
})
