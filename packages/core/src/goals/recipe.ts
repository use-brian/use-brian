/**
 * Goal recipes — the one earned Spec (§3.6).
 *
 * A recipe is a reusable, `{{var}}`-parameterized goal blueprint ("drive a
 * deal to closed-won", "ship this feature"). Instantiating one mints a concrete
 * goal whose `recipe_id` links back to it. This is the PURE instantiation half
 * (the template-substitution engine, mirroring `instantiatePageTemplate`); the
 * library surface + persistence are the api/web halves.
 *
 * A recipe is a Spec, not a Noun: it is teleological (end-state + acceptance),
 * which no existing Spec is, so it passes the irreducibility gate (§2). The
 * live goal it mints stays a Noun.
 *
 * [COMP:goals/recipe]
 */
import type { DoneWhenNode } from './done-when.js'
import type { GoalBudget, GoalCreateParams, GoalHost, GoalMeans, GoalPolicy } from './types.js'

export type GoalRecipeVar = { name: string; description?: string; required?: boolean }

export type GoalRecipe = {
  id: string
  name: string
  description: string
  /** Outcome template, with `{{var}}` placeholders. */
  outcome: string
  /** Acceptance predicate; `{{var}}` placeholders in string positions resolve. */
  doneWhen: DoneWhenNode
  means?: GoalMeans
  budget?: GoalBudget
  policy?: GoalPolicy
  /** Declared variables the recipe expects. */
  vars?: GoalRecipeVar[]
}

export type InstantiateRecipeOpts = {
  workspaceId: string
  vars?: Record<string, string>
  /** Default null = self-hosted. */
  host?: GoalHost
  parentGoalId?: string | null
  createdByUserId?: string | null
}

export class GoalRecipeVarError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GoalRecipeVarError'
  }
}

const VAR_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g

/** Recursively substitute `{{var}}` in every string position of `value`. An
 *  unknown placeholder is left verbatim (visible, not silently dropped) — the
 *  same rule as the page-template engine. */
export function substituteVars<T>(value: T, vars: Record<string, string>): T {
  if (typeof value === 'string') {
    return value.replace(VAR_RE, (_m, key: string) =>
      key in vars ? vars[key] : `{{${key}}}`,
    ) as unknown as T
  }
  if (Array.isArray(value)) {
    return value.map((v) => substituteVars(v, vars)) as unknown as T
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substituteVars(v, vars)
    }
    return out as unknown as T
  }
  return value
}

/** Instantiate a recipe into `GoalCreateParams`, with `recipe_id` linking the
 *  minted goal back to the Spec. Throws `GoalRecipeVarError` if a declared
 *  required var is missing. */
export function instantiateGoalRecipe(
  recipe: GoalRecipe,
  opts: InstantiateRecipeOpts,
): GoalCreateParams {
  const vars = opts.vars ?? {}
  for (const v of recipe.vars ?? []) {
    if (v.required && !(v.name in vars)) {
      throw new GoalRecipeVarError(`goal recipe "${recipe.name}" requires var "${v.name}"`)
    }
  }
  return {
    workspaceId: opts.workspaceId,
    outcome: substituteVars(recipe.outcome, vars),
    doneWhen: substituteVars(recipe.doneWhen, vars),
    means: recipe.means ? substituteVars(recipe.means, vars) : undefined,
    budget: recipe.budget,
    policy: recipe.policy,
    host: opts.host ?? null,
    parentGoalId: opts.parentGoalId ?? null,
    recipeId: recipe.id,
    createdByUserId: opts.createdByUserId ?? null,
    status: 'active',
  }
}
