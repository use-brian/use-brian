import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { PoolClient } from 'pg'
import { bindScopeSource, boundScopeSources, type ApplicationOperationContext, type ScopeSource } from '@use-brian/core'
import type { ApplicationRecordProjection } from '@use-brian/shared'
import { bindApplicationFieldProjection, readApplicationFieldAncestors } from '../field-evidence.js'

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

describe('[COMP:api/native-chat-read-cost] complete field discovery across source cohorts', () => {
  function source(workspaceId: string, kind: ScopeSource['resourceKind']): ScopeSource {
    return { workspaceId, userId: null, assistantId: null, sensitivity: 'internal', compartments: [], projectIds: [],
      resourceKind: kind, resourceId: randomUUID(), version: 'v1' }
  }

  it('keeps every root and version on the admitted reader, including zero-field files, with bounded coherent batches', async () => {
    const workspaceId = randomUUID()
    const fields = Array.from({ length: 203 }, (_, index) => ({ ...source(workspaceId, 'application_field'), version: `field-${index}` }))
    const files = Array.from({ length: 4 }, (_, index) => ({ ...source(workspaceId, 'workspace_file'), version: `file-${index}` }))
    const roots = [fields[0], files[0], ...fields.slice(1), ...files.slice(1)]
    const seen: Array<{ kinds: string[]; ids: string[]; versions: string[] }> = []
    const byId = new Map(fields.map(value => [value.resourceId, value]))
    const query = vi.fn(async (sql: string, parameters: [string, string[], string[], string[]]) => {
      expect(sql).toContain('read_native_session_field_dependencies')
      expect(parameters[0]).toBe(workspaceId)
      const [, kinds, ids, versions] = parameters
      expect(new Set(kinds).size).toBe(1)
      expect(ids.length).toBeLessThanOrEqual(100)
      seen.push({ kinds, ids, versions })
      return { rows: ids.flatMap(id => byId.has(id) ? [{ nodeVersion: byId.get(id)!.version, source: byId.get(id) }] : []) }
    })
    const result = await readApplicationFieldAncestors(workspaceId, roots, { query } as unknown as Pick<PoolClient, 'query'>)
    expect(result).toEqual(fields)
    expect(seen.map(batch => batch.ids.length)).toEqual([100, 100, 3, 4])
    expect(seen.flatMap(batch => batch.ids)).toEqual([...fields, ...files].map(value => value.resourceId))
    expect(seen.flatMap(batch => batch.versions)).toEqual([...fields, ...files].map(value => value.version))
  })

  it('propagates refusal from a file cohort instead of treating its missing fields as permission', async () => {
    const workspaceId = randomUUID(), field = source(workspaceId, 'application_field'), file = source(workspaceId, 'workspace_file')
    const denied = Object.assign(new Error('Fictional source refusal'), { code: '42501' })
    const query = vi.fn(async (_sql: string, parameters: [string, string[], string[], string[]]) => {
      if (parameters[1][0] === 'workspace_file') throw denied
      return { rows: [{ nodeVersion: field.version, source: field }] }
    })
    await expect(readApplicationFieldAncestors(workspaceId, [field, file], { query } as unknown as Pick<PoolClient, 'query'>)).rejects.toBe(denied)
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('refuses conflicting ancestor scopes returned by separate canonical cohorts', async () => {
    const workspaceId = randomUUID(), field = source(workspaceId, 'application_field'), context = source(workspaceId, 'session_context_revision')
    const query = vi.fn(async (_sql: string, parameters: [string, string[], string[], string[]]) => ({
      rows: [{ nodeVersion: field.version, source: { ...field, sensitivity: parameters[1][0] === 'application_field' ? 'internal' : 'confidential' } }],
    }))
    await expect(readApplicationFieldAncestors(workspaceId, [field, context], { query } as unknown as Pick<PoolClient, 'query'>))
      .rejects.toMatchObject({ code: 'access_unavailable' })
  })
})
