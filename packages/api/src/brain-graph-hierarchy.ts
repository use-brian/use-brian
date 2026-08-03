// [COMP:brain/graph-hierarchy]
/**
 * Server-side level-of-detail projection for the Brain graph.
 *
 * The source graph may contain thousands of clearance-scoped entries, but a
 * response is always a small navigation surface: overview groups, one scoped
 * group's children, or the bounded leaf scope containing a search match.
 * Hidden member ids never cross the HTTP boundary.
 *
 * Spec: docs/architecture/brain/graph-view.md -> "Server-side hierarchy".
 */

import { detectCommunities } from '@use-brian/shared'

export type BrainGraphSensitivity =
  | 'public'
  | 'internal'
  | 'confidential'
  | 'restricted'

type BrainGraphNodeBase = {
  id: string
  kind: string
  name: string
  sensitivity: BrainGraphSensitivity
  degree: number
}

export type BrainGraphSourceNode = BrainGraphNodeBase & {
  nodeType?: 'entry'
}

export type BrainGraphSourceEdge = {
  id: string
  source: string
  target: string
  type: string
  sensitivity: BrainGraphSensitivity
}

export type BrainGraphGroupNode = BrainGraphNodeBase & {
  nodeType: 'group'
  groupId: string
  memberCount: number
  kindCounts: Record<string, number>
  level: number
  expandable: true
}

export type BrainGraphProjectedNode = BrainGraphSourceNode | BrainGraphGroupNode

export type BrainGraphProjectedEdge = BrainGraphSourceEdge & {
  /** Number of source relationships represented by this edge. */
  count: number
}

export type BrainGraphHierarchyProjection = {
  nodes: BrainGraphProjectedNode[]
  edges: BrainGraphProjectedEdge[]
  truncated: boolean
  totalNodes: number
  groupedNodeCount: number
  scopeId: string | null
  parentScopeId: string | null
  scopeLabel: string | null
  focusNodeIds: string[]
  renderBudget: { nodes: number; edges: number }
}

type InternalGroup = BrainGraphGroupNode & {
  members: BrainGraphSourceNode[]
  parentId: string | null
  children: InternalGroup[]
}

type ProjectOptions = {
  nodes: BrainGraphSourceNode[]
  edges: BrainGraphSourceEdge[]
  truncated: boolean
  scopeId?: string | null
  focusQuery?: string | null
}

const RESPONSE_NODE_BUDGET = 200
const RESPONSE_EDGE_BUDGET = 600
const OVERVIEW_GROUP_BUDGET = 60
const DETAIL_ENTRY_BUDGET = 160
const GROUP_TARGET_SIZE = 120
const MIN_COMMUNITY_SIZE = 4
const LARGE_COMMUNITY_KEEP_COUNT = 48

const SENSITIVITY_RANK: Record<BrainGraphSensitivity, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
}

function maxSensitivity(
  a: BrainGraphSensitivity,
  b: BrainGraphSensitivity,
): BrainGraphSensitivity {
  return SENSITIVITY_RANK[a] >= SENSITIVITY_RANK[b] ? a : b
}

function compareNodes(a: BrainGraphSourceNode, b: BrainGraphSourceNode): number {
  if (b.degree !== a.degree) return b.degree - a.degree
  const byName = a.name.localeCompare(b.name)
  return byName !== 0 ? byName : a.id.localeCompare(b.id)
}

function compareGroups(a: InternalGroup, b: InternalGroup): number {
  if (b.memberCount !== a.memberCount) return b.memberCount - a.memberCount
  return a.groupId.localeCompare(b.groupId)
}

function membershipHash(ids: string[]): string {
  // FNV-1a over sorted ids. Membership-derived ids remain stable across edge
  // order and response order changes without exposing member ids to clients.
  let hash = 0x811c9dc5
  for (const id of ids) {
    for (let i = 0; i < id.length; i += 1) {
      hash ^= id.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193)
    }
    hash ^= 0
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

function pluralityKind(kindCounts: Record<string, number>): string {
  const ranked = Object.entries(kindCounts).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1]
    return a[0].localeCompare(b[0])
  })
  return ranked[0]?.[0] ?? 'other'
}

function makeGroup(
  members: BrainGraphSourceNode[],
  level: number,
  parentId: string | null,
): InternalGroup {
  const ordered = [...members].sort(compareNodes)
  const ids = members.map((node) => node.id).sort()
  const kindCounts: Record<string, number> = {}
  let sensitivity: BrainGraphSensitivity = 'public'
  for (const member of members) {
    kindCounts[member.kind] = (kindCounts[member.kind] ?? 0) + 1
    sensitivity = maxSensitivity(sensitivity, member.sensitivity)
  }
  const groupId = `brain-group:${level}:${membershipHash(ids)}`
  return {
    id: groupId,
    nodeType: 'group',
    groupId,
    kind: pluralityKind(kindCounts),
    name: ordered[0]?.name ?? 'Group',
    sensitivity,
    degree: 0,
    memberCount: members.length,
    kindCounts,
    level,
    expandable: true,
    members,
    parentId,
    children: [],
  }
}

