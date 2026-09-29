/** Durable anchors for live-only drafts. [COMP:api/office-suggestions] */
import { createHash } from 'node:crypto'
import { preflightOfficeCandidate } from '@use-brian/office-model'
import type { OfficeArtifactRow, createOfficeArtifactStore } from '../db/office-artifacts.js'
import type { createOfficeLiveStore } from '../db/office-live.js'

type Deps = {
  getLive: ReturnType<typeof createOfficeLiveStore>['getOfflineSource']
  getArtifact: ReturnType<typeof createOfficeArtifactStore>['get']
  anchorDraft: ReturnType<typeof createOfficeArtifactStore>['anchorDraft']
  canComment(userId: string, artifactId: string): Promise<boolean>
  persist(userId: string, artifact: OfficeArtifactRow, bytes: Uint8Array, hash: string): Promise<{ fileId: string; discard(): Promise<void> }>
}

export function createOfficeCommentVersionResolver(deps: Deps) {
  return async (userId: string, artifact: OfficeArtifactRow): Promise<string | null> => {
    if (artifact.headVersionId) return artifact.headVersionId
    if (artifact.headVersion !== 0 || artifact.mode === 'session' || artifact.lifecycleState !== 'active') return null
    if (!await deps.canComment(userId, artifact.id)) return null
    const live = await deps.getLive(userId, artifact.id)
    if (!live || live.baseVersion !== 0 || live.snapshot.artifactId !== artifact.id || !preflightOfficeCandidate(live.snapshot).ok) return null
    const bytes = new TextEncoder().encode(JSON.stringify(live.snapshot))
    const hash = createHash('sha256').update(bytes).digest('hex')
    const saved = await deps.persist(userId, artifact, bytes, hash)
    if (!await deps.canComment(userId, artifact.id)) {
      await saved.discard()
      return null
    }
    const anchored = await deps.anchorDraft({ userId, artifactId: artifact.id,
      expectedSeq: live.seq, expectedUpdate: live.update, snapshotFileId: saved.fileId, snapshotHash: hash,
      operationClock: live.stateVector, schemaVersion: live.snapshot.schemaVersion,
      capabilityVersion: live.snapshot.capabilityVersion })
    if (anchored) return anchored.id
    // Each attempt owns a distinct file, so a loser cannot delete the winner.
    // Do not delete on a thrown/ambiguous DB acknowledgement: it may have committed.
    await saved.discard()
    // A concurrent first comment or normal checkpoint may have won the lock.
    return (await deps.getArtifact(userId, artifact.id))?.headVersionId ?? null
  }
}
