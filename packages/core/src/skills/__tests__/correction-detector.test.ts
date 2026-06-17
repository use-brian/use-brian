/**
 * Tests for the `detectCorrection` heuristic used by the deferred V1.1
 * `user_corrected_after` signal.
 * Component tag: [COMP:skills/correction-detector].
 *
 * The detector is intentionally rough — it errs toward false-negatives.
 * Tests assert the obvious positives (sentence opens with a correction
 * phrase) and the load-bearing negatives (correction phrase appears
 * mid-sentence, or only as a substring).
 *
 * Cases mirror the spec's example: "User sends correction message
 * within next N turns referencing this skill's domain" — at this layer
 * we only check shape, not domain reference. Domain matching is the
 * downstream V1.1 worker's job.
 */

import { describe, it, expect } from 'vitest'
import { detectCorrection } from '../invocation-buffer.js'

describe('[COMP:skills/correction-detector] detectCorrection', () => {
  it.each([
    ['No, I meant the other one', true],
    ['no thanks, undo that', true],
    ['Wrong — try again', true],
    ['Stop, that\'s not what I asked', true],
    ['Actually, do it differently', true],
    ['Not what I meant — please retry', true],
    ['Incorrect, try again', true],
    ["Don't do that", true],
    ['dont send it', true],
    ['Cancel that', true],
    ['Undo the last action', true],
    ['Instead of X, do Y', true],
    ['Nope, redo that', true],
    ['Nah, try something else', true],
    ['  no, retry  ', true], // leading whitespace + comma
  ])('returns true for correction-shaped message: %p', (msg, expected) => {
    expect(detectCorrection(msg)).toBe(expected)
  })

  it.each([
    ['Let me think about that', false],
    ['Can you summarize this?', false],
    ['Thanks, that works great', false],
    ['What does X mean?', false],
    // Substring traps — these must NOT match because the phrase is mid-sentence
    // or part of a longer word.
    ['I would like a snowstop sign', false],
    ['Tell me about notation', false],
    ['I have a question about cancelation policies', false],
    // Mid-sentence correction phrase — refining the same ask, not
    // correcting the prior turn.
    ['Could you do X? Wait actually do Y instead', false],
    ['Please continue', false],
    ['', false],
    ['   ', false],
  ])('returns false for non-correction message: %p', (msg, expected) => {
    expect(detectCorrection(msg)).toBe(expected)
  })

  it('only inspects the first 80 chars', () => {
    // Pad the message so the correction phrase falls beyond the window.
    const padding = 'lorem '.repeat(20) // ~120 chars before "no"
    const msg = padding + 'no, that was wrong'
    expect(detectCorrection(msg)).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(detectCorrection('NO, that was wrong')).toBe(true)
    expect(detectCorrection('Stop')).toBe(true)
    expect(detectCorrection('INSTEAD do this')).toBe(true)
  })
})
