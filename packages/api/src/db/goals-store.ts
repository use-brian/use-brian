import type { GoalStore } from '@sidanclaw/core'
import {
  countOpenSubGoalsSystem,
  createGoal,
  getGoalById,
  getGoalByIdSystem,
  listGoals,
  listGoalsByHostSystem,
  setGoalStatusSystem,
} from './goals.js'

/**
 * Create a GoalStore backed by PostgreSQL — adapts the SQL helpers in
 * `goals.ts` to the core `GoalStore` interface. Operational table: writes use
 * the owner pool (the route/engine is the authz gate), user reads route
 * through `queryWithRLS` so `goals_workspace_member` enforces isolation.
 */
export function createDbGoalStore(): GoalStore {
  return {
    create: createGoal,
    getById: getGoalById,
    getByIdSystem: getGoalByIdSystem,
    list: listGoals,
    listByHostSystem: listGoalsByHostSystem,
    setStatusSystem: setGoalStatusSystem,
    countOpenSubGoalsSystem,
  }
}
