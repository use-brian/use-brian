import type { Block, Page } from '@sidanclaw/core/dist/views/blocks.js'

const rich = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})

/** One block of every one of the 19 kinds, including consecutive list runs
 *  and the two heading levels that exercise the 1–4 range (`h4`). */
export const ALL_KINDS: Block[] = [
  { kind: 'heading', id: 'h1', level: 1, text: 'Q3 pipeline' },
  { kind: 'heading', id: 'h4', level: 4, text: 'A sub-sub-heading' },
  { kind: 'text', id: 't1', text: 'Updated Mondays.' },
  { kind: 'text', id: 't2', text: 'A muted note.', variant: 'muted' },
  { kind: 'divider', id: 'd1' },
  { kind: 'callout', id: 'c1', icon: '🔥', richText: rich('Heads up') as never },
  { kind: 'code', id: 'co1', language: 'ts', code: 'const x = 1' },
  { kind: 'quote', id: 'q1', richText: rich('A quote') as never },
  { kind: 'bulleted_list_item', id: 'b1', richText: rich('first') as never },
  { kind: 'bulleted_list_item', id: 'b2', richText: rich('second') as never },
  { kind: 'numbered_list_item', id: 'n1', richText: rich('one') as never },
  { kind: 'numbered_list_item', id: 'n2', richText: rich('two') as never },
  { kind: 'to_do', id: 'td1', checked: false, richText: rich('do this') as never },
  { kind: 'to_do', id: 'td2', checked: true, richText: rich('done') as never },
  { kind: 'toggle', id: 'tg1', expanded: true, richText: rich('details') as never },
  {
    kind: 'table',
    id: 'tbl1',
    hasHeaderRow: true,
    rows: [
      [rich('Name') as never, rich('Role') as never],
      [rich('Ana') as never, rich('Eng') as never],
    ],
  },
  {
    kind: 'data',
    id: 'data1',
    binding: { entity: 'tasks', viewType: 'table' } as never,
  },
  {
    kind: 'chart',
    id: 'chart1',
    chartType: 'bar',
    title: 'By status',
    binding: { op: 'count', groupBy: 'status' } as never,
  },
  {
    kind: 'image',
    id: 'img1',
    ref: {
      bucket: 'b',
      path: 'p.png',
      mimeType: 'image/png',
      sizeBytes: 10,
      name: 'p.png',
    },
    alt: 'a',
    caption: 'cap',
  },
  {
    kind: 'file',
    id: 'file1',
    ref: { bucket: 'b', path: 'f.pdf', mimeType: 'application/pdf', sizeBytes: 9, name: 'f.pdf' },
  },
  {
    kind: 'bookmark',
    id: 'bm1',
    url: 'https://example.com',
    meta: { title: 'Example' },
  },
  { kind: 'video', id: 'vid1', url: 'https://example.com/clip.mp4', caption: 'demo' },
  { kind: 'audio', id: 'aud1', url: 'https://example.com/voice.mp3' },
  { kind: 'child_page', id: 'cp1', childPageId: 'page-xyz' },
]

export const ALL_KINDS_PAGE: Page = { blocks: ALL_KINDS }
