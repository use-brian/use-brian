import { describe, expect, it } from 'vitest'
import {
  projectBrainGraphHierarchy,
  type BrainGraphSourceEdge,
  type BrainGraphSourceNode,
} from '../brain-graph-hierarchy.js'

function graphOf(count: number): {
  nodes: BrainGraphSourceNode[]
  edges: BrainGraphSourceEdge[]
} {
  const kinds = ['person', 'company', 'knowledge', 'project']
  const nodes = Array.from({ length: count }, (_, index) => ({
    id: `node-${String(index).padStart(5, '0')}`,
    kind: kinds[index % kinds.length]!,
    name: `Entry ${String(index).padStart(5, '0')}`,
    sensitivity: 'internal' as const,
    degree: index % 9,
  }))
  const edges: BrainGraphSourceEdge[] = []
  for (let index = 1; index < count; index += 1) {
    edges.push({
      id: `edge-${index}`,
      source: nodes[index - 1]!.id,
      target: nodes[index]!.id,
      type: 'related',
      sensitivity: 'internal',
    })
  }
  return { nodes, edges }
}

describe('[COMP:brain/graph-hierarchy] bounded Brain graph hierarchy', () => {
  it('returns a small graph as real entries without grouping', () => {
    const source = graphOf(40)
    const result = projectBrainGraphHierarchy({
      ...source,
      truncated: false,
    })

    expect(result.nodes).toHaveLength(40)
    expect(result.nodes.every((node) => node.nodeType !== 'group')).toBe(true)
    expect(result.totalNodes).toBe(40)
    expect(result.groupedNodeCount).toBe(0)
  })

  it('projects 5000 entries into a fixed-budget overview without member ids', () => {
    const source = graphOf(5_000)
    const result = projectBrainGraphHierarchy({
      ...source,
      truncated: true,
    })

    expect(result.nodes.length).toBeLessThanOrEqual(60)
    expect(result.edges.length).toBeLessThanOrEqual(600)
    expect(result.nodes.every((node) => node.nodeType === 'group')).toBe(true)
    expect(result.groupedNodeCount).toBe(5_000)
    expect(result.totalNodes).toBe(5_000)
    expect(result.renderBudget).toEqual({ nodes: 200, edges: 600 })
    expect(JSON.stringify(result)).not.toContain('members')
  })

  it('opens one group into at most 160 real entries', () => {
    const source = graphOf(1_000)
    const overview = projectBrainGraphHierarchy({
      ...source,
      truncated: false,
    })
    const group = overview.nodes.find((node) => node.nodeType === 'group')
    expect(group?.nodeType).toBe('group')

    const scoped = projectBrainGraphHierarchy({
      ...source,
      truncated: false,
      scopeId: group?.id,
    })

    expect(scoped.scopeId).toBe(group?.id)
    expect(scoped.nodes.length).toBeLessThanOrEqual(160)
    expect(scoped.nodes.every((node) => node.nodeType !== 'group')).toBe(true)
  })

  it('reveals the bounded scope containing a server-side search match', () => {
    const source = graphOf(1_000)
    const result = projectBrainGraphHierarchy({
      ...source,
      truncated: false,
      focusQuery: 'Entry 00999',
    })

    expect(result.scopeId).not.toBeNull()
    expect(result.focusNodeIds).toContain('node-00999')
    expect(result.nodes.some((node) => node.id === 'node-00999')).toBe(true)
    expect(result.nodes.length).toBeLessThanOrEqual(160)
  })

  it('keeps group ids stable when source edge order changes', () => {
    const source = graphOf(800)
    const first = projectBrainGraphHierarchy({
      ...source,
      truncated: false,
    })
    const second = projectBrainGraphHierarchy({
      nodes: [...source.nodes].reverse(),
      edges: [...source.edges].reverse(),
      truncated: false,
    })

    expect(first.nodes.map((node) => node.id).sort()).toEqual(
      second.nodes.map((node) => node.id).sort(),
    )
  })

  it('aggregates repeated relationships between groups into weighted edges', () => {
    const source = graphOf(400)
    // Cross-kind chords ensure several source relationships collapse onto the
    // same overview pair.
    for (let index = 0; index < 100; index += 1) {
      source.edges.push({
        id: `chord-${index}`,
        source: source.nodes[index]!.id,
        target: source.nodes[index + 200]!.id,
        type: index % 2 === 0 ? 'mentions' : 'related',
        sensitivity: index === 0 ? 'confidential' : 'internal',
      })
    }
    const result = projectBrainGraphHierarchy({
      ...source,
      truncated: false,
    })

    expect(result.edges.some((edge) => edge.count > 1)).toBe(true)
    expect(result.edges.every((edge) => edge.source !== edge.target)).toBe(true)
  })
})
