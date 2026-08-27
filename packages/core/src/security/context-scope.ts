import type { AccessContext } from './access-context.js'
import { isSensitivity, maxSensitivity, type Sensitivity } from './sensitivity.js'

/** A finite set is a ceiling; null is the universe grant. */
export type ScopeGrant = string[] | null

export type ScopeEvidence = {
  sensitivity?: Sensitivity
  compartments?: string[]
  projectIds?: string[]
}

/** The one trusted scope resolved before prompt assembly or tool execution. */
export type TurnScope = {
  access: AccessContext
  activeGroupId: string | null
  activeProjectId: string | null
  effectiveCompartments: ScopeGrant
  effectiveProjectIds: ScopeGrant
  writeCompartments: string[]
  writeProjectIds: string[]
}

export type ResolvedWriteScope = {
  sensitivity: Sensitivity
  compartments: string[]
  projectIds: string[]
}

function canonical(values: readonly string[] | null | undefined): string[] {
  if (!values) return []
  return [...new Set(values.filter((value) => value.length > 0))].sort()
}

/** Flat grant intersection. Universe is the identity element. */
export function intersectScopeGrants(...grants: readonly ScopeGrant[]): ScopeGrant {
  let result: Set<string> | null = null
  for (const grant of grants) {
    if (grant === null) continue
    const next = new Set(grant)
    if (result === null) {
      result = next
    } else {
      const current: Set<string> = result
      result = new Set([...current].filter((value) => next.has(value)))
    }
  }
  return result === null ? null : [...result].sort()
}

/** High-water union for row requirements and write stamps. */
export function unionScopeRequirements(
  ...requirements: readonly (readonly string[] | null | undefined)[]
): string[] {
  const result = new Set<string>()
  for (const requirement of requirements) {
    if (!requirement) continue
    for (const value of requirement) {
      if (value.length > 0) result.add(value)
    }
  }
  return [...result].sort()
}

/** Is every required scope contained by the principal grant? */
export function scopeGrantContains(
  grant: ScopeGrant | undefined,
  required: readonly string[] | null | undefined,
): boolean {
  if (grant == null) return true
  if (!required || required.length === 0) return true
  const granted = new Set(grant)
  return required.every((value) => granted.has(value))
}

/**
 * Per-turn high-water state. General rows contribute empty sets, never a
 * widening signal. Reads may only raise sensitivity and add requirements.
 */
export class ContextScopeAccumulator {
  #sensitivity: Sensitivity = 'public'
  readonly #compartments = new Set<string>()
  readonly #projectIds = new Set<string>()

  constructor(initial?: ScopeEvidence | null) {
    this.note(initial)
  }

  get sensitivity(): Sensitivity {
    return this.#sensitivity
  }

  /** Compatibility name for callers migrating from SensitivityAccumulator. */
  get max(): Sensitivity {
    return this.#sensitivity
  }

  get compartments(): string[] {
    return [...this.#compartments].sort()
  }

  get projectIds(): string[] {
    return [...this.#projectIds].sort()
  }

  get evidence(): ScopeEvidence {
    return {
      sensitivity: this.#sensitivity,
      compartments: this.compartments,
      projectIds: this.projectIds,
    }
  }

  note(evidence: ScopeEvidence | null | undefined): void {
    if (!evidence) return
    if (evidence.sensitivity) {
      this.#sensitivity = maxSensitivity(this.#sensitivity, evidence.sensitivity)
    }
    for (const value of evidence.compartments ?? []) {
      if (value.length > 0) this.#compartments.add(value)
    }
    for (const value of evidence.projectIds ?? []) {
      if (value.length > 0) this.#projectIds.add(value)
    }
  }

  noteSensitivity(sensitivity: Sensitivity | null | undefined): void {
    this.note({ sensitivity: sensitivity ?? undefined })
  }

  noteCompartments(compartments: readonly string[] | null | undefined): void {
    this.note({ compartments: compartments ? [...compartments] : undefined })
  }

  noteProjectIds(projectIds: readonly string[] | null | undefined): void {
    this.note({ projectIds: projectIds ? [...projectIds] : undefined })
  }
}

/** Union/max evidence for exactly the access-filtered rows returned to a model. */
export function scopeEvidenceFromRows(rows: readonly unknown[]): ScopeEvidence {
  const accumulator = new ContextScopeAccumulator()
  const seen = new Set<object>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry)
      return
    }
    if (!value || typeof value !== 'object') return
    if (seen.has(value)) return
    seen.add(value)
    const row = value as {
      sensitivity?: unknown
      compartments?: unknown
      projectIds?: unknown
      project_ids?: unknown
    }
    const projects = row.projectIds ?? row.project_ids
    accumulator.note({
      sensitivity: isSensitivity(row.sensitivity) ? row.sensitivity : undefined,
      compartments: Array.isArray(row.compartments)
        ? row.compartments.filter((entry): entry is string => typeof entry === 'string')
        : undefined,
      projectIds: Array.isArray(projects)
        ? projects.filter((entry): entry is string => typeof entry === 'string')
        : undefined,
    })
    for (const nested of Object.values(row)) visit(nested)
  }
  for (const value of rows) visit(value)
  return accumulator.evidence
}

export class ContextScopeViolation extends Error {
  readonly code = 'context_scope_not_granted'

  constructor(readonly axis: 'team' | 'project', readonly values: string[]) {
    super(`Context ${axis} scope is not granted: ${values.join(', ')}`)
    this.name = 'ContextScopeViolation'
  }
}

/** Resolve the mandatory high-water stamp and prove it stays under both ceilings. */
export function resolveWriteScope(params: {
  sensitivity?: Sensitivity
  baseCompartments?: readonly string[] | null
  baseProjectIds?: readonly string[] | null
  explicitCompartments?: readonly string[] | null
  explicitProjectIds?: readonly string[] | null
  evidence?: ScopeEvidence | ContextScopeAccumulator | null
  compartmentGrant?: ScopeGrant
  projectGrant?: ScopeGrant
}): ResolvedWriteScope {
  const evidence = params.evidence instanceof ContextScopeAccumulator
    ? params.evidence.evidence
    : params.evidence
  const compartments = unionScopeRequirements(
    params.baseCompartments,
    params.explicitCompartments,
    evidence?.compartments,
  )
  const projectIds = unionScopeRequirements(
    params.baseProjectIds,
    params.explicitProjectIds,
    evidence?.projectIds,
  )
  const sensitivity = maxSensitivity(
    params.sensitivity ?? 'public',
    evidence?.sensitivity ?? 'public',
  )

  if (!scopeGrantContains(params.compartmentGrant, compartments)) {
    const grant = new Set(params.compartmentGrant ?? [])
    throw new ContextScopeViolation('team', compartments.filter((value) => !grant.has(value)))
  }
  if (!scopeGrantContains(params.projectGrant, projectIds)) {
    const grant = new Set(params.projectGrant ?? [])
    throw new ContextScopeViolation('project', projectIds.filter((value) => !grant.has(value)))
  }

  return { sensitivity, compartments, projectIds }
}

/** Runtime/migration shared project label contract: trim, then lowercase. */
export function normalizeProjectName(name: string): string {
  return name.trim().toLowerCase()
}

export function canonicalScopeGrant(grant: ScopeGrant): ScopeGrant {
  return grant === null ? null : canonical(grant)
}
