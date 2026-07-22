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
      { ref: '@e1', role: 'button', name: 'Send' },
      { ref: '@e2', role: 'textbox', name: 'Write a message', value: 'draft' },
      { ref: '@e3', role: 'link', name: 'Jane Doe' },
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
    expect(nodes).toEqual([{ ref: '@e1', role: 'button', name: 'Real' }])
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
    expect(nodes).toEqual([{ ref: '@e1', role: 'genericcontainer', name: 'Message body' }])
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
})
