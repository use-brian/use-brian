import { describe, it, expect } from 'vitest'
import { stripCommentThreadReplyTag } from '../control-tags.js'

describe('[COMP:shared/control-tags] stripCommentThreadReplyTag', () => {
  it('returns text unchanged when no tag is present', () => {
    expect(stripCommentThreadReplyTag('Consolidated the dependencies section.')).toBe(
      'Consolidated the dependencies section.',
    )
  })

  it('unwraps the confabulated tag, keeping the inner reply prose', () => {
    // The exact shape that leaked into a doc comment thread: the assistant
    // invented an XML-ish wrapper (no prompt defines it) around its reply,
    // leaking an internal page UUID. We keep the reply, drop the markers.
    const input =
      '<comment-thread-reply pageId="b3317b50-31a9-4223-8aa4-fdfde53478eb"> Consolidated ' +
      'the dependencies section. The redundant table has been removed. </comment-thread-reply>'
    expect(stripCommentThreadReplyTag(input)).toBe(
      ' Consolidated the dependencies section. The redundant table has been removed.',
    )
  })

  it('keeps the prose authored before and after the wrapper', () => {
    const input =
      'I have consolidated these into the subpage.\n\n' +
      '<comment-thread-reply pageId="abc-123">Done.</comment-thread-reply>'
    expect(stripCommentThreadReplyTag(input)).toBe(
      'I have consolidated these into the subpage.\n\nDone.',
    )
  })

  it('removes a trailing half-streamed/unclosed opener', () => {
    expect(
      stripCommentThreadReplyTag('Working on it.\n\n<comment-thread-reply pageId="abc'),
    ).toBe('Working on it.')
  })

  it('does not touch a legitimate angle-bracket / code fragment', () => {
    const input = 'Use `a < b && b > c` to compare, and see the <Button> component.'
    expect(stripCommentThreadReplyTag(input)).toBe(input)
  })

  it('is case-insensitive and attribute-tolerant', () => {
    const input = '<Comment-Thread-Reply  data-x="1" pageId="p">Hi</Comment-Thread-Reply>'
    expect(stripCommentThreadReplyTag(input)).toBe('Hi')
  })
})
