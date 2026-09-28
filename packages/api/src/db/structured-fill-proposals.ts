/** Atomic proposal-only Office persistence with current evidence and destination authority. */
import { createHash } from 'node:crypto'
import type { AccessContext, ScopeEvidence } from '@use-brian/core'
import { buildAccessPredicate, buildCurrentMemberSourcePredicate, mutationActorAccess } from './access-predicate.js'
import { defaultOfficeDbQuery, type OfficeDbQuery } from './office-artifacts.js'

export type StructuredFillProposalInput = {
  userId: string; workspaceId: string; artifactId: string; baseVersionId: string
  expectedSeq: number; assistantId: string | null; extractionId: string; evidenceHash: string
  command: unknown; preview: unknown; lineage: unknown; body: string; targetIds: string[]
  access: AccessContext
  evidenceFiles: Array<{ id: string; scopeVersion: string }>
  evidenceScope: Required<Pick<ScopeEvidence, 'sensitivity' | 'compartments' | 'projectIds'>>
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
          !Array.isArray(input.targetIds) || input.targetIds.length < 1 || input.targetIds.length > 1000 || new Set(input.targetIds).size !== input.targetIds.length ||
          !Array.isArray(input.evidenceFiles) || input.evidenceFiles.length < 2 || input.evidenceFiles.length > 12 ||
          input.evidenceFiles.some(file => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(file.id) || typeof file.scopeVersion !== 'string' || !file.scopeVersion) ||
          new Set(input.evidenceFiles.map(file => file.id)).size !== input.evidenceFiles.length ||
          !input.evidenceScope || !['public', 'internal', 'confidential'].includes(input.evidenceScope.sensitivity) ||
          !Array.isArray(input.evidenceScope.compartments) || !Array.isArray(input.evidenceScope.projectIds)) throw new Error('invalid_proposal_payload')
      const access = mutationActorAccess(input.userId, input.workspaceId, input.access)
      const command = canonical(input.command), preview = canonical(input.preview), lineage = canonical(input.lineage)
      if ([command,preview,lineage].some(s => Buffer.byteLength(s) > 4 * 1024 * 1024)) throw new Error('invalid_proposal_payload')
      const { access: _access, ...payloadInput } = input
      const payloadHash = digest(canonical({ ...payloadInput, command: JSON.parse(command), preview: JSON.parse(preview), lineage: JSON.parse(lineage) }))
      const key = canonical([input.userId,input.workspaceId,input.extractionId,input.artifactId,input.evidenceHash])
      const id = stableId('suggestion',key), threadId = stableId('thread',key), messageId = stableId('message',key)
      const fileAccess = buildAccessPredicate(access, { alias: 'f', operation: 'mutation', startIdx: 22 })
      const fileMember = buildCurrentMemberSourcePredicate(input.userId, { alias: 'f', operation: 'mutation', startIdx: fileAccess.nextIdx })
      const result = await db<StructuredFillProposalResult>(input.userId, `
        WITH evidence_files AS MATERIALIZED (
          SELECT f.id
          FROM structured_document_extractions evidence_job
          JOIN workspace_files f ON f.id=evidence_job.source_file_id
            OR f.id=evidence_job.records_file_id
            OR f.id IN (SELECT (image->>'fileId')::uuid FROM jsonb_array_elements(evidence_job.image_files) image)
          JOIN jsonb_to_recordset($18::jsonb) AS expected(id uuid,"scopeVersion" text)
            ON expected.id=f.id AND expected."scopeVersion"=f.scope_version::text
          WHERE evidence_job.id=$7 AND evidence_job.user_id=$1 AND evidence_job.workspace_id=$2
            AND evidence_job.status='completed'
            AND f.valid_to IS NULL AND f.retracted_at IS NULL AND f.superseded_by IS NULL
            AND (${fileAccess.sql}) AND (${fileMember.sql})
          FOR SHARE OF f
        ), current_target AS MATERIALIZED (
          SELECT a.id FROM office_artifacts a
          JOIN office_collab_documents c ON c.artifact_id=a.id AND c.workspace_id=a.workspace_id
          JOIN structured_document_extractions e ON e.id=$7 AND e.workspace_id=a.workspace_id AND e.user_id=$1
          JOIN workspace_members member ON member.workspace_id=a.workspace_id AND member.user_id=$1
          LEFT JOIN office_artifact_grants g ON g.artifact_id=a.id AND g.user_id=$1
          WHERE a.id=$3 AND a.workspace_id=$2 AND a.lifecycle_state='active'
            AND a.family='spreadsheet' AND a.mode='artifact'
            AND a.head_version_id=$4 AND c.seq=$5 AND e.status='completed'
            AND NOT (g.role='deny' AND g.revoked_at IS NULL)
            AND COALESCE(CASE WHEN g.revoked_at IS NULL THEN g.role END,
                  CASE WHEN a.creator_user_id=$1 OR a.owner_user_id=$1 THEN 'edit' ELSE a.default_workspace_role END)
                IN ('comment','edit')
            AND sensitivity_rank(a.sensitivity)>=sensitivity_rank($19)
            AND $20::text[] <@ a.compartments AND $21::uuid[] <@ a.project_ids
            AND (SELECT count(*) FROM evidence_files)=jsonb_array_length($18::jsonb)
            AND jsonb_array_length($18::jsonb)=2+jsonb_array_length(e.image_files)
          FOR UPDATE OF a,c,e
        ), reservation AS (
          INSERT INTO structured_document_fill_proposals AS p
            (id,thread_id,user_id,workspace_id,artifact_id,base_version_id,expected_seq,
             assistant_id,extraction_id,evidence_hash,payload_hash,command,preview,lineage,body,target_ids)
          SELECT $15,$16,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14::uuid[]
          WHERE EXISTS (SELECT 1 FROM current_target)
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
        input.extractionId,input.evidenceHash,payloadHash,command,preview,lineage,input.body,input.targetIds,id,threadId,messageId,
        JSON.stringify(input.evidenceFiles),input.evidenceScope.sensitivity,input.evidenceScope.compartments,input.evidenceScope.projectIds,
        ...fileAccess.params,...fileMember.params])
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
