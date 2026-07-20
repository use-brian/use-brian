import { describe, it, expect } from 'vitest'
import type { Block, Page } from '@use-brian/core/dist/views/blocks.js'
import { pageToPlaintext } from '../block-mapping.js'
import { pageToYDoc, yDocToPlaintext } from '../encode.js'
import { ALL_KINDS_PAGE } from './fixtures.js'

const rich = (text: string) =>
  ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }) as never

describe('[COMP:doc-model/plaintext] pageToPlaintext', () => {
  it('extracts text/heading/quote/callout/code prose, one block per line', () => {
    const page: Page = {
      blocks: [
        { kind: 'heading', id: 'h', level: 1, text: 'Launch plan' },
        { kind: 'text', id: 't', text: 'Ship the onboarding flow.' },
        { kind: 'quote', id: 'q', richText: rich('Move fast') },
        { kind: 'callout', id: 'c', icon: '🔥', richText: rich('Heads up') },
        { kind: 'code', id: 'co', language: 'ts', code: 'const x = 1' },
      ] as Block[],
    }
    expect(pageToPlaintext(page)).toBe(
      'Launch plan\nShip the onboarding flow.\nMove fast\nHeads up\nconst x = 1',
    )
  })

  it('emits each list item on its own line (no run-on merge)', () => {
    const page: Page = {
      blocks: [
        { kind: 'bulleted_list_item', id: 'b1', richText: rich('first') },
        { kind: 'bulleted_list_item', id: 'b2', richText: rich('second') },
        { kind: 'to_do', id: 'td', checked: false, richText: rich('a task') },
      ] as Block[],
    }
    expect(pageToPlaintext(page)).toBe('first\nsecond\na task')
  })

  it('inlines mention labels (@name / 📄 title) from richText blocks', () => {
    // Mentions are inline atoms in a richText block (callout/quote/list);
    // flat text/heading blocks already store them pre-flattened as @name.
    const page: Page = {
      blocks: [
        {
          kind: 'callout',
          id: 'c',
          icon: '💬',
          richText: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [
                  { type: 'text', text: 'ping ' },
                  { type: 'personMention', attrs: { id: 'u1', name: 'Ada' } },
                  { type: 'text', text: ' re ' },
                  { type: 'pageMention', attrs: { id: 'p1', title: 'Roadmap' } },
                ],
              },
            ],
          } as never,
        },
      ] as Block[],
    }
    expect(pageToPlaintext(page)).toBe('ping @Ada re 📄 Roadmap')
  })

  it('skips opaque blocks — no binding/url/divider noise leaks in', () => {
    // ALL_KINDS_PAGE includes data/chart/image/file/bookmark/child_page/divider.
    const out = pageToPlaintext(ALL_KINDS_PAGE)
    expect(out).toContain('Q3 pipeline') // heading prose IS present
    expect(out).not.toContain('tasks') // data/chart binding JSON is NOT
    expect(out).not.toContain('example.com') // bookmark url is NOT
    expect(out).not.toContain('page-xyz') // child_page id is NOT
  })

  it('returns an empty string for an empty page', () => {
    expect(pageToPlaintext({ blocks: [] })).toBe('')
  })
})

describe('[COMP:doc-model/plaintext] yDocToPlaintext', () => {
  it('round-trips a page through a Y.Doc and back to the same plaintext', () => {
    const page: Page = {
      blocks: [
        { kind: 'heading', id: 'h', level: 1, text: 'Weekly notes' },
        { kind: 'text', id: 't', text: 'Three things happened.' },
      ] as Block[],
    }
    const ydoc = pageToYDoc(page, 'Weekly notes')
    expect(yDocToPlaintext(ydoc)).toBe('Weekly notes\nThree things happened.')
    ydoc.destroy()
  })
})
