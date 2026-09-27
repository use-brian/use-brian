import { describe, it, expect } from 'vitest'
import { buildSnapshot, type CdpAXNode } from '../snapshot.js'

function ax(partial: Partial<CdpAXNode> & { nodeId: string }): CdpAXNode {
  return partial
}

describe('[COMP:ext/agent] Ref-based accessibility snapshot builder (P1.5)', () => {
  it('lists interactive nodes with sequential @eN refs and keeps the ref → backend node mapping', () => {
    const { nodes, refToBackendNodeId, refToName } = buildSnapshot([
      ax({ nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'LinkedIn' }, backendDOMNodeId: 10 }),
      ax({ nodeId: '2', role: { value: 'button' }, name: { value: 'Send' }, backendDOMNodeId: 11 }),
      ax({ nodeId: '3', role: { value: 'textbox' }, name: { value: 'Write a message' }, backendDOMNodeId: 12, value: { value: 'draft' } }),
      ax({ nodeId: '4', role: { value: 'link' }, name: { value: 'Jane Doe' }, backendDOMNodeId: 13 }),
    ])
    expect(nodes).toEqual([
      { nodeId: '11', ref: '@e1', role: 'button', name: 'Send' },
      { nodeId: '12', ref: '@e2', role: 'textbox', name: 'Write a message', value: 'draft' },
      { nodeId: '13', ref: '@e3', role: 'link', name: 'Jane Doe' },
    ])
    expect(refToBackendNodeId.get('@e1')).toBe(11)
    expect(refToBackendNodeId.get('@e2')).toBe(12)
    expect(refToName.get('@e1')).toBe('Send')
  })

  it('skips ignored nodes, nodes without a backend DOM node, and non-interactive noise', () => {
    const { nodes } = buildSnapshot([
      ax({ nodeId: '1', role: { value: 'button' }, name: { value: 'Hidden' }, backendDOMNodeId: 20, ignored: true }),
      ax({ nodeId: '2', role: { value: 'button' }, name: { value: 'Detached' } }),
      ax({ nodeId: '3', role: { value: 'paragraph' }, name: { value: 'Just text' }, backendDOMNodeId: 22 }),
      ax({ nodeId: '4', role: { value: 'button' }, name: { value: 'Real' }, backendDOMNodeId: 23 }),
    ])
    expect(nodes).toEqual([{ nodeId: '23', ref: '@e1', role: 'button', name: 'Real' }])
  })

  it('includes focusable named nodes with generic roles (contenteditable message boxes)', () => {
    const { nodes } = buildSnapshot([
      ax({
        nodeId: '1',
        role: { value: 'genericContainer' },
        name: { value: 'Message body' },
        backendDOMNodeId: 30,
        properties: [{ name: 'focusable', value: { value: true } }],
      }),
    ])
    expect(nodes).toEqual([{ nodeId: '30', ref: '@e1', role: 'genericcontainer', name: 'Message body' }])
  })

  it('marks disabled nodes', () => {
    const { nodes } = buildSnapshot([
      ax({
        nodeId: '1',
        role: { value: 'button' },
        name: { value: 'Send' },
        backendDOMNodeId: 40,
        properties: [{ name: 'disabled', value: { value: true } }],
      }),
    ])
    expect(nodes[0]).toMatchObject({ name: 'Send', disabled: true })
  })

  it('adds static fare information without refs in full mode and omits InlineTextBox duplicates', () => {
    const { nodes, refToBackendNodeId } = buildSnapshot([
      ax({ nodeId: '1', role: { value: 'heading' }, name: { value: 'FARE INFO' }, backendDOMNodeId: 50 }),
      ax({ nodeId: '2', role: { value: 'StaticText' }, name: { value: 'Adult' }, backendDOMNodeId: 51 }),
      ax({ nodeId: '3', role: { value: 'InlineTextBox' }, name: { value: 'Adult' } }),
      ax({ nodeId: '4', role: { value: 'cell' }, name: { value: '5.9' }, backendDOMNodeId: 52 }),
      ax({ nodeId: '5', role: { value: 'button' }, name: { value: 'Show details' }, backendDOMNodeId: 53 }),
    ], 'full')

    expect(nodes).toEqual([
      { nodeId: '50', role: 'heading', name: 'FARE INFO' },
      { nodeId: '51', role: 'statictext', name: 'Adult' },
      { nodeId: '52', role: 'cell', name: '5.9' },
      { nodeId: '53', ref: '@e1', role: 'button', name: 'Show details' },
    ])
    expect(refToBackendNodeId.get('@e1')).toBe(53)
  })

  it('keeps the default interactive snapshot unchanged', () => {
    const { nodes } = buildSnapshot([
      ax({ nodeId: '1', role: { value: 'StaticText' }, name: { value: '5.9' }, backendDOMNodeId: 60 }),
      ax({ nodeId: '2', role: { value: 'button' }, name: { value: 'Show details' }, backendDOMNodeId: 61 }),
    ])

    expect(nodes).toEqual([{ nodeId: '61', ref: '@e1', role: 'button', name: 'Show details' }])
  })
})

it('keeps informational nodes without inventing missing backend identity', () => {
  expect(buildSnapshot([{ nodeId: 'ax-only', role: { value: 'StaticText' }, name: { value: 'Text' } }], 'full').nodes)
    .toEqual([{ role: 'statictext', name: 'Text' }])
})


describe('snapshot checked and validation state', () => {
  function state(properties: Array<[string, unknown]>) {
    return buildSnapshot([{
      nodeId: '1', backendDOMNodeId: 10, role: { value: 'checkbox' }, name: { value: 'Agree' },
      properties: properties.map(([name, value]) => ({ name, value: { value } })),
    }]).nodes[0]!
  }
  it.each([[true, true], [false, false], ['true', true], ['false', false], ['mixed', 'mixed']])('normalizes checked %s to %s, preserving false', (raw, checked) => {
    expect(state([['checked', raw]])).toMatchObject({ checked })
  })
  it.each([[true, true], [false, false], ['true', true], ['false', false]])('normalizes required %s to %s', (raw, required) => {
    expect(state([['required', raw]])).toMatchObject({ required })
  })
  it.each([true, 'true', 'grammar', 'spelling', 'other'])('exposes non-false invalid state %s as a string', raw => {
    expect(state([['invalid', raw]])).toMatchObject({ invalid: String(raw) })
  })
  it.each([false, 'false', '', undefined, null])('omits invalid state %s', raw => {
    expect(state([['invalid', raw]])).not.toHaveProperty('invalid')
  })
  it('does not invent absent or unknown boolean states', () => {
    for (const node of [state([]), state([['checked', 'unknown'], ['required', 'mixed']])]) {
      expect(node).not.toHaveProperty('checked')
      expect(node).not.toHaveProperty('required')
    }
  })
  it('exposes both checkbox transitions and validation changes without changing identity', () => {
    const before = state([['checked', true], ['required', true], ['invalid', 'false']])
    const after = state([['checked', false], ['required', false], ['invalid', 'true']])
    expect(after.nodeId).toBe(before.nodeId)
    expect(before).toMatchObject({ checked: true, required: true })
    expect(after).toMatchObject({ checked: false, required: false, invalid: 'true' })
  })
})
