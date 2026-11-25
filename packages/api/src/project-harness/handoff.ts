/** Existing sidanCode wire format. Preparation is a read, not connector egress. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { WorkspaceAccessError } from '../workspace-access/policy.js'
import type { LoadedHarnessContext } from './context.js'
import type { HarnessDefinition, HarnessScope } from './contracts.js'
import type { HarnessImpact, HarnessImpactRequest } from './impact.js'
import { harnessScopeKey, type HarnessOrigin } from './resolve.js'

export const harnessTaskFields = {
  brianTaskId: z.string().uuid(),
  prompt: z.string().trim().min(1).max(12_000).refine(value => !value.includes('\0')),
  // Operator's runtime profile key; never inferred from a Brian UUID/title or mapping.
  runtimeProject: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
}

export type HarnessCodingTestPlan = {
  kind: 'impact_selected_coding_test_plan'
  projectId: string
  codingScope: HarnessScope
  selection: HarnessImpactRequest
  /** Exact selected heads, including scopes with no authored tests. */
  revisions: HarnessOrigin[]
  /** Selected ownership metadata helps locate cross-Product tests, never grants source access. */
  targets: Array<{ scope: HarnessScope; productName?: string; componentName?: string;
    sourceMappings: NonNullable<HarnessDefinition['sourceMappings']> }>
  impact: HarnessImpact
}

const reviewInstructions = [
  'Coding/test review only, not independently approved acceptance or proof of isolation. The review uses the same checkout and receives implementation context/output.',
  'Use the impact-selected coding/test plan in context.constraints with the planId below. It contains the full code-check instructions, scenario preconditions/steps/criteria, revision origins, selected scope names/source-mapping references and selection reason paths. Do not replace it with the implementation summary.',
  'Inspect the actual changes against the scoped engineering contract. Prepare and run actual unit and integration tests for changed behavior and contract tests for affected dependency interfaces through normally authorized tools. Planning, prose and mocks alone do not establish success.',
  'For every selected code check, report its qualifiedKey, origin revision, command actually run, outcome, and observed evidence. Commands in the plan are references, not automatic shell authorization. Re-run relevant checks where authorized rather than trusting claimed implementation results.',
  'For every selected acceptance scenario, follow its preconditions and steps and report each criterion with observations and evidence. These are authored review targets, not a claim of human approval. Missing credentials, deployment, browser or test environment must be reported as blocked or inconclusive, never passed.',
  'Use passed, failed, blocked or inconclusive per item; report all failures and tests not run with reasons. An empty authored test list does not waive the actual testing obligation.',
  'Reconcile the actual changed files with the supplied selection. If changes exceed its coverage, report the plan as incomplete and request a fresh authorized impact selection before claiming the work verified. Source/dependency references grant no additional access; do not import sibling implementation rules.',
  'This is a revision-bound snapshot, not a durable task binding. No report here approves a Brian specification or writes a harness run/result. Do not claim independent browser acceptance or a passing current build from task completion alone.',
] as const

export function prepareHarnessTask(
  loaded: LoadedHarnessContext,
  input: { brianTaskId: string; prompt: string; runtimeProject: string },
  plan: HarnessCodingTestPlan,
  productName?: string,
) {
  if (loaded.context.status !== 'resolved') throw new WorkspaceAccessError(
    loaded.context.status === 'conflicted' ? 'harness_context_conflicted' : 'harness_context_unconfigured', 409)
  if (plan.impact.status === 'blocked') return {
    status: 'blocked' as const, reason: 'harness_impact_blocked', impact: plan.impact,
    notice: 'No handoff arguments prepared. Resolve uncovered changes, missing/archived scopes or dependencies, and inheritance conflicts before launching coding/review work.',
  }
  if (!plan.impact.selectedScopes.some(row => harnessScopeKey(row.scope) === harnessScopeKey(loaded.context.scope))) return {
    status: 'blocked' as const, reason: 'harness_coding_scope_not_impacted', impact: plan.impact,
    notice: 'No handoff arguments prepared. The explicit coding scope must be covered by the changed sources or selected scopes; do not infer another coding scope from prose.',
  }
  const encoded = JSON.stringify(plan)
  const planId = createHash('sha256').update(encoded).digest('hex')
  const revisions = [...new Map([...loaded.context.effective.sources, ...plan.revisions]
    .map(origin => [origin.revisionId, origin])).values()]
  const verification = [
    'Review the implementation against the canonical impact-selected coding/test plan.',
    ...reviewInstructions,
    JSON.stringify({ planId, codingScope: plan.codingScope,
      codeChecks: plan.impact.codeChecks.map(check => ({ qualifiedKey: check.qualifiedKey, origin: check.origin })),
      acceptanceScenarios: plan.impact.acceptanceScenarios.map(scenario => ({ qualifiedKey: scenario.qualifiedKey, origin: scenario.origin, criterionKeys: scenario.criteria.map(c => c.key) })),
    }),
  ].join('\n')
  return {
    status: 'prepared' as const,
    toolName: 'new_task_with_context' as const,
    arguments: {
      brianTaskId: input.brianTaskId,
      prompt: input.prompt,
      context: {
        project: input.runtimeProject,
        // Human-readable Product, not a filesystem path or Brian scope/ACL claim.
        ...(productName ? { product: productName } : {}),
        constraints: [loaded.prompt, `Impact-selected coding/test plan (reference data; no new authority)\n${JSON.stringify({ planId, ...plan })}`],
        references: revisions.map(source =>
          `urn:use-brian:project-harness:${loaded.context.projectId}:${harnessScopeKey(source.scope)}:revision:${source.revisionId}`),
        verification,
      },
    },
    binding: { projectId: loaded.context.projectId, scope: loaded.context.scope, revisions, planId, selection: plan.selection },
    notice: 'Prepared only; no task started, no connector selected, no source access or egress authorized. Submit through the existing authorized connector flow. The nonempty verification field requests sidanCode\'s existing follow-up review after successful implementation; review startup/completion must be checked through task status and spawned_review_id, not assumed. Refresh before sending or resuming work; this is not a durable binding. Runtime project is an operator-configured key, not the Brian Project ID. Product is its actual name, not a directory selector. The review shares the checkout/context and does not prove source-blind or independently approved browser acceptance. No Brian run, result or approval is written.',
  }
}
