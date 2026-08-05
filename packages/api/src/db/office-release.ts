/** Office claim/media review, release records, and offline manifests.
 * [COMP:api/office-store] */
import { defaultOfficeDbQuery, type OfficeDbQuery } from './office-artifacts.js'
import type { OfficeReleaseAcknowledgement, OfficeReleaseAction, OfficeReleaseDestination, OfficeReleaseReceipt } from '../office/release.js'

export function createOfficeReleaseStore(db: OfficeDbQuery = defaultOfficeDbQuery) {
  return {
    async listClaims(userId: string, artifactId: string, versionId: string) {
      const result = await db<{ id: string; classification: string; confidence: number; severity: string; reasonCode: string; status: string }>(userId, `
        SELECT id, classification, confidence, severity, reason_code AS "reasonCode", status
          FROM office_claims WHERE artifact_id=$1 AND artifact_version_id=$2
         ORDER BY severity DESC, created_at
      `, [artifactId, versionId])
      return result.rows
    },

    async listMedia(userId: string, artifactId: string, versionId: string) {
      const result = await db<{ id: string; provenanceState: string; disclosureRequired: boolean }>(userId, `
        SELECT id, provenance_state AS "provenanceState", disclosure_required AS "disclosureRequired"
          FROM office_media_uses WHERE artifact_id=$1 AND artifact_version_id=$2
         ORDER BY created_at
      `, [artifactId, versionId])
      return result.rows
    },

    async createRelease(params: { userId: string; artifactId: string; versionId: string; workspaceId: string; action: OfficeReleaseAction; destination: OfficeReleaseDestination; receipt: OfficeReleaseReceipt; acknowledgement?: OfficeReleaseAcknowledgement; releasedFileId: string }): Promise<{ id: string }> {
      const result = await db<{ id: string }>(params.userId, `
        INSERT INTO office_release_records
          (artifact_id,artifact_version_id,workspace_id,action,destination_projection,
           validation_receipt,acknowledgement,released_file_id,released_by)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9)
        RETURNING id
      `, [params.artifactId, params.versionId, params.workspaceId, params.action, JSON.stringify(params.destination), JSON.stringify(params.receipt), params.acknowledgement ? JSON.stringify(params.acknowledgement) : null, params.releasedFileId, params.userId])
      if (!result.rows[0]) throw new Error('Office release insert returned no row')
      return result.rows[0]
    },

    async upsertOfflinePackage(params: { userId: string; artifactId: string; versionId: string; workspaceId: string; deviceId: string; packageFileId: string; manifest: unknown; manifestHash: string; signature: string; stateVector: Uint8Array; pinned: boolean }) {
      const result = await db<Record<string, unknown>>(params.userId, `
        INSERT INTO office_offline_packages
          (artifact_id,artifact_version_id,workspace_id,user_id,device_id,package_file_id,
           manifest,manifest_hash,signature,state_vector,complete,pinned,last_synced_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,TRUE,$11,now())
        ON CONFLICT (artifact_id,user_id,device_id) DO UPDATE SET
          artifact_version_id=EXCLUDED.artifact_version_id,package_file_id=EXCLUDED.package_file_id,
          manifest=EXCLUDED.manifest,manifest_hash=EXCLUDED.manifest_hash,
          signature=EXCLUDED.signature,state_vector=EXCLUDED.state_vector,
          complete=TRUE,pinned=EXCLUDED.pinned,revoked_at=NULL,last_synced_at=now(),updated_at=now()
        RETURNING id, manifest, manifest_hash AS "manifestHash", signature, complete, pinned,
                  last_synced_at AS "lastSyncedAt"
      `, [params.artifactId, params.versionId, params.workspaceId, params.userId, params.deviceId, params.packageFileId, JSON.stringify(params.manifest), params.manifestHash, params.signature, Buffer.from(params.stateVector), params.pinned])
      if (!result.rows[0]) throw new Error('Office offline package upsert returned no row')
      return result.rows[0]
    },

    async revokeOfflinePackages(userId: string, artifactId: string): Promise<void> {
      await db(userId, `UPDATE office_offline_packages SET revoked_at=now(),complete=FALSE,updated_at=now() WHERE artifact_id=$1 AND revoked_at IS NULL`, [artifactId])
    },
  }
}

export const officeReleaseStore = createOfficeReleaseStore()
