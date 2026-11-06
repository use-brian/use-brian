/** Published template discovery for chat. [COMP:api/office-template-discovery] */
import { canRead, scopeGrantContains, scopeEvidenceFromRows, type OfficeToolPort, type OfficePublishedTemplate } from '@use-brian/core'
import { defaultOfficeDbQuery, type OfficeDbQuery } from '../db/office-artifacts.js'

type Scope = { sensitivity: 'public' | 'internal' | 'confidential'; compartments: string[]; projectIds: string[] }
type Row = OfficePublishedTemplate & { scopes: Scope[] }

export function createOfficeTemplateDiscovery(query: OfficeDbQuery = defaultOfficeDbQuery): NonNullable<OfficeToolPort['listTemplates']> {
  return async (context, input) => {
    if (!context.workspaceId) return { templates: [], scopeEvidence: scopeEvidenceFromRows([]) }
    const rows = (await query<Row>(context.userId, `
      SELECT t.id AS "templateId",v.id AS "templateVersionId",t.name,t.description,t.family,
        v.version::int AS version,
        jsonb_build_array(
          jsonb_build_object('sensitivity',t.sensitivity,'compartments',a.compartments,'projectIds',a.project_ids),
          jsonb_build_object('sensitivity',a.sensitivity,'compartments',a.compartments,'projectIds',a.project_ids),
          jsonb_build_object('sensitivity',f.sensitivity,'compartments',f.compartments,'projectIds',f.project_ids)
        ) || COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'sensitivity',CASE WHEN sensitivity_rank(rf.sensitivity)>sensitivity_rank(r.sensitivity) THEN rf.sensitivity ELSE r.sensitivity END,
          'compartments',COALESCE(rf.compartments,'{}'::text[]),'projectIds',COALESCE(rf.project_ids,'{}'::uuid[])))
          FROM office_template_resource_refs ref JOIN office_resources r ON r.id=ref.resource_id AND r.workspace_id=ref.workspace_id
          LEFT JOIN workspace_files rf ON rf.id=r.file_id AND rf.workspace_id=r.workspace_id
          WHERE ref.template_version_id=v.id AND ref.workspace_id=t.workspace_id),'[]'::jsonb) AS scopes
      FROM office_templates t JOIN office_template_versions v ON v.id=t.current_version_id AND v.template_id=t.id AND v.workspace_id=t.workspace_id
      JOIN office_artifacts a ON a.id=t.draft_artifact_id AND a.workspace_id=t.workspace_id
      JOIN workspace_files f ON f.id=v.bundle_file_id AND f.workspace_id=t.workspace_id
      WHERE t.workspace_id=$1 AND ($2::text IS NULL OR t.family=$2)
        AND ($3::text IS NULL OR strpos(lower(t.name),lower($3))>0 OR strpos(lower(t.description),lower($3))>0)
        AND t.lifecycle_state='admitted' AND v.status='admitted'
        AND a.mode='template' AND a.family=t.family AND a.lifecycle_state='active'
        AND f.valid_to IS NULL AND f.retracted_at IS NULL AND NOT f.scope_held
        AND office_template_version_scope_allows(v.id,v.workspace_id,false)
      ORDER BY t.name,t.id LIMIT 200
    `, [context.workspaceId, input.family ?? null, input.query ?? null])).rows
    const visible = rows.filter(row => row.scopes.every(scope =>
      canRead(context.clearance ?? 'public', scope.sensitivity)
      && scopeGrantContains(context.compartments ?? null, scope.compartments)
      && scopeGrantContains(context.projectIds ?? null, scope.projectIds)))
    return {
      templates: visible.map(({ scopes: _scopes, ...template }) => template),
      scopeEvidence: scopeEvidenceFromRows(visible.flatMap(row => row.scopes)),
    }
  }
}
