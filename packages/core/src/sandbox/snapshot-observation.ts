import type { BrowserSnapshot, BrowserSnapshotNode } from './types.js'

export type ObservationMode = 'auto' | 'full' | 'diff'
type Row = { id: string; identity: string; node: BrowserSnapshotNode }
// DOM node identity is scoped to a document. Names, values, positions and
// scan-local provider refs cannot establish that an element survived a scan.
const identity = (n: BrowserSnapshotNode) => JSON.stringify([n.nodeId, !!n.ref])
export const renderSnapshotNode = (n: BrowserSnapshotNode) => `${n.ref ? `${n.ref} ` : ''}${n.role} ${JSON.stringify(n.name)}${n.value !== undefined ? ` value=${JSON.stringify(n.value)}` : ''}${n.disabled ? ' (disabled)' : ''}${n.checked !== undefined ? ` checked=${n.checked}` : ''}${n.required ? ' (required)' : ''}${n.invalid ? ` invalid=${JSON.stringify(n.invalid)}` : ''}`
const line = renderSnapshotNode

/** Session-owned state. Future compound actions should resolve every public ref through
 * resolve(), and observe() their final provider snapshot under the same tool lock.
 * Provider refs are scan-local and must never escape this adapter.
 * Requires documentId to change on document replacement and nodeId to identify
 * the same actual DOM node for that document's lifetime (never a recycled index).
 * All rows, including informational nodes, need unique nodeIds to seed a delta.
 * The renderer must honor the supplied offset/limit; only that window is bound.
 */
export class SnapshotObservationState {
  private serial = 0
  private version = 0
  private baseline?: { rows: Row[]; scope: string; url: string; documentId: string; version: number }
  private bindings = new Map<string, string>()

  reset(): void {
    this.baseline = undefined
    this.bindings.clear()
  }

  resolve(ref: string): string {
    const provider = this.bindings.get(ref)
    if (!provider) throw new Error(`Stale or unknown browser ref ${ref}; take browserSnapshot again.`)
    return provider
  }

  observe(snapshot: BrowserSnapshot, options: {
    scope: string
    mode?: 'interactive' | 'full'
    observation?: ObservationMode
    offset?: number
    limit?: number
    /** Full renderer retains the existing pagination contract. */
    render: (snapshot: BrowserSnapshot) => string
  }): { rendered: string; snapshot: BrowserSnapshot; refLabels: Map<string, string> } {
    const observation = options.observation ?? 'auto'
    const scope = JSON.stringify([options.scope, options.mode ?? 'interactive'])
    const nodeIds = snapshot.nodes.map(node => node.nodeId)
    const unknownIdentity = !snapshot.documentId || nodeIds.some(id => !id) || new Set(nodeIds).size !== nodeIds.length
    const offset = options.offset ?? 0
    const end = Math.min(offset + (options.limit ?? 150), snapshot.nodes.length)
    const incomplete = offset !== 0 || end < snapshot.nodes.length
    if (observation === 'full' || unknownIdentity || incomplete || this.baseline?.scope !== scope || this.baseline?.url !== snapshot.url || this.baseline?.documentId !== snapshot.documentId) this.reset()
    const previous = this.baseline
    const prior = new Map(previous?.rows.map(row => [row.identity, row]) ?? [])
    this.bindings.clear()
    const rows = snapshot.nodes.map((node, index): Row => {
      const key = identity(node)
      const id = prior.get(key)?.id ?? `@e${++this.serial}`
      if (node.ref && index >= offset && index < end) this.bindings.set(id, node.ref)
      // Strip private identity metadata even from the full renderer input.
      const { nodeId: _nodeId, ...publicNode } = node
      return { id, identity: key, node: { ...publicNode, ...(node.ref ? { ref: id } : {}) } }
    })
    const publicSnapshot: BrowserSnapshot = { url: snapshot.url, title: snapshot.title, nodes: rows.map(row => row.node) }
    const version = ++this.version
    const full = `Observation v${version} full\n${options.render(publicSnapshot)}`
    let rendered = full
    if (previous) {
      const current = new Map(rows.map(row => [row.id, row]))
      const old = new Map(previous.rows.map(row => [row.id, row]))
      // Zero-based removal positions refer to the old view; additions/changes
      // refer to the new view. Informational rows never acquire action refs.
      const changes: string[] = []
      for (const [index, row] of previous.rows.entries()) if (!current.has(row.id)) changes.push(`- [${index}] ${line(row.node)}`)
      for (const [index, row] of rows.entries()) {
        const before = old.get(row.id)
        if (!before) changes.push(`+ [${index}] ${line(row.node)}`)
        else if (JSON.stringify(before.node) !== JSON.stringify(row.node) || previous.rows[index]?.id !== row.id) changes.push(`~ [${index}] ${line(row.node)}`)
      }
      const diff = `Observation v${version} diff from v${previous.version}\nPage: ${snapshot.title || '(untitled)'}\nURL: ${snapshot.url}\n${changes.join('\n') || 'No changes.'}`
      if (observation === 'diff' || diff.length < full.length) rendered = diff
    }
    // A paginated or downstream-truncated observation cannot seed a delta.
    this.baseline = incomplete || unknownIdentity || rendered.length > 20_000 ? undefined : { rows, scope, url: snapshot.url, documentId: snapshot.documentId!, version }
    return { rendered, snapshot: publicSnapshot, refLabels: new Map(rows.slice(offset, end).flatMap(row => row.node.ref ? [[row.node.ref, row.node.name]] : [])) }
  }
}
