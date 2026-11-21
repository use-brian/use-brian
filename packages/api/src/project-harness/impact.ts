/** Pure impact planning over an already-authorized, complete Project snapshot.
 * Metadata never grants repository access, execution authority or test approval.
 * Reverse dependencies select additional scopes; they NEVER inherit sibling rules.
 */
import { z } from 'zod'
import {
  harnessDefinitionSchema, harnessRepositorySchema, harnessScopeSchema, harnessSourcePathSchema,
  type HarnessDefinition, type HarnessProjectSnapshot, type HarnessRevision, type HarnessScope,
} from './contracts.js'
import { harnessScopeKey, resolveHarness, scopeLineage, type HarnessConflict, type HarnessOrigin } from './resolve.js'

export const changedHarnessSourceSchema = z.object({ repository: harnessRepositorySchema, path: harnessSourcePathSchema }).strict()
/** HTTP body: exactly one mode, never caller-supplied definitions/tree/authority. */
export const impactRequestSchema = z.union([
  z.object({ changedSources: z.array(changedHarnessSourceSchema).min(1).max(500) }).strict(),
  z.object({ scopes: z.array(harnessScopeSchema).min(1).max(100) }).strict(),
])
export type HarnessImpactRequest = z.infer<typeof impactRequestSchema>
export type ChangedHarnessSource = z.infer<typeof changedHarnessSourceSchema>
export type HarnessImpactReasonPath = {
  seed: { kind: 'source'; source: ChangedHarnessSource } | { kind: 'scope'; scope: HarnessScope }
  steps: Array<{ kind: 'source_mapping' | 'changed_scope' | 'ancestor' | 'reverse_dependency'; scope: HarnessScope; contract?: string }>
}
type SelectedTest<T> = T & { qualifiedKey: string; origin: HarnessOrigin; reasonPaths: HarnessImpactReasonPath[] }
export type HarnessImpact = {
  /** Readiness is structural planning only, NOT approval/pass/permission to execute. */
  status: 'ready' | 'blocked'
  selectedScopes: Array<{ scope: HarnessScope; reasonPaths: HarnessImpactReasonPath[] }>
  codeChecks: Array<SelectedTest<HarnessDefinition['codeChecks'][number]>>
  acceptanceScenarios: Array<SelectedTest<HarnessDefinition['acceptanceScenarios'][number]>>
  uncovered: Array<{ kind: 'source'; source: ChangedHarnessSource; reason: 'no_source_mapping' }
    | { kind: 'scope'; scope: HarnessScope; reason: 'missing_or_archived_scope' }>
  unresolvedDependencies: Array<{ origin: HarnessOrigin; target: HarnessScope; contract: string; reason: 'missing_or_archived_scope' }>
  conflicts: Array<{ scope: HarnessScope; conflict: HarnessConflict }>
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const scopeKey = (scope: HarnessScope) => harnessScopeKey(scope).toLowerCase()
function normalizedScope(input: HarnessScope): HarnessScope {
  const scope = harnessScopeSchema.parse(input)
  return scope.kind === 'project' ? scope : scope.kind === 'product'
    ? { kind: 'product', productId: scope.productId.toLowerCase() }
    : { kind: 'component', productId: scope.productId.toLowerCase(), componentId: scope.componentId.toLowerCase() }
}
const originOf = (r: HarnessRevision): HarnessOrigin => ({ revisionId: r.id, revision: r.revision, scope: r.scope })
function invalid(): never { throw new Error('harness_impact_snapshot_invalid') }

/**
 * The caller must supply the COMPLETE authorized tree and exactly one current
 * revision for each defined scope from a consistent snapshot. Completeness and
 * currentness cannot be proven by a pure function. Foreign rows, wrong ancestry
 * and duplicate heads are rejected, never treated as additional authority.
 *
 * Ancestors and transitive reverse dependencies participate in one graph.
 * No implicit descendant/sibling selection. Each seed records a deterministic
 * shortest reason path per reached scope (not exponentially many cycle paths).
 * Unresolved references anywhere in the active graph block readiness because
 * they make impact selection incomplete. Rule conflicts concern selected lineages.
 */
export function selectHarnessImpact(
  target: { workspaceId: string; projectId: string }, snapshot: HarnessProjectSnapshot, input: HarnessImpactRequest,
): HarnessImpact {
  const { workspaceId, projectId } = z.object({ workspaceId: z.string().uuid(), projectId: z.string().uuid() }).strict().parse(target)
  const request = impactRequestSchema.parse(input)
  const scopes = new Map<string, { scope: HarnessScope; active: boolean }>([['project', { scope: { kind: 'project' }, active: true }]])
  const ids = new Set<string>([projectId.toLowerCase()])
  const products = new Map<string, boolean>()
  for (const node of snapshot.tree.products) {
    if (node.workspaceId !== workspaceId || node.projectId !== projectId || !z.string().uuid().safeParse(node.id).success
      || ids.has(node.id.toLowerCase()) || !['active', 'archived'].includes(node.status)) invalid()
    const id = node.id.toLowerCase(); ids.add(id); products.set(id, node.status === 'active')
    const scope: HarnessScope = { kind: 'product', productId: id }
    scopes.set(scopeKey(scope), { scope, active: node.status === 'active' })
  }
  for (const node of snapshot.tree.components) {
    if (node.workspaceId !== workspaceId || node.projectId !== projectId || !z.string().uuid().safeParse(node.id).success
      || ids.has(node.id.toLowerCase()) || !products.has(node.productId.toLowerCase()) || !['active', 'archived'].includes(node.status)) invalid()
    ids.add(node.id.toLowerCase())
    const scope: HarnessScope = { kind: 'component', productId: node.productId.toLowerCase(), componentId: node.id.toLowerCase() }
    scopes.set(scopeKey(scope), { scope, active: node.status === 'active' && products.get(scope.productId)! })
  }
  const heads = new Map<string, HarnessRevision>()
  const revisionIds = new Set<string>()
  for (const row of snapshot.revisions) {
    const scope = normalizedScope(row.scope), key = scopeKey(scope)
    if (row.workspaceId !== workspaceId || row.projectId !== projectId || !scopes.has(key) || heads.has(key)
      || !z.string().uuid().safeParse(row.id).success || revisionIds.has(row.id.toLowerCase())
      || !Number.isSafeInteger(row.revision) || row.revision < 1) invalid()
    revisionIds.add(row.id.toLowerCase())
    heads.set(key, { ...row, scope, definition: harnessDefinitionSchema.parse(row.definition) })
  }
  const result: HarnessImpact = { status: 'ready', selectedScopes: [], codeChecks: [], acceptanceScenarios: [], uncovered: [], unresolvedDependencies: [], conflicts: [] }
  type Edge = { kind: 'ancestor' | 'reverse_dependency'; scope: HarnessScope; contract?: string }
  const graph = new Map<string, Edge[]>()
  const active = [...scopes.entries()].filter(([, value]) => value.active).sort(([a], [b]) => compare(a, b))
  for (const [key, { scope }] of active) {
    const lineage = scopeLineage(scope)
    graph.set(key, lineage.length > 1 ? [{ kind: 'ancestor', scope: lineage[lineage.length - 2] }] : [])
  }
  for (const [key] of active) {
    const row = heads.get(key)
    if (!row) continue
    const dependencies = (row.definition.dependencies ?? []).map(dep => ({ ...dep, scope: normalizedScope(dep.scope) }))
      .sort((a, b) => compare(scopeKey(a.scope), scopeKey(b.scope)) || compare(a.contract, b.contract))
    for (const dep of dependencies) {
      const dependencyKey = scopeKey(dep.scope)
      if (!scopes.get(dependencyKey)?.active) {
        const unresolved = { origin: originOf(row), target: dep.scope, contract: dep.contract, reason: 'missing_or_archived_scope' as const }
        if (!result.unresolvedDependencies.some(item => JSON.stringify(item) === JSON.stringify(unresolved))) result.unresolvedDependencies.push(unresolved)
      } else graph.get(dependencyKey)!.push({ kind: 'reverse_dependency', scope: row.scope, contract: dep.contract })
    }
  }
  for (const edges of graph.values()) edges.sort((a, b) => compare(scopeKey(a.scope), scopeKey(b.scope)) || compare(a.kind, b.kind) || compare(a.contract ?? '', b.contract ?? ''))
  const seeds: Array<{ key: string; path: HarnessImpactReasonPath }> = []
  if ('changedSources' in request) {
    const sources = [...new Map(request.changedSources.map(source => [JSON.stringify(source), source])).values()]
      .sort((a, b) => compare(a.repository, b.repository) || compare(a.path, b.path))
    for (const source of sources) {
      let covered = false
      for (const [key, { scope }] of active) {
        if (!(heads.get(key)?.definition.sourceMappings ?? []).some(mapping => mapping.repository === source.repository
          && (source.path === mapping.pathPrefix || source.path.startsWith(`${mapping.pathPrefix}/`)))) continue
        covered = true
        seeds.push({ key, path: { seed: { kind: 'source', source }, steps: [{ kind: 'source_mapping', scope }] } })
      }
      if (!covered) result.uncovered.push({ kind: 'source', source, reason: 'no_source_mapping' })
    }
  } else {
    const changedScopes = [...new Map(request.scopes.map(inputScope => {
      const scope = normalizedScope(inputScope); return [scopeKey(scope), scope] as const
    })).entries()].sort(([a], [b]) => compare(a, b))
    for (const [key, scope] of changedScopes) {
      if (!scopes.get(key)?.active) result.uncovered.push({ kind: 'scope', scope, reason: 'missing_or_archived_scope' })
      else seeds.push({ key, path: { seed: { kind: 'scope', scope }, steps: [{ kind: 'changed_scope', scope }] } })
    }
  }
  const reasons = new Map<string, HarnessImpactReasonPath[]>()
  for (const seed of seeds) {
    const queue = [seed], visited = new Set<string>([seed.key])
    for (let i = 0; i < queue.length; i++) {
      const current = queue[i]
      const paths = reasons.get(current.key) ?? []; paths.push(current.path); reasons.set(current.key, paths)
      for (const edge of graph.get(current.key) ?? []) {
        const key = scopeKey(edge.scope)
        if (visited.has(key)) continue
        visited.add(key); queue.push({ key, path: { seed: current.path.seed, steps: [...current.path.steps, edge] } })
      }
    }
  }
  const seenConflicts = new Set<string>()
  for (const [key, { scope }] of active) {
    const reasonPaths = reasons.get(key)
    if (!reasonPaths) continue
    result.selectedScopes.push({ scope, reasonPaths })
    const lineage = scopeLineage(scope).flatMap(ancestor => heads.get(scopeKey(ancestor)) ?? [])
    for (const conflict of resolveHarness({ workspaceId, projectId, scope }, lineage).conflicts) {
      const identity = JSON.stringify(conflict)
      if (!seenConflicts.has(identity)) { seenConflicts.add(identity); result.conflicts.push({ scope, conflict }) }
    }
    const row = heads.get(key)
    if (!row) continue
    const origin = originOf(row)
    for (const check of [...row.definition.codeChecks].sort((a, b) => compare(a.key, b.key))) {
      result.codeChecks.push({ ...check, origin, qualifiedKey: `${key}/codeCheck/${check.key}`, reasonPaths })
    }
    for (const scenario of [...row.definition.acceptanceScenarios].sort((a, b) => compare(a.key, b.key))) {
      result.acceptanceScenarios.push({ ...scenario, origin, qualifiedKey: `${key}/acceptanceScenario/${scenario.key}`, reasonPaths })
    }
  }
  result.status = result.uncovered.length || result.unresolvedDependencies.length || result.conflicts.length ? 'blocked' : 'ready'
  return result
}
