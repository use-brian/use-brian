/**
 * `finalizeProduct` workflow — product lock-in canonical workflow.
 *
 * Translates the worked example in `docs/plans/company-brain/approvals.md`
 * §381-405 into the V1 workflow primitives (`packages/core/src/workflow/`).
 *
 * Four sequential `tool_call` steps:
 *   1. createEntity (allow)    — create the product entity
 *   2. createEdge   (allow)    — link product → draft file via `documented_by`
 *   3. supersedeMemory (allow) — close open product-goal commitment memories
 *   4. githubWriteFile (ask)   — commit the finalized spec to the repo
 *
 * Step 1 stashes its output as `vars.entity`; step 2 references
 * `{{vars.entity.id}}` (the V1 idiom for the spec's pseudocode `$1.id`).
 *
 * Tool names use camelCase (the V1 schema's `toolName` regex rejects `:`).
 * All four tools are registered (WU-6.11): `createEntity` / `createEdge` /
 * `supersedeMemory` are first-party brain-write tools
 * (`packages/core/src/workflows/tools.ts`, added to the boot-time tool map);
 * `githubWriteFile` is a GitHub connector tool reached through the workflow
 * `tool_call` registry's MCP arm. The workflow is runnable once its
 * definition is seeded (WU-6.5).
 *
 * `permission_grants` lives on the sibling `workflows.permission_grants`
 * column (migration 123), not inside the `definition` JSON. The constant is
 * exported here so the workflow seed/import path can persist both pieces
 * together once WU-6.5 (grants evaluator) lands.
 *
 * [COMP:workflows/finalize-product]
 */

import { z } from 'zod'
import type { WorkflowDefinition } from '../workflow/types.js'

// ── Input ────────────────────────────────────────────────────────────────

/**
 * Variables interpolated as `{{input.X}}` in step arguments. Pass this into
 * `runStore.createRun({ input })` when kicking off the workflow.
 */
export const finalizeProductInputSchema = z.object({
  name: z.string().min(1).max(280),
  attributes: z.record(z.unknown()).default({}),
  draft_file_id: z.string().uuid(),
  commit_sha: z.string().min(7).max(64),
  owner: z.string().min(1),
  repo: z.string().min(1),
  path: z.string().min(1),
  body: z.string(),
})

export type FinalizeProductInput = z.infer<typeof finalizeProductInputSchema>

// ── Permission grants ────────────────────────────────────────────────────

export type WorkflowPermissionGrant = {
  action_kind: string
  grant: 'allow' | 'ask' | 'block'
}

/**
 * `action_kind` for the github step keeps the colon-namespaced spec form
 * (`'github:writeFile'`) — that field is free text and is what the future
 * grants evaluator (WU-6.5) matches against. The `toolName` in the step
 * below is the V1-legal camelCase identifier (`'githubWriteFile'`).
 */
export const finalizeProductPermissionGrants: ReadonlyArray<WorkflowPermissionGrant> = [
  { action_kind: 'createEntity', grant: 'allow' },
  { action_kind: 'createEdge', grant: 'allow' },
  { action_kind: 'supersedeMemory', grant: 'allow' },
  { action_kind: 'github:writeFile', grant: 'ask' },
]

// ── Workflow definition ──────────────────────────────────────────────────

export const FINALIZE_PRODUCT_WORKFLOW_NAME = 'finalizeProduct' as const

export const finalizeProductWorkflow: WorkflowDefinition = {
  startStepId: 'create_entity',
  steps: [
    {
      id: 'create_entity',
      type: 'tool_call',
      description: 'Create the product entity.',
      toolName: 'createEntity',
      arguments: {
        kind: 'product',
        name: '{{input.name}}',
        attributes: '{{input.attributes}}',
      },
      storeOutputAs: 'entity',
      nextStepId: 'create_edge',
    },
    {
      id: 'create_edge',
      type: 'tool_call',
      description: 'Link the product entity to its draft file.',
      toolName: 'createEdge',
      arguments: {
        source_kind: 'entity',
        source_id: '{{vars.entity.id}}',
        edge_type: 'documented_by',
        target_kind: 'file',
        target_id: '{{input.draft_file_id}}',
        attributes: { commit_sha: '{{input.commit_sha}}' },
      },
      nextStepId: 'supersede_goals',
    },
    {
      id: 'supersede_goals',
      type: 'tool_call',
      description: 'Close open product-goal commitment memories.',
      toolName: 'supersedeMemory',
      arguments: {
        tags: ['commitment:goal', 'commitment:open'],
      },
      nextStepId: 'github_write',
    },
    {
      id: 'github_write',
      type: 'tool_call',
      description: 'Commit the finalized product spec to the repo.',
      toolName: 'githubWriteFile',
      arguments: {
        owner: '{{input.owner}}',
        repo: '{{input.repo}}',
        path: '{{input.path}}',
        content: '{{input.body}}',
      },
      nextStepId: null,
    },
  ],
}
