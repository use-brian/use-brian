/** Deterministic inheritance, never authorization or semantic approval. [COMP:api/project-harness] */
import {
  harnessDefinitionSchema, harnessScopeSchema,
  type HarnessDefinition, type HarnessRevision, type HarnessRule, type HarnessScope,
} from './contracts.js'

export type HarnessOrigin = { revisionId: string; revision: number; scope: HarnessScope }
export type HarnessConflict = {
  key: string
  reason: 'invariant_override' | 'override_required' | 'override_without_default'
  origin: HarnessOrigin
  inheritedFrom?: HarnessOrigin
}
export type EffectiveHarness = {
  /** Resolved means structurally consistent, NOT approved or authorized to execute. */
  status: 'resolved' | 'conflicted'
  sources: HarnessOrigin[]
  rules: Array<HarnessRule & { origin: HarnessOrigin }>
  codeChecks: Array<HarnessDefinition['codeChecks'][number] & { origin: HarnessOrigin }>
  acceptanceScenarios: Array<HarnessDefinition['acceptanceScenarios'][number] & { origin: HarnessOrigin }>
  conflicts: HarnessConflict[]
}

export function harnessScopeKey(scope: HarnessScope): string {
  if (scope.kind === 'project') return 'project'
  if (scope.kind === 'product') return `product:${scope.productId}`
  return `component:${scope.productId}:${scope.componentId}`
}

export function scopeLineage(scope: HarnessScope): HarnessScope[] {
  const result: HarnessScope[] = [{ kind: 'project' }]
  if (scope.kind !== 'project') result.push({ kind: 'product', productId: scope.productId })
  if (scope.kind === 'component') result.push({ ...scope })
  return result
}

/**
 * Input must come from an authorized, consistent store lineage. Reject foreign
 * ancestry instead of accidentally leaking sibling rules via conflict output.
 * Missing definitions are permitted; duplicate scope heads are not.
 * Prose contradictions under distinct keys still require human review.
 */
export function resolveHarness(
  target: { workspaceId: string; projectId: string; scope: HarnessScope },
  revisions: readonly HarnessRevision[],
): EffectiveHarness {
  const scope = harnessScopeSchema.parse(target.scope)
  const lineage = scopeLineage(scope)
  const keys = lineage.map(harnessScopeKey)
  const byScope = new Map<string, HarnessRevision>()
  for (const row of revisions) {
    const rowScope = harnessScopeSchema.parse(row.scope)
    const key = harnessScopeKey(rowScope)
    if (row.workspaceId !== target.workspaceId || row.projectId !== target.projectId || !keys.includes(key) || byScope.has(key)) {
      throw new Error('harness_lineage_invalid')
    }
    byScope.set(key, { ...row, scope: rowScope, definition: harnessDefinitionSchema.parse(row.definition) })
  }

  const result: EffectiveHarness = { status: 'resolved', sources: [], rules: [], codeChecks: [], acceptanceScenarios: [], conflicts: [] }
  const rules = new Map<string, HarnessRule & { origin: HarnessOrigin }>()
  for (const key of keys) {
    const row = byScope.get(key)
    if (!row) continue
    const origin: HarnessOrigin = { revisionId: row.id, revision: row.revision, scope: row.scope }
    result.sources.push(origin)
    for (const rule of row.definition.rules) {
      // Product/project local constraints are not instructions for descendants.
      if (rule.kind === 'local' && key !== harnessScopeKey(scope)) continue
      const inherited = rules.get(rule.key)
      let reason: HarnessConflict['reason'] | undefined
      if (inherited?.kind === 'invariant') {
        if (rule.kind === 'invariant' && rule.value === inherited.value && !rule.override) continue
        reason = 'invariant_override'
      } else if (inherited && !rule.override) reason = 'override_required'
      else if (!inherited && rule.override) reason = 'override_without_default'
      if (reason) {
        result.conflicts.push({ key: rule.key, reason, origin, ...(inherited ? { inheritedFrom: inherited.origin } : {}) })
      } else rules.set(rule.key, { ...rule, origin })
    }
    // Checks are additive and scope-qualified by origin. A child cannot delete
    // an inherited acceptance criterion by reusing its key.
    result.codeChecks.push(...row.definition.codeChecks.map(check => ({ ...check, origin })))
    result.acceptanceScenarios.push(...row.definition.acceptanceScenarios.map(scenario => ({ ...scenario, origin })))
  }
  result.rules = [...rules.values()]
  result.status = result.conflicts.length ? 'conflicted' : 'resolved'
  return result
}
