import {capturePdfIntakeSource,reservePdfIntake,finalizePdfIntake,checkPdfIntakeRequest,pdfIntakeError} from './office-pdf-intake.js'
import {queryWithRLS} from './client.js'
/** Owner-only PDF session persistence. [COMP:api/office-pdf-sessions] */
import type { PdfSnapshot } from '@use-brian/office-model'
import { defaultOfficeDbQuery, type OfficeDbQuery } from './office-artifacts.js'

export type PdfSessionRow = {
  id: string
  workspaceId: string
  ownerUserId: string
  title: string
  sensitivity: 'public' | 'internal' | 'confidential'
  compartments: string[]
  projectIds: string[]
  headVersionId: string
  headVersion: number
  expiresAt: Date
  sourceFileId: string
  snapshotFileId: string
}

export type PdfSessionAssetRow = {
  fileId: string
  role: 'source' | 'signature' | 'snapshot' | 'preview' | 'release'
  contentSha256: string
  path: string
  storageUri: string
  mime: string
}

export type CreatePdfSessionRecord = {
  intakeReserved?: boolean
  userId: string
  artifactId: string
  versionId: string
  workspaceId: string
  title: string
  sensitivity: 'public' | 'internal' | 'confidential'
  compartments: string[]
  projectIds: string[]
  idempotencyKey: string
  snapshot: PdfSnapshot
  snapshotFileId: string
  snapshotHash: string
  snapshotBytes: Uint8Array
  stateVector: Uint8Array
  sourceFileId: string
  sourceSha256: string
  signatureFileId?: string
  signatureSha256?: string
}

const SELECT_SESSION = `
  SELECT a.id,a.workspace_id AS "workspaceId",a.owner_user_id AS "ownerUserId",
         a.title,a.sensitivity,a.compartments,a.project_ids AS "projectIds",
         a.head_version_id AS "headVersionId",a.head_version::int AS "headVersion",
         a.expires_at AS "expiresAt",
         src.file_id AS "sourceFileId",v.snapshot_file_id AS "snapshotFileId"
    FROM office_artifacts a
    JOIN office_artifact_versions v ON v.id=a.head_version_id
    JOIN office_pdf_session_assets src ON src.artifact_id=a.id AND src.role='source'
   WHERE a.family='pdf' AND a.mode='session' AND a.lifecycle_state='active'
     AND now()<a.expires_at`

