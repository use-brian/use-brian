import type { PoolClient } from 'pg'
import type { AdmissionPolicy } from './resource-admission.js'

/** Policy rows are admin-readable and system-writable under RLS. Admission
 * needs the current policy for ordinary members too. Elevate ONLY this fixed
 * metadata query, restoring the GUC before any resource read/write. The caller
 * holds the workspace lock; no policy-row write lock is needed here. */
export async function readAdmissionPolicy(client: PoolClient, workspaceId: string): Promise<AdmissionPolicy | undefined> {
  const previous = (await client.query<{ value: string | null }>("SELECT current_setting('app.system_bypass',true) AS value")).rows[0].value
  await client.query("SELECT set_config('app.system_bypass','true',true)")
  try {
    return (await client.query<AdmissionPolicy>(`SELECT p.workspace_id AS "workspaceId",p.access_mode AS mode,p.setup_state AS "setupState",
      coalesce((SELECT (to_jsonb(w)->>'department_read_v2')::boolean FROM workspaces w WHERE w.id=p.workspace_id),false) AS "departmentReadV2",
      p.revision::text,p.default_department_id AS "defaultDepartmentId",g.compartment_key AS "defaultCompartment"
      FROM workspace_access_policies p LEFT JOIN workspace_groups g ON g.id=p.default_department_id AND g.workspace_id=p.workspace_id
        AND g.kind='team' AND g.status='active'
      WHERE p.workspace_id=$1`, [workspaceId])).rows[0]
  } finally {
    await client.query("SELECT set_config('app.system_bypass',$1,true)", [previous ?? 'false'])
  }
}

/** The superseded mode-admission protocol remains the rollback contract for
 * pre-v2 workspaces. A completed setup must not switch a v2 workspace back to
 * that different permission model. Its department RLS, provenance, holding and
 * canonical writer rules apply before and after setup completion. */
export function usesClassicModeAdmission(policy: AdmissionPolicy | null | undefined): policy is AdmissionPolicy {
  return !!policy && policy.departmentReadV2 !== true && policy.setupState !== 'legacy'
}
