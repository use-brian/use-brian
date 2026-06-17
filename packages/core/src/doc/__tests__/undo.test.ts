/**
 * [COMP:doc/undo] Single-step undo bridge — `buildUndoEntry` /
 * `applyUndoEntry` / `isUndoEntryStale`.
 *
 * Property under test: applying the stored undo entry to the post-patch
 * page reverts back to the pre-patch page byte-for-byte. Single-step:
 * applying the same entry twice must fail (the caller is expected to
 * clear `saved_views.last_undo` after the first apply, but even without
 * that, the version-mismatch guard makes a second apply error out).
 */

import { describe, expect, it } from 'vitest'
import { applyOps } from '../ops.js'
import type {
  HeadingBlock,
  Op,
  Page,
  TextBlock,
  VersionedPage,
} from '../page-types.js'
import {
  applyUndoEntry,
  buildUndoEntry,
  isUndoEntryStale,
  type UndoEntry,
} from '../undo.js'

// ── helpers ──────────────────────────────────────────────────────────

const headingBlock = (
  id: string,
  text: string,
  level: 1 | 2 | 3 = 1,
): HeadingBlock => ({
  kind: 'heading',
  id,
  level,
  text,
})

const textBlock = (id: string, text: string): TextBlock => ({
  kind: 'text',
  id,
  text,
})

/** Make a fresh sequential id generator for deterministic tests. */
const makeIdGen = (prefix = 'gen') => {
  let i = 0
  return () => `${prefix}-${++i}`
}

// ── buildUndoEntry ───────────────────────────────────────────────────