export function createOfficePdfSessionStore(db: OfficeDbQuery = defaultOfficeDbQuery) {
  return {
    captureSource: capturePdfIntakeSource,
    reserveIntake: reservePdfIntake,
    checkIntakeRequest: checkPdfIntakeRequest,
    async abortIntake(actor:string,id:string) {
      return (await queryWithRLS(actor,'SELECT abandon_pdf_intake($1) AS abandoned',[id])).rows[0]?.abandoned===true
    },
    async get(userId: string, artifactId: string): Promise<PdfSessionRow | null> {
      const result = await db<PdfSessionRow>(userId, `${SELECT_SESSION} AND a.id=$1`, [artifactId])
      return result.rows[0] ?? null
    },

    async findByIdempotency(userId: string, workspaceId: string, idempotencyKey: string): Promise<PdfSessionRow | null> {
      const result = await db<PdfSessionRow>(userId, `${SELECT_SESSION}
        AND a.workspace_id=$1 AND a.owner_user_id=$2 AND a.pdf_session_idempotency_key=$3`,
      [workspaceId, userId, idempotencyKey])
      return result.rows[0] ?? null
    },

    async create(params: CreatePdfSessionRecord): Promise<PdfSessionRow | null> {
      if (params.intakeReserved) return finalizePdfIntake(params,SELECT_SESSION)
      if (db===defaultOfficeDbQuery) pdfIntakeError('pdf_intake_reservation_required')
      const assetIds = [params.sourceFileId, params.snapshotFileId, ...(params.signatureFileId ? [params.signatureFileId] : [])]
      const assetRoles = ['source', 'snapshot', ...(params.signatureFileId ? ['signature'] : [])]
      const assetHashes = [params.sourceSha256, params.snapshotHash, ...(params.signatureSha256 ? [params.signatureSha256] : [])]
      const result = await db<PdfSessionRow>(params.userId, `
        WITH artifact AS (
          INSERT INTO office_artifacts
            (id,workspace_id,family,mode,title,creator_user_id,owner_user_id,
             head_version_id,head_version,capability_version,sensitivity,
             compartments,project_ids,default_workspace_role,expires_at,
             pdf_session_idempotency_key)
          VALUES ($1,$3,'pdf','session',$4,$5,$5,$2,0,$6,$7,$8::text[],$9::uuid[],
                  'deny',now()+interval '24 hours',$10)
          ON CONFLICT (workspace_id,owner_user_id,pdf_session_idempotency_key)
            WHERE mode='session' DO NOTHING
          RETURNING *
        ), version AS (
          INSERT INTO office_artifact_versions
            (id,artifact_id,workspace_id,version,parent_version_id,snapshot_file_id,
             snapshot_hash,operation_clock,schema_version,capability_version,
             author_type,author_user_id,origin,summary)
          SELECT $2,id,workspace_id,0,NULL,$11,$12,$13,$14,$15,'import',$5,'import','PDF session intake'
            FROM artifact RETURNING *
        ), live AS (
          INSERT INTO office_collab_documents
            (artifact_id,workspace_id,ydoc,state_vector,canonical_hash,base_version,seq)
          SELECT artifact_id,workspace_id,$16,$17,$12,0,1 FROM version RETURNING artifact_id
        ), assets AS (
          INSERT INTO office_pdf_session_assets
            (artifact_id,workspace_id,owner_user_id,file_id,role,content_sha256)
          SELECT a.id,a.workspace_id,a.owner_user_id,u.file_id,u.role,u.sha256
            FROM artifact a
            CROSS JOIN unnest($18::uuid[],$19::text[],$20::text[]) AS u(file_id,role,sha256)
          RETURNING artifact_id
        ), audit AS (
          INSERT INTO office_audit_events
            (workspace_id,artifact_id,actor_user_id,event_type,artifact_version,metadata)
          SELECT workspace_id,id,$5,'office_pdf_session_created',0,
                 jsonb_build_object('pageCount',$21::int,'sourceSha256',$22::text)
            FROM artifact RETURNING artifact_id
        )
        ${SELECT_SESSION}
         AND a.id=(SELECT id FROM artifact)
         AND EXISTS (SELECT 1 FROM live)
         AND EXISTS (SELECT 1 FROM assets)
         AND EXISTS (SELECT 1 FROM audit)
      `, [
        params.artifactId, params.versionId, params.workspaceId, params.title, params.userId,
        params.snapshot.capabilityVersion, params.sensitivity, params.compartments, params.projectIds,
        params.idempotencyKey, params.snapshotFileId, params.snapshotHash, Buffer.from(params.stateVector),
        params.snapshot.schemaVersion, params.snapshot.capabilityVersion, Buffer.from(params.snapshotBytes),
        Buffer.from(params.stateVector), assetIds, assetRoles, assetHashes,
        params.snapshot.source.pageCount, params.sourceSha256,
      ])
      return result.rows[0] ?? null
    },

    async listAssets(userId: string, artifactId: string): Promise<PdfSessionAssetRow[]> {
      const result = await db<PdfSessionAssetRow>(userId, `
        SELECT a.file_id AS "fileId",a.role,a.content_sha256 AS "contentSha256",
               f.path,f.storage_uri AS "storageUri",f.mime
          FROM office_pdf_session_assets a
          JOIN workspace_files f ON f.id=a.file_id AND f.workspace_id=a.workspace_id
         WHERE a.artifact_id=$1 ORDER BY a.created_at,a.file_id
      `, [artifactId])
      return result.rows
    },

    async trackAsset(params: {
      userId: string
      artifactId: string
      fileId: string
      role: PdfSessionAssetRow['role']
      contentSha256: string
    }): Promise<boolean> {
      const result = await db<{ fileId: string }>(params.userId, `
        INSERT INTO office_pdf_session_assets
          (artifact_id,workspace_id,owner_user_id,file_id,role,content_sha256)
        SELECT a.id,a.workspace_id,a.owner_user_id,f.id,$3,$4
          FROM office_artifacts a
          JOIN workspace_files f ON f.id=$2 AND f.workspace_id=a.workspace_id
         WHERE a.id=$1 AND a.mode='session' AND a.owner_user_id=$5
           AND a.lifecycle_state='active' AND now()<a.expires_at
           AND f.path LIKE '/office/sessions/' || a.id::text || '/%'
           AND f.metadata @> '{"officeSession":true,"noIndex":true}'::jsonb
        ON CONFLICT (artifact_id,file_id) DO NOTHING
        RETURNING file_id AS "fileId"
      `, [params.artifactId, params.fileId, params.role, params.contentSha256, params.userId])
      return result.rows.length === 1
    },

    async untrackAsset(userId: string, artifactId: string, fileId: string): Promise<void> {
      await db(userId, `DELETE FROM office_pdf_session_assets WHERE artifact_id=$1 AND file_id=$2`, [artifactId, fileId])
    },

    async elevateScope(params: {
      userId: string
      artifactId: string
      sensitivity: 'public' | 'internal' | 'confidential'
      compartments: string[]
      projectIds: string[]
    }): Promise<boolean> {
      const result = await db<{ id: string }>(params.userId, `
        UPDATE office_artifacts SET
          sensitivity=CASE WHEN sensitivity_rank(sensitivity)>=sensitivity_rank($2) THEN sensitivity ELSE $2 END,
          compartments=ARRAY(SELECT DISTINCT x FROM unnest(compartments||$3::text[]) x ORDER BY x),
          project_ids=ARRAY(SELECT DISTINCT x FROM unnest(project_ids||$4::uuid[]) x ORDER BY x),
          updated_at=now()
         WHERE id=$1 AND mode='session' AND owner_user_id=$5
           AND lifecycle_state='active' AND now()<expires_at
        RETURNING id
      `, [params.artifactId, params.sensitivity, params.compartments, params.projectIds, params.userId])
      return result.rows.length === 1
    },

    async commitSignaturePlacement(params: {
      userId: string
      assistantId: string
      artifactId: string
      expectedVersion: number
      expectedSeq: number
      snapshot: PdfSnapshot
      snapshotFileId: string
      snapshotHash: string
      snapshotBytes: Uint8Array
      stateVector: Uint8Array
      sourceHash: string
      targetId: string
      signatureResourceId: string
      approvalId: string
      commandId: string
    }): Promise<{ version: number } | null> {
      const result = await db<{ version: number }>(params.userId, `
        WITH current_head AS (
          SELECT a.* FROM office_artifacts a
           WHERE a.id=$1 AND a.owner_user_id=$2 AND a.family='pdf' AND a.mode='session'
             AND a.lifecycle_state='active' AND now()<a.expires_at
             AND a.head_version=$3
             AND EXISTS (
               SELECT 1 FROM office_pdf_session_assets src
                WHERE src.artifact_id=a.id AND src.role='source' AND src.content_sha256=$11
             )
             AND EXISTS (
               SELECT 1 FROM office_pdf_session_assets sig
                WHERE sig.artifact_id=a.id AND sig.role='signature' AND sig.file_id=$13
             )
           FOR UPDATE
        ), current_live AS (
          SELECT d.artifact_id FROM office_collab_documents d
          JOIN current_head h ON h.id=d.artifact_id
           WHERE d.base_version=$3 AND d.seq=$4
           FOR UPDATE
        ), inserted AS (
          INSERT INTO office_artifact_versions
            (artifact_id,workspace_id,version,parent_version_id,snapshot_file_id,
             snapshot_hash,operation_clock,schema_version,capability_version,
             author_type,author_assistant_id,origin,summary,checkpoint_kind)
          SELECT h.id,h.workspace_id,h.head_version+1,h.head_version_id,$5,$6,$7,$8,$9,
                 'assistant',$10,'ai','Approved PDF signature placement','revision'
            FROM current_head h JOIN current_live l ON l.artifact_id=h.id
          RETURNING id,artifact_id,version
        ), advanced AS (
          UPDATE office_artifacts a SET head_version_id=i.id,head_version=i.version,
                 title=$14,updated_at=now()
            FROM inserted i WHERE a.id=i.artifact_id
          RETURNING a.workspace_id,i.version
        ), live AS (
          UPDATE office_collab_documents d SET ydoc=$15,state_vector=$7,
                 canonical_hash=$6,base_version=a.version,seq=d.seq+1,updated_at=now()
            FROM advanced a WHERE d.artifact_id=$1 AND d.seq=$4
          RETURNING a.workspace_id,a.version
        ), audit AS (
          INSERT INTO office_audit_events
            (workspace_id,artifact_id,actor_user_id,actor_assistant_id,event_type,
             artifact_version,metadata)
          SELECT workspace_id,$1,$2,$10,'office_pdf_signature_placed',version,
                 jsonb_build_object('approvalId',$12::text,'commandId',$16::text,
                   'targetId',$17::text,'signatureResourceId',$13::text,
                   'sourceSha256',$11::text,'approvingUserId',$2::text)
            FROM live
          RETURNING artifact_version
        )
        SELECT artifact_version::int AS version FROM audit
      `, [
        params.artifactId, params.userId, params.expectedVersion, params.expectedSeq,
        params.snapshotFileId, params.snapshotHash, Buffer.from(params.stateVector),
        params.snapshot.schemaVersion, params.snapshot.capabilityVersion,
        params.assistantId, params.sourceHash, params.approvalId,
        params.signatureResourceId, params.snapshot.title, Buffer.from(params.snapshotBytes),
        params.commandId, params.targetId,
      ])
      return result.rows[0] ?? null
    },

    /** Commit a validated target-native Brian revision only while both the
     * durable head and live collaboration sequence still match the planner's
     * input. This keeps an assistant from overwriting a direct editor command
     * that arrived while the model was planning. */
    async commitRevision(params: {
      userId: string
      assistantId: string
      artifactId: string
      expectedVersion: number
      expectedSeq: number
      snapshot: PdfSnapshot
      snapshotFileId: string
      snapshotHash: string
      snapshotBytes: Uint8Array
      stateVector: Uint8Array
      sourceHash: string
    }): Promise<{ version: number } | null> {
      const result = await db<{ version: number }>(params.userId, `
        WITH current_head AS (
          SELECT a.* FROM office_artifacts a
           WHERE a.id=$1 AND a.owner_user_id=$2 AND a.family='pdf' AND a.mode='session'
             AND a.lifecycle_state='active' AND now()<a.expires_at
             AND a.head_version=$3
             AND EXISTS (
               SELECT 1 FROM office_pdf_session_assets src
                WHERE src.artifact_id=a.id AND src.role='source' AND src.content_sha256=$11
             )
           FOR UPDATE
        ), current_live AS (
          SELECT d.artifact_id FROM office_collab_documents d
          JOIN current_head h ON h.id=d.artifact_id
           WHERE d.base_version=$3 AND d.seq=$4
           FOR UPDATE
        ), inserted AS (
          INSERT INTO office_artifact_versions
            (artifact_id,workspace_id,version,parent_version_id,snapshot_file_id,
             snapshot_hash,operation_clock,schema_version,capability_version,
             author_type,author_assistant_id,origin,summary,checkpoint_kind)
          SELECT h.id,h.workspace_id,h.head_version+1,h.head_version_id,$5,$6,$7,$8,$9,
                 'assistant',$10,'ai','Brian PDF revision','revision'
            FROM current_head h JOIN current_live l ON l.artifact_id=h.id
          RETURNING id,artifact_id,version
        ), advanced AS (
          UPDATE office_artifacts a SET head_version_id=i.id,head_version=i.version,
                 title=$12,updated_at=now()
            FROM inserted i WHERE a.id=i.artifact_id
          RETURNING a.workspace_id,i.version
        ), live AS (
          UPDATE office_collab_documents d SET ydoc=$13,state_vector=$7,
                 canonical_hash=$6,base_version=a.version,seq=d.seq+1,updated_at=now()
            FROM advanced a WHERE d.artifact_id=$1 AND d.seq=$4
          RETURNING a.workspace_id,a.version
        ), audit AS (
          INSERT INTO office_audit_events
            (workspace_id,artifact_id,actor_assistant_id,event_type,artifact_version,metadata)
          SELECT workspace_id,$1,$10,'office_pdf_revised',version,
                 jsonb_build_object('sourceSha256',$11::text)
            FROM live
          RETURNING artifact_version
        )
        SELECT artifact_version::int AS version FROM audit
      `, [
        params.artifactId, params.userId, params.expectedVersion, params.expectedSeq,
        params.snapshotFileId, params.snapshotHash, Buffer.from(params.stateVector),
        params.snapshot.schemaVersion, params.snapshot.capabilityVersion,
        params.assistantId, params.sourceHash, params.snapshot.title,
        Buffer.from(params.snapshotBytes),
      ])
      return result.rows[0] ?? null
    },
  }
}

export type OfficePdfSessionStore = ReturnType<typeof createOfficePdfSessionStore>
