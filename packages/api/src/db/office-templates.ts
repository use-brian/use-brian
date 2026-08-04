/** Versioned Office templates and declarative resources. [COMP:api/office-store] */
import { defaultOfficeDbQuery, type OfficeDbQuery } from './office-artifacts.js'

export function createOfficeTemplateStore(db: OfficeDbQuery = defaultOfficeDbQuery) {
  return {
    async createDraft(params: { userId: string; workspaceId: string; family: 'document' | 'presentation'; name: string; description: string; sensitivity: 'public' | 'internal' | 'confidential' }): Promise<{ id: string }> {
      const result = await db<{ id: string }>(params.userId, `
        INSERT INTO office_templates
          (workspace_id, family, name, description, owner_user_id, sensitivity)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING id
      `, [params.workspaceId, params.family, params.name, params.description, params.userId, params.sensitivity])
      if (!result.rows[0]) throw new Error('Office template draft insert returned no row')
      return result.rows[0]
    },

    async addVersion(params: { userId: string; templateId: string; workspaceId: string; bundleFileId: string; bundleHash: string; capabilityVersion: number; locales: string[]; tags: string[]; whenToUse: string[]; whenNotToUse: string[]; exampleRequests: string[]; fieldSchema: unknown; admissionReceipt: unknown; provenance: unknown; status: 'draft' | 'admitted' }): Promise<{ id: string; version: number }> {
      const result = await db<{ id: string; version: number }>(params.userId, `
        WITH next AS (
          SELECT COALESCE(max(version), 0) + 1 AS version
            FROM office_template_versions WHERE template_id = $1
        ), inserted AS (
          INSERT INTO office_template_versions
            (template_id, workspace_id, version, parent_version_id, bundle_file_id,
             bundle_hash, capability_version, locales, tags, when_to_use,
             when_not_to_use, example_requests, field_schema, admission_receipt,
             provenance, status, admitted_by, admitted_at, created_by)
          SELECT $1,$2,next.version,t.current_version_id,$3,$4,$5,$6,$7,
                 $8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,
                 $14, CASE WHEN $14 = 'admitted' THEN $15::uuid END,
                 CASE WHEN $14 = 'admitted' THEN now() END, $15
            FROM next JOIN office_templates t ON t.id = $1
          RETURNING id, version
        ), promoted AS (
          UPDATE office_templates t
             SET current_version_id = CASE WHEN $14 = 'admitted' THEN i.id ELSE t.current_version_id END,
                 lifecycle_state = CASE WHEN $14 = 'admitted' THEN 'admitted' ELSE t.lifecycle_state END,
                 updated_at = now()
            FROM inserted i WHERE t.id = $1
        )
        SELECT id, version FROM inserted
      `, [params.templateId, params.workspaceId, params.bundleFileId, params.bundleHash, params.capabilityVersion, params.locales, params.tags, JSON.stringify(params.whenToUse), JSON.stringify(params.whenNotToUse), JSON.stringify(params.exampleRequests), JSON.stringify(params.fieldSchema), JSON.stringify(params.admissionReceipt), JSON.stringify(params.provenance), params.status, params.userId])
      const row = result.rows[0]
      if (!row) throw new Error('Office template version insert returned no row')
      return row
    },

    async addResource(params: { userId: string; workspaceId: string; kind: 'font' | 'theme' | 'field_schema' | 'brand_media' | 'reusable_section' | 'reusable_slide'; name: string; fileId: string | null; hash: string; mime: string; licence: unknown; embeddingRights: 'allowed' | 'subset_only' | 'prohibited' | 'unknown'; sensitivity: 'public' | 'internal' | 'confidential' }): Promise<{ id: string }> {
      const result = await db<{ id: string }>(params.userId, `
        INSERT INTO office_resources
          (workspace_id, kind, name, file_id, content_hash, mime, licence,
           embedding_rights, sensitivity, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)
        ON CONFLICT (workspace_id, kind, content_hash) DO UPDATE SET updated_at = now()
        RETURNING id
      `, [params.workspaceId, params.kind, params.name, params.fileId, params.hash, params.mime, JSON.stringify(params.licence), params.embeddingRights, params.sensitivity, params.userId])
      if (!result.rows[0]) throw new Error('Office resource insert returned no row')
      return result.rows[0]
    },
  }
}

export const officeTemplateStore = createOfficeTemplateStore()