describe('[COMP:doc/undo] buildUndoEntry', () => {
  it('produces an entry with ISO timestamp, version, and inverse ops', () => {
    const pre: VersionedPage = { blocks: [], version: 3, title: 'Page' }
    const ops: Op[] = [
      { op: 'add', after: 'start', block: headingBlock('tmp-1', 'Hi') },
    ]
    const { idMap } = applyOps(pre, ops, makeIdGen())
    const entry = buildUndoEntry(pre, ops, idMap, 4)

    expect(entry.resultingVersion).toBe(4)
    expect(entry.appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    expect(entry.inverseOps).toHaveLength(1)
    expect(entry.inverseOps[0].op).toBe('delete')
    expect(entry.idMap).toEqual(idMap)
  })

  it('captures inverse for edit with prior values', () => {
    const pre: Page = { blocks: [headingBlock('b1', 'old', 1)] }
    const ops: Op[] = [
      { op: 'edit', blockId: 'b1', patch: { text: 'new', level: 2 } },
    ]
    const { idMap } = applyOps(pre, ops, makeIdGen())
    const entry = buildUndoEntry(pre, ops, idMap, 2)

    expect(entry.inverseOps).toEqual([
      {
        op: 'edit',
        blockId: 'b1',
        patch: { text: 'old', level: 1 },
      },
    ])
  })

  it('captures inverse for delete (re-add with the original block)', () => {
    const original = headingBlock('b1', 'gone', 3)
    const pre: Page = { blocks: [original, headingBlock('b2', 'stays')] }
    const ops: Op[] = [{ op: 'delete', blockId: 'b1' }]
    const { idMap } = applyOps(pre, ops, makeIdGen())
    const entry = buildUndoEntry(pre, ops, idMap, 2)

    expect(entry.inverseOps).toEqual([
      { op: 'add', after: 'start', block: original },
    ])
  })

  it('persists the idMap on the entry verbatim', () => {
    const pre: Page = { blocks: [] }
    const ops: Op[] = [
      { op: 'add', after: 'start', block: textBlock('tmp-7', 'first') },
    ]
    const { idMap } = applyOps(pre, ops, makeIdGen())
    const entry = buildUndoEntry(pre, ops, idMap, 2)

    expect(entry.idMap).toEqual(idMap)
    expect(entry.idMap?.['tmp-7']).toBe('gen-1')
  })
})

// ── applyUndoEntry — round-trip ──────────────────────────────────────

describe('[COMP:doc/undo] applyUndoEntry — round-trip', () => {
  it('reverts a single-op add back to the pre-state', () => {
    const pre: VersionedPage = { blocks: [], version: 1, title: '' }
    const ops: Op[] = [
      { op: 'add', after: 'start', block: headingBlock('tmp-1', 'Heading') },
    ]
    const { page: post, idMap } = applyOps(pre, ops, makeIdGen())
    const entry = buildUndoEntry(pre, ops, idMap, 2)

    const { page: reverted, nextVersion } = applyUndoEntry(post, 2, entry)
    expect(reverted.blocks).toEqual(pre.blocks)
    expect(nextVersion).toBe(3)
  })

  it('reverts a multi-op patch (add + edit + move + setTitle) back to pre-state byte-for-byte', () => {
    const pre: VersionedPage = {
      blocks: [headingBlock('h1', 'Top'), textBlock('p1', 'body')],
      version: 5,
      title: 'Original',
    }
    const ops: Op[] = [
      { op: 'add', after: 'h1', block: textBlock('tmp-1', 'inserted') },
      { op: 'edit', blockId: 'h1', patch: { text: 'New Top', level: 2 } },
      { op: 'move', blockId: 'p1', after: 'start' },
      { op: 'setTitle', title: 'Renamed' },
    ]
    const { page: post, idMap } = applyOps(pre, ops, makeIdGen())
    const entry = buildUndoEntry(pre, ops, idMap, 6)

    const { page: reverted } = applyUndoEntry(post, 6, entry)
    expect(reverted.blocks).toEqual(pre.blocks)
    expect((reverted as VersionedPage).title).toBe(pre.title)
  })

  it('reverts a delete by reinstating the captured block at its prior position', () => {
    const pre: Page = {
      blocks: [
        headingBlock('b1', 'one'),
        headingBlock('b2', 'two'),
        headingBlock('b3', 'three'),
      ],
    }
    const ops: Op[] = [{ op: 'delete', blockId: 'b2' }]
    const { page: post, idMap } = applyOps(pre, ops, makeIdGen())
    const entry = buildUndoEntry(pre, ops, idMap, 2)

    const { page: reverted } = applyUndoEntry(post, 2, entry)
    expect(reverted.blocks).toEqual(pre.blocks)
  })

  it('returns nextVersion = currentVersion + 1', () => {
    const pre: VersionedPage = { blocks: [], version: 10, title: '' }
    const ops: Op[] = [
      { op: 'add', after: 'start', block: textBlock('tmp-1', 'x') },
    ]
    const { page: post, idMap } = applyOps(pre, ops, makeIdGen())
    const entry = buildUndoEntry(pre, ops, idMap, 11)

    const { nextVersion } = applyUndoEntry(post, 11, entry)
    expect(nextVersion).toBe(12)
  })
})

// ── applyUndoEntry — version mismatch ────────────────────────────────

describe('[COMP:doc/undo] applyUndoEntry — version mismatch', () => {
  it('throws a clear error when currentVersion does not match resultingVersion', () => {
    const pre: Page = { blocks: [headingBlock('b1', 'x')] }
    const ops: Op[] = [
      { op: 'edit', blockId: 'b1', patch: { text: 'y' } },
    ]
    const { page: post, idMap } = applyOps(pre, ops, makeIdGen())
    const entry = buildUndoEntry(pre, ops, idMap, 2)

    expect(() => applyUndoEntry(post, 5, entry)).toThrow(
      /undo conflict: expected page version 2, got 5/,
    )
  })

  it('throws when currentVersion is behind resultingVersion (page reverted elsewhere)', () => {
    const pre: Page = { blocks: [headingBlock('b1', 'x')] }
    const ops: Op[] = [
      { op: 'edit', blockId: 'b1', patch: { text: 'y' } },
    ]
    const { page: post, idMap } = applyOps(pre, ops, makeIdGen())
    const entry = buildUndoEntry(pre, ops, idMap, 7)

    expect(() => applyUndoEntry(post, 6, entry)).toThrow(/undo conflict/)
  })

  it('does not mutate the input page when version mismatch fires', () => {
    const pre: Page = { blocks: [headingBlock('b1', 'x')] }
    const ops: Op[] = [
      { op: 'edit', blockId: 'b1', patch: { text: 'y' } },
    ]
    const { page: post, idMap } = applyOps(pre, ops, makeIdGen())
    const entry = buildUndoEntry(pre, ops, idMap, 2)
    const snapshot = JSON.stringify(post)

    expect(() => applyUndoEntry(post, 99, entry)).toThrow()
    expect(JSON.stringify(post)).toBe(snapshot)
  })
})

// ── applyUndoEntry — single-step semantics ───────────────────────────

describe('[COMP:doc/undo] applyUndoEntry — single-step', () => {
  it('applying the same entry twice errors on the second call (version drift after revert)', () => {
    const pre: VersionedPage = { blocks: [], version: 1, title: '' }
    const ops: Op[] = [
      { op: 'add', after: 'start', block: textBlock('tmp-1', 'transient') },
    ]
    const { page: post, idMap } = applyOps(pre, ops, makeIdGen())
    const entry = buildUndoEntry(pre, ops, idMap, 2)

    // First apply succeeds — reverts the page, bumps to v3.
    const { page: reverted, nextVersion } = applyUndoEntry(post, 2, entry)
    expect(nextVersion).toBe(3)

    // Second apply on the reverted page fails — the entry's
    // resultingVersion is still 2, but the caller is now at v3. Caller
    // is responsible for clearing `last_undo` after the first apply;
    // even if they don't, the version guard prevents a wild revert.
    expect(() => applyUndoEntry(reverted, nextVersion, entry)).toThrow(
      /undo conflict/,
    )
  })
})

// ── isUndoEntryStale ─────────────────────────────────────────────────

describe('[COMP:doc/undo] isUndoEntryStale', () => {
  it('returns false for a just-created entry', () => {
    const entry: UndoEntry = {
      appliedAt: new Date().toISOString(),
      resultingVersion: 1,
      inverseOps: [],
    }
    expect(isUndoEntryStale(entry)).toBe(false)
  })

  it('returns true for an entry older than the default 7 days', () => {
    const eightDaysAgo = new Date(
      Date.now() - 8 * 24 * 60 * 60 * 1000,
    ).toISOString()
    const entry: UndoEntry = {
      appliedAt: eightDaysAgo,
      resultingVersion: 1,
      inverseOps: [],
    }
    expect(isUndoEntryStale(entry)).toBe(true)
  })

  it('respects a custom maxAgeMs threshold', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    const entry: UndoEntry = {
      appliedAt: fiveMinAgo,
      resultingVersion: 1,
      inverseOps: [],
    }
    // 1-minute window — 5 minutes old is stale.
    expect(isUndoEntryStale(entry, 60 * 1000)).toBe(true)
    // 10-minute window — 5 minutes old is fresh.
    expect(isUndoEntryStale(entry, 10 * 60 * 1000)).toBe(false)
  })

  it('returns true for an entry right at the boundary (1ms over)', () => {
    const justOver = new Date(Date.now() - 1001).toISOString()
    const entry: UndoEntry = {
      appliedAt: justOver,
      resultingVersion: 1,
      inverseOps: [],
    }
    expect(isUndoEntryStale(entry, 1000)).toBe(true)
  })
})

