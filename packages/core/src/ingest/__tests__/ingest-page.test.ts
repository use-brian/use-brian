import { describe, it, expect, vi } from 'vitest'

import type { Block } from '../../views/blocks.js'
import {
  AUTHORED_BLOCK_KINDS,
  BLOCK_KIND_REGISTRY,
  MIN_AUTHORED_BLOCK_CHARS,
  authoredTextOf,
  distillPageToBrain,
  filterAuthoredBlocks,
  flattenBlocks,
  hashAuthoredContent,
  renderSectionContent,
  sectionAuthoredBlocks,
  type DistillPageDeps,
  type RunSectionEpisodeInput,
  type UpsertPageSource,
} from '../ingest-page.js'

// ── Helpers ───────────────────────────────────────────────────────────────

function richText(text: string): Record<string, unknown> {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }
}

function text(id: string, body: string): Block {
  return { kind: 'text', id, text: body }
}

function heading(id: string, level: 1 | 2 | 3 | 4, body: string): Block {
  return { kind: 'heading', id, level, text: body }
}

/** A `data` block — brain-derived, must be skipped. */
function dataBlock(id: string): Block {
  return { kind: 'data', id, binding: { entity: 'tasks', viewType: 'table' } }
}

function fakeDeps(): {
  deps: DistillPageDeps
  episodeCalls: RunSectionEpisodeInput[]
  upsertCalls: Parameters<UpsertPageSource>[0][]
} {
  const episodeCalls: RunSectionEpisodeInput[] = []
  const upsertCalls: Parameters<UpsertPageSource>[0][] = []
  let n = 0
  const deps: DistillPageDeps = {
    runSectionEpisode: vi.fn(async (input: RunSectionEpisodeInput) => {
      episodeCalls.push(input)
      n += 1
      return { episodeId: `ep-${n}` }
    }),
    upsertPageSource: vi.fn(async (args) => {
      upsertCalls.push(args)
    }),
  }
  return { deps, episodeCalls, upsertCalls }
}

