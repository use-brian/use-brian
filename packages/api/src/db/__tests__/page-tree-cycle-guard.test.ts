/**
 * [COMP:doc/page-tree-store] reparentWouldCycle — pure cycle guard.
 *
 * Fast unit test for the cycle-detection helper used by
 * `SavedViewStore.reparent`. No DB: the ancestor chain is supplied as a
 * plain map so the guard logic is exercised in isolation.
 */

import { describe, expect, it } from 'vitest'
import { reparentWouldCycle } from '../saved-views-store.js'

// Tree:  root(null)  →  A  →  B  →  C
//                         └─→  D
const PARENT_OF: Record<string, string | null> = {
  A: null,
  B: 'A',
  C: 'B',
  D: 'A',
}

const parentOf = (id: string): string | null | undefined =>
  id in PARENT_OF ? PARENT_OF[id] : undefined

describe('[COMP:doc/page-tree-store] reparentWouldCycle', () => {
  it('allows promoting to root (newParentId = null)', () => {
    expect(reparentWouldCycle('C', null, parentOf)).toBe(false)
  })

  it('rejects parenting a page under itself', () => {
    expect(reparentWouldCycle('B', 'B', parentOf)).toBe(true)
  })

  it('rejects parenting a page under its direct child', () => {
    // Moving A under B — but B is a descendant of A → cycle.
    expect(reparentWouldCycle('A', 'B', parentOf)).toBe(true)
  })

  it('rejects parenting a page under a deep descendant', () => {
    // Moving A under C (A → B → C) → cycle.
    expect(reparentWouldCycle('A', 'C', parentOf)).toBe(true)
  })

  it('allows parenting under an unrelated subtree', () => {
    // Moving C under D — D is not below C → safe.
    expect(reparentWouldCycle('C', 'D', parentOf)).toBe(false)
  })

  it('allows parenting a leaf under a sibling-subtree node', () => {
    expect(reparentWouldCycle('D', 'C', parentOf)).toBe(false)
  })

  it('treats a corrupt (already-cyclic) chain as a cycle via the depth bound', () => {
    // Self-referential parent map: X → X. Walking up never terminates;
    // the maxDepth guard must classify it as a cycle rather than hang.
    const corrupt = (id: string): string | null | undefined => (id === 'X' ? 'X' : undefined)
    expect(reparentWouldCycle('moving', 'X', corrupt, 5)).toBe(true)
  })

  it('stops the walk on an unknown ancestor (undefined) without a cycle', () => {
    // newParent points at an id we can't resolve → not a cycle (the move
    // is decided not-a-cycle here; the store separately rejects an
    // unresolvable parent as not-found).
    expect(reparentWouldCycle('moving', 'ghost', parentOf)).toBe(false)
  })
})
