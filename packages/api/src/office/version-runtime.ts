/** Shared native history preview and restoration. [COMP:api/office-routes] */
import { createHash } from 'node:crypto'
import { assertOfficeArtifactSnapshot, encodeOfficeState, officeStateVector, snapshotToYDoc, type OfficeArtifactSnapshot } from '@use-brian/office-model'
import { scopeEvidenceFromRows, workspaceCredentialDelegation, type FilesApi, type ToolContext } from '@use-brian/core'
import type { createOfficeArtifactStore } from '../db/office-artifacts.js'

export function createOfficeVersionRuntime(deps: {
  files: FilesApi
  artifacts: ReturnType<typeof createOfficeArtifactStore>
  replaceLive(snapshot: OfficeArtifactSnapshot, expected: { expectedVersion: number; canonicalHash: string }): Promise<unknown>
}) {
  async function read(userId: string, artifactId: string, versionId: string, context?: ToolContext) {
    await context?.executionContext?.security.authority.assertCurrent()
    const source = await deps.artifacts.getVersionSource(userId, artifactId, versionId)
    if (!source) return null
    if (context && source.workspaceId !== context.workspaceId) return null
    const access = context?.executionContext
      ? { ...context.executionContext.security.access, executionContext: context.executionContext }
      : { workspaceId: source.workspaceId, userId, assistantKind: 'standard' as const, clearance: 'confidential' as const }
    const result = await deps.files.readBytes(access, source.snapshotFileId)
    if (!result.ok) return null
    const hash = createHash('sha256').update(result.value.bytes).digest('hex')
    if (hash !== source.snapshotHash) throw new Error('Office version snapshot hash mismatch')
    const snapshot = assertOfficeArtifactSnapshot(JSON.parse(new TextDecoder().decode(result.value.bytes)))
    if (snapshot.artifactId !== artifactId || snapshot.workspaceId !== source.workspaceId) throw new Error('Office version snapshot identity mismatch')
    await context?.executionContext?.security.authority.assertCurrent()
    return { snapshot, source, scopeEvidence: scopeEvidenceFromRows([result.value.file]) }
  }
  return {
    read,
    async restore(params: { userId: string; artifactId: string; targetVersionId: string; expectedVersion: number; summary: string;
      actorAssistantId?: string; admissionObservationId?: string; context?: ToolContext }) {
      const loaded = await read(params.userId, params.artifactId, params.targetVersionId, params.context)
      if (!loaded) return null
      const doc = snapshotToYDoc(loaded.snapshot)
      await params.context?.executionContext?.security.authority.assertCurrent()
      const restored = await deps.artifacts.restoreVersion({ ...params, sharedAudience: params.context?.executionContext?.security.access.sharedAudience === true, workspaceDelegation: workspaceCredentialDelegation(params.context?.executionContext) ?? undefined, snapshotTitle: loaded.snapshot.title,
        liveUpdate: encodeOfficeState(doc), liveStateVector: officeStateVector(doc), liveCanonicalHash: loaded.source.snapshotHash })
      if (restored) await deps.replaceLive(loaded.snapshot, { expectedVersion: restored.version, canonicalHash: loaded.source.snapshotHash })
      return restored
    },
  }
}
