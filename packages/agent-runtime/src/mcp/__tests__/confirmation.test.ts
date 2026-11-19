import { describe, it, expect, vi } from 'vitest'
import { createConfirmationResolver } from '../types.js'

describe('[COMP:mcp/confirmation] ConfirmationResolver', () => {
  it('resolves a pending decision', async () => {
    const resolver = createConfirmationResolver()

    const promise = resolver.waitForDecision('tool-1', 5000)
    resolver.resolve('tool-1', 'allow')

    await expect(promise).resolves.toEqual({ decision: 'allow' })
  })

  it('handles early-arriving decisions', async () => {
    const resolver = createConfirmationResolver()

    // Resolve before wait
    resolver.resolve('tool-1', 'deny')
    const result = await resolver.waitForDecision('tool-1', 5000)

    expect(result).toEqual({ decision: 'deny' })
  })

  it('carries a deny-with-comment note back with the decision', async () => {
    const resolver = createConfirmationResolver()

    const promise = resolver.waitForDecision('tool-1', 5000)
    resolver.resolve('tool-1', 'deny', '  do not mention the app password  ')

    // The note is trimmed and rides alongside the decision.
    await expect(promise).resolves.toEqual({
      decision: 'deny',
      comment: 'do not mention the app password',
    })
  })

  it('omits an all-whitespace comment (treated as a plain deny)', async () => {
    const resolver = createConfirmationResolver()

    resolver.resolve('tool-1', 'deny', '   ')
    const result = await resolver.waitForDecision('tool-1', 5000)

    expect(result).toEqual({ decision: 'deny' })
  })

  it('times out with rejection', async () => {
    vi.useFakeTimers()
    const resolver = createConfirmationResolver()

    const promise = resolver.waitForDecision('tool-1', 100)
    vi.advanceTimersByTime(150)

    await expect(promise).rejects.toThrow('Confirmation timed out')
    vi.useRealTimers()
  })

  it('handles multiple concurrent confirmations', async () => {
    const resolver = createConfirmationResolver()

    const p1 = resolver.waitForDecision('tool-1', 5000)
    const p2 = resolver.waitForDecision('tool-2', 5000)

    resolver.resolve('tool-2', 'always_deny')
    resolver.resolve('tool-1', 'always_allow')

    await expect(p1).resolves.toEqual({ decision: 'always_allow' })
    await expect(p2).resolves.toEqual({ decision: 'always_deny' })
  })

  it('ignores resolve for unknown tool IDs', () => {
    const resolver = createConfirmationResolver()
    // Should not throw
    resolver.resolve('nonexistent', 'allow')
  })
})
