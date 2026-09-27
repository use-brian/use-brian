import { describe, expect, it } from 'vitest'
import { SnapshotObservationState } from '../snapshot-observation.js'
import type { BrowserSnapshot, BrowserSnapshotNode } from '../types.js'

const nodes: BrowserSnapshotNode[] = [
  { nodeId: 'email', ref: '@e1', role: 'textbox', name: 'Email', value: 'old' },
  { nodeId: 'send', ref: '@e2', role: 'button', name: 'Send' },
  { nodeId: 'heading', role: 'heading', name: 'Inbox' },
]
const page = (rows = nodes): BrowserSnapshot => ({ documentId: 'document-1', url: 'https://example.com', title: 'Mail', nodes: rows })
const options = { scope: 'cloud/profile', render: (snapshot: BrowserSnapshot) => JSON.stringify(snapshot) }

describe('semantic snapshot observations', () => {
  it('starts full, then uses a smaller versioned delta and rebinds renumbered refs', () => {
    const state = new SnapshotObservationState()
    expect(state.observe(page(), options).rendered).toContain('v1 full')
    const next = state.observe(page(nodes.map(n => ({ ...n, ...(n.ref ? { ref: n.ref === '@e1' ? '@e9' : '@e8' } : {}) }))), options)
    expect(next.rendered).toContain('v2 diff from v1')
    expect(next.rendered).toContain('No changes.')
    expect(state.resolve('@e1')).toBe('@e9')
    expect(next.refLabels.get('@e2')).toBe('Send')
  })

  it('includes value/disabled changes, informational removals/additions and metadata', () => {
    const state = new SnapshotObservationState()
    state.observe(page(), options)
    const next = state.observe({ ...page([{ ...nodes[0]!, value: 'new', disabled: true }, { nodeId: 'done', role: 'heading', name: 'Done' }]), title: 'Updated' }, { ...options, observation: 'diff' })
    expect(next.rendered).toContain('~ [0] @e1 textbox "Email" value="new" (disabled)')
    expect(next.rendered).toContain('- [2] heading "Inbox"')
    expect(next.rendered).toContain('+ [1] heading "Done"')
    expect(next.rendered).toContain('Page: Updated\nURL: https://example.com')
    expect(() => state.resolve('@e2')).toThrow('Stale')
  })

  it.each(['scope', 'mode', 'url', 'full', 'reset', 'duplicate', 'pagination', 'truncation'] as const)('resets safely for %s without reusing refs', reason => {
    const state = new SnapshotObservationState()
    state.observe(page(), options)
    if (reason === 'reset') state.reset()
    const next = state.observe(reason === 'url' ? { ...page(), url: 'https://elsewhere.com' } : reason === 'duplicate' ? page([...nodes, nodes[0]!]) : page(), {
      ...options,
      ...(reason === 'scope' ? { scope: 'local/other' } : {}),
      ...(reason === 'mode' ? { mode: 'full' as const } : {}),
      ...(reason === 'full' ? { observation: 'full' as const } : {}),
      ...(reason === 'pagination' ? { limit: 1 } : {}),
      ...(reason === 'truncation' ? { observation: 'full' as const, render: () => 'x'.repeat(21_000) } : {}),
    })
    expect(next.rendered).toContain('v2 full')
    expect(() => state.resolve('@e1')).toThrow('Stale')
    if (['pagination', 'truncation', 'duplicate'].includes(reason)) expect(state.observe(page(), options).rendered).toContain('v3 full')
  })

  it('auto retains full when a delta is larger, while diff explicitly requests it', () => {
    const state = new SnapshotObservationState()
    const tiny = { ...options, render: () => 'tiny' }
    state.observe(page(), tiny)
    expect(state.observe(page(), tiny).rendered).toContain('v2 full')
    expect(state.observe(page(), { ...tiny, observation: 'diff' }).rendered).toContain('v3 diff from v2')
  })
})


it('distinguishes duplicate names by DOM identity, including reorder and renaming', () => {
  const state = new SnapshotObservationState()
  const controls = [
    { nodeId: 'first', ref: 'provider-1', role: 'button', name: 'Open' },
    { nodeId: 'second', ref: 'provider-2', role: 'button', name: 'Open' },
  ]
  state.observe(page(controls), options)
  const next = state.observe(page([
    { ...controls[1]!, ref: 'provider-3', name: 'Close' },
    { ...controls[0]!, ref: 'provider-4' },
  ]), { ...options, observation: 'diff' })
  expect(next.rendered).toContain('v2 diff from v1')
  expect(next.rendered).toContain('~ [0] @e2 button "Close"')
  expect(state.resolve('@e1')).toBe('provider-4')
  expect(state.resolve('@e2')).toBe('provider-3')
})

