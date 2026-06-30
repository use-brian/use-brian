/**
 * Goal recipes store — persistence for the earned Spec (the Goals library
 * backing). See `docs/architecture/features/goals.md` → "Recipes". Workspace
 * writes via the owner pool (route is the authz gate), reads via `queryWithRLS`
 * so `goal_recipes_workspace_member` enforces isolation. Rows map to the core
 * `GoalRecipe` shape so `instantiateGoalRecipe` consumes them directly.
 */
import type { GoalRecipe, GoalRecipeVar } from '@sidanclaw/core'
import { query, queryWithRLS } from './client.js'

const FULL_SELECT = `id, name, description, outcome, done_when as "doneWhen", means, budget, policy, vars`

type RecipeRow = {
  id: string
  name: string
  description: string
  outcome: string
  doneWhen: unknown
  means: Record<string, unknown> | null
  budget: Record<string, unknown> | null
  policy: Record<string, unknown> | null
  vars: unknown[] | null
}

function toRecipe(row: RecipeRow): GoalRecipe {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    outcome: row.outcome,
    doneWhen: row.doneWhen as GoalRecipe['doneWhen'],
    means: (row.means ?? {}) as GoalRecipe['means'],
    budget: (row.budget ?? {}) as GoalRecipe['budget'],
    policy: (row.policy ?? {}) as GoalRecipe['policy'],
    vars: (row.vars ?? []) as GoalRecipeVar[],
  }
}

export type GoalRecipeCreateParams = {
  workspaceId: string
  name: string
  description?: string
  outcome: string
  doneWhen: GoalRecipe['doneWhen']
  means?: GoalRecipe['means']
  budget?: GoalRecipe['budget']
  policy?: GoalRecipe['policy']
  vars?: GoalRecipeVar[]
  createdByUserId?: string | null
}

export async function createGoalRecipe(params: GoalRecipeCreateParams): Promise<GoalRecipe> {
  const r = await query<RecipeRow>(
    `INSERT INTO goal_recipes (workspace_id, name, description, outcome, done_when, means, budget, policy, vars, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10)
     RETURNING ${FULL_SELECT}`,
    [
      params.workspaceId,
      params.name,
      params.description ?? '',
      params.outcome,
      JSON.stringify(params.doneWhen),
      JSON.stringify(params.means ?? {}),
      JSON.stringify(params.budget ?? {}),
      JSON.stringify(params.policy ?? {}),
      JSON.stringify(params.vars ?? []),
      params.createdByUserId ?? null,
    ],
  )
  return toRecipe(r.rows[0])
}

export async function getGoalRecipeById(userId: string, id: string): Promise<GoalRecipe | null> {
  const r = await queryWithRLS<RecipeRow>(userId, `SELECT ${FULL_SELECT} FROM goal_recipes WHERE id = $1`, [id])
  return r.rows.length === 0 ? null : toRecipe(r.rows[0])
}

export async function getGoalRecipeByIdSystem(id: string): Promise<GoalRecipe | null> {
  const r = await query<RecipeRow>(`SELECT ${FULL_SELECT} FROM goal_recipes WHERE id = $1`, [id])
  return r.rows.length === 0 ? null : toRecipe(r.rows[0])
}

export async function listGoalRecipes(userId: string, workspaceId: string): Promise<GoalRecipe[]> {
  const r = await queryWithRLS<RecipeRow>(
    userId,
    `SELECT ${FULL_SELECT} FROM goal_recipes WHERE workspace_id = $1 ORDER BY updated_at DESC`,
    [workspaceId],
  )
  return r.rows.map(toRecipe)
}
