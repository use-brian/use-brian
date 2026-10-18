import { DerivedScopeError, deriveResourceScope, resourceScopeKey, type ScopeSource } from './derived-scope.js'

// Object identity is the trust boundary. User-controlled JSON properties and
// serialization never create or retain a canonical reader's binding.
const sources = new WeakMap<object, ScopeSource[]>()

/** Attach an already-authorized canonical source without putting it in content. */
export function bindScopeSource<T extends object>(value: T, source: ScopeSource): T {
  return bindScopeSources(value, [source])
}

/** Several observations can contribute to one result, including hidden aggregate rows. */
export function bindScopeSources<T extends object>(value: T, observed: readonly ScopeSource[]): T {
  if (!Array.isArray(observed)) throw new DerivedScopeError('scope_evidence_missing')
  const snapshot = structuredClone(observed)
  // Validate the entire batch before changing the trusted binding. Reading
  // several visibility partitions is allowed; the derived writer judges them.
  for (const source of snapshot) deriveResourceScope({ producer: 'reader', sources: [source] })
  const all = new Map<string, ScopeSource>()
  for (const source of [...(sources.get(value) ?? []), ...snapshot]) {
    all.set(JSON.stringify([source.workspaceId, source.resourceKind, source.resourceId, source.version, resourceScopeKey(source)]), source)
  }
  sources.set(value, [...all.values()])
  return value
}

/** A single-source reader must not silently truncate a multi-source binding. */
export function boundScopeSource(value: object): ScopeSource | undefined {
  const observed = sources.get(value)
  if (observed && observed.length > 1) throw new DerivedScopeError('scope_evidence_missing')
  return observed?.length === 1 ? structuredClone(observed[0]) : undefined
}

/** Defensive snapshots, available only for this exact trusted result identity. */
export function boundScopeSources(value: object): ScopeSource[] {
  return structuredClone(sources.get(value) ?? [])
}
