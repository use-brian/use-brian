/**
 * KB self-maintain agents — per-source maintenance config + the
 * system-managed workflow it materializes (migration 411).
 *
 * A maintenance agent is a row in `kb_maintenance_agents` (the anti-slop
 * contract: charter, path scope, signals, update-over-create threshold,
 * style contract, sensitivity ceiling, weekly proposal budget) plus ONE
 * materialized workflow (`workflows.managed_by = 'knowledge'`). The
 * workflow is ordinary executor machinery end to end:
 *
 *   kbm-judge (assistant_call, primary, strict-JSON verdict)
 *     → kbm-has-proposal (branch: action ∈ update|create)
 *       → kbm-kind (branch: update vs create)
 *         → kbm-write-update / kbm-write-create (tool_call — pauses into
 *           the Approvals inbox via the executor's `workflow_step` approval)
 *
 * Suggestion-first is therefore not new enforcement — both write tools carry
 * `requiresConfirmation` and the workflow tool registry keeps that visible
 * (`keepBuiltinsDirect`), so every proposal parks for a human. The weekly
 * budget is enforced mechanically at the event-dispatch run starter
 * (`kbMaintenanceRunGuard`), counting attempted write steps in the trailing
 * 7 days; the sensitivity ceiling and similarity threshold are judge-prompt
 * contracts (the approval card shows the stamped tier, and the accumulator
 * can only ever raise it).
 *
 * Spec: docs/architecture/features/knowledge-base.md → "Self-maintain
 * agents". [COMP:knowledge/maintenance]
 */

import { z } from 'zod'
import type { Sensitivity, WorkflowDefinition, WorkflowTrigger } from '@use-brian/core'
import { query } from '../db/client.js'

// ── Step-id constants ──────────────────────────────────────────
// The budget guard counts step runs by these ids — keep them stable.

export const KBM_STEP_JUDGE = 'kbm-judge'
export const KBM_STEP_HAS_PROPOSAL = 'kbm-has-proposal'
export const KBM_STEP_KIND = 'kbm-kind'
export const KBM_STEP_WRITE_UPDATE = 'kbm-write-update'
export const KBM_STEP_WRITE_CREATE = 'kbm-write-create'

/** Step ids that constitute an attempted proposal (budget accounting). */
export const KBM_WRITE_STEP_IDS = [KBM_STEP_WRITE_UPDATE, KBM_STEP_WRITE_CREATE] as const

// ── Types ──────────────────────────────────────────────────────

export type KbMaintenanceSignals =
  | { mode: 'events' }
  | { mode: 'daily'; time: string }

export type KbMaintenanceAgent = {
  id: string
  workspaceId: string
  sourceId: string
  workflowId: string | null
  enabled: boolean
  charter: string
  pathScope: string[]
  signals: KbMaintenanceSignals
  similarityThreshold: number
  styleContract: string
  sensitivityCeiling: Sensitivity
  weeklyProposalBudget: number
  createdBy: string | null
  createdAt: Date
  updatedAt: Date
}

/** PUT-body contract — every anti-slop field is mandatory. */
export const KbMaintenanceConfigSchema = z.object({
  enabled: z.boolean().default(true),
  charter: z.string().trim().min(40, 'charter must be at least 40 characters'),
  pathScope: z.array(z.string().trim().min(1)).min(1, 'at least one path prefix is required').max(20),
  signals: z.union([
    z.object({ mode: z.literal('events') }),
    z.object({ mode: z.literal('daily'), time: z.string().regex(/^\d{2}:\d{2}$/, 'time must be HH:MM') }),
  ]),
  similarityThreshold: z.number().gt(0).lte(1).default(0.8),
  styleContract: z.string().trim().min(20, 'styleContract must be at least 20 characters'),
  sensitivityCeiling: z.enum(['public', 'internal', 'confidential']).default('internal'),
  weeklyProposalBudget: z.number().int().min(1).max(100).default(5),
})

export type KbMaintenanceConfig = z.infer<typeof KbMaintenanceConfigSchema>

// ── Store ──────────────────────────────────────────────────────

const AGENT_COLUMNS = `
  id, workspace_id AS "workspaceId", source_id AS "sourceId",
  workflow_id AS "workflowId", enabled,
  charter, path_scope AS "pathScope", signals,
  similarity_threshold AS "similarityThreshold",
  style_contract AS "styleContract",
  sensitivity_ceiling AS "sensitivityCeiling",
  weekly_proposal_budget AS "weeklyProposalBudget",
  created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"
` as const

export type KbMaintenanceStore = {
  getBySource(sourceId: string): Promise<KbMaintenanceAgent | null>
  listByWorkspace(workspaceId: string): Promise<KbMaintenanceAgent[]>
  upsert(params: {
    workspaceId: string
    sourceId: string
    workflowId: string | null
    config: KbMaintenanceConfig
    createdBy: string
  }): Promise<KbMaintenanceAgent>
  setWorkflowId(id: string, workflowId: string | null): Promise<void>
  deleteBySource(sourceId: string): Promise<boolean>
  /**
   * Budget accounting for the run-starter guard: how many write steps
   * (attempted proposals) this workflow started in the trailing 7 days.
   */
  countRecentProposalAttempts(workflowId: string): Promise<number>
  /** The guard's config read — null when the workflow is not KB-managed. */
  getByWorkflowId(workflowId: string): Promise<KbMaintenanceAgent | null>
}

