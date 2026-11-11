const MAX_ITEM_CHARS = 8 * 1024 * 1024
const MAX_TOTAL_CHARS = 32 * 1024 * 1024
const MAX_ITEMS = 1024

type Failure = 'snapshot_conflict' | 'snapshot_order' | 'text_limit' | 'item_limit'

/** Deliberately contains neither item IDs nor model text. */
export class CodexTextReconciliationError extends Error {
  constructor(readonly reason: Failure) {
    super(`Codex text reconciliation failed: ${reason}`)
    this.name = 'CodexTextReconciliationError'
  }
}

type Item = { text: string; completed: boolean; order: number }

/** One native turn's agent-message text only; callers handle reasoning/phases. */
export class CodexTextReconciler {
  private readonly items = new Map<string, Item>()
  private totalChars = 0
  private latestPublishedOrder = -1

  /** Creation order is useful even when an item's deltas never arrive. */
  start(itemId: string): void {
    if (this.items.has(itemId)) return
    this.checkBounds(undefined, 0)
    this.add(itemId)
  }

  delta(itemId: string, delta: string): string {
    const item = this.items.get(itemId)
    // A snapshot is authoritative; even a nonmatching late frame cannot append.
    if (item?.completed) return ''
    const length = (item?.text.length ?? 0) + delta.length
    this.checkBounds(item, length)
    const state = item ?? this.add(itemId)
    // Check lengths before allocating a growing concatenation.
    state.text += delta
    this.totalChars += delta.length
    if (delta.length) this.latestPublishedOrder = Math.max(this.latestPublishedOrder, state.order)
    return delta
  }

  complete(snapshot: { id: string; text: string }): string {
    const item = this.items.get(snapshot.id)
    if (item?.completed) {
      if (snapshot.text !== item.text) throw new CodexTextReconciliationError('snapshot_conflict')
      return ''
    }
    this.checkBounds(item, snapshot.text.length)
    const previous = item?.text ?? ''
    if (!snapshot.text.startsWith(previous)) throw new CodexTextReconciliationError('snapshot_conflict')
    const missing = snapshot.text.length - previous.length
    // First-observed item order is conservative: ordinary interleaved deltas are
    // preserved, but cannot make an earlier item's repair safe after a later one.
    if (missing && item && item.order < this.latestPublishedOrder) {
      throw new CodexTextReconciliationError('snapshot_order')
    }
    const state = item ?? this.add(snapshot.id)
    const suffix = snapshot.text.slice(previous.length)
    state.text = snapshot.text
    state.completed = true
    this.totalChars += missing
    if (missing) this.latestPublishedOrder = Math.max(this.latestPublishedOrder, state.order)
    return suffix
  }

  /** Validate the authoritative item order and all repairs before publishing
   * any suffix. An unseen earlier item cannot be appended after streamed text.
   * The small state copy shares existing strings; it never clones text buffers.
   */
  completeTurn(snapshots: readonly { id: string; text: string }[]): string[] {
    const ids = new Set<string>()
    let lastPublishedPosition = -1
    let previousOrder = -1
    for (const [index, snapshot] of snapshots.entries()) {
      if (ids.has(snapshot.id)) throw new CodexTextReconciliationError('snapshot_order')
      ids.add(snapshot.id)
      const item = this.items.get(snapshot.id)
      if (item?.text) {
        if (item.order < previousOrder) throw new CodexTextReconciliationError('snapshot_order')
        previousOrder = item.order
        lastPublishedPosition = index
      }
    }
    for (let index = 0; index < lastPublishedPosition; index++) {
      const snapshot = snapshots[index]!
      if (snapshot.text.length > (this.items.get(snapshot.id)?.text.length ?? 0)) {
        throw new CodexTextReconciliationError('snapshot_order')
      }
    }
    const next = new CodexTextReconciler()
    for (const [id, item] of this.items) next.items.set(id, { ...item })
    next.totalChars = this.totalChars
    next.latestPublishedOrder = this.latestPublishedOrder
    const suffixes = snapshots.map(snapshot => next.complete(snapshot))
    this.items.clear()
    for (const [id, item] of next.items) this.items.set(id, item)
    this.totalChars = next.totalChars
    this.latestPublishedOrder = next.latestPublishedOrder
    return suffixes
  }

  /** Must be called between native turns, including after a failed turn. */
  clear(): void {
    this.items.clear()
    this.totalChars = 0
    this.latestPublishedOrder = -1
  }

  private checkBounds(item: Item | undefined, nextLength: number): void {
    if (!item && this.items.size >= MAX_ITEMS) throw new CodexTextReconciliationError('item_limit')
    // Limits count JS string code units, not UTF-8 bytes; no growing buffers are
    // allocated until both the per-item and aggregate budgets have been checked.
    if (nextLength > MAX_ITEM_CHARS || this.totalChars - (item?.text.length ?? 0) + nextLength > MAX_TOTAL_CHARS) {
      throw new CodexTextReconciliationError('text_limit')
    }
  }

  private add(id: string): Item {
    const item = { text: '', completed: false, order: this.items.size }
    this.items.set(id, item)
    return item
  }
}
