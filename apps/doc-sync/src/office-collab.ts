/** Office codec/persistence adapter for the shared doc-sync service.
 * [COMP:doc-sync/office-collab] */
import { createHash } from 'node:crypto'
import * as Y from 'yjs'
import {
  encodeOfficeState,
  documentSuggestionWasApplied,
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

export function officeCanonicalSnapshotHash(snapshot: OfficeArtifactSnapshot): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
}

export class OfficeLiveHeadConflict extends Error {
  constructor() {
    super('Office collaboration base no longer matches the immutable head')
    this.name = 'OfficeLiveHeadConflict'
  }
}

/** A service secret proves only transport identity. Snapshot replacement is
 * authorized by an exact binding to the already-committed immutable head. */
export async function verifyOfficeCommittedHead(params: {
  artifactId: string
  expectedVersion: number
  canonicalHash: string
  query: SysQuery
}): Promise<boolean> {
  const rows = await params.query<{ headVersion: number; snapshotHash: string }>(
    `SELECT a.head_version::int AS "headVersion", v.snapshot_hash AS "snapshotHash"
       FROM office_artifacts a
       JOIN office_artifact_versions v ON v.id = a.head_version_id
      WHERE a.id = $1 AND a.lifecycle_state = 'active'`,
    [params.artifactId],
  )
  const row = rows[0]
  return row?.headVersion === params.expectedVersion && row.snapshotHash === params.canonicalHash
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
}): Promise<{ update: Uint8Array; baseVersion: number } | null> {
  const rows = await params.query<{ ydoc: Buffer; baseVersion: number }>(
    'SELECT ydoc, base_version::int AS "baseVersion" FROM office_collab_documents WHERE artifact_id = $1',
    [params.artifactId],
  )
  return rows[0]?.ydoc ? { update: new Uint8Array(rows[0].ydoc), baseVersion: rows[0].baseVersion } : null
}

export async function storeOfficeSnapshot(params: {
  artifactId: string
  ydoc: Y.Doc
  query: SysQuery
  expectedBaseVersion?: number
  committedHead?: { version: number; snapshotHash: string }
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
     SELECT $1,a.workspace_id,$3,$4,$5,a.head_version,1,now()
       FROM office_artifacts a
      WHERE a.id = $1 AND a.workspace_id = $2 AND a.lifecycle_state = 'active'
        AND (($6::bigint IS NOT NULL AND a.head_version = $6)
          OR ($7::bigint IS NOT NULL
            AND $8::text IS NOT NULL
            AND a.head_version = $7
            AND EXISTS (
              SELECT 1 FROM office_artifact_versions version
               WHERE version.id = a.head_version_id
                 AND version.snapshot_hash = $8
            )))
     ON CONFLICT (artifact_id) DO UPDATE SET
       ydoc = EXCLUDED.ydoc,
       state_vector = EXCLUDED.state_vector,
       canonical_hash = EXCLUDED.canonical_hash,
       base_version = EXCLUDED.base_version,
       seq = CASE
         WHEN office_collab_documents.base_version = EXCLUDED.base_version
          AND office_collab_documents.canonical_hash = EXCLUDED.canonical_hash
         THEN office_collab_documents.seq
         ELSE office_collab_documents.seq + 1
       END,
       updated_at = now()
     WHERE ($6::bigint IS NOT NULL
            AND office_collab_documents.base_version = $6
            AND EXCLUDED.base_version = $6)
        OR ($7::bigint IS NOT NULL
            AND $8::text IS NOT NULL
            AND EXCLUDED.base_version = $7
            AND EXISTS (
          SELECT 1
            FROM office_artifacts head
            JOIN office_artifact_versions version ON version.id = head.head_version_id
           WHERE head.id = $1
             AND head.head_version = $7
             AND version.snapshot_hash = $8
        ))
     RETURNING base_version::int AS "baseVersion"`,
    [
      params.artifactId,
      snapshot.workspaceId,
      Buffer.from(encodeOfficeState(params.ydoc)),
      Buffer.from(officeStateVector(params.ydoc)),
      hash,
      params.expectedBaseVersion ?? null,
      params.committedHead?.version ?? null,
      params.committedHead?.snapshotHash ?? null,
    ],
  )
  if (!rows[0]) throw new OfficeLiveHeadConflict()
  return { snapshot, hash, baseVersion: rows[0].baseVersion }
}

/** Receipt lookup never opens/disconnects a writer connection or persists state. */
export async function readOfficeSuggestionStatus(params: {
  artifactId: string
  suggestionId: string
  liveDocument: () => Y.Doc | undefined
  query: SysQuery
}): Promise<boolean> {
  const live = params.liveDocument()
  if (live) return documentSuggestionWasApplied(live, params.suggestionId)
  const loaded = await loadOfficeUpdate(params)
  // A live document may have appeared while the durable read was in flight.
  const current = params.liveDocument()
  if (current) return documentSuggestionWasApplied(current, params.suggestionId)
  if (!loaded) return false
  const restored = new Y.Doc()
  try {
    Y.applyUpdate(restored, loaded.update)
    return documentSuggestionWasApplied(restored, params.suggestionId)
  } finally { restored.destroy() }
}