export function createDbKbMaintenanceStore(): KbMaintenanceStore {
  return {
    async getBySource(sourceId) {
      const result = await query<KbMaintenanceAgent>(
        `SELECT ${AGENT_COLUMNS} FROM kb_maintenance_agents WHERE source_id = $1`,
        [sourceId],
      )
      return result.rows[0] ?? null
    },

    async listByWorkspace(workspaceId) {
      const result = await query<KbMaintenanceAgent>(
        `SELECT ${AGENT_COLUMNS} FROM kb_maintenance_agents WHERE workspace_id = $1 ORDER BY created_at ASC`,
        [workspaceId],
      )
      return result.rows
    },

    async upsert({ workspaceId, sourceId, workflowId, config, createdBy }) {
      const result = await query<KbMaintenanceAgent>(
        `INSERT INTO kb_maintenance_agents
           (workspace_id, source_id, workflow_id, enabled, charter, path_scope, signals,
            similarity_threshold, style_contract, sensitivity_ceiling, weekly_proposal_budget, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (source_id) DO UPDATE SET
           workflow_id = EXCLUDED.workflow_id,
           enabled = EXCLUDED.enabled,
           charter = EXCLUDED.charter,
           path_scope = EXCLUDED.path_scope,
           signals = EXCLUDED.signals,
           similarity_threshold = EXCLUDED.similarity_threshold,
           style_contract = EXCLUDED.style_contract,
           sensitivity_ceiling = EXCLUDED.sensitivity_ceiling,
           weekly_proposal_budget = EXCLUDED.weekly_proposal_budget,
           updated_at = now()
         RETURNING ${AGENT_COLUMNS}`,
        [
          workspaceId, sourceId, workflowId, config.enabled, config.charter,
          config.pathScope, JSON.stringify(config.signals), config.similarityThreshold,
          config.styleContract, config.sensitivityCeiling, config.weeklyProposalBudget,
          createdBy,
        ],
      )
      return result.rows[0]
    },

    async setWorkflowId(id, workflowId) {
      await query(
        `UPDATE kb_maintenance_agents SET workflow_id = $1, updated_at = now() WHERE id = $2`,
        [workflowId, id],
      )
    },

    async deleteBySource(sourceId) {
      const result = await query(
        `DELETE FROM kb_maintenance_agents WHERE source_id = $1`,
        [sourceId],
      )
      return (result.rowCount ?? 0) > 0
    },

    async countRecentProposalAttempts(workflowId) {
      const result = await query<{ count: string }>(
        `SELECT COUNT(*) AS count
         FROM workflow_step_runs sr
         JOIN workflow_runs r ON r.id = sr.run_id
         WHERE r.workflow_id = $1
           AND sr.step_id = ANY($2::text[])
           AND sr.started_at > now() - interval '7 days'`,
        [workflowId, [...KBM_WRITE_STEP_IDS]],
      )
      return Number(result.rows[0]?.count ?? 0)
    },

    async getByWorkflowId(workflowId) {
      const result = await query<KbMaintenanceAgent>(
        `SELECT ${AGENT_COLUMNS} FROM kb_maintenance_agents WHERE workflow_id = $1`,
        [workflowId],
      )
      return result.rows[0] ?? null
    },
  }
}

// ── Run-starter budget guard ───────────────────────────────────

/**
 * Called by the event-dispatch run starter (boot) before creating a run.
 * Non-KB-managed workflows pass through on one indexed read. A managed
 * workflow over its weekly proposal budget — or whose agent is disabled —
 * is skipped (the skip is logged by the caller; the 7-day window slides,
 * so it self-heals with no ceremony).
 */
export async function kbMaintenanceRunGuard(
  store: KbMaintenanceStore,
  workflowId: string,
): Promise<{ skip: boolean; reason?: string }> {
  const agent = await store.getByWorkflowId(workflowId)
  if (!agent) return { skip: false }
  if (!agent.enabled) return { skip: true, reason: 'maintenance agent disabled' }
  const attempts = await store.countRecentProposalAttempts(workflowId)
  if (attempts >= agent.weeklyProposalBudget) {
    return {
      skip: true,
      reason: `weekly proposal budget reached (${attempts}/${agent.weeklyProposalBudget} in the last 7 days)`,
    }
  }
  return { skip: false }
}

// ── Workflow materializer ──────────────────────────────────────

/** The source slice the materializer reads. */
export type MaintenanceSourceRef = {
  id: string
  repo: string
  rootPath: string
  sourceType: 'github' | 'local'
}

