import { deriveResourceScope, type ScopeSource } from './derived-scope.js'

// Object identity is the trust boundary. User-controlled JSON properties and
// serialization never create or retain a canonical reader's binding.
const sources = new WeakMap<object, ScopeSource>()

/** Attach an already-authorized canonical source without putting it in content. */
export function bindScopeSource<T extends object>(value: T, source: ScopeSource): T {
  deriveResourceScope({ producer: 'reader', sources: [source] })
  sources.set(value, structuredClone(source))
  return value
}

/** A defensive snapshot, available only for objects bound by a trusted reader. */
export function boundScopeSource(value: object): ScopeSource | undefined {
  const source = sources.get(value)
  return source ? structuredClone(source) : undefined
}
