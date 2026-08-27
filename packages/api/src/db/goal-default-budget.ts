/**
 * Workspace goal-default-budget persistence.
 *
 * Reads return the effective setting, falling back safely when the workspace
 * has no override. Writes re-check owner/admin membership on the system pool.
 *
 * [COMP:goals/default-budget]
 */
import {
  BUILTIN_GOAL_DEFAULT_BUDGET,
  type GoalDefaultBudgetSnapshot,
  type GoalDefaultBudgetStorePort,
  type SetGoalDefaultBudgetResult,
} from '@use-brian/core'
import { query } from './client.js'

type BudgetRow = {
  max_iterations: number
  max_spend_usd: string | number
}

function fromRow(row: BudgetRow): GoalDefaultBudgetSnapshot {
  return {
    budget: {
      maxIterations: Number(row.max_iterations),
      maxSpend: Number(row.max_spend_usd),
    },
    source: 'workspace',
  }
}

function builtIn(): GoalDefaultBudgetSnapshot {
  return {
    budget: { ...BUILTIN_GOAL_DEFAULT_BUDGET },
    source: 'built_in',
  }
}

export async function getWorkspaceGoalDefaultBudgetSystem(
  workspaceId: string,
): Promise<GoalDefaultBudgetSnapshot> {
  try {
    const result = await query<BudgetRow>(
      `SELECT max_iterations, max_spend_usd
         FROM workspace_goal_defaults
        WHERE workspace_id = $1`,
      [workspaceId],
    )
    return result.rows[0] ? fromRow(result.rows[0]) : builtIn()
  } catch (error) {
    console.error('[goal-default-budget] lookup failed, using built-in default:', error)
    return builtIn()
  }
}

export async function setWorkspaceGoalDefaultBudget(
  userId: string,
  workspaceId: string,
  patch: {
    maxIterations?: number
    maxSpend?: number
    reset?: boolean
  },
): Promise<SetGoalDefaultBudgetResult> {
  if (
    (patch.maxIterations !== undefined
      && (!Number.isInteger(patch.maxIterations)
        || patch.maxIterations < 1
        || patch.maxIterations > 1000))
    || (patch.maxSpend !== undefined
      && (!Number.isFinite(patch.maxSpend) || patch.maxSpend <= 0))
    || (patch.reset === true
      && (patch.maxIterations !== undefined || patch.maxSpend !== undefined))
  ) {
    return {
      ok: false,
      reason: 'invalid',
      message:
        'maxIterations must be a whole number from 1 to 1000, maxSpend must be positive, and reset must be used by itself.',
    }
  }

  const membership = await query<{ role: string | null; workspace_exists: boolean }>(
    `SELECT wm.role, true AS workspace_exists
       FROM workspaces w
       LEFT JOIN workspace_members wm
         ON wm.workspace_id = w.id AND wm.user_id = $2
      WHERE w.id = $1`,
    [workspaceId, userId],
  )
  const access = membership.rows[0]
  if (!access) {
    return { ok: false, reason: 'not_found', message: 'Workspace not found.' }
  }
  if (access.role !== 'owner' && access.role !== 'admin') {
    return {
      ok: false,
      reason: 'not_admin',
      message: 'Only a workspace owner or admin can change the default goal budget.',
    }
  }

  if (patch.reset === true) {
    await query('DELETE FROM workspace_goal_defaults WHERE workspace_id = $1', [workspaceId])
    return { ok: true, ...builtIn() }
  }

  if (patch.maxIterations === undefined && patch.maxSpend === undefined) {
    return { ok: true, ...(await getWorkspaceGoalDefaultBudgetSystem(workspaceId)) }
  }

  const result = await query<BudgetRow>(
    `INSERT INTO workspace_goal_defaults
       (workspace_id, max_iterations, max_spend_usd, updated_by_user_id)
     VALUES ($1, COALESCE($2, $4), COALESCE($3, $5), $6)
     ON CONFLICT (workspace_id) DO UPDATE
       SET max_iterations = COALESCE($2, workspace_goal_defaults.max_iterations),
           max_spend_usd = COALESCE($3, workspace_goal_defaults.max_spend_usd),
           updated_by_user_id = $6,
           updated_at = now()
     RETURNING max_iterations, max_spend_usd`,
    [
      workspaceId,
      patch.maxIterations ?? null,
      patch.maxSpend ?? null,
      BUILTIN_GOAL_DEFAULT_BUDGET.maxIterations,
      BUILTIN_GOAL_DEFAULT_BUDGET.maxSpend,
      userId,
    ],
  )
  const row = result.rows[0]
  if (!row) {
    return { ok: false, reason: 'not_found', message: 'Workspace not found.' }
  }
  return { ok: true, ...fromRow(row) }
}

export function createGoalDefaultBudgetStore(): GoalDefaultBudgetStorePort {
  return {
    get: getWorkspaceGoalDefaultBudgetSystem,
    set: setWorkspaceGoalDefaultBudget,
  }
}
