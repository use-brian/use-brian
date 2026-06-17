import { describe, it, expect } from 'vitest'
import { normalizeBullets } from '../normalize-markdown.js'

describe('[COMP:chat-ui/normalize-markdown] normalizeBullets', () => {
  it('returns input unchanged when there are no bullet characters', () => {
    expect(normalizeBullets('plain text\n- already a list')).toBe(
      'plain text\n- already a list',
    )
  })

  it('rewrites leading bullets to dashes', () => {
    expect(normalizeBullets('\u2022 item one\n\u2022 item two')).toBe(
      '- item one\n- item two',
    )
  })

  it('splits inline bullets onto separate lines', () => {
    expect(
      normalizeBullets('First \u2022 second \u2022 third'),
    ).toBe('First\n- second\n- third')
  })

  it('preserves bullets inside fenced code blocks', () => {
    const input = '```\n\u2022 inside fence\n```\nafter \u2022 outside'
    expect(normalizeBullets(input)).toBe(
      '```\n\u2022 inside fence\n```\nafter\n- outside',
    )
  })
})
