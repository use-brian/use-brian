import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScopeSource } from '@use-brian/core'
vi.mock('../../db/client.js', () => ({ getPool: vi.fn() }))
import { getPool } from '../../db/client.js'
import { readExternalSourceAncestors } from '../external-source-ancestry.js'

// Metadata/batching contract only. Independent ACLs and native supersession run in the real source fixture.
describe('[COMP:api/external-source-access] immutable ancestry metadata contract', () => {
  beforeEach(() => vi.clearAllMocks())
  function fixture() {
    const workspaceId = randomUUID()
    const source: ScopeSource = { workspaceId,userId: null,assistantId: null,resourceKind: 'external_source',resourceId: randomUUID(),
      version: '1',sensitivity: 'internal',compartments: [],projectIds: [] }
    const root = { ...source,resourceKind: 'memory',resourceId: randomUUID() }
    const query = vi.fn(async (_sql: string, _values: unknown[]) => ({ rows: [{ nodeVersion: '1',source }] }))
    vi.mocked(getPool).mockReturnValue({ query } as never)
    return { workspaceId,source,root,query }
  }
  it('skips absent/native-free roots and refuses workspace mismatch before lookup', async () => {
    const f = fixture()
    expect(await readExternalSourceAncestors(f.workspaceId, [])).toEqual([])
    expect(await readExternalSourceAncestors(f.workspaceId, [f.source])).toEqual([])
    await expect(readExternalSourceAncestors(randomUUID(), [f.root])).rejects.toMatchObject({ code: 'source_access_denied' })
    expect(f.query).not.toHaveBeenCalled()
  })
  it('batches native roots while keeping one copy of an identical external obligation', async () => {
    const f = fixture(), roots = Array.from({ length: 201 }, () => ({ ...f.root,resourceId: randomUUID() }))
    expect(await readExternalSourceAncestors(f.workspaceId, roots)).toEqual([f.source])
    expect(f.query).toHaveBeenCalledTimes(3)
    expect(f.query.mock.calls[0][0]).toContain('read_external_source_dependencies')
  })
  it.each(['missing','wrong-version','wrong-workspace','incomplete','oversized'] as const)('refuses %s ancestry metadata', async kind => {
    const f = fixture()
    const row = kind === 'missing' || kind === 'oversized' ? { nodeVersion: '1',source: null }
      : kind === 'wrong-version' ? { nodeVersion: 'changed',source: f.source }
      : kind === 'wrong-workspace' ? { nodeVersion: '1',source: { ...f.source,workspaceId: randomUUID() } }
      : { nodeVersion: '1',source: { ...f.source,compartments: undefined } }
    f.query.mockResolvedValueOnce({ rows: [row] } as never)
    await expect(readExternalSourceAncestors(f.workspaceId, [f.root])).rejects.toMatchObject({ code: 'source_access_denied' })
  })
  it('refuses conflicting versions even when both observation rows are individually well formed', async () => {
    const f = fixture()
    f.query.mockResolvedValueOnce({ rows: [{ nodeVersion: '1',source: f.source },{ nodeVersion: '2',source: { ...f.source,version: '2' } }] })
    await expect(readExternalSourceAncestors(f.workspaceId, [f.root])).rejects.toMatchObject({ code: 'source_access_denied' })
  })
})