it.each(['document', 'missing-document', 'missing-node', 'duplicate-node'] as const)('resets for %s identity', reason => {
  const state = new SnapshotObservationState()
  state.observe(page(), options)
  const changed = page()
  if (reason === 'document') changed.documentId = 'document-2'
  if (reason === 'missing-document') delete changed.documentId
  if (reason === 'missing-node') changed.nodes = nodes.map(({ nodeId: _, ...node }) => node)
  if (reason === 'duplicate-node') changed.nodes = nodes.map(node => ({ ...node, nodeId: 'same' }))
  const next = state.observe(changed, { ...options, observation: 'diff' })
  expect(next.rendered).toContain('v2 full')
  expect(() => state.resolve('@e1')).toThrow('Stale')
  if (reason !== 'document') expect(state.observe(changed, { ...options, observation: 'diff' }).rendered).toContain('v3 full')
})

it('does not reuse a ref when a same-name control is replaced', () => {
  const state = new SnapshotObservationState()
  state.observe(page(), options)
  const next = state.observe(page(nodes.map(node => ({ ...node, nodeId: `${node.nodeId}-replacement` }))), { ...options, observation: 'diff' })
  expect(next.rendered).toContain('- [0] @e1 textbox "Email"')
  expect(next.rendered).toContain('+ [0] @e4 textbox "Email"')
  expect(() => state.resolve('@e1')).toThrow('Stale')
})

it('keeps identity metadata out of renderer input and all output', () => {
  const state = new SnapshotObservationState()
  const first = state.observe(page(), options)
  expect(first.snapshot).not.toHaveProperty('documentId')
  expect(first.snapshot.nodes[0]).not.toHaveProperty('nodeId')
  for (const output of [first.rendered, state.observe(page(), { ...options, observation: 'diff' }).rendered]) {
    expect(output).not.toMatch(/documentId|nodeId|document-1/)
  }
})

it('only binds and labels refs inside the returned pagination window', () => {
  const state = new SnapshotObservationState()
  const observe = (offset: number) => state.observe(page(), {
    ...options, offset, limit: 1,
    render: snapshot => JSON.stringify(snapshot.nodes.slice(offset, offset + 1)),
  })
  const first = observe(0)
  expect([...first.refLabels.keys()]).toEqual(['@e1'])
  expect(state.resolve('@e1')).toBe('@e1')
  expect(() => state.resolve('@e2')).toThrow('Stale')
  const second = observe(1)
  expect([...second.refLabels.keys()]).toEqual(['@e5'])
  expect(state.resolve('@e5')).toBe('@e2')
  expect(() => state.resolve('@e1')).toThrow('Stale')
  expect(() => state.resolve('@e4')).toThrow('Stale')
  expect(observe(100).refLabels.size).toBe(0)
  expect(() => state.resolve('@e5')).toThrow('Stale')
})

it('reports informational text changes by DOM identity without adding action refs', () => {
  const state = new SnapshotObservationState()
  state.observe(page(), options)
  const next = state.observe(page(nodes.map(node => node.nodeId === 'heading' ? { ...node, name: 'New messages' } : node)), { ...options, observation: 'diff' })
  expect(next.rendered).toContain('~ [2] heading "New messages"')
  expect(next.rendered).not.toContain('@e3')
  expect(() => state.resolve('@e3')).toThrow('Stale')
})

it('allows unnamed distinct DOM controls but requires identity on informational rows too', () => {
  const state = new SnapshotObservationState()
  const unnamed = nodes.map(node => ({ ...node, name: '' }))
  state.observe(page(unnamed), options)
  expect(state.observe(page(unnamed), { ...options, observation: 'diff' }).rendered).toContain('v2 diff from v1')
  const missingInfoIdentity = unnamed.map(node => node.ref ? node : { ...node, nodeId: undefined })
  expect(state.observe(page(missingInfoIdentity), { ...options, observation: 'diff' }).rendered).toContain('v3 full')
  expect(() => state.resolve('@e1')).toThrow('Stale')
})

it('does not resurrect refs after an element loses and regains actionability', () => {
  const state = new SnapshotObservationState()
  state.observe(page(), options)
  state.observe(page(nodes.map(node => node.nodeId === 'email' ? { ...node, ref: undefined } : node)), options)
  expect(() => state.resolve('@e1')).toThrow('Stale')
  const next = state.observe(page(), { ...options, observation: 'diff' })
  expect(next.snapshot.nodes[0]?.ref).not.toBe('@e1')
  expect(() => state.resolve('@e1')).toThrow('Stale')
})
