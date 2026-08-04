/** Office codec/persistence adapter for the shared doc-sync service.
 * [COMP:doc-sync/office-collab] */
import { createHash } from 'node:crypto'
import * as Y from 'yjs'
import {
  encodeOfficeState,
  officeStateVector,
  snapshotToYDoc,
  yDocToSnapshot,
  type OfficeArtifactSnapshot,
} from '@use-brian/office-model'
import type { SysQuery } from './persistence.js'

export function officeSnapshotUpdate(snapshot: OfficeArtifactSnapshot): Uint8Array {
  return encodeOfficeState(snapshotToYDoc(snapshot))
}

export async function loadOfficeUpdate(params: {
  artifactId: string
  query: SysQuery
}): Promise<Uint8Array | null> {
  const rows = await params.query<{ ydoc: Buffer }>(
    'SELECT ydoc FROM office_collab_documents WHERE artifact_id = $1',
    [params.artifactId],
  )
  return rows[0]?.ydoc ? new Uint8Array(rows[0].ydoc) : null
}

export async function storeOfficeSnapshot(params: {
  artifactId: string
  ydoc: Y.Doc
  query: SysQuery
}): Promise<{ snapshot: OfficeArtifactSnapshot; hash: string }> {
  const snapshot = yDocToSnapshot(params.ydoc)
  if (snapshot.artifactId !== params.artifactId) throw new Error('Office collaboration document artifact mismatch')
  const canonical = JSON.stringify(snapshot)
  const hash = createHash('sha256').update(canonical).digest('hex')
  await params.query(
    `INSERT INTO office_collab_documents
       (artifact_id, workspace_id, ydoc, state_vector, canonical_hash, base_version, seq, updated_at)
     SELECT $1,$2,$3,$4,$5,a.head_version,1,now()
       FROM office_artifacts a WHERE a.id = $1
     ON CONFLICT (artifact_id) DO UPDATE SET
       ydoc = EXCLUDED.ydoc,
       state_vector = EXCLUDED.state_vector,
       canonical_hash = EXCLUDED.canonical_hash,
       base_version = EXCLUDED.base_version,
       seq = office_collab_documents.seq + 1,
       updated_at = now()`,
    [
      params.artifactId,
      snapshot.workspaceId,
      Buffer.from(encodeOfficeState(params.ydoc)),
      Buffer.from(officeStateVector(params.ydoc)),
      hash,
    ],
  )
  return { snapshot, hash }
}
