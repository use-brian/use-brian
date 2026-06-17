import { describe, it, expect } from 'vitest'
import { parseFollowUps, stripFollowUps } from '../follow-ups.js'

describe('[COMP:shared/follow-ups] parseFollowUps', () => {
  it('returns text unchanged when no tag is present', () => {
    const out = parseFollowUps('Hello world')
    expect(out).toEqual({ display: 'Hello world', questions: [] })
  })

  it('strips a complete tag and parses questions', () => {
    const input = 'Body text.\n\n<followup>["What is X?", "What is Y?"]</followup>'
    const out = parseFollowUps(input)
    expect(out.display).toBe('Body text.')
    expect(out.questions).toEqual(['What is X?', 'What is Y?'])
  })

  it('hides a partial tag (mid-stream) without a parsed list', () => {
    const out = parseFollowUps('Body text.\n\n<followup>["What is')
    expect(out.display).toBe('Body text.')
    expect(out.questions).toEqual([])
  })

  it('discards malformed JSON inside the tag', () => {
    const out = parseFollowUps('Body.\n\n<followup>[not json]</followup>')
    expect(out.display).toBe('Body.')
    expect(out.questions).toEqual([])
  })

  it('caps to 4 questions and drops empty strings', () => {
    const input = 'Body.\n<followup>["a", "", "b", "c", "d", "e"]</followup>'
    const out = parseFollowUps(input)
    expect(out.questions).toEqual(['a', 'b', 'c', 'd'])
  })

  it('strips even when followed by stray whitespace', () => {
    const out = parseFollowUps('Body.   \n  <followup>["q"]</followup>\n')
    expect(out.display).toBe('Body.')
    expect(out.questions).toEqual(['q'])
  })
})

describe('[COMP:shared/follow-ups] stripFollowUps', () => {
  it('returns text unchanged when no tag is present', () => {
    expect(stripFollowUps('Hello world')).toBe('Hello world')
  })

  it('removes a complete tag and trims trailing whitespace', () => {
    const input = 'Body text.\n\n<followup>["What is X?"]</followup>'
    expect(stripFollowUps(input)).toBe('Body text.')
  })

  it('removes a trailing malformed/half-streamed opener', () => {
    expect(stripFollowUps('Body text.\n\n<followup>["What is')).toBe('Body text.')
  })

  it('removes the tag wherever it appears, preserving following prose', () => {
    // Unlike parseFollowUps (which discards everything after the tag),
    // stripFollowUps is surgical and keeps surrounding content.
    const input = 'Intro.\n<followup>["q"]</followup>\nConclusion.'
    expect(stripFollowUps(input)).toBe('Intro.\n\nConclusion.')
  })

  it('removes multiple tags', () => {
    const input = 'A<followup>["x"]</followup> B <followup>["y"]</followup>'
    expect(stripFollowUps(input)).toBe('A B')
  })

  it('strips the doc-style tag the model volunteers (app-surface leak regression)', () => {
    // The exact shape that leaked into the "Ask Doc" chat: an app assistant
    // volunteered the chip tag (never instructed), and it surfaced raw +
    // re-seeded itself via history replay. stripFollowUps is what the chat
    // route runs before persist for app assistants, and the doc chat runs
    // on display. See docs/architecture/features/follow-up-questions.md → "App surfaces".
    const input =
      'You have 0 overdue or upcoming tasks in the formal database for this week.\n\n' +
      '<followup>["Create a task for the DeltaDeFi research", "Show me tasks due next week"]</followup>'
    expect(stripFollowUps(input)).toBe(
      'You have 0 overdue or upcoming tasks in the formal database for this week.',
    )
  })
})
