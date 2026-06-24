import { describe, it, expect } from 'vitest'
import { detectSalesCall } from './detect-sales-call.js'

/**
 * Unit tests for the heuristic sales-call detector (recording-to-brain).
 * Component tag: [COMP:media/detect-sales-call].
 */
describe('[COMP:media/detect-sales-call] detectSalesCall', () => {
  it('flags a real sales call (breadth + density across categories)', () => {
    const transcript = [
      'Thanks for the demo. What does the pricing look like for our team?',
      'We have budget approved, but procurement needs a formal proposal and SOW.',
      'Our current vendor is up for renewal next quarter, so timeline matters.',
      'Next steps: I will send over the quote by Friday and we can schedule a follow-up.',
    ].join('\n')
    const d = detectSalesCall(transcript)
    expect(d.isSalesCall).toBe(true)
    expect(d.categoriesHit).toBeGreaterThanOrEqual(3)
    expect(d.score).toBeGreaterThan(0.5)
    expect(d.signals.length).toBeGreaterThan(0)
  })

  it('does NOT flag an internal standup with no sales language', () => {
    const transcript = [
      'Yesterday I finished the migration and merged the PR.',
      'Today I am pairing with Sam on the flaky test, then reviewing the docs.',
      'No blockers. The deploy went out this morning and the dashboard looks healthy.',
    ].join('\n')
    const d = detectSalesCall(transcript)
    expect(d.isSalesCall).toBe(false)
    expect(d.categoriesHit).toBeLessThan(2)
  })

  it('does NOT flag a single incidental commercial word (needs breadth)', () => {
    const transcript = 'We talked about the team offsite budget for snacks and nothing else really.'
    const d = detectSalesCall(transcript)
    expect(d.isSalesCall).toBe(false)
  })

  it('returns explainable signals for what fired', () => {
    const d = detectSalesCall('Lets discuss pricing, the proposal, next steps, and the deal stage.')
    expect(d.signals).toEqual(expect.arrayContaining(['pricing', 'proposal']))
  })
})
