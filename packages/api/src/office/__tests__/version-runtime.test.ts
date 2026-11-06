import { bindScopeSource } from '@use-brian/core'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { documentSnapshot } from '../../../../core/src/office/__tests__/fixtures.js'
import { createOfficeVersionRuntime } from '../version-runtime.js'

function fixture() {
  const snapshot = documentSnapshot(), bytes = Buffer.from(JSON.stringify(snapshot))
  const source = { snapshotFileId: 'file', snapshotHash: createHash('sha256').update(bytes).digest('hex'), workspaceId: snapshot.workspaceId, version: 1 }
  const artifacts = { getVersionSource: vi.fn(async () => source), restoreVersion: vi.fn(async () => ({ id: 'new-version', version: 3 })) }
  const fileSource = { workspaceId: snapshot.workspaceId, resourceKind: 'workspace_file', resourceId: 'file', version: '1',
    userId: null, assistantId: null, sensitivity: 'internal' as const, compartments: [], projectIds: [] }
  const file = bindScopeSource({ id: 'file' }, fileSource)
  const files = { readBytes: vi.fn(async () => ({ ok: true, value: { bytes, file } })) }
  const replaceLive = vi.fn(async () => {})
  const runtime = createOfficeVersionRuntime({ artifacts, files, replaceLive } as never)
  const input = { userId: 'actor', artifactId: snapshot.artifactId, targetVersionId: 'old-version', expectedVersion: 2, summary: 'Restore', actorAssistantId: 'assistant' }
  return { runtime, source, fileSource, snapshot, artifacts, files, replaceLive, input }
}

describe('[COMP:api/office-routes] canonical Office history runtime', () => {
  it('restores immutable bytes through the version transaction and broadcasts its committed head', async () => {
    const f = fixture()
    expect(await f.runtime.restore(f.input)).toEqual({ id: 'new-version', version: 3 })
    expect(f.artifacts.restoreVersion).toHaveBeenCalledWith(expect.objectContaining({ ...f.input, liveCanonicalHash: f.source.snapshotHash, snapshotTitle: f.snapshot.title }))
    expect(f.replaceLive).toHaveBeenCalledWith(f.snapshot, { expectedVersion: 3, canonicalHash: f.source.snapshotHash })
  })

  it('retains the trusted snapshot File proof when previewing historical content', async () => {
    const f = fixture()
    expect((await f.runtime.read(f.input.userId, f.input.artifactId, f.input.targetVersionId))?.scopeEvidence.sources).toEqual([f.fileSource])
  })

  it('does not broadcast a stale restore', async () => {
    const f = fixture()
    f.artifacts.restoreVersion.mockResolvedValueOnce(null as never)
    expect(await f.runtime.restore(f.input)).toBeNull()
    expect(f.replaceLive).not.toHaveBeenCalled()
  })

  it('refuses changed bytes and cross-artifact snapshots before mutation', async () => {
    const f = fixture()
    f.source.snapshotHash = '0'.repeat(64)
    await expect(f.runtime.restore(f.input)).rejects.toThrow('hash mismatch')
    expect(f.artifacts.restoreVersion).not.toHaveBeenCalled()
    const g = fixture()
    await expect(g.runtime.restore({ ...g.input, artifactId: 'another-artifact' })).rejects.toThrow('identity mismatch')
    expect(g.artifacts.restoreVersion).not.toHaveBeenCalled()
  })

  it('uses current machine access for bytes and stops if authority changes during reading', async () => {
    const f = fixture()
    const authority = { assertCurrent: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('revoked')) }
    const access = { workspaceId: f.snapshot.workspaceId, userId: 'actor', assistantId: 'assistant', clearance: 'internal' }
    const context = { workspaceId: f.snapshot.workspaceId, executionContext: { security: { authority, access } } }
    await expect(f.runtime.restore({ ...f.input, context: context as never })).rejects.toThrow('revoked')
    expect(f.files.readBytes).toHaveBeenCalledWith({ ...access, executionContext: context.executionContext }, 'file')
    expect(f.artifacts.restoreVersion).not.toHaveBeenCalled()
  })
})