function chunkMembers(
  members: BrainGraphSourceNode[],
  level: number,
  parentId: string | null,
): InternalGroup[] {
  const ordered = [...members].sort(compareNodes)
  const groups: InternalGroup[] = []
  for (let offset = 0; offset < ordered.length; offset += GROUP_TARGET_SIZE) {
    groups.push(
      makeGroup(ordered.slice(offset, offset + GROUP_TARGET_SIZE), level, parentId),
    )
  }
  return groups
}

function compactGroups(
  groups: InternalGroup[],
  level: number,
  parentId: string | null,
): InternalGroup[] {
  if (groups.length <= OVERVIEW_GROUP_BUDGET) return groups.sort(compareGroups)

  const ranked = [...groups].sort(compareGroups)
  const kept = ranked.slice(0, LARGE_COMMUNITY_KEEP_COUNT)
  const overflowByKind = new Map<string, BrainGraphSourceNode[]>()
  for (const group of ranked.slice(LARGE_COMMUNITY_KEEP_COUNT)) {
    const kind = pluralityKind(group.kindCounts)
    const bucket = overflowByKind.get(kind) ?? []
    bucket.push(...group.members)
    overflowByKind.set(kind, bucket)
  }
  const overflow = [...overflowByKind.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, members]) => makeGroup(members, level, parentId))

  return [...kept, ...overflow]
    .sort(compareGroups)
    .slice(0, OVERVIEW_GROUP_BUDGET)
}

function partitionMembers(
  members: BrainGraphSourceNode[],
  edges: BrainGraphSourceEdge[],
  level: number,
  parentId: string | null,
): InternalGroup[] {
  if (members.length === 0) return []

  const memberIds = new Set(members.map((member) => member.id))
  const localEdges = edges.filter(
    (edge) => memberIds.has(edge.source) && memberIds.has(edge.target),
  )
  const communities = detectCommunities(members, localEdges)
  const byCommunity = new Map<number, BrainGraphSourceNode[]>()
  for (const member of members) {
    const community = communities.byId.get(member.id) ?? -1
    const bucket = byCommunity.get(community) ?? []
    bucket.push(member)
    byCommunity.set(community, bucket)
  }

  const buckets: BrainGraphSourceNode[][] = []
  const tinyByKind = new Map<string, BrainGraphSourceNode[]>()
  for (const communityMembers of byCommunity.values()) {
    if (communityMembers.length >= MIN_COMMUNITY_SIZE) {
      buckets.push(communityMembers)
      continue
    }
    for (const member of communityMembers) {
      const bucket = tinyByKind.get(member.kind) ?? []
      bucket.push(member)
      tinyByKind.set(member.kind, bucket)
    }
  }
  for (const membersOfKind of tinyByKind.values()) buckets.push(membersOfKind)

  const split = buckets.flatMap((bucket) =>
    chunkMembers(bucket, level, parentId),
  )
  return compactGroups(split, level, parentId)
}

function buildHierarchy(
  nodes: BrainGraphSourceNode[],
  edges: BrainGraphSourceEdge[],
): InternalGroup[] {
  const top = partitionMembers(nodes, edges, 1, null)
  for (const group of top) {
    if (group.memberCount <= DETAIL_ENTRY_BUDGET) continue
    group.children = partitionMembers(group.members, edges, 2, group.groupId)
  }
  return top
}

function findGroup(groups: InternalGroup[], id: string): InternalGroup | null {
  for (const group of groups) {
    if (group.groupId === id) return group
    const child = group.children.find((candidate) => candidate.groupId === id)
    if (child) return child
  }
  return null
}

function groupContaining(
  groups: InternalGroup[],
  nodeId: string,
): InternalGroup | null {
  for (const group of groups) {
    if (!group.members.some((member) => member.id === nodeId)) continue
    const child = group.children.find((candidate) =>
      candidate.members.some((member) => member.id === nodeId),
    )
    return child ?? group
  }
  return null
}

function bestFocusMatches(
  nodes: BrainGraphSourceNode[],
  query: string,
): BrainGraphSourceNode[] {
  const normalized = query.trim().toLocaleLowerCase()
  if (normalized.length === 0) return []
  return nodes
    .filter((node) => node.name.toLocaleLowerCase().includes(normalized))
    .sort((a, b) => {
      const aName = a.name.toLocaleLowerCase()
      const bName = b.name.toLocaleLowerCase()
      const aPrefix = aName.startsWith(normalized) ? 1 : 0
      const bPrefix = bName.startsWith(normalized) ? 1 : 0
      if (bPrefix !== aPrefix) return bPrefix - aPrefix
      return compareNodes(a, b)
    })
}

