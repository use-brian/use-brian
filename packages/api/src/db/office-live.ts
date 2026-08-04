/** Optimistic REST fallback over the same Office Yjs document doc-sync owns. [COMP:api/office-store] */
import { createHash } from 'node:crypto'
import * as Y from 'yjs'
import {
  OfficeCommandSchema,
  appendOfficeCommand,
  encodeOfficeState,
  officeStateVector,
  preflightOfficeCandidate,
  snapshotToYDoc,
  yDocToSnapshot,
  type OfficeArtifactSnapshot,
  type OfficeCommand,
} from '@use-brian/office-model'
import { defaultOfficeDbQuery, type OfficeDbQuery } from './office-artifacts.js'

export type OfficeLiveSnapshot = { snapshot: OfficeArtifactSnapshot; seq: number; baseVersion: number }

function decode(bytes: Uint8Array): Y.Doc {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, bytes)
  return doc
}

export function createOfficeLiveStore(db: OfficeDbQuery = defaultOfficeDbQuery) {
  const get = async (userId: string, artifactId: string): Promise<OfficeLiveSnapshot | null> => {
    const result = await db<{ ydoc: Buffer; seq: number; baseVersion: number }>(userId, `
      SELECT ydoc, seq::int AS seq, base_version::int AS "baseVersion"
        FROM office_collab_documents WHERE artifact_id = $1
    `, [artifactId])
    const row = result.rows[0]
    if (!row) return null
    return { snapshot: yDocToSnapshot(decode(row.ydoc)), seq: row.seq, baseVersion: row.baseVersion }
  }
  return {
    get,

    async initialize(params: { userId: string; artifactId: string; snapshot: OfficeArtifactSnapshot }): Promise<void> {
      if (params.snapshot.artifactId !== params.artifactId) throw new Error('Office live snapshot artifact mismatch')
      const preflight = preflightOfficeCandidate(params.snapshot)
      if (!preflight.ok) throw new Error(`Office live snapshot failed preflight: ${preflight.diagnostics.map((item) => `${item.path}: ${item.message}`).join('; ')}`)
      const doc = snapshotToYDoc(params.snapshot)
      const bytes = encodeOfficeState(doc)
      const hash = createHash('sha256').update(JSON.stringify(params.snapshot)).digest('hex')
      await db(params.userId, `
        INSERT INTO office_collab_documents
          (artifact_id,workspace_id,ydoc,state_vector,canonical_hash,base_version,seq)
        SELECT $1,a.workspace_id,$2,$3,$4,a.head_version,1 FROM office_artifacts a WHERE a.id=$1
        ON CONFLICT (artifact_id) DO UPDATE SET
          ydoc=EXCLUDED.ydoc,state_vector=EXCLUDED.state_vector,
          canonical_hash=EXCLUDED.canonical_hash,base_version=EXCLUDED.base_version,
          seq=office_collab_documents.seq+1,updated_at=now()
      `, [params.artifactId, Buffer.from(bytes), Buffer.from(officeStateVector(doc)), hash])
    },

    async appendCommand(params: { userId: string; artifactId: string; expectedSeq: number; command: OfficeCommand }): Promise<OfficeLiveSnapshot | 'conflict' | null> {
      const current = await get(params.userId, params.artifactId)
      if (!current) return null
      const command = OfficeCommandSchema.parse(params.command)
      if (command.artifactId !== params.artifactId || command.baseVersion !== current.baseVersion) return 'conflict'
      const doc = decode((await db<{ ydoc: Buffer }>(params.userId, `SELECT ydoc FROM office_collab_documents WHERE artifact_id = $1`, [params.artifactId])).rows[0]!.ydoc)
      appendOfficeCommand(doc, command)
      const snapshot = yDocToSnapshot(doc)
      const preflight = preflightOfficeCandidate(snapshot)
      if (!preflight.ok) throw new Error(`Office command failed preflight: ${preflight.diagnostics.map((item) => `${item.path}: ${item.message}`).join('; ')}`)
      const update = encodeOfficeState(doc)
      const hash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
      const saved = await db<{ seq: number }>(params.userId, `
        UPDATE office_collab_documents SET
          ydoc = $3, state_vector = $4, canonical_hash = $5,
          seq = seq + 1, updated_at = now()
         WHERE artifact_id = $1 AND seq = $2
         RETURNING seq::int AS seq
      `, [params.artifactId, params.expectedSeq, Buffer.from(update), Buffer.from(officeStateVector(doc)), hash])
      const row = saved.rows[0]
      return row ? { snapshot, seq: row.seq, baseVersion: current.baseVersion } : 'conflict'
    },
  }
}

export const officeLiveStore = createOfficeLiveStore()
