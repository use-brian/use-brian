import { describe, expect, it } from 'vitest'
import type { NativeObservation } from '@use-brian/computer-control/protocol.js'
import { matchNativeNode, nativeSelectorForNode, type NativeNodeSelector } from './selector.js'
import { nativeModelContext } from './context.js'
import { buildNativeCandidates } from './orchestrator.js'

function tree(): NativeObservation {
  const base = { role: 'group', name: '', focused: false, selected: false, sensitive: false, enabled: true, actions: [] as NativeObservation['nodes'][number]['actions'] }
  return {
    identity: { deploymentId: 'd', userId: 'u', workspaceId: 'w', deviceId: 'dev', sessionId: 's', conversationId: 'c', taskId: 't' }, target: { appId: 'com.usebrian.NativeComputerFixture', processId: 1, processInstanceId: 'p', windowId: 'w', windowInstanceId: 'wi' }, epoch: 1, id: 'o', monotonicMs: 1, capturedAt: Date.now(), foreground: true, completeness: 'complete', displayLayoutVersion: 'l', bounds: { x: 0, y: 0, width: 100, height: 100 },
    nodes: [
      { ...base, ref: 'root', role: 'window', name: 'Fixture' },
      { ...base, ref: 'primary', name: 'Primary target', parentRef: 'root' },
      { ...base, ref: 'secondary', name: 'Archive distractor', parentRef: 'root' },
      { ...base, ref: 'a', role: 'button', name: 'Apply', parentRef: 'primary', actions: ['invoke'] },
      { ...base, ref: 'b', role: 'button', name: 'Apply', parentRef: 'secondary', actions: ['invoke'] },
    ],
  }
}
const scoped: NativeNodeSelector = { role: 'button', name: 'Apply', ancestors: [{ role: 'group', name: 'Primary target' }] }

describe('stable native ancestor selectors', () => {
  it('grounds grouped duplicate Apply candidates without authorizing effects or relying on order', () => {
    const o = tree()
    expect(matchNativeNode(o, { role: 'button', name: 'Apply' }).node).toBeUndefined()
    expect(matchNativeNode(o, scoped).node?.ref).toBe('a')
    expect(nativeSelectorForNode(o, o.nodes[3]!)).toEqual(scoped)
    o.nodes.reverse()
    expect(matchNativeNode(o, scoped).node?.ref).toBe('a')
    const policy = { allows: () => true, allowsCapture: () => false, isComplete: () => false }
    expect(buildNativeCandidates(o, policy).map(c => 'ref' in c.action && c.action.ref)).toEqual(['b', 'a'])
    expect(buildNativeCandidates(o, { ...policy, allows: () => false })).toEqual([])
  })
  it('survives ref churn but not relabelled/reparented evidence', () => {
    const o = tree()
    for (const n of o.nodes) { n.ref += '-new'; if (n.parentRef) n.parentRef += '-new' }
    expect(matchNativeNode(o, scoped).node?.ref).toBe('a-new')
    o.nodes[3]!.parentRef = 'secondary-new'
    expect(matchNativeNode(o, scoped).node).toBeUndefined()
    o.nodes[3]!.parentRef = 'primary-new'; o.nodes[1]!.name = 'Renamed'
    expect(matchNativeNode(o, scoped).node).toBeUndefined()
  })
  it.each(['missing-parent', 'cycle', 'sensitive', 'partial', 'duplicate-group', 'duplicate-field', 'duplicate-ref', 'mismatched-role', 'missing-group'])('refuses %s in the full raw tree', problem => {
    const o = tree()
    if (problem === 'missing-parent') o.nodes[2]!.parentRef = 'gone' // even an excluded rival cannot hide a broken chain
    if (problem === 'cycle') o.nodes[0]!.parentRef = 'a'
    if (problem === 'sensitive') o.nodes[2]!.sensitive = true
    if (problem === 'partial') o.completeness = 'partial'
    if (problem === 'duplicate-group') o.nodes.push({ ...o.nodes[1]!, ref: 'another-primary' })
    if (problem === 'duplicate-field') o.nodes.push({ ...o.nodes[3]!, ref: 'another-apply' })
    if (problem === 'duplicate-ref') o.nodes[4]!.ref = 'a'
    if (problem === 'mismatched-role') o.nodes[1]!.role = 'different-role'
    if (problem === 'missing-group') o.nodes.splice(1, 1)
    expect(matchNativeNode(o, scoped).node).toBeUndefined()
  })
  it('uses a contiguous nearest-first prefix with at most four entries, never skipping wrappers', () => {
    const o = tree()
    o.nodes.push({ ...o.nodes[1]!, ref: 'wrapper', role: 'panel', name: '', parentRef: 'primary' })
    o.nodes[3]!.parentRef = 'wrapper'
    expect(matchNativeNode(o, scoped).node).toBeUndefined()
    const ancestors = [{ role: 'panel', name: '' }, ...scoped.ancestors!, { role: 'window', name: 'Fixture' }]
    expect(matchNativeNode(o, { ...scoped, ancestors }).node?.ref).toBe('a')
    expect(matchNativeNode(o, { ...scoped, ancestors: [...ancestors].reverse() }).node).toBeUndefined()
    expect(matchNativeNode(o, { ...scoped, ancestors: Array(5).fill(ancestors[0]) }).node).toBeUndefined()
    expect(matchNativeNode(o, { ...scoped, ancestors: [] }).node).toBeUndefined()
  })
  it('does not hide a duplicate named ancestor that has no target descendant', () => {
    const o = tree(); o.target.appId = 'org.gnome.gedit'
    for (const n of o.nodes) n.actions = []
    o.nodes.push({ ...o.nodes[1]!, ref: 'empty-primary' })
    const input = { goal: 'Check primary result', observation: o, candidates: [], signal: new AbortController().signal, deadlineAt: Date.now() + 1000 }
    const context = nativeModelContext(input, [{ ...scoped, property: 'name', equals: 'Apply' }], true)
    expect(context.nodes.map(n => n.ref)).toContain('empty-primary')
    expect(matchNativeNode(o, scoped).node).toBeUndefined()
    expect(matchNativeNode({ ...o, nodes: context.nodes }, scoped).node).toBeUndefined()
  })
  it('projection retains rival matches and their complete ancestor chains, not just the scoped winner', () => {
    const o = tree(); o.target.appId = 'org.gnome.gedit'
    for (const n of o.nodes) n.actions = []
    const input = { goal: 'Check primary result', observation: o, candidates: [], signal: new AbortController().signal, deadlineAt: Date.now() + 1000 }
    const context = nativeModelContext(input, [{ ...scoped, property: 'name', equals: 'Apply' }], true)
    expect(context.nodes.map(n => n.ref)).toEqual(o.nodes.map(n => n.ref))
    expect(context.objectives[0]!.ancestors).toEqual(scoped.ancestors)
    expect(matchNativeNode({ ...o, nodes: context.nodes }, scoped).node?.ref).toBe('a')
  })
})
