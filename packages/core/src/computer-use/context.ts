import { matchNativeNode, type NativeNodeSelector } from './selector.js'
import type { NativeObservation } from '@use-brian/computer-control/protocol.js'
import type { NativeModelInput } from './types.js'

/** Frozen whole-goal postconditions, supplied by trusted runtime code, not action authority. */
export type NativeGoalObjective = NativeNodeSelector & {
  property: 'value' | 'selected' | 'name'; equals: string | boolean
}
export const NATIVE_DOCUMENT_APPS: ReadonlySet<string> = new Set(['com.apple.TextEdit', 'com.microsoft.Notepad', 'org.gnome.gedit'])

/** A model-only view; never replace the observation used for policy or dispatch.
 * The adapter must check full raw scope/safety before opting into projection.
 * No values/candidates are clipped. The caller still enforces its serialized byte limit.
 */
export function nativeModelContext(input: NativeModelInput, objectives: readonly NativeGoalObjective[] = [], documentProjection = false) {
  const o = input.observation
  const project = documentProjection && NATIVE_DOCUMENT_APPS.has(o.target.appId)
  if (project && o.nodes.filter(n => n.actions.length > 0).length > 24) throw new Error('Too many document actionables')
  if (project && (o.completeness !== 'complete' || o.nodes.some(n => n.sensitive))) throw new Error('Document context unsafe or incomplete')
  const byRef = new Map(o.nodes.map(n => [n.ref, n]))
  if (byRef.size !== o.nodes.length) throw new Error('Ambiguous native refs')
  for (const candidate of input.candidates) {
    if ('ref' in candidate.action && !byRef.has(candidate.action.ref)) throw new Error('Candidate missing from context')
  }
  let nodes = o.nodes
  if (project) {
    const keep = new Set<string>()
    const retain = (node: NativeObservation['nodes'][number]) => {
      const chain = new Set<string>()
      let current: typeof node | undefined = node
      while (current) {
        if (chain.has(current.ref)) throw new Error('Cyclic native ancestry')
        chain.add(current.ref); keep.add(current.ref)
        if (!current.parentRef) break
        current = byRef.get(current.parentRef)
        if (!current) throw new Error('Missing native ancestor')
      }
    }
    for (const node of nodes) if (node.actions.length || node.focused) retain(node)
    for (const candidate of input.candidates) if ('ref' in candidate.action) retain(byRef.get(candidate.action.ref)!)
    for (const objective of objectives) {
      const matches = matchNativeNode(o, objective).candidates
      if (!matches.length) throw new Error('Goal objective absent from document context')
      // Retain every match: projection must never erase field ambiguity.
      for (const match of matches) retain(match)
      // Retain rival ancestor labels too, even groups with no matching descendant.
      // Otherwise projection could erase an ambiguous scope from model context.
      for (const ancestor of objective.ancestors ?? []) {
        for (const match of matchNativeNode(o, ancestor).candidates) retain(match)
      }
    }
    nodes = nodes.filter(n => keep.has(n.ref))
  }
  return {
    nodes, objectives: [...objectives],
    context: { mode: project ? 'document' as const : 'full' as const, omittedPassiveNodes: o.nodes.length - nodes.length, completeness: o.completeness },
  }
}
