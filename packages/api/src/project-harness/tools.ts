/** Native read tools, also projected through the canonical MCP catalog/executor. */
import { z } from 'zod'
import { buildTool, estimateStringTokens, type Tool, type ToolContext } from '@use-brian/core'
import { runWithAgentAccess } from '../db/agent-access-context.js'
import { createProjectHarnessStore, readHarnessProjectSnapshot } from '../db/project-harness-store.js'
import { createHarnessExecutionStore } from '../db/project-harness-execution-store.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'
import { harnessDefinitionSchema, harnessScopeSchema, type HarnessScope, type ProjectHarnessStore } from './contracts.js'
import type { HarnessExecutionStore } from './execution-contracts.js'
import { changedHarnessSourceSchema, selectHarnessImpact } from './impact.js'
import { harnessScopeKey, scopeLineage } from './resolve.js'
import { assertHarnessReadCeiling, harnessScopeEvidence, loadHarnessContext, withHarnessReadAuthority } from './context.js'
import { harnessTaskFields, prepareHarnessTask } from './handoff.js'

const targetFields = { projectId: z.string().uuid().optional(), scope: harnessScopeSchema.default({ kind: 'project' }) }
const impactFields = {
  changedSources: z.array(changedHarnessSourceSchema).min(1).max(500).optional(),
  scopes: z.array(harnessScopeSchema).min(1).max(100).optional(),
}
const oneImpactMode = (input: { changedSources?: unknown; scopes?: unknown }) => !(input.changedSources && input.scopes)
export const getProjectHarnessContextSchema = z.object(targetFields).strict()
export const prepareProjectHarnessTaskSchema = z.object({ ...targetFields, ...harnessTaskFields, ...impactFields })
  .strict().refine(oneImpactMode, 'Choose changedSources or scopes, not both')
export const listProjectHarnessScopesSchema = z.object(targetFields).strict()
export const selectProjectHarnessTestsSchema = z.object({ ...targetFields, ...impactFields })
  .strict().refine(oneImpactMode, 'Choose changedSources or scopes, not both')
export const getProjectHarnessAcceptanceSchema = z.object({
  ...targetFields, approvalId: z.string().uuid().optional(),
  scenarioKey: z.string().regex(/^[a-z][a-z0-9._-]{0,99}$/).optional(), includeRuns: z.boolean().default(false),
}).strict()

export type ProjectHarnessToolsOptions = {
  store?: Pick<ProjectHarnessStore, 'lineage' | 'tree' | 'definition' | 'history'>
  execution?: Pick<HarnessExecutionStore, 'approvals' | 'runs'>
  snapshot?: typeof readHarnessProjectSnapshot
}
type TargetInput = { projectId?: string; scope: HarnessScope }

/** Identity comes only from authenticated host context, never the billed owner or arguments. */
function actor(context: ToolContext, input: TargetInput) {
  const ec = context.executionContext
  const userId = ec?.security.access.userId ?? context.workspaceActorUserId ?? context.programmaticPrincipal?.userId
  const projectId = input.projectId ?? context.activeProjectId
  if (context.systemRead || ec?.surface.systemRead || ec?.identity.kind === 'system' || !userId || !context.workspaceId) {
    throw new WorkspaceAccessError('harness_actor_required', 403)
  }
  if (ec && (ec.identity.kind === 'attended' && ec.identity.principal.kind !== 'workspace_member'
    || ec.identity.kind === 'programmatic' && !['brain_key', 'assistant_key', 'oauth_token', 'home_app'].includes(ec.identity.principal.kind)
    || ec.ownership.kind !== 'workspace' || ec.ownership.workspaceId !== context.workspaceId
    || ec.security.access.workspaceId !== context.workspaceId || ec.security.access.userId !== context.userId
    || ec.security.access.assistantId !== context.assistantId || ec.security.authority !== context.authority
    || ec.identity.kind === 'programmatic' && ec.identity.principal.actorUserId !== userId)) {
    throw new WorkspaceAccessError('harness_authority_required', 403)
  }
  if (!context.authority) throw new WorkspaceAccessError('harness_authority_required', 403)
  if (!projectId) throw new WorkspaceAccessError('harness_project_required', 400)
  const ids = z.object({ userId: z.string().uuid(), workspaceId: z.string().uuid(), projectId: z.string().uuid() })
    .parse({ userId, workspaceId: context.workspaceId, projectId })
  return { ...ids, scope: input.scope, authority: context.authority }
}
const failure = (error: unknown) => ({ isError: true, data: { error: error instanceof WorkspaceAccessError ? error.code
  : error instanceof z.ZodError ? 'harness_invalid_input' : 'harness_unavailable' } })

