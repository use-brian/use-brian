/** Versioned Office templates and declarative resources. [COMP:api/office-store] */
import { defaultOfficeDbQuery, type OfficeDbQuery } from './office-artifacts.js'

export function createOfficeTemplateStore(db: OfficeDbQuery = defaultOfficeDbQuery) {
  return {
    async get(userId: string, templateId: string): Promise<{ id: string; workspaceId: string; family: 'document' | 'presentation' | 'spreadsheet'; name: string; description: string; sensitivity: 'public' | 'internal' | 'confidential'; lifecycleState: 'draft' | 'admitted' | 'deprecated' | 'trash' | 'retained'; draftArtifactId: string | null } | null> {
      const result = await db<{ id: string; workspaceId: string; family: 'document' | 'presentation' | 'spreadsheet'; name: string; description: string; sensitivity: 'public' | 'internal' | 'confidential'; lifecycleState: 'draft' | 'admitted' | 'deprecated' | 'trash' | 'retained'; draftArtifactId: string | null }>(userId, `
        SELECT id, workspace_id AS "workspaceId", family, name, description,
               sensitivity, lifecycle_state AS "lifecycleState",
               draft_artifact_id AS "draftArtifactId"
          FROM office_templates WHERE id = $1 AND lifecycle_state <> 'purged'
      `, [templateId])
      return result.rows[0] ?? null
    },

    async getVersion(userId: string, versionId: string): Promise<{ id: string; templateId: string; workspaceId: string; version: number; status: 'draft' | 'admitted'; bundleFileId: string; bundleHash: string } | null> {
      const result = await db<{ id: string; templateId: string; workspaceId: string; version: number; status: 'draft' | 'admitted'; bundleFileId: string; bundleHash: string }>(userId, `
        SELECT id, template_id AS "templateId", workspace_id AS "workspaceId",
               version::int AS version, status, bundle_file_id AS "bundleFileId",
               bundle_hash AS "bundleHash"
          FROM office_template_versions
         WHERE id=$1
      `, [versionId])
      return result.rows[0] ?? null
    },

    async getResource(userId: string, resourceId: string): Promise<{ id: string; workspaceId: string; fileId: string | null; hash: string; mime: string; licence: { name?: unknown; url?: unknown; attribution?: unknown }; embeddingRights: 'allowed' | 'subset_only' | 'prohibited' | 'unknown'; sensitivity: 'public' | 'internal' | 'confidential' } | null> {
      const result = await db<{ id: string; workspaceId: string; fileId: string | null; hash: string; mime: string; licence: { name?: unknown; url?: unknown; attribution?: unknown }; embeddingRights: 'allowed' | 'subset_only' | 'prohibited' | 'unknown'; sensitivity: 'public' | 'internal' | 'confidential' }>(userId, `
        SELECT id, workspace_id AS "workspaceId", file_id AS "fileId",
               content_hash AS hash, mime, licence,
               embedding_rights AS "embeddingRights", sensitivity
          FROM office_resources WHERE id=$1
      `, [resourceId])
      return result.rows[0] ?? null
    },

    async list(userId: string, workspaceId: string, family?: 'document' | 'presentation' | 'spreadsheet'): Promise<Array<Record<string, unknown>>> {
      const result = await db<Record<string, unknown>>(userId, `
        SELECT id, family, name, description, lifecycle_state AS "lifecycleState",
               current_version_id AS "currentVersionId",
               draft_artifact_id AS "draftArtifactId", sensitivity,
               updated_at AS "updatedAt"
          FROM office_templates
         WHERE workspace_id = $1
           AND ($2::text IS NULL OR family = $2::text)
           AND lifecycle_state <> 'purged'
           AND (lifecycle_state <> 'retained' OR owner_user_id = $3 OR EXISTS (
             SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=office_templates.workspace_id
               AND wm.user_id=$3 AND wm.role IN ('owner','admin')
           ))
         ORDER BY updated_at DESC
         LIMIT 200
      `, [workspaceId, family ?? null, userId])
      return result.rows
    },

    async createDraft(params: { userId: string; workspaceId: string; family: 'document' | 'presentation' | 'spreadsheet'; name: string; description: string; sensitivity: 'public' | 'internal' | 'confidential'; draftArtifactId: string }): Promise<{ id: string }> {
      const result = await db<{ id: string }>(params.userId, `
        INSERT INTO office_templates
          (workspace_id, family, name, description, owner_user_id, sensitivity,
           draft_artifact_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id
      `, [params.workspaceId, params.family, params.name, params.description, params.userId, params.sensitivity, params.draftArtifactId])
      if (!result.rows[0]) throw new Error('Office template draft insert returned no row')
      return result.rows[0]
    },

    async getDraftRouting(userId: string, templateId: string): Promise<unknown | null> {
      const result = await db<{ draftRouting: unknown | null }>(userId, `
        SELECT draft_routing AS "draftRouting"
          FROM office_templates
         WHERE id=$1 AND lifecycle_state='draft'
      `, [templateId])
      return result.rows[0]?.draftRouting ?? null
    },

    async saveDraftRouting(params: { userId: string; templateId: string; routing: unknown }): Promise<boolean> {
      const result = await db<{ id: string }>(params.userId, `
        UPDATE office_templates
           SET draft_routing=$2::jsonb, updated_at=now()
         WHERE id=$1 AND lifecycle_state='draft'
        RETURNING id
      `, [params.templateId, JSON.stringify(params.routing)])
      return result.rows.length === 1
    },

    async deleteEmptyDraft(userId: string, templateId: string): Promise<boolean> {
      const result = await db<{ id: string }>(userId, `
        DELETE FROM office_templates t
         WHERE t.id = $1
           AND t.owner_user_id = $2
           AND t.lifecycle_state = 'draft'
           AND t.current_version_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM office_template_versions v WHERE v.template_id = t.id
           )
        RETURNING t.id
      `, [templateId, userId])
      return result.rows.length === 1
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

    async transitionLifecycle(params: { userId: string; templateId: string; action: 'deprecate' | 'restore' | 'trash' | 'purge'; reason: string }): Promise<Record<string, unknown> | null> {
      const result = await db<Record<string, unknown>>(params.userId, `
        WITH candidate AS (
          SELECT t.* FROM office_templates t
           WHERE t.id=$1 AND t.legal_hold=FALSE
             AND (t.owner_user_id=$3 OR EXISTS (
               SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=t.workspace_id
                 AND wm.user_id=$3 AND wm.role IN ('owner','admin')
             ))
             AND (($2='deprecate' AND t.lifecycle_state='admitted') OR
                  ($2='restore' AND t.lifecycle_state IN ('deprecated','trash','retained')) OR
                  ($2='trash' AND t.lifecycle_state IN ('draft','admitted','deprecated')) OR
                  ($2='purge' AND t.lifecycle_state IN ('trash','retained') AND NOT EXISTS (
                    SELECT 1 FROM office_artifacts a JOIN office_template_versions v ON v.id=a.template_version_id
                     WHERE v.template_id=t.id AND a.lifecycle_state <> 'purged'
                  )))
           FOR UPDATE
        )
        , updated AS (
          UPDATE office_templates t SET
            lifecycle_state=CASE $2 WHEN 'deprecate' THEN 'deprecated' WHEN 'restore' THEN CASE WHEN t.current_version_id IS NULL THEN 'draft' ELSE 'admitted' END WHEN 'trash' THEN 'trash' WHEN 'purge' THEN 'purged' END,
            trashed_at=CASE WHEN $2='trash' THEN now() WHEN $2='restore' THEN NULL ELSE t.trashed_at END,
            retain_at=CASE WHEN $2='trash' THEN now()+interval '30 days' WHEN $2='restore' THEN NULL ELSE t.retain_at END,
            purge_at=CASE WHEN $2='trash' THEN now()+interval '60 days' WHEN $2='restore' THEN NULL ELSE t.purge_at END,
            updated_at=now()
          FROM candidate c WHERE t.id=c.id RETURNING t.*
        ), audited AS (
          INSERT INTO office_audit_events(workspace_id,actor_user_id,event_type,reason,metadata)
          SELECT workspace_id,$3,'office.template.lifecycle.'||$2,$4,jsonb_build_object('templateId',id) FROM updated
        )
        SELECT id,lifecycle_state AS "lifecycleState",updated_at AS "updatedAt" FROM updated
      `, [params.templateId, params.action, params.userId, params.reason])
      return result.rows[0] ?? null
    },
  }
}

export const officeTemplateStore = createOfficeTemplateStore()
