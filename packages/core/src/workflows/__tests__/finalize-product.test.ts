import { describe, it, expect } from 'vitest'
import { WorkflowDefinitionSchema } from '../../workflow/schemas.js'
import type { ToolCallStep } from '../../workflow/types.js'
import {
  FINALIZE_PRODUCT_WORKFLOW_NAME,
  finalizeProductInputSchema,
  finalizeProductPermissionGrants,
  finalizeProductWorkflow,
  type FinalizeProductInput,
} from '../finalize-product.js'

const VALID_INPUT: FinalizeProductInput = {
  name: 'Pretext',
  attributes: { tagline: 'AI-native design tooling' },
  draft_file_id: '00000000-0000-0000-0000-000000000001',
  commit_sha: 'abc1234',
  owner: 'sidan-org',
  repo: 'pretext',
  path: 'specs/pretext.md',
  body: '# Pretext\n\nFinalized spec body.',
}

describe('[COMP:workflows/finalize-product] finalizeProduct workflow', () => {
  it('exports the canonical workflow name', () => {
    expect(FINALIZE_PRODUCT_WORKFLOW_NAME).toBe('finalizeProduct')
  })

  it('parses against the V1 WorkflowDefinitionSchema', () => {
    const result = WorkflowDefinitionSchema.safeParse(finalizeProductWorkflow)
    if (!result.success) {
      throw new Error(`schema parse failed: ${JSON.stringify(result.error.issues, null, 2)}`)
    }
    expect(result.success).toBe(true)
  })

  it('has exactly the four expected steps in order', () => {
    expect(finalizeProductWorkflow.startStepId).toBe('create_entity')
    expect(finalizeProductWorkflow.steps.map((s) => s.id)).toEqual([
      'create_entity',
      'create_edge',
      'supersede_goals',
      'github_write',
    ])
  })

  it('targets the camelCase tool names from the spec translation', () => {
    const toolNames = finalizeProductWorkflow.steps.map((s) => {
      expect(s.type).toBe('tool_call')
      return (s as ToolCallStep).toolName
    })
    expect(toolNames).toEqual([
      'createEntity',
      'createEdge',
      'supersedeMemory',
      'githubWriteFile',
    ])
  })

  it('terminates after the github write step', () => {
    const last = finalizeProductWorkflow.steps[finalizeProductWorkflow.steps.length - 1]
    expect(last.nextStepId).toBeNull()
  })

  it('stashes the entity output for downstream interpolation', () => {
    const createEntity = finalizeProductWorkflow.steps.find((s) => s.id === 'create_entity')!
    expect(createEntity.storeOutputAs).toBe('entity')
    const others = finalizeProductWorkflow.steps.filter((s) => s.id !== 'create_entity')
    for (const step of others) {
      expect(step.storeOutputAs).toBeUndefined()
    }
  })

  it('references vars.entity.id and the documented_by edge in the edge step', () => {
    const createEdge = finalizeProductWorkflow.steps.find((s) => s.id === 'create_edge') as ToolCallStep
    expect(createEdge.arguments.source_kind).toBe('entity')
    expect(createEdge.arguments.source_id).toBe('{{vars.entity.id}}')
    expect(createEdge.arguments.edge_type).toBe('documented_by')
    expect(createEdge.arguments.target_kind).toBe('file')
    expect(createEdge.arguments.target_id).toBe('{{input.draft_file_id}}')
    expect(createEdge.arguments.attributes).toEqual({ commit_sha: '{{input.commit_sha}}' })
  })

  it('routes input fields into the entity create step', () => {
    const createEntity = finalizeProductWorkflow.steps.find((s) => s.id === 'create_entity') as ToolCallStep
    expect(createEntity.arguments).toEqual({
      kind: 'product',
      name: '{{input.name}}',
      attributes: '{{input.attributes}}',
    })
  })

  it('filters open product-goal commitments in the supersede step', () => {
    const supersede = finalizeProductWorkflow.steps.find((s) => s.id === 'supersede_goals') as ToolCallStep
    expect(supersede.arguments).toEqual({
      tags: ['commitment:goal', 'commitment:open'],
    })
  })

  it('routes input fields into the github write step', () => {
    const githubWrite = finalizeProductWorkflow.steps.find((s) => s.id === 'github_write') as ToolCallStep
    expect(githubWrite.arguments).toEqual({
      owner: '{{input.owner}}',
      repo: '{{input.repo}}',
      path: '{{input.path}}',
      content: '{{input.body}}',
    })
  })
})

describe('[COMP:workflows/finalize-product] permission grants', () => {
  it('lists the four expected action kinds with the right grants', () => {
    expect(finalizeProductPermissionGrants).toEqual([
      { action_kind: 'createEntity', grant: 'allow' },
      { action_kind: 'createEdge', grant: 'allow' },
      { action_kind: 'supersedeMemory', grant: 'allow' },
      { action_kind: 'github:writeFile', grant: 'ask' },
    ])
  })

  it('keeps the external github write as ask even inside the workflow', () => {
    const github = finalizeProductPermissionGrants.find((g) => g.action_kind === 'github:writeFile')
    expect(github?.grant).toBe('ask')
  })

  it('auto-approves every internal substrate write', () => {
    const internal = finalizeProductPermissionGrants.filter((g) => g.action_kind !== 'github:writeFile')
    expect(internal.every((g) => g.grant === 'allow')).toBe(true)
  })
})

describe('[COMP:workflows/finalize-product] finalizeProductInputSchema', () => {
  it('accepts a valid input', () => {
    expect(finalizeProductInputSchema.safeParse(VALID_INPUT).success).toBe(true)
  })

  it('defaults attributes to an empty object when omitted', () => {
    const { attributes: _omit, ...withoutAttributes } = VALID_INPUT
    const parsed = finalizeProductInputSchema.parse(withoutAttributes)
    expect(parsed.attributes).toEqual({})
  })

  it('rejects empty name', () => {
    const result = finalizeProductInputSchema.safeParse({ ...VALID_INPUT, name: '' })
    expect(result.success).toBe(false)
  })

  it('rejects a malformed draft_file_id', () => {
    const result = finalizeProductInputSchema.safeParse({ ...VALID_INPUT, draft_file_id: 'not-a-uuid' })
    expect(result.success).toBe(false)
  })

  it('rejects a short commit_sha', () => {
    const result = finalizeProductInputSchema.safeParse({ ...VALID_INPUT, commit_sha: 'abc' })
    expect(result.success).toBe(false)
  })

  it('rejects missing required fields', () => {
    const { repo: _omit, ...withoutRepo } = VALID_INPUT
    const result = finalizeProductInputSchema.safeParse(withoutRepo)
    expect(result.success).toBe(false)
  })
})
