import type { NativeObservation } from '@use-brian/computer-control/protocol.js'

type Node = NativeObservation['nodes'][number]
export type NativeAncestorSelector = { role: string; name: string }
export type NativeNodeSelector = NativeAncestorSelector & {
  /** Exact contiguous nearest-parent-first prefix, 1..4 entries. No skipped wrappers.
   * The full actual chain to a root is validated even beyond this prefix. */
  ancestors?: NativeAncestorSelector[]
}

/** One matcher for grounding and postconditions. candidates intentionally includes
 * ALL role/name matches, even when ancestry distinguishes one; projection must not
 * discard rivals and thereby manufacture uniqueness. No opaque refs are selectors. */
export function matchNativeNode(o: NativeObservation, selector: NativeNodeSelector): { candidates: Node[]; node?: Node } {
  const candidates = o.nodes.filter(n => n.role === selector.role && n.name === selector.name)
  const denied = { candidates }
  const ancestors = selector.ancestors ?? []
  if (o.completeness !== 'complete' || o.nodes.some(n => n.sensitive)
    || (selector.ancestors && (ancestors.length < 1 || ancestors.length > 4))) return denied
  const byRef = new Map(o.nodes.map(n => [n.ref, n]))
  if (byRef.size !== o.nodes.length) return denied
  const chains = new Map<string, Node[]>()
  // Validate full raw graph, not a filtered view or just the selected branch.
  for (const node of o.nodes) {
    const chain: Node[] = [], seen = new Set([node.ref])
    let ref = node.parentRef
    while (ref) {
      const parent = byRef.get(ref)
      if (!parent || seen.has(ref)) return denied
      seen.add(ref); chain.push(parent); ref = parent.parentRef
    }
    chains.set(node.ref, chain)
  }
  const same = (n: Node | undefined, s: NativeAncestorSelector) => !!n && n.role === s.role && n.name === s.name
  const under = (n: Node, path: NativeAncestorSelector[]) => path.every((s, i) => same(chains.get(n.ref)![i], s))
  const matches = candidates.filter(n => under(n, ancestors))
  if (matches.length !== 1) return denied
  const node = matches[0]!
  // Each named ancestor must itself resolve uniquely in the specified outer
  // context. Two identically labelled groups cannot be distinguished by refs/order.
  for (let i = 0; i < ancestors.length; i++) {
    const groups = o.nodes.filter(n => same(n, ancestors[i]!) && under(n, ancestors.slice(i + 1)))
    if (groups.length !== 1 || groups[0]!.ref !== chains.get(node.ref)![i]!.ref) return denied
  }
  return { candidates, node }
}

/** Derive only from the current full AX tree; used to ground bounded candidates.
 * Frozen model objectives carry their own selector and must never call this to
 * silently reinterpret a relabelled/reparented goal. */
export function nativeSelectorForNode(o: NativeObservation, node: Node): NativeNodeSelector | undefined {
  const selector: NativeNodeSelector = { role: node.role, name: node.name }
  if (matchNativeNode(o, selector).node?.ref === node.ref) return selector
  const byRef = new Map(o.nodes.map(n => [n.ref, n])), ancestors: NativeAncestorSelector[] = []
  let ref = node.parentRef
  for (let depth = 0; ref && depth < 4; depth++) {
    const parent = byRef.get(ref)
    if (!parent) return undefined
    ancestors.push({ role: parent.role, name: parent.name })
    const scoped = { ...selector, ancestors: [...ancestors] }
    if (matchNativeNode(o, scoped).node?.ref === node.ref) return scoped
    ref = parent.parentRef
  }
  return undefined
}
