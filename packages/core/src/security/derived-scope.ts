import { maxSensitivity, SENSITIVITY_VALUES, type Sensitivity } from './sensitivity.js'

/** An explicit row envelope. Null visibility means workspace-wide on that axis. */
export type ResourceScope = {
  workspaceId: string
  userId: string | null
  assistantId: string | null
  sensitivity: Sensitivity
  compartments: string[]
  projectIds: string[]
}

/** Only trusted readers construct these; never accept them as model tool arguments. */
export type ScopeSource = ResourceScope & {
  resourceKind: string
  resourceId: string
  version: string
}

export type DerivedWriteEvidence = {
  producer: string
  sources: ScopeSource[]
}

export class DerivedScopeError extends Error {
  constructor(readonly code:
    | 'scope_evidence_missing'
    | 'scope_workspace_mismatch'
    | 'scope_visibility_incompatible'
    | 'scope_source_changed',
  ) {
    // Do not put inaccessible source identities or labels in a caller-visible error.
    super(code)
    this.name = 'DerivedScopeError'
  }
}

function labels(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string' && v.trim().length > 0)
}

function identity(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function nullableIdentity(value: unknown): value is string | null {
  return value === null || identity(value)
}

function canonical(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

function assertScope(value: ResourceScope): void {
  if (!value || !identity(value.workspaceId) || !nullableIdentity(value.userId)
    || !nullableIdentity(value.assistantId) || !SENSITIVITY_VALUES.includes(value.sensitivity)
    || !labels(value.compartments) || !labels(value.projectIds)) {
    throw new DerivedScopeError('scope_evidence_missing')
  }
}

function intersectVisibility(a: string | null, b: string | null): string | null {
  if (a !== null && b !== null && a !== b) {
    throw new DerivedScopeError('scope_visibility_incompatible')
  }
  return a ?? b
}

/** Canonical bucket for routine synthesis, before similarity comparison or model input. */
export function resourceScopeKey(scope: ResourceScope): string {
  assertScope(scope)
  return JSON.stringify([
    scope.workspaceId, scope.userId, scope.assistantId, scope.sensitivity,
    canonical(scope.compartments), canonical(scope.projectIds),
  ])
}

/**
 * All model inputs contribute, including examples and prior derived content.
 * Empty arrays are known General; absent axes are never silently made General.
 */
export function deriveResourceScope(
  evidence: DerivedWriteEvidence,
  requested?: ResourceScope,
): ResourceScope {
  return derive(evidence, requested, intersectVisibility)
}

/**
 * The label floor (max sensitivity, union of compartments and Projects) over
 * rows a turn has read, without intersecting personal/assistant visibility.
 * Reading is not deriving: a primary assistant legitimately reads rows from
 * several visibility partitions in one turn, and the refusal belongs to the
 * derived write, never to the read. Every other evidence check still applies.
 */
export function deriveContextFloor(
  evidence: DerivedWriteEvidence,
): Pick<ResourceScope, 'sensitivity' | 'compartments' | 'projectIds'> {
  const { sensitivity, compartments, projectIds } = derive(evidence, undefined, (a) => a)
  return { sensitivity, compartments, projectIds }
}

/** True when the sources can certify one derived envelope. */
export function sourcesShareVisibility(sources: readonly ScopeSource[]): boolean {
  try {
    deriveResourceScope({ producer: 'visibility-probe', sources: [...sources] })
    return true
  } catch (err) {
    if (err instanceof DerivedScopeError && err.code === 'scope_visibility_incompatible') return false
    throw err
  }
}

function derive(
  evidence: DerivedWriteEvidence,
  requested: ResourceScope | undefined,
  visibility: (a: string | null, b: string | null) => string | null,
): ResourceScope {
  if (!evidence || !identity(evidence.producer) || !Array.isArray(evidence.sources)
    || evidence.sources.length === 0) throw new DerivedScopeError('scope_evidence_missing')
  const versions = new Map<string, { version: string; scope: string }>()
  let output: ResourceScope | undefined
  for (const source of evidence.sources) {
    assertScope(source)
    if (!identity(source.resourceKind) || !identity(source.resourceId) || !identity(source.version)) {
      throw new DerivedScopeError('scope_evidence_missing')
    }
    const key = JSON.stringify([source.workspaceId, source.resourceKind, source.resourceId])
    const previous = versions.get(key)
    const scope = resourceScopeKey(source)
    if (previous && (previous.version !== source.version || previous.scope !== scope)) {
      throw new DerivedScopeError('scope_source_changed')
    }
    versions.set(key, { version: source.version, scope })
    output = output ? combine(output, source, visibility) : {
      workspaceId: source.workspaceId,
      userId: source.userId,
      assistantId: source.assistantId,
      sensitivity: source.sensitivity,
      compartments: canonical(source.compartments),
      projectIds: canonical(source.projectIds),
    }
  }
  if (requested) {
    assertScope(requested)
    output = combine(output!, requested, visibility)
  }
  return output!
}

function combine(
  a: ResourceScope,
  b: ResourceScope,
  visibility: (a: string | null, b: string | null) => string | null,
): ResourceScope {
  if (a.workspaceId !== b.workspaceId) throw new DerivedScopeError('scope_workspace_mismatch')
  return {
    workspaceId: a.workspaceId,
    userId: visibility(a.userId, b.userId),
    assistantId: visibility(a.assistantId, b.assistantId),
    sensitivity: maxSensitivity(a.sensitivity, b.sensitivity),
    compartments: canonical([...a.compartments, ...b.compartments]),
    projectIds: canonical([...a.projectIds, ...b.projectIds]),
  }
}
