/** Office codec/persistence adapter for the shared doc-sync service.
 * [COMP:doc-sync/office-collab] */
import { createHash } from 'node:crypto'
import * as Y from 'yjs'
import {
  encodeOfficeState,
  officeStateVector,
  preflightOfficeCandidate,
  replaceOfficeSnapshot,
  snapshotToYDoc,
  yDocToSnapshot,
  type OfficeArtifactSnapshot,
} from '@use-brian/office-model'
import type { SysQuery } from './persistence.js'

export function officeSnapshotUpdate(snapshot: OfficeArtifactSnapshot): Uint8Array {
  return encodeOfficeState(snapshotToYDoc(snapshot))
}

/** Apply a committed AI/import head to the authoritative live Y.Doc in place.
 * The caller owns access/secret checks; this helper owns canonical validation
 * and command-log compaction. */
export function replaceLiveOfficeSnapshot(ydoc: Y.Doc, snapshot: OfficeArtifactSnapshot): OfficeArtifactSnapshot {
  replaceOfficeSnapshot(ydoc, snapshot)
  const materialized = yDocToSnapshot(ydoc)
  const preflight = preflightOfficeCandidate(materialized)
  if (!preflight.ok) throw new Error(`Office replacement snapshot failed preflight: ${preflight.diagnostics.map((item) => `${item.path}: ${item.message}`).join('; ')}`)
  return materialized
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
}): Promise<{ snapshot: OfficeArtifactSnapshot; hash: string; baseVersion: number }> {
  const snapshot = yDocToSnapshot(params.ydoc)
  if (snapshot.artifactId !== params.artifactId) throw new Error('Office collaboration document artifact mismatch')
  const preflight = preflightOfficeCandidate(snapshot)
  if (!preflight.ok) throw new Error(`Office collaboration snapshot failed preflight: ${preflight.diagnostics.map((item) => `${item.path}: ${item.message}`).join('; ')}`)
  const canonical = JSON.stringify(snapshot)
  const hash = createHash('sha256').update(canonical).digest('hex')
  const rows = await params.query<{ baseVersion: number }>(
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
       updated_at = now()
     RETURNING base_version::int AS "baseVersion"`,
    [
      params.artifactId,
      snapshot.workspaceId,
      Buffer.from(encodeOfficeState(params.ydoc)),
      Buffer.from(officeStateVector(params.ydoc)),
      hash,
    ],
  )
  return { snapshot, hash, baseVersion: rows[0]?.baseVersion ?? 0 }
}
