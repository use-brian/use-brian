import { describe, it, expect } from 'vitest'
import {
  parseInline,
  blocksFromMarkdown,
  expandTextOrHeadingBlock,
  liftListItemText,
  normalizeMarkdownBlocks,
  normalizeMarkdownOps,
} from '../markdown.js'
import { applyOps, validateOps } from '../ops.js'
import {
  blockSchema,
  liftedBlockSchema,
  liftedPageSchema,
  opsSchema,
} from '../page-schemas.js'
import type { Block, Ops, Page } from '../page-types.js'

/** Deterministic id generator so chained anchors are assertable. */
function seqIds(): () => string {
  let n = 0
  return () => `g${n++}`
}

/** Every produced block must validate against the canonical block schema. */
function expectValidBlocks(blocks: Block[]): void {
  for (const b of blocks) expect(blockSchema.safeParse(b).success).toBe(true)
}

/** The exact blob the model crammed into one block in production
 *  (session 97007562, 2026-05-30) — heading + bold + paragraph. */
const CERT_MD =
  '### Degree Certificate Summary\n\n' +
  'This document is a Bachelor of Engineering degree certificate from The Hong Kong ' +
  'University of Science and Technology (HKUST). It certifies that **LAU, Chi Hong** ' +
  'successfully completed the program of study for a **Bachelor of Engineering in Computer ' +
  'Engineering**, graduating with **Second Class Honors, Division I**, on July 31, 2025.'

