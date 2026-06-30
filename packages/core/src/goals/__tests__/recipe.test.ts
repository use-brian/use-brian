import { describe, it, expect } from 'vitest'
import {
  GoalRecipeVarError,
  instantiateGoalRecipe,
  substituteVars,
  type GoalRecipe,
} from '../recipe.js'

const CLOSE_DEAL: GoalRecipe = {
  id: 'recipe-close-deal',
  name: 'Close a deal',
  description: 'Drive a deal to closed-won.',
  outcome: 'Close the {{account}} deal',
  doneWhen: { kind: 'query', query: { description: '{{account}} closed', predicate: { stage: 'closed-won', account: '{{account}}' } } },
  means: { workflowId: 'wf-follow-up' },
  budget: { maxIterations: 50 },
  vars: [{ name: 'account', required: true }],
}

describe('[COMP:goals/recipe] goal recipe instantiation', () => {
  it('substitutes {{var}} in strings, arrays, and nested objects', () => {
    expect(substituteVars('hi {{name}}', { name: 'Sam' })).toBe('hi Sam')
    expect(substituteVars(['{{a}}', '{{b}}'], { a: '1', b: '2' })).toEqual(['1', '2'])
    expect(substituteVars({ x: { y: '{{v}}' } }, { v: 'deep' })).toEqual({ x: { y: 'deep' } })
  })

  it('leaves an unknown placeholder verbatim (visible, not dropped)', () => {
    expect(substituteVars('hi {{missing}}', {})).toBe('hi {{missing}}')
  })

  it('does not mutate non-string leaves', () => {
    expect(substituteVars({ n: 42, b: true, z: null }, {})).toEqual({ n: 42, b: true, z: null })
  })

  it('instantiates into GoalCreateParams with the recipe_id link', () => {
    const params = instantiateGoalRecipe(CLOSE_DEAL, {
      workspaceId: 'w1',
      vars: { account: 'Acme' },
      host: { type: 'entity', id: 'deal-1' },
      createdByUserId: 'u1',
    })
    expect(params.outcome).toBe('Close the Acme deal')
    expect(params.doneWhen).toEqual({
      kind: 'query',
      query: { description: 'Acme closed', predicate: { stage: 'closed-won', account: 'Acme' } },
    })
    expect(params.recipeId).toBe('recipe-close-deal')
    expect(params.host).toEqual({ type: 'entity', id: 'deal-1' })
    expect(params.means).toEqual({ workflowId: 'wf-follow-up' })
    expect(params.budget).toEqual({ maxIterations: 50 })
    expect(params.workspaceId).toBe('w1')
    expect(params.status).toBe('active')
  })

  it('defaults to self-hosted when no host is given', () => {
    const params = instantiateGoalRecipe(CLOSE_DEAL, { workspaceId: 'w1', vars: { account: 'Acme' } })
    expect(params.host).toBeNull()
  })

  it('throws when a required var is missing', () => {
    expect(() => instantiateGoalRecipe(CLOSE_DEAL, { workspaceId: 'w1', vars: {} })).toThrow(
      GoalRecipeVarError,
    )
  })
})
