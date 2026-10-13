/** Engine persistence for native routine intake. No public admission endpoint.
 * Spec: docs/architecture/features/routine-work-intake.md
 * [COMP:api/routine-intake]
 */
import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { routineConfigurationShape, type ScopeEvidence, type WorkflowDefinition, type WorkflowTrigger } from '@use-brian/core'
import { getPool } from './client.js'

export type RoutineConfiguration = {
  definition: WorkflowDefinition
  trigger: WorkflowTrigger
  contextGroupId: string | null
  contextProjectId: string | null
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value)
}

export const routineConfigurationDigest = (configuration: RoutineConfiguration): string =>
  createHash('sha256').update(canonical(routineConfigurationShape(configuration))).digest('hex')

/** Cheap, read-only preflight before a configuration or admission command. */
export async function requireRoutineSchema(client: Pick<PoolClient, 'query'> = getPool()): Promise<void> {
  const row = (await client.query<{ ready: boolean }>(`SELECT to_regclass('public.task_routine_intake_receipts') IS NOT NULL
    AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='workflows'
      AND column_name='task_intake_revision')
    AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='workflow_runs'
      AND column_name='routine_intake_context') AS ready`)).rows[0]
  if (!row?.ready) throw Object.assign(new Error('routine_schema_not_ready'), { status: 409 })
}

export type RoutineIntakeReceipt = {
  id: string
  workspaceId: string
  routineId: string
  acceptedRevision: number
  acceptedDigest: string
  caseKey: string
  runId: string | null
  taskId: string
  sourceEvidence: ScopeEvidence
  basis: Record<string, unknown>
  executor: Record<string, unknown>
  home: Record<string, unknown>
  qualification: Record<string, unknown>
}

/** The caller owns the workspace/configuration/source locks and transaction. */
export async function findRoutineReceipt(client: PoolClient, workspaceId: string, routineId: string, caseKey: string): Promise<RoutineIntakeReceipt | null> {
  const row = (await client.query(`SELECT id,workspace_id AS "workspaceId",routine_id AS "routineId",
    accepted_revision::int AS "acceptedRevision",accepted_digest AS "acceptedDigest",case_key AS "caseKey",run_id AS "runId",
    task_id AS "taskId",source_evidence AS "sourceEvidence",basis,executor,home,qualification
    FROM task_routine_intake_receipts WHERE workspace_id=$1 AND routine_id=$2 AND case_key=$3`, [workspaceId, routineId, caseKey])).rows[0]
  return row ?? null
}
