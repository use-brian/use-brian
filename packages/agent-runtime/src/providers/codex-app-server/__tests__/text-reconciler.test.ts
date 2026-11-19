import { describe, expect, it } from 'vitest'
import { CodexTextReconciler, CodexTextReconciliationError } from '../text-reconciler.js'

const ITEM_LIMIT = 8 * 1024 * 1024

function expectFailure(run: () => unknown, reason: string): void {
  expect(run).toThrow(CodexTextReconciliationError)
  expect(run).toThrow(`Codex text reconciliation failed: ${reason}`)
}

describe('CodexTextReconciler', () => {
  it('uses item creation order even when the earlier item had no deltas', () => {
    const reconciler = new CodexTextReconciler()
    reconciler.start('earlier')
    reconciler.delta('later', 'Later')
    expectFailure(() => reconciler.complete({ id: 'earlier', text: 'Earlier' }), 'snapshot_order')
  })

  it('recovers an ordered full turn atomically and deduplicates it', () => {
    const reconciler = new CodexTextReconciler()
    const snapshots = [{ id: 'a', text: 'Hello' }, { id: 'b', text: ' world' }]
    expect(reconciler.completeTurn(snapshots)).toEqual(['Hello', ' world'])
    expect(reconciler.completeTurn(snapshots)).toEqual(['', ''])
  })

  it('refuses to append a previously unseen earlier item after a later item streamed', () => {
    const reconciler = new CodexTextReconciler()
    reconciler.delta('later', 'Later')
    expectFailure(() => reconciler.completeTurn([{ id: 'earlier', text: 'Earlier' }, { id: 'later', text: 'Later' }]), 'snapshot_order')
  })

  it('detects an authoritative order conflicting with earlier completion observations', () => {
    const reconciler = new CodexTextReconciler()
    reconciler.delta('later', 'Later')
    reconciler.complete({ id: 'earlier', text: 'Earlier' })
    expectFailure(() => reconciler.completeTurn([{ id: 'earlier', text: 'Earlier' }, { id: 'later', text: 'Later' }]), 'snapshot_order')
  })

  it('rejects duplicate identities without adopting any snapshot state', () => {
    const reconciler = new CodexTextReconciler()
    expectFailure(() => reconciler.completeTurn([{ id: 'a', text: 'One' }, { id: 'a', text: 'Two' }]), 'snapshot_order')
    expect(reconciler.complete({ id: 'a', text: 'Other' })).toBe('Other')
  })

  it('does not adopt an earlier repair when a later snapshot violates the text bound', () => {
    const reconciler = new CodexTextReconciler()
    reconciler.delta('a', 'O')
    expectFailure(() => reconciler.completeTurn([{ id: 'a', text: 'Okey' }, { id: 'b', text: 'X'.repeat(ITEM_LIMIT + 1) }]), 'text_limit')
    expect(reconciler.complete({ id: 'a', text: 'Other' })).toBe('ther')
  })

  it('preserves ordinary interleaved deltas when the full turn needs no repair', () => {
    const reconciler = new CodexTextReconciler()
    reconciler.delta('a', 'ha')
    reconciler.delta('b', '!')
    reconciler.delta('a', 'ha')
    expect(reconciler.completeTurn([{ id: 'a', text: 'haha' }, { id: 'b', text: '!' }])).toEqual(['', ''])
  })

  it('publishes a full snapshot with no deltas and deduplicates item/turn snapshots', () => {
    const reconciler = new CodexTextReconciler()
    expect(reconciler.complete({ id: 'a', text: 'Hello' })).toBe('Hello')
    expect(reconciler.complete({ id: 'a', text: 'Hello' })).toBe('')
  })

  it('publishes only the missing suffix after partial deltas', () => {
    const reconciler = new CodexTextReconciler()
    expect(reconciler.delta('a', 'H')).toBe('H')
    expect(reconciler.delta('a', 'el')).toBe('el')
    expect(reconciler.complete({ id: 'a', text: 'Hello' })).toBe('lo')
    expect(reconciler.complete({ id: 'a', text: 'Hello' })).toBe('')
  })

  it('publishes nothing for a fully streamed or empty snapshot', () => {
    const reconciler = new CodexTextReconciler()
    expect(reconciler.delta('a', 'Hello')).toBe('Hello')
    expect(reconciler.complete({ id: 'a', text: 'Hello' })).toBe('')
    expect(reconciler.complete({ id: 'empty', text: '' })).toBe('')
    expect(reconciler.complete({ id: 'empty', text: '' })).toBe('')
  })

  it('reconciles two items independently, even when their text is identical', () => {
    const reconciler = new CodexTextReconciler()
    const output = [
      reconciler.delta('a', 'Hel'),
      reconciler.complete({ id: 'a', text: 'Hello' }),
      reconciler.complete({ id: 'b', text: 'Hello' }),
      reconciler.complete({ id: 'a', text: 'Hello' }),
      reconciler.complete({ id: 'b', text: 'Hello' }),
    ].join('')
    expect(output).toBe('HelloHello')
  })

  it('preserves ordinary interleaving and repeated delta content verbatim', () => {
    const reconciler = new CodexTextReconciler()
    expect([
      reconciler.delta('a', 'ha'),
      reconciler.delta('b', '!'),
      reconciler.delta('a', 'ha'),
    ].join('')).toBe('ha!ha')
    expect(reconciler.complete({ id: 'b', text: '!' })).toBe('')
    expect(reconciler.complete({ id: 'a', text: 'haha' })).toBe('')
  })

  it('ignores all late deltas after an authoritative completion', () => {
    const reconciler = new CodexTextReconciler()
    reconciler.delta('a', 'Hel')
    reconciler.complete({ id: 'a', text: 'Hello' })
    for (const delta of ['lo', 'Hello', 'unrelated', '']) {
      expect(reconciler.delta('a', delta)).toBe('')
    }
    expect(reconciler.complete({ id: 'a', text: 'Hello' })).toBe('')
  })

  it.each(['Different private text', 'Priv', ''])('rejects non-prefix snapshots without exposing text: %j', text => {
    const reconciler = new CodexTextReconciler()
    reconciler.delta('private-item-id', 'Private streamed text')
    expectFailure(() => reconciler.complete({ id: 'private-item-id', text }), 'snapshot_conflict')
    try {
      reconciler.complete({ id: 'private-item-id', text })
    } catch (error) {
      expect(String(error)).not.toContain('private-item-id')
      expect(String(error)).not.toContain('Private streamed text')
      expect(JSON.stringify(error)).not.toContain('private-item-id')
      expect(JSON.stringify(error)).not.toContain('Private streamed text')
    }
    // Failure must not mutate the stored prefix or mark it completed.
    expect(reconciler.complete({ id: 'private-item-id', text: 'Private streamed text!' })).toBe('!')
  })

  it.each(['Hello!', 'Hell', 'Other'])('rejects any changed snapshot after completion: %s', text => {
    const reconciler = new CodexTextReconciler()
    reconciler.complete({ id: 'a', text: 'Hello' })
    expectFailure(() => reconciler.complete({ id: 'a', text }), 'snapshot_conflict')
    expect(reconciler.complete({ id: 'a', text: 'Hello' })).toBe('')
  })

  it('rejects suffix repair behind a later emitted item, but accepts exact snapshots in either order', () => {
    const reconciler = new CodexTextReconciler()
    reconciler.delta('a', 'Hel')
    reconciler.delta('b', 'World')
    expectFailure(() => reconciler.complete({ id: 'a', text: 'Hello' }), 'snapshot_order')
    expect(reconciler.complete({ id: 'b', text: 'World!' })).toBe('!')
    expect(reconciler.complete({ id: 'a', text: 'Hel' })).toBe('')
  })

  it('does not treat resuming an earlier delta stream as permission to reorder a repair', () => {
    const reconciler = new CodexTextReconciler()
    reconciler.delta('a', 'H')
    reconciler.delta('b', 'World')
    reconciler.delta('a', 'el')
    expectFailure(() => reconciler.complete({ id: 'a', text: 'Hello' }), 'snapshot_order')
  })

  it('tracks empty items without treating empty later frames as published text', () => {
    const reconciler = new CodexTextReconciler()
    reconciler.delta('a', '')
    reconciler.delta('b', '')
    expect(reconciler.complete({ id: 'a', text: 'Hello' })).toBe('Hello')
    expect(reconciler.complete({ id: 'b', text: 'World' })).toBe('World')
    const other = new CodexTextReconciler()
    other.delta('a', '')
    other.delta('b', 'World')
    expectFailure(() => other.complete({ id: 'a', text: 'Hello' }), 'snapshot_order')
  })

  it('clears completion, prefixes, ordering and IDs between turns and isolates instances', () => {
    const reconciler = new CodexTextReconciler()
    const other = new CodexTextReconciler()
    reconciler.delta('a', 'old')
    reconciler.complete({ id: 'b', text: 'later' })
    expect(other.complete({ id: 'a', text: 'independent' })).toBe('independent')
    reconciler.clear()
    expect(reconciler.delta('b', 'new')).toBe('new')
    expect(reconciler.complete({ id: 'b', text: 'new turn' })).toBe(' turn')
    expect(reconciler.complete({ id: 'a', text: 'fresh' })).toBe('fresh')
    expect(other.complete({ id: 'a', text: 'independent' })).toBe('')
  })

  it('enforces the per-item limit on both paths before growing state', () => {
    const full = 'x'.repeat(ITEM_LIMIT)
    const reconciler = new CodexTextReconciler()
    expectFailure(() => reconciler.complete({ id: 'oversize', text: full + 'x' }), 'text_limit')
    expectFailure(() => reconciler.delta('oversize', full + 'x'), 'text_limit')
    expect(reconciler.delta('a', full)).toBe(full)
    expectFailure(() => reconciler.delta('a', 'x'), 'text_limit')
    expectFailure(() => reconciler.complete({ id: 'a', text: full + 'x' }), 'text_limit')
    expect(reconciler.complete({ id: 'a', text: full })).toBe('')
    expect(reconciler.delta('a', full + 'x')).toBe('')
    expect(reconciler.complete({ id: 'oversize', text: 'ok' })).toBe('ok')
  })

  it('enforces the aggregate limit on both paths, counts snapshots once, and resets the budget', () => {
    const full = 'x'.repeat(ITEM_LIMIT)
    const reconciler = new CodexTextReconciler()
    for (let i = 0; i < 4; i++) {
      expect(reconciler.delta(String(i), full)).toBe(full)
      expect(reconciler.complete({ id: String(i), text: full })).toBe('')
      expect(reconciler.complete({ id: String(i), text: full })).toBe('')
    }
    expectFailure(() => reconciler.delta('next', 'x'), 'text_limit')
    expectFailure(() => reconciler.complete({ id: 'next', text: 'x' }), 'text_limit')
    reconciler.clear()
    expect(reconciler.complete({ id: 'next', text: full })).toBe(full)
  })

  it('counts completion suffixes toward the aggregate budget', () => {
    const full = 'x'.repeat(ITEM_LIMIT)
    const reconciler = new CodexTextReconciler()
    for (let i = 0; i < 3; i++) reconciler.complete({ id: String(i), text: full })
    reconciler.delta('last', full.slice(1))
    expectFailure(() => reconciler.delta('extra', 'xx'), 'text_limit')
    expect(reconciler.complete({ id: 'last', text: full })).toBe('x')
    expectFailure(() => reconciler.complete({ id: 'extra', text: 'x' }), 'text_limit')
  })

  it('caps tracked items including empty ones, preserves existing entries, and clears the cap', () => {
    const reconciler = new CodexTextReconciler()
    for (let i = 0; i < 1024; i++) {
      if (i % 2) reconciler.complete({ id: String(i), text: '' })
      else reconciler.delta(String(i), '')
    }
    expectFailure(() => reconciler.delta('overflow', ''), 'item_limit')
    expectFailure(() => reconciler.complete({ id: 'overflow', text: '' }), 'item_limit')
    expect(reconciler.delta('0', 'still tracked')).toBe('still tracked')
    expect(reconciler.complete({ id: '0', text: 'still tracked' })).toBe('')
    reconciler.clear()
    expect(reconciler.complete({ id: 'overflow', text: 'new' })).toBe('new')
  })
})
