import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { PoolClient } from 'pg'
import { bindScopeSource, boundScopeSources, type ApplicationOperationContext, type ScopeSource } from '@use-brian/core'
import type { ApplicationRecordProjection } from '@use-brian/shared'
import { bindApplicationFieldProjection } from '../field-evidence.js'

// Binding/race contract only. Real SQL authority is covered by the local PostgreSQL suite.
describe('[COMP:api/application-field-evidence] private capture binding', () => {
  function fixture() {
    const workspaceId = randomUUID(),source: ScopeSource = { workspaceId,userId: null,assistantId: null,sensitivity: 'internal',
      compartments: [],projectIds: [],resourceKind: 'application_field',resourceId: randomUUID(),version: 'a'.repeat(64) }
    const projection: ApplicationRecordProjection = { ref: { workspaceId,origin: { kind: 'generic',entityTypeId: randomUUID() },typeKey: 'request',id: randomUUID(),version: '1' },
      values: { title: { kind: 'text',value: 'Fictional title' } },fields: ['title'],policyVersion: 'fixture-policy' }
    const query = vi.fn(),context = { execution: { security: { access: { workspaceId } } },transaction: { query } } as unknown as ApplicationOperationContext<PoolClient>
    const result = { rows: [{ value: { values: structuredClone(projection.values),sources: [source],policyVersion: 'b'.repeat(64) } }] }
    return { projection,source,query,context,result }
  }
  it('refuses a projection changed while canonical capture is pending', async () => {
    const f = fixture()
    let resolve!: (value: typeof f.result) => void
    const gate = new Promise<typeof f.result>(done => { resolve = done })
    f.query.mockReturnValue(gate)
    const pending = bindApplicationFieldProjection(f.context,f.projection)
    f.projection.fields = []; resolve(f.result)
    await expect(pending).rejects.toMatchObject({ code: 'access_unavailable' })
    expect(f.query.mock.calls[0][1][7]).toEqual(['title'])
    expect(boundScopeSources(f.projection)).toEqual([])
  })
  it('requires the fresh selected values to match before binding any evidence', async () => {
    const f = fixture()
    f.result.rows[0].value.values = { title: { kind: 'text',value: 'Changed canonical value' } }
    f.query.mockResolvedValue(f.result)
    await expect(bindApplicationFieldProjection(f.context,f.projection)).rejects.toMatchObject({ code: 'access_unavailable' })
    expect(boundScopeSources(f.projection)).toEqual([])
  })
  it('refuses to merge field evidence into an existing whole-row binding', async () => {
    const f = fixture()
    bindScopeSource(f.projection,{ ...f.source,resourceKind: 'entity_instance',resourceId: f.projection.ref.id,version: '1' })
    await expect(bindApplicationFieldProjection(f.context,f.projection)).rejects.toMatchObject({ code: 'access_unavailable' })
    expect(f.query).not.toHaveBeenCalled()
    expect(boundScopeSources(f.projection)).toHaveLength(1)
  })
  it('captures readable absence together with returned values without serializing its private sources',async () => {
    const f = fixture();f.projection.absentFields = ['cost'];f.query.mockResolvedValue(f.result)
    const result = await bindApplicationFieldProjection(f.context,f.projection)
    expect(f.query.mock.calls[0][1][7]).toEqual(['title','cost'])
    expect(boundScopeSources(result)).toEqual([f.source])
    expect(JSON.stringify(result)).not.toContain('application_field')
  })
  it('refuses a claimed absence for a returned field before requesting capture',async () => {
    const f = fixture();f.projection.absentFields = ['title']
    await expect(bindApplicationFieldProjection(f.context,f.projection)).rejects.toMatchObject({ code: 'access_unavailable' })
    expect(f.query).not.toHaveBeenCalled()
  })
})