/** Canonical access is intersected with any parent execution, never widened. */
export function createProjectHarnessTools(options: ProjectHarnessToolsOptions = {}): Tool[] {
  const store = options.store ?? createProjectHarnessStore()
  const execution = options.execution ?? createHarnessExecutionStore()
  const snapshot = options.snapshot ?? readHarnessProjectSnapshot
  async function read<T>(input: TargetInput, context: ToolContext, work: (a: ReturnType<typeof actor>) => Promise<T>) {
    try {
      const a = actor(context, input)
      const guarded = () => withHarnessReadAuthority(a.authority, async () => {
        assertHarnessReadCeiling(a.userId, a.workspaceId, a.projectId)
        const scopeEvidence = harnessScopeEvidence(a.projectId)
        context.scopeAccumulator?.note(scopeEvidence)
        const data = await work(a)
        // Check the exact native success serialization, including repeated prompt
        // JSON and CJK. Stay below the executor's universal 25k-token cap.
        const encoded = JSON.stringify(data)
        if (encoded.length > 60_000 || estimateStringTokens(encoded) > 24_000) {
          throw new WorkspaceAccessError('harness_context_too_large', 503)
        }
        return { data, scopeEvidence }
      })
      return await (context.executionContext ? runWithAgentAccess(context.executionContext.security.access, guarded) : guarded())
    } catch (error) { return failure(error) }
  }
  return [buildTool({
    name: 'getProjectHarnessContext',
    description: 'Read the effective Project → Product → Component engineering contract and a canonical prompt for coding agents. Defaults to the active Project and project scope. Includes lineage/provenance, conflicts, actual unit/integration test obligations and exact-target source/dependency references only. References grant no source access. Does not execute code checks or approve anything.',
    inputSchema: getProjectHarnessContextSchema, isReadOnly: true, isConcurrencySafe: true,
    async execute(raw, context) {
      try {
        const input = getProjectHarnessContextSchema.parse(raw)
        return await read(input, context, async a => {
          const loaded = await loadHarnessContext({ ...a, store, scopeAccumulator: context.scopeAccumulator })
          return { context: loaded.context, prompt: loaded.prompt }
        })
      } catch (error) { return failure(error) }
    },
  }), buildTool({
    name: 'prepareProjectHarnessTask',
    description: 'Prepare exact new_task_with_context arguments for the existing sidanCode MCP connector from one fresh authorized Project snapshot. Supply the coding prompt, explicit runtimeProject key (NOT a Brian UUID), explicit coding scope, and changedSources OR scopes for impact selection (defaults to coding scope). Includes scoped constraints, impacted ancestor/reverse-dependent checks and scenarios with reasons/revisions, actual Product name, and nonempty verification for Sidan follow-up review. Blocked/uncovered/conflicted plans produce no runnable arguments. Review is not human approval or source-blind acceptance. Does not launch, authorize egress, copy hidden history or write results. Refresh before sending/resuming.',
    inputSchema: prepareProjectHarnessTaskSchema, isReadOnly: true, isConcurrencySafe: true,
    async execute(raw, context) {
      try {
        const input = prepareProjectHarnessTaskSchema.parse(raw)
        return await read(input, context, async a => {
          // One actor-bound repeatable-read snapshot supplies BOTH implementation
          // lineage and impacted tests; never mix heads from separate store reads.
          const current = await snapshot(a.userId, a.workspaceId, a.projectId)
          const selection = input.changedSources ? { changedSources: input.changedSources } : { scopes: input.scopes ?? [a.scope] }
          const impact = selectHarnessImpact({ workspaceId: a.workspaceId, projectId: a.projectId }, current, selection)
          const lineageKeys = new Set(scopeLineage(a.scope).map(harnessScopeKey))
          const loaded = await loadHarnessContext({ ...a, scopeAccumulator: context.scopeAccumulator,
            store: { lineage: async () => current.revisions.filter(row => lineageKeys.has(harnessScopeKey(row.scope))) },
          })
          const selectedKeys = new Set(impact.selectedScopes.map(row => harnessScopeKey(row.scope)))
          const revisions = current.revisions.filter(row => selectedKeys.has(harnessScopeKey(row.scope)))
            .map(row => ({ scope: row.scope, revisionId: row.id, revision: row.revision }))
            .sort((a, b) => harnessScopeKey(a.scope).localeCompare(harnessScopeKey(b.scope)))
          const productNameFor = (scope: HarnessScope) => scope.kind === 'project' ? undefined
            : current.tree.products.find(row => row.id === scope.productId)?.name
          const targets = impact.selectedScopes.map(({ scope }) => ({
            scope,
            ...(scope.kind !== 'project' ? { productName: productNameFor(scope) } : {}),
            ...(scope.kind === 'component' ? { componentName: current.tree.components.find(row => row.id === scope.componentId && row.productId === scope.productId)?.name } : {}),
            sourceMappings: current.revisions.find(row => harnessScopeKey(row.scope) === harnessScopeKey(scope))?.definition.sourceMappings ?? [],
          }))
          return prepareHarnessTask(loaded, input, {
            kind: 'impact_selected_coding_test_plan', projectId: a.projectId, codingScope: a.scope,
            selection, revisions, targets, impact,
          }, productNameFor(a.scope))
        })
      } catch (error) { return failure(error) }
    },
  }), buildTool({
    name: 'listProjectHarnessScopes',
    description: 'List engineering scope metadata in an authorized shared Project, optionally within an explicit product/component. Defaults to active Project and project scope. Does not read definitions, repositories, or dependency bodies; scope membership grants no source access.',
    inputSchema: listProjectHarnessScopesSchema, isReadOnly: true, isConcurrencySafe: true,
    async execute(raw, context) {
      try {
        const input = listProjectHarnessScopesSchema.parse(raw)
        return await read(input, context, async a => {
          const tree = await store.tree(a.userId, a.workspaceId, a.projectId)
          if ([...tree.products, ...tree.components].some(n => n.workspaceId !== a.workspaceId || n.projectId !== a.projectId)) {
            throw new WorkspaceAccessError('harness_unavailable', 503)
          }
          const scope = a.scope
          if (scope.kind !== 'project' && !tree.products.some(n => n.id === scope.productId && n.status === 'active')
            || scope.kind === 'component' && !tree.components.some(n => n.id === scope.componentId && n.productId === scope.productId && n.status === 'active')) {
            throw new WorkspaceAccessError('harness_not_found', 404)
          }
          const products = tree.products.filter(n => scope.kind === 'project' || n.id === scope.productId)
          const components = tree.components.filter(n => scope.kind === 'project' || n.productId === scope.productId && (scope.kind !== 'component' || n.id === scope.componentId))
          return { projectId: a.projectId, scope, scopes: [
            ...(scope.kind === 'project' ? [{ scope: { kind: 'project' as const } }] : []),
            ...products.filter(() => scope.kind !== 'component').map(n => ({ scope: { kind: 'product' as const, productId: n.id }, name: n.name, status: n.status, revision: n.revision })),
            ...components.map(n => ({ scope: { kind: 'component' as const, productId: n.productId, componentId: n.id }, name: n.name, status: n.status, revision: n.revision })),
          ] }
        })
      } catch (error) { return failure(error) }
    },
  }), buildTool({
    name: 'selectProjectHarnessTests',
    description: 'Plan code checks and acceptance scenarios from a server-owned Project snapshot using changedSources or explicit scopes (defaults to the target scope). Includes ancestor/reverse-dependency reasons, conflicts and uncovered changes. Structural readiness is not approval, execution, freshness, or a passing result. Never executes commands or fetches source code.',
    inputSchema: selectProjectHarnessTestsSchema, isReadOnly: true, isConcurrencySafe: true,
    async execute(raw, context) {
      try {
        const input = selectProjectHarnessTestsSchema.parse(raw)
        return await read(input, context, async a => ({ impact: selectHarnessImpact(
          { workspaceId: a.workspaceId, projectId: a.projectId }, await snapshot(a.userId, a.workspaceId, a.projectId),
          input.changedSources ? { changedSources: input.changedSources } : { scopes: input.scopes ?? [a.scope] },
        ), notice: 'Planning only. No commands executed; no approval, passing tests, source ACL grants, freshness or isolation established.' }))
      } catch (error) { return failure(error) }
    },
  }), buildTool({
    name: 'getProjectHarnessAcceptance',
    description: 'Read acceptance scenarios from a server revision with a persisted approval, optionally selecting a scenario key and run metadata. Without approvalId, uses the current target revision only if approved; with approvalId, reads that exact historical revision. Returns no implementation rules, code-check commands or implementation prompt. Historical approval/run metadata does not prove freshness, isolated execution or a passing current build. This tool cannot approve or write.',
    inputSchema: getProjectHarnessAcceptanceSchema, isReadOnly: true, isConcurrencySafe: true,
    async execute(raw, context) {
      try {
        const input = getProjectHarnessAcceptanceSchema.parse(raw)
        return await read(input, context, async a => {
          const guarded = <T>(work: () => Promise<T>) => withHarnessReadAuthority(a.authority, work)
          const approvals = await guarded(() => execution.approvals(a.userId, a.workspaceId, a.projectId, a.scope))
          if (approvals.some(row => row.workspaceId !== a.workspaceId || row.projectId !== a.projectId)) throw new WorkspaceAccessError('harness_unavailable', 503)
          const pinned = input.approvalId ? approvals.find(row => row.id === input.approvalId) : undefined
          if (input.approvalId && !pinned) throw new WorkspaceAccessError('harness_not_found', 404)
          const revision = pinned
            ? (await guarded(() => store.history(a.userId, a.workspaceId, a.projectId, a.scope))).find(row => row.id === pinned.revisionId)
            : await guarded(() => store.definition(a.userId, a.workspaceId, a.projectId, a.scope))
          if (revision && (revision.workspaceId !== a.workspaceId || revision.projectId !== a.projectId || harnessScopeKey(revision.scope) !== harnessScopeKey(a.scope))) {
            throw new WorkspaceAccessError('harness_unavailable', 503)
          }
          const approval = pinned ?? approvals.find(row => row.revisionId === revision?.id)
          if (!revision || !approval) return { status: 'unavailable' as const, reason: 'approved_revision_unavailable', scenarios: [] }
          const definition = harnessDefinitionSchema.parse(revision.definition)
          const scenarios = definition.acceptanceScenarios.filter(s => !input.scenarioKey || s.key === input.scenarioKey)
          if (input.scenarioKey && !scenarios.length) throw new WorkspaceAccessError('harness_not_found', 404)
          const runs = input.includeRuns ? await guarded(() => execution.runs(a.userId, a.workspaceId, a.projectId, a.scope)) : undefined
          if (runs?.some(row => row.workspaceId !== a.workspaceId || row.projectId !== a.projectId)) throw new WorkspaceAccessError('harness_unavailable', 503)
          return {
            status: 'available' as const, projectId: a.projectId, scope: a.scope,
            revision: { id: revision.id, revision: revision.revision, createdAt: revision.createdAt }, approval, scenarios,
            ...(runs ? { runs: runs.filter(r => r.revisionId === revision.id && r.approvalId === approval.id).map(r => ({
              id: r.id, approvalId: r.approvalId, revisionId: r.revisionId, executor: r.executor, status: r.status,
              createdAt: r.createdAt, startedAt: r.startedAt, expiresAt: r.expiresAt, completedAt: r.completedAt,
            })) } : {}),
            notice: 'Persisted review and run metadata only; no claim of freshness, isolated execution, source access, or current build success. No implementation prompt is included.',
          }
        })
      } catch (error) { return failure(error) }
    },
  })]
}