// ── Integrated chain ─────────────────────────────────────────────────

describe('[COMP:doc/undo] integrated chain — build → apply → discard', () => {
  it('forward patch → store undo → user Cmd-Z → entry must be cleared (single-step)', () => {
    // Pre-state: a page with two blocks at v1.
    const pre: VersionedPage = {
      blocks: [headingBlock('h1', 'Title'), textBlock('p1', 'Para')],
      version: 1,
      title: 'Doc',
    }

    // User submits a multi-op patch.
    const forwardOps: Op[] = [
      { op: 'add', after: 'p1', block: textBlock('tmp-1', 'New para') },
      { op: 'setTitle', title: 'Renamed' },
    ]
    const { page: post, idMap } = applyOps(pre, forwardOps, makeIdGen())

    // patchPage builds the undo entry and persists it on saved_views.last_undo.
    const entry = buildUndoEntry(pre, forwardOps, idMap, 2)

    // User hits Cmd-Z. The chat tool / route reads `last_undo` and
    // calls applyUndoEntry.
    const { page: reverted, nextVersion } = applyUndoEntry(post, 2, entry)

    // Page is back to the pre-state blocks + title.
    expect(reverted.blocks).toEqual(pre.blocks)
    expect((reverted as VersionedPage).title).toBe(pre.title)
    expect(nextVersion).toBe(3)

    // Caller is now expected to clear `last_undo`. If they re-attempt
    // the same undo, the version guard fires — undo is single-step by
    // construction.
    expect(() => applyUndoEntry(reverted, nextVersion, entry)).toThrow(
      /undo conflict/,
    )
  })
})