describe('[COMP:doc/markdown-normalizer] Markdown → blocks normalizer', () => {
  describe('parseInline', () => {
    it('marks bold / italic / code / strike', () => {
      expect(parseInline('a **b** c')).toEqual([
        { type: 'text', text: 'a ' },
        { type: 'text', text: 'b', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' c' },
      ])
      expect(parseInline('`x`')).toEqual([{ type: 'text', text: 'x', marks: [{ type: 'code' }] }])
      expect(parseInline('~~y~~')).toEqual([{ type: 'text', text: 'y', marks: [{ type: 'strike' }] }])
    })

    it('leaves stray / mid-word delimiters literal (5 * 3, snake_case)', () => {
      expect(parseInline('5 * 3 = 15')).toEqual([{ type: 'text', text: '5 * 3 = 15' }])
      expect(parseInline('a_b_c')).toEqual([{ type: 'text', text: 'a_b_c' }])
    })

    it('renders a link as its label (no link mark in the doc schema)', () => {
      expect(parseInline('see [Google](https://g.co) now')).toEqual([
        { type: 'text', text: 'see ' },
        { type: 'text', text: 'Google' },
        { type: 'text', text: ' now' },
      ])
    })

    it('nests bold around italic', () => {
      expect(parseInline('**a *b* c**')).toEqual([
        { type: 'text', text: 'a ', marks: [{ type: 'bold' }] },
        { type: 'text', text: 'b', marks: [{ type: 'bold' }, { type: 'italic' }] },
        { type: 'text', text: ' c', marks: [{ type: 'bold' }] },
      ])
    })
  })

  describe('blocksFromMarkdown', () => {
    it('splits heading + blank-line paragraphs; clamps level to 4', () => {
      const blocks = blocksFromMarkdown('# A\n\nbody one\n\n###### deep', seqIds())
      expect(blocks.map((b) => b.kind)).toEqual(['heading', 'text', 'heading'])
      expect((blocks[0] as Extract<Block, { kind: 'heading' }>).level).toBe(1)
      expect((blocks[2] as Extract<Block, { kind: 'heading' }>).level).toBe(4)
      expectValidBlocks(blocks)
    })

    it('emits list items with rich-text marks, divider, and untouched code', () => {
      const md = '- **bold** item\n1. first\n- [x] done\n\n---\n\n```ts\nconst ### = 1\n```'
      const blocks = blocksFromMarkdown(md, seqIds())
      expect(blocks.map((b) => b.kind)).toEqual([
        'bulleted_list_item',
        'numbered_list_item',
        'to_do',
        'divider',
        'code',
      ])
      const bullet = blocks[0] as Extract<Block, { kind: 'bulleted_list_item' }>
      const para = (bullet.richText as { content: { content: unknown[] }[] }).content[0]
      expect(para.content[0]).toEqual({ type: 'text', text: 'bold', marks: [{ type: 'bold' }] })
      expect((blocks[2] as Extract<Block, { kind: 'to_do' }>).checked).toBe(true)
      // Fenced code is verbatim — the `###` inside is NOT re-parsed as a heading.
      expect((blocks[4] as Extract<Block, { kind: 'code' }>).code).toBe('const ### = 1')
      expectValidBlocks(blocks)
    })

    it('treats the Unicode bullet glyphs the model emits (• ‣ ◦) as list items', () => {
      // The chat model routinely prefixes list items with a literal bullet
      // glyph (esp. after CJK content) instead of Markdown `-`. Each must
      // become a real `bulleted_list_item`, not collapse into one prose block.
      const blocks = blocksFromMarkdown('• alpha\n‣ beta\n◦ gamma', seqIds())
      expect(blocks.map((b) => b.kind)).toEqual([
        'bulleted_list_item',
        'bulleted_list_item',
        'bulleted_list_item',
      ])
      const first = blocks[0] as Extract<Block, { kind: 'bulleted_list_item' }>
      const para = (first.richText as { content: { content: { text: string }[] }[] }).content[0]
      expect(para.content[0].text).toBe('alpha')
      expectValidBlocks(blocks)
    })

    it('captures sub-list indentation as nesting depth', () => {
      const md = ['- A', '  - B', '  - C', '    - D', '- E', '  1. one', '  2. two'].join('\n')
      const blocks = blocksFromMarkdown(md, seqIds())
      expect(blocks.map((b) => b.kind)).toEqual([
        'bulleted_list_item',
        'bulleted_list_item',
        'bulleted_list_item',
        'bulleted_list_item',
        'bulleted_list_item',
        'numbered_list_item',
        'numbered_list_item',
      ])
      expect(blocks.map((b) => (b as { indent?: number }).indent)).toEqual([
        undefined, // A — top level, no indent key
        1, // B
        1, // C
        2, // D
        undefined, // E — dedented back to top
        1, // 1. one — a numbered sub-list under E
        1, // 2. two
      ])
      expectValidBlocks(blocks)
    })

    it('captures indented to_do items as nesting depth (to-dos nest, A7)', () => {
      const blocks = blocksFromMarkdown(['- [ ] A', '  - [x] B'].join('\n'), seqIds())
      expect(blocks.map((b) => b.kind)).toEqual(['to_do', 'to_do'])
      expect(blocks.map((b) => (b as { indent?: number }).indent ?? 0)).toEqual([0, 1])
      expectValidBlocks(blocks)
    })

    it('resets nesting depth after a non-list block breaks the run', () => {
      const blocks = blocksFromMarkdown(['  - deep-looking', '## H', '- flat'].join('\n'), seqIds())
      // The heading clears the list context, so the bullet after it is depth 0.
      const flat = blocks[blocks.length - 1] as Extract<Block, { kind: 'bulleted_list_item' }>
      expect(flat.kind).toBe('bulleted_list_item')
      expect((flat as { indent?: number }).indent).toBeUndefined()
    })
  })

  describe('expandTextOrHeadingBlock', () => {
    it('leaves Markdown-free prose untouched (same object identity)', () => {
      const block: Block = { kind: 'text', id: 'b1', text: 'Just a plain sentence.' }
      expect(expandTextOrHeadingBlock(block, seqIds())).toEqual([block])
    })

    it('expands a text block holding a heading + paragraph; first keeps id', () => {
      const block: Block = { kind: 'text', id: 'orig', text: CERT_MD }
      const out = expandTextOrHeadingBlock(block, seqIds())
      expect(out[0]).toEqual({ kind: 'heading', id: 'orig', level: 3, text: 'Degree Certificate Summary' })
      expect(out[1].kind).toBe('text')
      const para = out[1] as Extract<Block, { kind: 'text' }>
      expect(para.text).toContain('LAU, Chi Hong')
      expect(para.text).not.toContain('**')
      expectValidBlocks(out)
    })

    it('fixes a heading block whose text still carries ### and strips marks', () => {
      const block: Block = { kind: 'heading', id: 'h', level: 1, text: '### Big **Title**' }
      const out = expandTextOrHeadingBlock(block, seqIds())
      expect(out).toEqual([{ kind: 'heading', id: 'h', level: 3, text: 'Big Title' }])
    })

    it('preserves the variant on the first expanded paragraph', () => {
      const block: Block = { kind: 'text', id: 'b', text: 'one\n\ntwo', variant: 'muted' }
      const out = expandTextOrHeadingBlock(block, seqIds())
      expect(out[0]).toEqual({ kind: 'text', id: 'b', text: 'one', variant: 'muted' })
    })

    it('expands a text block of `•` lines into native bullets (Content Pillars repro)', () => {
      // Real repro (2026-06-01): the model crammed three `•`-prefixed lines
      // into ONE text block. The normalizer used to leave them as prose, so
      // the page showed a stray `•` glyph per line instead of native bullets.
      const block: Block = {
        kind: 'text',
        id: 'pillars',
        text:
          '• 荒謬觀察 (Absurd Observations, ~40%): cold, dry observations\n' +
          '• 微細生存美學 (Micro-Survival Aesthetics, ~40%): small rituals\n' +
          '• 靈魂出竅 (Soul Departure, ~20%): travel-obsessed mindset',
      }
      const out = expandTextOrHeadingBlock(block, seqIds())
      expect(out.map((b) => b.kind)).toEqual([
        'bulleted_list_item',
        'bulleted_list_item',
        'bulleted_list_item',
      ])
      // First expanded block inherits the original id (normalizer contract).
      expect(out[0].id).toBe('pillars')
      const first = out[0] as Extract<Block, { kind: 'bulleted_list_item' }>
      const para = (first.richText as { content: { content: { text: string }[] }[] }).content[0]
      expect(para.content[0].text).toContain('荒謬觀察')
      expectValidBlocks(out)
    })
  })

  describe('normalizeMarkdownBlocks (renderPage path)', () => {
    it('flat-maps a page block list through expansion', () => {
      const blocks: Block[] = [
        { kind: 'heading', id: 'title', level: 1, text: 'Report' },
        { kind: 'text', id: 'body', text: '## Section\n\nPara with **bold**.' },
      ]
      const out = normalizeMarkdownBlocks(blocks, seqIds())
      expect(out.map((b) => b.kind)).toEqual(['heading', 'heading', 'text'])
      expect((out[1] as Extract<Block, { kind: 'heading' }>).text).toBe('Section')
      expect((out[2] as Extract<Block, { kind: 'text' }>).text).toBe('Para with bold.')
      expectValidBlocks(out)
    })
  })

  describe('normalizeMarkdownOps (patchPage path)', () => {
    it('reproduces + fixes the production edit: ### blob → real Heading 3 block', () => {
      // The model edited an existing text block, cramming the whole doc in.
      const page: Page = {
        blocks: [
          { kind: 'heading', id: 'top', level: 2, text: 'Attachments' },
          { kind: 'text', id: 'b1', text: '' },
        ],
      }
      const ops: Ops = [{ op: 'edit', blockId: 'b1', patch: { text: CERT_MD } }]
      const norm = normalizeMarkdownOps(ops, page, seqIds())

      // edit can't re-type a block → delete + chained adds at the prior neighbour.
      expect(norm[0]).toEqual({ op: 'delete', blockId: 'b1' })
      const adds = norm.slice(1).filter((o) => o.op === 'add') as Extract<typeof norm[number], { op: 'add' }>[]
      expect(adds[0].after).toBe('top') // anchored after b1's prior neighbour
      const heading = adds.find((a) => a.block.kind === 'heading')!.block as Extract<Block, { kind: 'heading' }>
      expect(heading.level).toBe(3)
      expect(heading.text).toBe('Degree Certificate Summary')

      // The whole rewritten patch applies cleanly against the real page.
      expect(validateOps(page, norm).valid).toBe(true)
      const { page: result } = applyOps(page, norm, seqIds())
      const kinds = result.blocks.map((b) => b.kind)
      expect(kinds).toContain('heading')
      const h3 = result.blocks.find((b) => b.kind === 'heading' && b.text === 'Degree Certificate Summary')
      expect(h3).toBeDefined()
      // No literal markdown survives into the body paragraph.
      const bodyText = result.blocks
        .filter((b): b is Extract<Block, { kind: 'text' }> => b.kind === 'text')
        .map((b) => b.text)
        .join(' ')
      expect(bodyText).not.toContain('**')
      expect(bodyText).not.toContain('###')
    })

    it('expands an add op into chained adds with resolvable real-id anchors', () => {
      const page: Page = { blocks: [{ kind: 'divider', id: 'd0' }] }
      const ops: Ops = [
        { op: 'add', after: 'd0', block: { kind: 'text', id: 'tmp-1', text: '# H\n\nbody' } },
      ]
      const norm = normalizeMarkdownOps(ops, page, seqIds())
      const adds = norm.filter((o) => o.op === 'add') as Extract<typeof norm[number], { op: 'add' }>[]
      expect(adds.length).toBe(2)
      expect(adds[0].after).toBe('d0')
      expect(adds[1].after).toBe(adds[0].block.id) // chained off the previous real id
      expect(validateOps(page, norm).valid).toBe(true)
    })

    it('does an in-place edit when the markdown is one same-kind segment', () => {
      const page: Page = { blocks: [{ kind: 'text', id: 'p', text: 'old' }] }
      const ops: Ops = [{ op: 'edit', blockId: 'p', patch: { text: 'Now **bold** here.' } }]
      const norm = normalizeMarkdownOps(ops, page, seqIds())
      expect(norm).toEqual([{ op: 'edit', blockId: 'p', patch: { text: 'Now bold here.' } }])
    })

    it('leaves non-prose ops and plain edits untouched', () => {
      const page: Page = { blocks: [{ kind: 'text', id: 'p', text: 'x' }] }
      const ops: Ops = [
        { op: 'edit', blockId: 'p', patch: { text: 'plain replacement' } },
        { op: 'delete', blockId: 'q' },
        { op: 'setTitle', title: 'T' },
      ]
      expect(normalizeMarkdownOps(ops, page, seqIds())).toEqual(ops)
    })
  })
})