function judgePrompt(config: KbMaintenanceConfig, source: MaintenanceSourceRef): string {
  const scopeList = config.pathScope.map((p) => `"${p}"`).join(', ')
  const pct = Math.round(config.similarityThreshold * 100)
  return [
    `You are the knowledge-base maintenance agent for the source "${source.repo}".`,
    '',
    '# Charter',
    config.charter,
    '',
    '# Scope',
    `You may only propose changes to knowledge entries whose path starts with one of: ${scopeList}. Anything outside these prefixes is out of bounds - never propose a change to it.`,
    '',
    '# Trigger',
    'A knowledge signal fired (empty on a scheduled review). Payload:',
    '{{input.event}}',
    '',
    '# Your job',
    '1. Read first: search the workspace knowledge base and read the entries the signal touches before judging anything.',
    '2. Decide whether a change genuinely serves the charter. Most signals need NO change - "none" is the default answer, not a failure.',
    `3. Update over create: before proposing a NEW entry, search for existing entries on the topic. If an existing in-scope entry covers roughly ${pct}% or more of the same ground, propose an update to it instead of creating a near-duplicate.`,
    '4. Style contract for any body you write:',
    config.styleContract,
    `5. Sensitivity ceiling: never assign a tier above "${config.sensitivityCeiling}". If serving the charter would require writing above that tier, answer "none" and say why.`,
    `6. Budget: this agent may attempt at most ${config.weeklyProposalBudget} proposals per rolling 7 days. Only propose changes with clear, durable value.`,
    '',
    '# Output (STRICT)',
    'Reply with ONLY one JSON object - no code fences, no prose before or after:',
    '- No change needed: {"action":"none","reason":"<one line>"}',
    '- Update an existing entry: {"action":"update","id":"<entry uuid you read this turn>","content":"<complete replacement body in markdown, no frontmatter>","changeSummary":"<one line>"}',
    `- Create a new entry: {"action":"create","path":"<path under one of the allowed prefixes>","title":"<title>","content":"<body in markdown, no frontmatter>","sensitivity":"<public, internal, or confidential - at or below ${config.sensitivityCeiling}>"}`,
    'The "content" field must be the FULL body. Never invent an entry id.',
  ].join('\n')
}

/**
 * Pure materializer: config + source → the managed workflow's name,
 * description, definition, and trigger. Re-run on every config edit; the
 * caller writes the result through the workflow store.
 */
export function buildMaintenanceWorkflow(
  config: KbMaintenanceConfig,
  source: MaintenanceSourceRef,
): {
  name: string
  description: string
  definition: WorkflowDefinition
  trigger: WorkflowTrigger
} {
  const definition: WorkflowDefinition = {
    startStepId: KBM_STEP_JUDGE,
    steps: [
      {
        id: KBM_STEP_JUDGE,
        type: 'assistant_call',
        description: 'Judge the signal against the charter',
        target: { assistantId: 'primary' },
        prompt: judgePrompt(config, source),
        storeOutputAs: 'verdict',
        nextStepId: KBM_STEP_HAS_PROPOSAL,
      },
      {
        id: KBM_STEP_HAS_PROPOSAL,
        type: 'branch',
        description: 'Did the judge propose a change?',
        condition: { in: [{ var: 'vars.verdict.action' }, ['update', 'create']] },
        nextStepIdIfTrue: KBM_STEP_KIND,
        nextStepIdIfFalse: null,
      },
      {
        id: KBM_STEP_KIND,
        type: 'branch',
        description: 'Update an existing entry, or create a new one?',
        condition: { '==': [{ var: 'vars.verdict.action' }, 'update'] },
        nextStepIdIfTrue: KBM_STEP_WRITE_UPDATE,
        nextStepIdIfFalse: KBM_STEP_WRITE_CREATE,
      },
      {
        id: KBM_STEP_WRITE_UPDATE,
        type: 'tool_call',
        description: 'Propose the update (pauses for approval)',
        toolName: 'updateKnowledgeEntry',
        arguments: {
          id: '{{vars.verdict.id}}',
          content: '{{vars.verdict.content}}',
          changeSummary: '{{vars.verdict.changeSummary}}',
        },
        nextStepId: null,
      },
      {
        id: KBM_STEP_WRITE_CREATE,
        type: 'tool_call',
        description: 'Propose the new entry (pauses for approval)',
        toolName: 'addKnowledgeEntry',
        arguments: {
          path: '{{vars.verdict.path}}',
          title: '{{vars.verdict.title}}',
          content: '{{vars.verdict.content}}',
          sensitivity: '{{vars.verdict.sensitivity}}',
          // Static disambiguation: a workspace with several writable sources
          // must not let the judge pick a different repo than the one this
          // agent is configured for.
          repo: source.repo,
        },
        nextStepId: null,
      },
    ],
  }

  const trigger: WorkflowTrigger =
    config.signals.mode === 'daily'
      ? { kind: 'schedule', schedule: { type: 'daily', time: config.signals.time }, mode: 'local' }
      : { kind: 'event', event: { sources: [{ source: { type: 'knowledge' } }] } }

  return {
    name: `KB maintenance: ${source.repo}`,
    description:
      'Managed by Studio - Knowledge (self-maintain). Edit its configuration on the knowledge source, not in the builder.',
    definition,
    trigger,
  }
}