describe('[COMP:ingest/doc-page-distillation] distillPageToBrain', () => {
  // ── Authored-layer filter (derived from the registry) ──────────────────

  describe('authored-layer filter', () => {
    it('classifies every block kind in the registry exhaustively', () => {
      // Every `Block` union member is classified — the registry is the single
      // source of truth for the skip-set, not a hardcoded `Set`.
      const kinds: Block['kind'][] = [
        'text', 'heading', 'divider', 'data', 'chart', 'diagram', 'callout',
        'code', 'quote', 'bulleted_list_item', 'numbered_list_item', 'to_do',
        'toggle', 'table', 'image', 'file', 'bookmark', 'video', 'audio',
        'child_page',
      ]
      for (const k of kinds) expect(BLOCK_KIND_REGISTRY[k]).toBeDefined()
    })

    it('derives the authored set from the registry, excluding data/chart and media', () => {
      // The set is computed from the registry, so `data`/`chart` (derived) and
      // media kinds are never authored — no hardcoded list to drift.
      expect(AUTHORED_BLOCK_KINDS.has('text')).toBe(true)
      expect(AUTHORED_BLOCK_KINDS.has('heading')).toBe(true)
      expect(AUTHORED_BLOCK_KINDS.has('callout')).toBe(true)
      expect(AUTHORED_BLOCK_KINDS.has('data')).toBe(false)
      expect(AUTHORED_BLOCK_KINDS.has('chart')).toBe(false)
      expect(AUTHORED_BLOCK_KINDS.has('image')).toBe(false)
      expect(AUTHORED_BLOCK_KINDS.has('divider')).toBe(false)
      // Equivalence: the derived set is exactly the registry's `authored` rows.
      const fromRegistry = (Object.keys(BLOCK_KIND_REGISTRY) as Block['kind'][])
        .filter((k) => BLOCK_KIND_REGISTRY[k] === 'authored')
      expect([...AUTHORED_BLOCK_KINDS].sort()).toEqual(fromRegistry.sort())
    })

    it('drops data/chart blocks and trivially short blocks, keeps real prose', () => {
      const blocks: Block[] = [
        text('t1', 'We decided to ship the new pricing model in Q3.'),
        dataBlock('d1'),
        { kind: 'chart', id: 'c1', chartType: 'kpi', data: { value: 42 } },
        text('t2', 'ok'), // too short (< MIN_AUTHORED_BLOCK_CHARS)
        { kind: 'image', id: 'i1', ref: null },
        { kind: 'divider', id: 'div1' },
      ]
      const kept = filterAuthoredBlocks(blocks)
      expect(kept.map((b) => b.id)).toEqual(['t1'])
    })

    it('keeps a short heading (it anchors its section) but drops a short paragraph', () => {
      const shortPara = 'tiny'
      expect(shortPara.length).toBeLessThan(MIN_AUTHORED_BLOCK_CHARS)
      const kept = filterAuthoredBlocks([
        heading('h1', 2, 'Q3'),
        text('t1', shortPara),
      ])
      expect(kept.map((b) => b.id)).toEqual(['h1'])
    })

    it('flattens callout/toggle children so each keeps its own id', () => {
      const blocks: Block[] = [
        {
          kind: 'callout',
          id: 'cal1',
          icon: '💡',
          richText: richText('The lead line of the callout, long enough.'),
          children: [text('child1', 'A nested authored fact that is long enough.')],
        },
      ]
      const flat = flattenBlocks(blocks)
      expect(flat.map((b) => b.id)).toEqual(['cal1', 'child1'])
      const kept = filterAuthoredBlocks(blocks)
      expect(kept.map((b) => b.id)).toEqual(['cal1', 'child1'])
    })

    it('extracts authored text from rich-text and table blocks', () => {
      expect(
        authoredTextOf({ kind: 'quote', id: 'q', richText: richText('A quoted claim.') }),
      ).toBe('A quoted claim.')
      expect(
        authoredTextOf({
          kind: 'table',
          id: 'tab',
          rows: [[richText('Name'), richText('Stage')], [richText('Acme'), richText('Won')]],
        }),
      ).toBe('Name | Stage\nAcme | Won')
      // Derived/media kinds yield no authored text.
      expect(authoredTextOf(dataBlock('d'))).toBe('')
    })
  })

  // ── Sectioning ─────────────────────────────────────────────────────────

  describe('sectioning', () => {
    it('groups blocks into heading-delimited sections with a leading preamble', () => {
      const authored = filterAuthoredBlocks([
        text('p0', 'Preamble sentence before any heading here.'),
        heading('h1', 1, 'Decisions'),
        text('p1', 'We will raise prices in Q3 across the board.'),
        heading('h2', 2, 'Risks'),
        text('p2', 'Churn could rise if we move too aggressively now.'),
      ])
      const sections = sectionAuthoredBlocks(authored)
      expect(sections).toHaveLength(3)
      expect(sections[0].sectionBlockId).toBeNull() // preamble
      expect(sections[0].blocks.map((b) => b.id)).toEqual(['p0'])
      expect(sections[1].sectionBlockId).toBe('h1')
      expect(sections[1].blocks.map((b) => b.id)).toEqual(['p1'])
      expect(sections[2].sectionBlockId).toBe('h2')
      expect(sections[2].blocks.map((b) => b.id)).toEqual(['p2'])
    })

    it('drops a lone heading with no body (nothing to extract)', () => {
      const authored = filterAuthoredBlocks([
        heading('h1', 1, 'Empty Section'),
        heading('h2', 2, 'Risks'),
        text('p1', 'There is a real fact under this heading at last.'),
      ])
      const sections = sectionAuthoredBlocks(authored)
      expect(sections.map((s) => s.sectionBlockId)).toEqual(['h2'])
    })

    it('leads section content with the heading title', () => {
      const [section] = sectionAuthoredBlocks(
        filterAuthoredBlocks([
          heading('h1', 1, 'Pricing'),
          text('p1', 'We will raise prices in Q3 across the board.'),
        ]),
      )
      expect(renderSectionContent(section)).toBe(
        '# Pricing\n\nWe will raise prices in Q3 across the board.',
      )
    })
  })

  // ── End-to-end: one Episode per section + back-edge + page-source ───────

  describe('distillPageToBrain', () => {
    it('runs one Episode per section with the (page_id, block_id) back-edge', async () => {
      const { deps, episodeCalls, upsertCalls } = fakeDeps()
      const page = {
        blocks: [
          heading('h1', 1, 'Decisions'),
          text('p1', 'We will raise prices in Q3 across the board.'),
          dataBlock('d1'), // skipped — derived
          heading('h2', 2, 'Risks'),
          text('p2', 'Churn could rise if we move too aggressively now.'),
        ] as Block[],
      }
      const result = await distillPageToBrain(
        { pageId: 'page-1', version: 7, page },
        deps,
      )

      expect(result.ingested).toBe(true)
      expect(result.sectionsProcessed).toBe(2)
      expect(episodeCalls).toHaveLength(2)
      // Each Episode carries the page id + its section heading id + version.
      expect(episodeCalls[0].backEdge).toEqual({
        pageId: 'page-1',
        sectionBlockId: 'h1',
        version: 7,
      })
      expect(episodeCalls[1].backEdge).toEqual({
        pageId: 'page-1',
        sectionBlockId: 'h2',
        version: 7,
      })
      // Section content carries the heading + body, never the derived block.
      expect(episodeCalls[0].content).toContain('# Decisions')
      expect(episodeCalls[0].content).toContain('raise prices in Q3')
      expect(episodeCalls[0].content).not.toContain('d1')

      // Page-as-source: one chunk per authored block, keyed by page + block,
      // linked to its section Episode id.
      expect(upsertCalls).toHaveLength(1)
      const chunks = upsertCalls[0].chunks
      expect(chunks.map((c) => c.blockId).sort()).toEqual(['h1', 'h2', 'p1', 'p2'])
      const p1 = chunks.find((c) => c.blockId === 'p1')!
      expect(p1.pageId).toBe('page-1')
      expect(p1.sectionEpisodeId).toBe('ep-1') // under the first section's Episode
      expect(p1.contentHash).toMatch(/^[0-9a-f]{64}$/)
    })

    it('content-hash dedup: skips re-ingest when the authored content is unchanged', async () => {
      const { deps, episodeCalls } = fakeDeps()
      const page = {
        blocks: [
          heading('h1', 1, 'Decisions'),
          text('p1', 'We will raise prices in Q3 across the board.'),
        ] as Block[],
      }
      const hash = hashAuthoredContent(page.blocks)

      const result = await distillPageToBrain(
        { pageId: 'page-1', version: 7, page, skipIfHashUnchanged: hash },
        deps,
      )
      expect(result.ingested).toBe(false)
      expect(result.contentHash).toBe(hash)
      expect(episodeCalls).toHaveLength(0)
      expect(deps.upsertPageSource).not.toHaveBeenCalled()
    })

    it('content hash ignores derived/media blocks — a data-only change does not re-ingest', () => {
      const authoredOnly = [
        heading('h1', 1, 'Decisions'),
        text('p1', 'We will raise prices in Q3 across the board.'),
      ] as Block[]
      const withData = [
        heading('h1', 1, 'Decisions'),
        text('p1', 'We will raise prices in Q3 across the board.'),
        dataBlock('d1'),
      ] as Block[]
      // Same authored layer → same hash, even though a derived block was added.
      expect(hashAuthoredContent(authoredOnly)).toBe(hashAuthoredContent(withData))
    })

    it('a real prose edit changes the hash (so it would re-ingest)', () => {
      const before = [text('p1', 'We will raise prices in Q3.')] as Block[]
      const after = [text('p1', 'We will raise prices in Q4.')] as Block[]
      expect(hashAuthoredContent(before)).not.toBe(hashAuthoredContent(after))
    })

    it('a page with no authored content runs nothing but still upserts (empty)', async () => {
      const { deps, episodeCalls } = fakeDeps()
      const page = { blocks: [dataBlock('d1'), { kind: 'divider', id: 'div1' }] as Block[] }
      const result = await distillPageToBrain({ pageId: 'p', version: 1, page }, deps)
      expect(result.ingested).toBe(true)
      expect(result.sectionsProcessed).toBe(0)
      expect(episodeCalls).toHaveLength(0)
      expect(deps.upsertPageSource).toHaveBeenCalledWith({ pageId: 'p', chunks: [], contentHash: result.contentHash })
    })
  })
})
