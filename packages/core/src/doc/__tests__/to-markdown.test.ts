import { describe, it, expect } from 'vitest'
import { blocksToMarkdown, pageToMarkdown } from '../to-markdown.js'
import { markdownToBlocks } from '../markdown.js'
import type { Block, Page, RichTextContent } from '../page-types.js'

/** One-paragraph richText doc from inline nodes. */
function rt(content: unknown[]): RichTextContent {
  return { type: 'doc', content: [{ type: 'paragraph', content }] } as unknown as RichTextContent
}
const txt = (t: string) => ({ type: 'text', text: t })

describe('[COMP:doc/markdown-serializer] Block → Markdown', () => {
  it('headings, text, divider', () => {
    const blocks: Block[] = [
      { kind: 'heading', id: 'a', level: 2, text: 'Title' },
      { kind: 'text', id: 'b', text: 'A paragraph.' },
      { kind: 'divider', id: 'c' },
    ]
    expect(blocksToMarkdown(blocks)).toBe('## Title\n\nA paragraph.\n\n---')
  })

  it('groups consecutive list items and numbers them', () => {
    const blocks: Block[] = [
      { kind: 'bulleted_list_item', id: 'a', richText: rt([txt('one')]) },
      { kind: 'bulleted_list_item', id: 'b', richText: rt([txt('two')]) },
      { kind: 'numbered_list_item', id: 'c', richText: rt([txt('first')]) },
      { kind: 'numbered_list_item', id: 'd', richText: rt([txt('second')]) },
    ]
    expect(blocksToMarkdown(blocks)).toBe('- one\n- two\n\n1. first\n2. second')
  })

  it('to_do checkbox state', () => {
    const blocks: Block[] = [
      { kind: 'to_do', id: 'a', checked: false, richText: rt([txt('open')]) },
      { kind: 'to_do', id: 'b', checked: true, richText: rt([txt('done')]) },
    ]
    expect(blocksToMarkdown(blocks)).toBe('- [ ] open\n- [x] done')
  })

  it('indents nested list items by depth', () => {
    const blocks: Block[] = [
      { kind: 'bulleted_list_item', id: 'a', richText: rt([txt('A')]) },
      { kind: 'bulleted_list_item', id: 'b', richText: rt([txt('B')]), indent: 1 },
      { kind: 'bulleted_list_item', id: 'c', richText: rt([txt('C')]), indent: 2 },
      { kind: 'bulleted_list_item', id: 'd', richText: rt([txt('D')]) },
    ]
    expect(blocksToMarkdown(blocks)).toBe('- A\n  - B\n    - C\n- D')
  })

  it('counts a nested numbered sub-list independently of the parent', () => {
    const blocks: Block[] = [
      { kind: 'bulleted_list_item', id: 'p', richText: rt([txt('Parent')]) },
      { kind: 'numbered_list_item', id: 's1', richText: rt([txt('one')]), indent: 1 },
      { kind: 'numbered_list_item', id: 's2', richText: rt([txt('two')]), indent: 1 },
      { kind: 'bulleted_list_item', id: 'n', richText: rt([txt('Next')]) },
    ]
    expect(blocksToMarkdown(blocks)).toBe('- Parent\n  1. one\n  2. two\n- Next')
  })

  it('serializes inline marks (bold / italic / code / strike / link)', () => {
    const blocks: Block[] = [
      {
        kind: 'bulleted_list_item',
        id: 'a',
        richText: rt([
          txt('a '),
          { type: 'text', text: 'b', marks: [{ type: 'bold' }] },
          txt(' '),
          { type: 'text', text: 'i', marks: [{ type: 'italic' }] },
          txt(' '),
          { type: 'text', text: 'c', marks: [{ type: 'code' }] },
          txt(' '),
          { type: 'text', text: 's', marks: [{ type: 'strike' }] },
          txt(' '),
          { type: 'text', text: 'go', marks: [{ type: 'link', attrs: { href: 'https://g.co' } }] },
        ]),
      },
    ]
    expect(blocksToMarkdown(blocks)).toBe('- a **b** *i* `c` ~~s~~ [go](https://g.co)')
  })

  it('fenced code with language', () => {
    const blocks: Block[] = [{ kind: 'code', id: 'a', language: 'ts', code: 'const x = 1' }]
    expect(blocksToMarkdown(blocks)).toBe('```ts\nconst x = 1\n```')
  })

  it('GFM table with a header row', () => {
    const blocks: Block[] = [
      {
        kind: 'table',
        id: 'a',
        hasHeaderRow: true,
        rows: [
          [rt([txt('Name')]), rt([txt('Age')])],
          [rt([txt('Alice')]), rt([txt('30')])],
        ],
      },
    ]
    expect(blocksToMarkdown(blocks)).toBe('| Name | Age |\n| --- | --- |\n| Alice | 30 |')
  })

  it('callout exports as an emoji-prefixed blockquote', () => {
    const blocks: Block[] = [{ kind: 'callout', id: 'a', icon: '💡', richText: rt([txt('heads up')]) }]
    expect(blocksToMarkdown(blocks)).toBe('> 💡 heads up')
  })

  it('diagram exports as a mermaid fence', () => {
    const blocks: Block[] = [{ kind: 'diagram', id: 'a', syntax: 'mermaid', code: 'graph TD\nA-->B' }]
    expect(blocksToMarkdown(blocks)).toBe('```mermaid\ngraph TD\nA-->B\n```')
  })

  it('data block placeholder without a resolver, resolved with one', () => {
    const block: Block = { kind: 'data', id: 'a', binding: { type: 'tasks' } as never }
    expect(blocksToMarkdown([block])).toBe('_[Live data view]_')
    const resolved = blocksToMarkdown([block], {
      resolveDataBlock: () => '| Task |\n| --- |\n| Ship it |',
    })
    expect(resolved).toBe('| Task |\n| --- |\n| Ship it |')
  })

  it('chart (bar) snapshots its inline points to a table', () => {
    const blocks: Block[] = [
      {
        kind: 'chart',
        id: 'a',
        chartType: 'bar',
        title: 'Sales',
        data: { points: [{ label: 'Q1', value: 10 }, { label: 'Q2', value: 20 }] },
      },
    ]
    expect(blocksToMarkdown(blocks)).toBe(
      '**Sales**\n\n| Label | Value |\n| --- | --- |\n| Q1 | 10 |\n| Q2 | 20 |',
    )
  })

  it('escapes a leading block marker in a plain text block', () => {
    const blocks: Block[] = [{ kind: 'text', id: 'a', text: '# not a heading' }]
    expect(blocksToMarkdown(blocks)).toBe('\\# not a heading')
  })

  it('pageToMarkdown prepends the title as an H1', () => {
    const page: Page = { blocks: [{ kind: 'text', id: 'a', text: 'body' }] }
    expect(pageToMarkdown(page, 'My Doc')).toBe('# My Doc\n\nbody')
  })
})