describe('[COMP:doc/markdown-normalizer] List-item text lift (pre-validation)', () => {
  /** Pull the plain text back out of a lifted `richText` doc for assertions. */
  function richPlain(rich: unknown): string {
    const doc = rich as {
      content?: { content?: { text?: string }[] }[]
    }
    return (doc.content?.[0]?.content ?? []).map((n) => n.text ?? '').join('')
  }

  describe('liftListItemText', () => {
    for (const kind of [
      'bulleted_list_item',
      'numbered_list_item',
      'to_do',
      'toggle',
      'quote',
      'callout',
    ]) {
      it(`lifts a stray text field into richText on ${kind}`, () => {
        const lifted = liftListItemText({ kind, id: 'b1', text: 'Phase 1: Foundations' }) as Record<
          string,
          unknown
        >
        expect(lifted.text).toBeUndefined()
        expect(richPlain(lifted.richText)).toBe('Phase 1: Foundations')
      })
    }

    it('parses inline marks in the lifted text', () => {
      const lifted = liftListItemText({
        kind: 'bulleted_list_item',
        id: 'b1',
        text: 'Use **bold** here',
      }) as Record<string, unknown>
      const para = (lifted.richText as { content: { content: unknown[] }[] }).content[0]
      expect(para.content).toEqual([
        { type: 'text', text: 'Use ' },
        { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' here' },
      ])
    })

    it('preserves sibling fields (to_do.checked) while lifting', () => {
      const lifted = liftListItemText({
        kind: 'to_do',
        id: 't1',
        checked: true,
        text: 'done',
      }) as Record<string, unknown>
      expect(lifted.checked).toBe(true)
      expect(richPlain(lifted.richText)).toBe('done')
    })

    it('passes through text/heading blocks untouched (same reference)', () => {
      const heading = { kind: 'heading', id: 'h', level: 2, text: 'Title' }
      const text = { kind: 'text', id: 'p', text: 'body' }
      expect(liftListItemText(heading)).toBe(heading)
      expect(liftListItemText(text)).toBe(text)
    })

    it('does not clobber an existing richText', () => {
      const existing = {
        kind: 'bulleted_list_item',
        id: 'b1',
        richText: { type: 'doc', content: [{ type: 'paragraph' }] },
      }
      expect(liftListItemText(existing)).toBe(existing)
    })

    it('passes non-objects through', () => {
      expect(liftListItemText(null)).toBe(null)
      expect(liftListItemText('x')).toBe('x')
    })
  })

  describe('liftListItemText — mirror slip (richText on a plain kind)', () => {
    for (const kind of ['text', 'heading'] as const) {
      it(`flattens a richText doc into plain text on ${kind}`, () => {
        const lifted = liftListItemText({
          kind,
          id: 'b1',
          ...(kind === 'heading' ? { level: 2 } : {}),
          richText: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [
                  { type: 'text', text: 'Verdict: ', marks: [{ type: 'bold' }] },
                  { type: 'text', text: 'lucrative margin arbitrage.' },
                ],
              },
            ],
          },
        }) as Record<string, unknown>
        expect(lifted.richText).toBeUndefined()
        expect(lifted.text).toBe('Verdict: lucrative margin arbitrage.')
      })
    }

    it('does not clobber an existing non-empty text', () => {
      const both = {
        kind: 'text',
        id: 'b1',
        text: 'real',
        richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'rich' }] }] },
      }
      // text wins; the schema strips the unknown richText key downstream.
      expect(liftListItemText(both)).toBe(both)
    })

    it('recurses into container children (toggle with a text child)', () => {
      const lifted = liftListItemText({
        kind: 'toggle',
        id: 'tg',
        richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Vertical 1' }] }] },
        children: [
          {
            kind: 'text',
            id: 'verdict',
            richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Verdict line' }] }] },
          },
          { kind: 'bulleted_list_item', id: 'c1', text: 'a stray-text bullet' },
        ],
      }) as Record<string, unknown>
      const children = lifted.children as Record<string, unknown>[]
      // Child 0: text block, richText flattened to plain text.
      expect(children[0].richText).toBeUndefined()
      expect(children[0].text).toBe('Verdict line')
      // Child 1: stray-text bullet lifted to richText (recursion reaches it too).
      expect(children[1].text).toBeUndefined()
      expect(richPlain(children[1].richText)).toBe('a stray-text bullet')
    })
  })

  describe('liftListItemText — stray table cells (repair #3)', () => {
    // The exact cell shape the "Client Discovery: Expert Local Consultant"
    // patchPage sent (page 78942466, autonomous session ab286573, 2026-07-21):
    // every cell `{ "text": "…" }`. The open-record cell schema validated it
    // and the block→PM bridge degraded every cell to an empty paragraph.
    it('lifts `{ text }` cells into one-paragraph richText docs', () => {
      const lifted = liftListItemText({
        kind: 'table',
        id: 'tmp-table-overview',
        rows: [
          [{ text: 'Business Dimension' }, { text: 'Details' }],
          [{ text: 'Company Name' }, { text: 'Expert Local Consultant' }],
        ],
        hasHeaderRow: true,
        hasHeaderColumn: false,
      }) as { rows: unknown[][]; hasHeaderRow: boolean }
      expect(lifted.hasHeaderRow).toBe(true)
      expect(lifted.rows).toHaveLength(2)
      expect(richPlain(lifted.rows[0][0])).toBe('Business Dimension')
      expect(richPlain(lifted.rows[1][1])).toBe('Expert Local Consultant')
    })

    it('lifts plain-string cells, parsing inline marks', () => {
      const lifted = liftListItemText({
        kind: 'table',
        id: 't1',
        rows: [['**Metric**', 'Value']],
      }) as { rows: unknown[][] }
      const para = (lifted.rows[0][0] as { content: { content: unknown[] }[] }).content[0]
      expect(para.content).toEqual([
        { type: 'text', text: 'Metric', marks: [{ type: 'bold' }] },
      ])
      expect(richPlain(lifted.rows[0][1])).toBe('Value')
    })

    it('wraps a bare paragraph-node cell in a doc', () => {
      const lifted = liftListItemText({
        kind: 'table',
        id: 't1',
        rows: [[{ type: 'paragraph', content: [{ type: 'text', text: 'Cell' }] }]],
      }) as { rows: { type: string; content: unknown[] }[][] }
      expect(lifted.rows[0][0].type).toBe('doc')
      expect(richPlain(lifted.rows[0][0])).toBe('Cell')
    })

    it('passes a canonical table through by reference', () => {
      const canonical = {
        kind: 'table',
        id: 't1',
        rows: [
          [
            { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }] },
          ],
        ],
        hasHeaderRow: true,
      }
      expect(liftListItemText(canonical)).toBe(canonical)
    })

    it('an add op with `{ text }` cells validates AND keeps the content', () => {
      const ops = [
        {
          op: 'add',
          block: {
            id: 'tmp-table-overview',
            kind: 'table',
            rows: [[{ text: 'Business Dimension' }, { text: 'Details' }]],
            hasHeaderRow: true,
          },
        },
      ]
      const result = opsSchema.safeParse(ops)
      expect(result.success).toBe(true)
      const add = (result as { data: Ops }).data[0] as Extract<Ops[number], { op: 'add' }>
      const table = add.block as Extract<Block, { kind: 'table' }>
      expect(richPlain(table.rows[0][0])).toBe('Business Dimension')
      expect(richPlain(table.rows[0][1])).toBe('Details')
    })
  })

  describe('the patchPage add-op schema accepts the prod 81a56d8b toggle', () => {
    // The exact shape session 81a56d8b (2026-06-11) sent and that the raw
    // schema rejected `ops.N.block.children.0.text: Required`, trapping the
    // model in a retry loop until the turn died on a stream-idle stall.
    it('an add op whose toggle child is a richText `text` block validates', () => {
      const ops = [
        {
          op: 'add',
          after: 'ca4d148f',
          block: {
            id: 'tmp-v1',
            kind: 'toggle',
            children: [
              {
                id: 'tmp-v1-verdict',
                kind: 'text',
                richText: {
                  type: 'doc',
                  content: [
                    {
                      type: 'paragraph',
                      content: [
                        { type: 'text', text: 'Verdict: ', marks: [{ type: 'bold' }] },
                        { type: 'text', text: 'highly lucrative margin arbitrage.' },
                      ],
                    },
                  ],
                },
              },
              {
                id: 'tmp-v1-c1',
                kind: 'bulleted_list_item',
                richText: {
                  type: 'doc',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Current' }] }],
                },
              },
            ],
          },
        },
      ]
      const result = opsSchema.safeParse(ops)
      expect(result.success).toBe(true)
      const add = (result as { data: Ops }).data[0] as Extract<Ops[number], { op: 'add' }>
      const verdict = (add.block as { children: Extract<Block, { kind: 'text' }>[] }).children[0]
      expect(verdict.kind).toBe('text')
      expect(verdict.text).toBe('Verdict: highly lucrative margin arbitrage.')
    })
  })

  describe('lifted schemas rescue the production repro', () => {
    // The exact shape "Intensive LeetCode Mastery Guide" (page a90026ad,
    // renderPage call_119, 2026-06-01) sent — bullets + to_do carried `text`,
    // which the raw blockSchema strips, persisting empty bullets.
    it('liftedBlockSchema keeps bullet content the raw schema drops', () => {
      const raw = { kind: 'bulleted_list_item', id: 'tmp-4', text: 'Arrays & Hashing' }
      // Baseline: the raw schema silently drops `text`.
      const rawParsed = blockSchema.parse(raw) as Record<string, unknown>
      expect(rawParsed.text).toBeUndefined()
      expect(rawParsed.richText).toBeUndefined()
      // The lifted schema rescues it into richText.
      const lifted = liftedBlockSchema.parse(raw) as Record<string, unknown>
      expect(richPlain(lifted.richText)).toBe('Arrays & Hashing')
    })

    it('liftedPageSchema rescues every list / to_do block on the page', () => {
      const page = {
        blocks: [
          { kind: 'heading', id: 'tmp-1', level: 1, text: 'Guide' },
          { kind: 'bulleted_list_item', id: 'tmp-4', text: 'Phase 1' },
          { kind: 'bulleted_list_item', id: 'tmp-5', text: 'Phase 2' },
          { kind: 'to_do', id: 'tmp-19', checked: false, text: 'Track progress' },
        ],
      }
      const parsed = liftedPageSchema.parse(page) as Page
      const texts = parsed.blocks.map((b) =>
        b.kind === 'heading' ? b.text : richPlain((b as { richText?: unknown }).richText),
      )
      expect(texts).toEqual(['Guide', 'Phase 1', 'Phase 2', 'Track progress'])
    })

    it('the patchPage add-op schema lifts list-item text too', () => {
      const ops = [
        { op: 'add', block: { kind: 'bulleted_list_item', id: 'tmp-1', text: 'New bullet' } },
      ]
      const parsed = opsSchema.parse(ops) as Ops
      const add = parsed[0] as Extract<Ops[number], { op: 'add' }>
      expect(richPlain((add.block as { richText?: unknown }).richText)).toBe('New bullet')
    })
  })

  describe('patchPage edit of a list item with a text patch', () => {
    it('converts a stray text patch on a bullet into a richText patch', () => {
      const page: Page = {
        blocks: [{ kind: 'bulleted_list_item', id: 'b1' }],
      }
      const ops: Ops = [{ op: 'edit', blockId: 'b1', patch: { text: 'Now **bold** here' } }]
      const norm = normalizeMarkdownOps(ops, page, seqIds())
      expect(norm.length).toBe(1)
      const edit = norm[0] as Extract<Ops[number], { op: 'edit' }>
      const patch = edit.patch as Record<string, unknown>
      expect(patch.text).toBeUndefined()
      expect(richPlain(patch.richText)).toBe('Now bold here')
      // The merged block validates and is no longer empty.
      const applied = applyOps(page, norm, seqIds())
      expect(blockSchema.safeParse(applied.page.blocks[0]).success).toBe(true)
      expect(richPlain((applied.page.blocks[0] as { richText?: unknown }).richText)).toBe(
        'Now bold here',
      )
    })

    it('still strips inline marks to plain text when editing a code block', () => {
      const page: Page = {
        blocks: [{ kind: 'code', id: 'c1', language: 'ts', code: 'x' }],
      }
      const ops: Ops = [{ op: 'edit', blockId: 'c1', patch: { code: 'y', text: 'a **b** c' } }]
      const norm = normalizeMarkdownOps(ops, page, seqIds())
      const edit = norm[0] as Extract<Ops[number], { op: 'edit' }>
      const patch = edit.patch as Record<string, unknown>
      expect(patch.richText).toBeUndefined()
      expect(patch.text).toBe('a b c')
    })
  })
})

describe('[COMP:doc/markdown-normalizer] <details> disclosure → toggle', () => {
  it('parses <details><summary> into a toggle with children on the normalizer path', () => {
    const md = [
      '<details>',
      '<summary>**Key** findings</summary>',
      '',
      'A paragraph inside.',
      '',
      '- a bullet',
      '',
      '</details>',
    ].join('\n')
    const out = blocksFromMarkdown(md, seqIds())
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('toggle')
    const toggle = out[0] as { children?: Block[]; expanded?: boolean }
    expect(toggle.expanded).toBeUndefined()
    expect(toggle.children).toHaveLength(2)
    expect(toggle.children?.[0]).toMatchObject({ kind: 'text', text: 'A paragraph inside.' })
    expect(toggle.children?.[1]).toMatchObject({ kind: 'bulleted_list_item' })
  })

  it('<details open> sets expanded and an unclosed tag degrades to body-to-EOF', () => {
    const out = blocksFromMarkdown('<details open>\n<summary>S</summary>\nbody line', seqIds())
    expect(out[0]).toMatchObject({ kind: 'toggle', expanded: true })
    expect((out[0] as { children?: Block[] }).children?.[0]).toMatchObject({
      kind: 'text',
      text: 'body line',
    })
  })
})
