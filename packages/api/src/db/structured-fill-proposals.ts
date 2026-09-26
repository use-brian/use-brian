/** Atomic proposal-only Office persistence. Caller owns current Files/Office authorization. */
import { createHash } from 'node:crypto'
import { defaultOfficeDbQuery, type OfficeDbQuery } from './office-artifacts.js'

export type StructuredFillProposalInput = {
  userId: string; workspaceId: string; artifactId: string; baseVersionId: string
  expectedSeq: number; assistantId: string | null; extractionId: string; evidenceHash: string
  command: unknown; preview: unknown; lineage: unknown; body: string; targetIds: string[]
}
export type StructuredFillProposalResult = { id: string; threadId: string }

// Canonical JSON binds every persisted field, independent of object property order.
function canonical(value: unknown, depth = 0): string {
  if (depth > 64) throw new Error('invalid_proposal_payload')
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(v => canonical(v, depth + 1)).join(',') + ']'
  if (typeof value === 'object' && value && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string,unknown>)[key], depth + 1)).join(',') + '}'
  }
  throw new Error('invalid_proposal_payload')
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
function stableId(domain: string, key: string) {
  const hex = digest(`structured-fill:${domain}:${key}`)
  // Version 8 UUID: domain-separated SHA-256, RFC variant.
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-8${hex.slice(13,16)}-${((parseInt(hex[16],16) & 3) | 8).toString(16)}${hex.slice(17,20)}-${hex.slice(20,32)}`
}
export function createStructuredFillProposalStore(db: OfficeDbQuery = defaultOfficeDbQuery) {
  return {
    async save(input: StructuredFillProposalInput): Promise<StructuredFillProposalResult | null> {
      if (!Number.isSafeInteger(input.expectedSeq) || input.expectedSeq < 1 || !/^[a-f0-9]{64}$/.test(input.evidenceHash) ||
          typeof input.body !== 'string' || !input.body.trim() || input.body.length > 20_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.body) ||
          !Array.isArray(input.targetIds) || input.targetIds.length < 1 || input.targetIds.length > 1000 || new Set(input.targetIds).size !== input.targetIds.length) throw new Error('invalid_proposal_payload')
      const command = canonical(input.command), preview = canonical(input.preview), lineage = canonical(input.lineage)
      if ([command,preview,lineage].some(s => Buffer.byteLength(s) > 4 * 1024 * 1024)) throw new Error('invalid_proposal_payload')
      const payloadHash = digest(canonical({ ...input, command: JSON.parse(command), preview: JSON.parse(preview), lineage: JSON.parse(lineage) }))
      const key = canonical([input.userId,input.workspaceId,input.extractionId,input.artifactId,input.evidenceHash])
      const id = stableId('suggestion',key), threadId = stableId('thread',key), messageId = stableId('message',key)
      const result = await db<StructuredFillProposalResult>(input.userId, `
        WITH current_target AS MATERIALIZED (
          SELECT a.id FROM office_artifacts a
          JOIN office_collab_documents c ON c.artifact_id=a.id AND c.workspace_id=a.workspace_id
          JOIN structured_document_extractions e ON e.id=$7 AND e.workspace_id=a.workspace_id AND e.user_id=$1
          WHERE a.id=$3 AND a.workspace_id=$2 AND a.lifecycle_state='active'
            AND a.family='spreadsheet' AND a.mode='artifact'
            AND a.head_version_id=$4 AND c.seq=$5 AND e.status='completed'
            AND EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id=$2 AND m.user_id=$1)
          FOR UPDATE OF a,c
        ), reservation AS (
          INSERT INTO structured_document_fill_proposals AS p
            (id,thread_id,user_id,workspace_id,artifact_id,base_version_id,expected_seq,
             assistant_id,extraction_id,evidence_hash,payload_hash,command,preview,lineage,body,target_ids)
          SELECT $15,$16,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14::uuid[]
          WHERE EXISTS (SELECT 1 FROM current_target)
             OR EXISTS (SELECT 1 FROM structured_document_fill_proposals prior
                        WHERE prior.id=$15 AND prior.user_id=$1 AND prior.payload_hash=$9)
          ON CONFLICT (user_id,workspace_id,extraction_id,artifact_id,evidence_hash)
          DO UPDATE SET payload_hash=p.payload_hash WHERE p.payload_hash=EXCLUDED.payload_hash
          RETURNING *
        ), thread AS (
          INSERT INTO office_comment_threads AS t
            (id,artifact_id,workspace_id,artifact_version_id,anchor_kind,anchor,created_by,last_valid_version_id)
          SELECT thread_id,artifact_id,workspace_id,base_version_id,'table_cell',
                 jsonb_build_object('kind','table_cell','targetIds',to_jsonb(target_ids)),user_id,base_version_id
          FROM reservation
          ON CONFLICT (id) DO UPDATE SET id=t.id
          RETURNING id
        ), message AS (
          INSERT INTO office_comment_messages AS m
            (id,thread_id,workspace_id,author_type,author_assistant_id,body)
          SELECT $17,p.thread_id,p.workspace_id,'assistant',p.assistant_id,p.body
          FROM reservation p JOIN thread t ON t.id=p.thread_id
          ON CONFLICT (id) DO UPDATE SET id=m.id
          RETURNING thread_id
        ), suggestion AS (
          INSERT INTO office_suggestions AS s
            (id,artifact_id,workspace_id,thread_id,base_version_id,proposed_by_type,
             proposed_by_assistant_id,command_batch,affected_object_ids)
          SELECT p.id,p.artifact_id,p.workspace_id,p.thread_id,p.base_version_id,'assistant',
                 p.assistant_id,p.command,p.target_ids
          FROM reservation p JOIN message m ON m.thread_id=p.thread_id
          ON CONFLICT (id) DO UPDATE SET id=s.id
          RETURNING id,thread_id
        ) SELECT id,thread_id AS "threadId" FROM suggestion
      `, [input.userId,input.workspaceId,input.artifactId,input.baseVersionId,input.expectedSeq,input.assistantId,
        input.extractionId,input.evidenceHash,payloadHash,command,preview,lineage,input.body,input.targetIds,id,threadId,messageId])
      return result.rows[0] ?? null
    },
    async get(userId: string, id: string): Promise<(StructuredFillProposalResult & { preview: unknown; lineage: unknown; evidenceHash: string; baseVersionId: string; expectedSeq: number }) | null> {
      const result = await db<StructuredFillProposalResult & { preview: unknown; lineage: unknown; evidenceHash: string; baseVersionId: string; expectedSeq: number }>(userId, `
        SELECT id,thread_id AS "threadId",preview,lineage,evidence_hash AS "evidenceHash",
               base_version_id AS "baseVersionId",expected_seq::int AS "expectedSeq"
        FROM structured_document_fill_proposals WHERE user_id=$1 AND id=$2
      `, [userId,id])
      return result.rows[0] ?? null
    },
  }
}