describe('[COMP:doc/markdown-serializer] Markdown round-trip is a fixed point', () => {
  // The "clean" subset (headings / text / lists / to_do / quote / code /
  // divider / table / inline marks / links in rich-text kinds) must satisfy
  // blocksToMarkdown(markdownToBlocks(md)) === md after one normalization pass.
  const SOURCE = [
    '# Heading one',
    '',
    'A paragraph with **bold**, *italic*, `code` and ~~strike~~.',
    '',
    '## Heading two',
    '',
    '- bullet **one**',
    '- bullet with a [link](https://example.com)',
    '',
    '1. first',
    '2. second',
    '',
    '- [ ] open task',
    '- [x] done task',
    '',
    '> a quoted line',
    '',
    '```ts',
    'const x = 1',
    '```',
    '',
    '---',
    '',
    '| Name | Age |',
    '| --- | --- |',
    '| Alice | 30 |',
  ].join('\n')

  it('normalizes once then is stable', () => {
    const once = blocksToMarkdown(markdownToBlocks(SOURCE))
    const twice = blocksToMarkdown(markdownToBlocks(once))
    expect(twice).toBe(once)
  })

  it('round-trips a nested list as a fixed point (depth preserved)', () => {
    const nested = [
      '- A',
      '  - B',
      '    - C',
      '- D',
      '  1. one',
      '  2. two',
    ].join('\n')
    const once = blocksToMarkdown(markdownToBlocks(nested))
    expect(once).toBe(nested)
    expect(blocksToMarkdown(markdownToBlocks(once))).toBe(once)
  })

  it('preserves the clean constructs through the round-trip', () => {
    const md = blocksToMarkdown(markdownToBlocks(SOURCE))
    expect(md).toContain('# Heading one')
    // Inline marks survive in rich-text kinds (list items); a plain paragraph
    // is a `text` block that correctly flattens its marks to clean text.
    expect(md).toContain('- bullet **one**')
    expect(md).toContain('A paragraph with bold, italic, code and strike.')
    expect(md).toContain('[link](https://example.com)')
    expect(md).toContain('- [ ] open task')
    expect(md).toContain('- [x] done task')
    expect(md).toContain('| Name | Age |')
    expect(md).toContain('```ts')
  })
})