function projectedGraph(
  sourceNodes: BrainGraphSourceNode[],
  sourceEdges: BrainGraphSourceEdge[],
  representatives: Array<BrainGraphSourceNode | InternalGroup>,
): { nodes: BrainGraphProjectedNode[]; edges: BrainGraphProjectedEdge[] } {
  const representativeByMember = new Map<string, string>()
  const internalGroupById = new Map<string, InternalGroup>()
  for (const representative of representatives) {
    if ('nodeType' in representative && representative.nodeType === 'group') {
      internalGroupById.set(representative.id, representative)
      for (const member of representative.members) {
        representativeByMember.set(member.id, representative.id)
      }
    } else {
      representativeByMember.set(representative.id, representative.id)
    }
  }

  const sourceIds = new Set(sourceNodes.map((node) => node.id))
  const edgeByPair = new Map<string, BrainGraphProjectedEdge>()
  for (const edge of sourceEdges) {
    if (!sourceIds.has(edge.source) || !sourceIds.has(edge.target)) continue
    const source = representativeByMember.get(edge.source)
    const target = representativeByMember.get(edge.target)
    if (!source || !target || source === target) continue
    const [a, b] = source < target ? [source, target] : [target, source]
    const key = `${a}\u0000${b}`
    const existing = edgeByPair.get(key)
    const aggregated = internalGroupById.has(a) || internalGroupById.has(b)
    if (existing) {
      existing.count += 1
      existing.sensitivity = maxSensitivity(existing.sensitivity, edge.sensitivity)
      if (existing.type !== edge.type) existing.type = 'aggregate'
      continue
    }
    edgeByPair.set(key, {
      id: aggregated ? `brain-group-edge:${membershipHash([a, b])}` : edge.id,
      source: a,
      target: b,
      type: aggregated ? 'aggregate' : edge.type,
      sensitivity: edge.sensitivity,
      count: 1,
    })
  }

  const allEdges = [...edgeByPair.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count
    return a.id.localeCompare(b.id)
  })
  const weightedDegree = new Map<string, number>()
  for (const edge of allEdges) {
    weightedDegree.set(
      edge.source,
      (weightedDegree.get(edge.source) ?? 0) + edge.count,
    )
    weightedDegree.set(
      edge.target,
      (weightedDegree.get(edge.target) ?? 0) + edge.count,
    )
  }

  const nodes = representatives.slice(0, RESPONSE_NODE_BUDGET).map((node) => {
    if ('nodeType' in node && node.nodeType === 'group') {
      const { members: _members, parentId: _parentId, children: _children, ...wire } = node
      return { ...wire, degree: weightedDegree.get(node.id) ?? 0 }
    }
    return node
  })
  const visibleIds = new Set(nodes.map((node) => node.id))
  const edges = allEdges
    .filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
    .slice(0, RESPONSE_EDGE_BUDGET)
  return { nodes, edges }
}

export function projectBrainGraphHierarchy(
  options: ProjectOptions,
): BrainGraphHierarchyProjection {
  const { nodes, edges, truncated } = options
  const topGroups = nodes.length > DETAIL_ENTRY_BUDGET
    ? buildHierarchy(nodes, edges)
    : []
  const focusMatches = bestFocusMatches(nodes, options.focusQuery ?? '')

  let scope = options.scopeId
    ? findGroup(topGroups, options.scopeId)
    : null
  if (focusMatches.length > 0) {
    scope = groupContaining(topGroups, focusMatches[0]!.id)
  }

  let scopeNodes = nodes
  let representatives: Array<BrainGraphSourceNode | InternalGroup>
  if (scope) {
    scopeNodes = scope.members
    representatives = scope.children.length > 0 ? scope.children : scope.members
  } else if (topGroups.length > 0) {
    representatives = topGroups
  } else {
    representatives = nodes
  }

  const projected = projectedGraph(scopeNodes, edges, representatives)
  const visibleIds = new Set(projected.nodes.map((node) => node.id))
  const focusNodeIds = focusMatches
    .map((node) => node.id)
    .filter((id) => visibleIds.has(id))
    .slice(0, 20)

  return {
    ...projected,
    truncated,
    totalNodes: nodes.length,
    groupedNodeCount: projected.nodes.reduce(
      (total, node) =>
        total + (node.nodeType === 'group' ? node.memberCount : 0),
      0,
    ),
    scopeId: scope?.groupId ?? null,
    parentScopeId: scope?.parentId ?? null,
    scopeLabel: scope?.name ?? null,
    focusNodeIds,
    renderBudget: {
      nodes: RESPONSE_NODE_BUDGET,
      edges: RESPONSE_EDGE_BUDGET,
    },
  }
}
