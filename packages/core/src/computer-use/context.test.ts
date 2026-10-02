import { describe, expect, it } from 'vitest'
import { nativeModelContext, type NativeGoalObjective } from './context.js'
import type { NativeModelInput } from './types.js'

function input(): NativeModelInput {
  const node = { role: 'label', name: 'Passive chrome', value: 'unchanged', enabled: true, selected: false, sensitive: false, focused: false, actions: [] }
  return {
    goal: 'Write a greeting', candidates: [], signal: new AbortController().signal, deadlineAt: Date.now() + 60000,
    observation: {
      identity: { deploymentId: 'd', userId: 'u', workspaceId: 'w', deviceId: 'dev', sessionId: 's', conversationId: 'c', taskId: 't' },
      target: { appId: 'org.gnome.gedit', processId: 1, processInstanceId: 'p', windowId: 'w', windowInstanceId: 'wi' },
      epoch: 1, id: 'o', capturedAt: Date.now(), monotonicMs: 1, foreground: true, completeness: 'complete', displayLayoutVersion: 'l', bounds: { x: 0, y: 0, width: 100, height: 100 },
      nodes: [
        { ...node, ref: 'root', role: 'window' }, { ...node, ref: 'container', parentRef: 'root' },
        { ...node, ref: 'doc', role: 'text', name: 'Document', parentRef: 'container', actions: ['setValue'], value: 'whole document' },
        { ...node, ref: 'focus', parentRef: 'root', focused: true },
        { ...node, ref: 'disabled', parentRef: 'root', enabled: false, actions: ['invoke'] },
        { ...node, ref: 'result', role: 'status', name: 'Result', parentRef: 'container' },
        { ...node, ref: 'duplicate', role: 'status', name: 'Result', parentRef: 'root' },
        ...Array.from({ length: 230 }, (_, i) => ({ ...node, ref: `chrome${i}`, parentRef: 'root' })),
      ],
    },
  }
}
const objective: NativeGoalObjective = { role: 'status', name: 'Result', property: 'value', equals: 'done' }

describe('reviewed document model context', () => {
  it('retains all actionable/focused nodes, ancestors, objective matches and exact values without mutating raw AX', () => {
    const i = input(), raw = structuredClone(i.observation)
    const c = nativeModelContext(i, [objective], true)
    expect(c.nodes.map(n => n.ref)).toEqual(['root', 'container', 'doc', 'focus', 'disabled', 'result', 'duplicate'])
    expect(c.context).toEqual({ mode: 'document', omittedPassiveNodes: 230, completeness: 'complete' })
    expect(c.objectives).toEqual([objective])
    expect(c.nodes[2]!.value).toBe('whole document')
    expect(i.observation).toEqual(raw)
    for (const n of c.nodes) expect(i.observation.nodes).toContain(n)
  })
  it('retains every candidate ref even if passive, and refuses fictional refs', () => {
    const i = input()
    i.candidates = [{ id: 'c0', action: { kind: 'select', target: i.observation.target, observationId: 'o', ref: 'chrome229' } }]
    expect(nativeModelContext(i, [], true).nodes.map(n => n.ref)).toContain('chrome229')
    i.candidates = [{ id: 'bad', action: { kind: 'select', target: i.observation.target, observationId: 'o', ref: 'invented' } }]
    expect(() => nativeModelContext(i, [], true)).toThrow('Candidate missing')
  })
  it.each(['partial', 'sensitive', 'missing-objective', 'missing-parent', 'cycle', 'duplicate-ref'])('fails closed for %s, not a convenient reduced view', issue => {
    const i = input()
    if (issue === 'partial') i.observation.completeness = 'partial'
    if (issue === 'sensitive') i.observation.nodes.at(-1)!.sensitive = true
    if (issue === 'missing-objective') i.observation.nodes = i.observation.nodes.filter(n => n.name !== 'Result')
    if (issue === 'missing-parent') i.observation.nodes[2]!.parentRef = 'absent'
    if (issue === 'cycle') i.observation.nodes[0]!.parentRef = 'container'
    if (issue === 'duplicate-ref') i.observation.nodes.at(-1)!.ref = 'doc'
    expect(() => nativeModelContext(i, [objective], true)).toThrow()
  })
  it('refuses more than 24 actionable document nodes instead of silently truncating', () => {
    const i = input()
    for (const node of i.observation.nodes.slice(-25)) node.actions = ['invoke']
    expect(() => nativeModelContext(i, [], true)).toThrow('Too many document actionables')
  })
  it.each(['com.usebrian.NativeComputerFixture', 'unreviewed.app'])('never filters %s', appId => {
    const i = input(); i.observation.target.appId = appId
    const c = nativeModelContext(i, [objective], true)
    expect(c.nodes).toBe(i.observation.nodes)
    expect(c.context.omittedPassiveNodes).toBe(0)
    expect(c.context.mode).toBe('full')
  })
  it('keeps legacy adapters on full context unless trusted projection is explicitly provided', () => {
    const i = input()
    expect(nativeModelContext(i).nodes).toBe(i.observation.nodes)
  })
})
