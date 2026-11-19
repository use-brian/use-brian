import type { PoolClient } from 'pg'
import type { AdmissionPolicy } from './resource-admission.js'

/** Read the fixed admission projection under current member or owner authority.
 * The caller holds the workspace lock across admission and publication. */
export async function readAdmissionPolicy(client: PoolClient, workspaceId: string): Promise<AdmissionPolicy | undefined> {
  return (await client.query<AdmissionPolicy>('SELECT * FROM public.read_workspace_admission_policy($1)', [workspaceId])).rows[0]
}

/** The superseded mode-admission protocol remains the rollback contract for
 * pre-v2 workspaces. A completed setup must not switch a v2 workspace back to
 * that different permission model. Its department RLS, provenance, holding and
 * canonical writer rules apply before and after setup completion. */
export function usesClassicModeAdmission(policy: AdmissionPolicy | null | undefined): policy is AdmissionPolicy {
  return !!policy && policy.departmentReadV2 !== true && policy.setupState !== 'legacy'
}