describe('[COMP:doc/markdown-serializer] toggle/callout children', () => {
  it('a childless toggle keeps the plain-summary reduction', () => {
    const blocks: Block[] = [{ kind: 'toggle', id: 'a', richText: rt([txt('Summary')]) }]
    expect(blocksToMarkdown(blocks)).toBe('Summary')
  })

  it('a toggle with children exports as <details> and re-imports as a toggle (fixed point)', () => {
    const blocks: Block[] = [
      {
        kind: 'toggle',
        id: 'a',
        expanded: true,
        richText: rt([txt('Findings')]),
        children: [
          { kind: 'text', id: 'b', text: 'Inside line.' },
          { kind: 'bulleted_list_item', id: 'c', richText: rt([txt('point')]) },
        ],
      } as Block,
    ]
    const md = blocksToMarkdown(blocks)
    expect(md).toBe(
      '<details open>\n<summary>Findings</summary>\n\nInside line.\n\n- point\n\n</details>',
    )
    const back = markdownToBlocks(md)
    expect(back).toHaveLength(1)
    expect(back[0]).toMatchObject({ kind: 'toggle', expanded: true })
    const children = (back[0] as { children?: Block[] }).children
    expect(children).toHaveLength(2)
    expect(children?.[0]).toMatchObject({ kind: 'text', text: 'Inside line.' })
    expect(children?.[1]).toMatchObject({ kind: 'bulleted_list_item' })
    // One full pass is the fixed point: md → blocks → md is stable.
    expect(blocksToMarkdown(back)).toBe(md)
  })

  it('a collapsed toggle omits the open flag', () => {
    const blocks: Block[] = [
      {
        kind: 'toggle',
        id: 'a',
        richText: rt([txt('Hidden')]),
        children: [{ kind: 'text', id: 'b', text: 'inside' }],
      } as Block,
    ]
    const md = blocksToMarkdown(blocks)
    expect(md.startsWith('<details>\n')).toBe(true)
    expect((markdownToBlocks(md)[0] as { expanded?: boolean }).expanded).toBeUndefined()
  })

  it('nested toggles round-trip through nested <details>', () => {
    const blocks: Block[] = [
      {
        kind: 'toggle',
        id: 'a',
        richText: rt([txt('Outer')]),
        children: [
          {
            kind: 'toggle',
            id: 'b',
            richText: rt([txt('Inner')]),
            children: [{ kind: 'text', id: 'c', text: 'deep' }],
          },
        ],
      } as Block,
    ]
    const md = blocksToMarkdown(blocks)
    const back = markdownToBlocks(md)
    const outer = back[0] as { children?: Block[] }
    const inner = outer.children?.[0] as { kind: string; children?: Block[] }
    expect(inner.kind).toBe('toggle')
    expect(inner.children?.[0]).toMatchObject({ kind: 'text', text: 'deep' })
    expect(blocksToMarkdown(back)).toBe(md)
  })

  it('callout children render inside the quote body', () => {
    const blocks: Block[] = [
      {
        kind: 'callout',
        id: 'a',
        icon: '💡',
        richText: rt([txt('Lead')]),
        children: [{ kind: 'text', id: 'b', text: 'Detail.' }],
      } as Block,
    ]
    expect(blocksToMarkdown(blocks)).toBe('> 💡 Lead\n> \n> Detail.')
  })
})

describe('[COMP:doc/markdown-serializer] nested to-dos', () => {
  it('exports indented checkboxes and re-imports the same depths (fixed point)', () => {
    const blocks: Block[] = [
      { kind: 'to_do', id: 'a', checked: false, richText: rt([txt('parent')]) },
      { kind: 'to_do', id: 'b', checked: true, richText: rt([txt('child')]), indent: 1 } as Block,
      { kind: 'to_do', id: 'c', checked: false, richText: rt([txt('sibling')]) },
    ]
    const md = blocksToMarkdown(blocks)
    expect(md).toBe('- [ ] parent\n  - [x] child\n- [ ] sibling')
    const back = markdownToBlocks(md)
    expect(back.map((b) => (b as { indent?: number }).indent ?? 0)).toEqual([0, 1, 0])
    expect(blocksToMarkdown(back)).toBe(md)
  })
})
