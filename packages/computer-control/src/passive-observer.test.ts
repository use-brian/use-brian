import { expect, it, vi } from 'vitest'
import { PassiveObserverHealthSchema as schema, PassiveObserverReasonSchema, passiveObserverHealth } from './passive-observer.js'
it('accepts only canonical fixed health and never reads accessors', () => {
  for (const reason of [null, ...PassiveObserverReasonSchema.options]) {
    const health = passiveObserverHealth(reason)
    expect(schema.parse(health)).toEqual(health)
    expect(Object.isFrozen(health)).toBe(true)
  }
  const getter = vi.fn()
  const health = passiveObserverHealth(null)
  for (const bad of [{ ...health, extra: true }, { ...health, reason: 'private' }, { ...health, drain: 'complete' }, { ...health, state: 'complete' }, Object.create(health), [], Promise.resolve(health), Object.defineProperty({ ...health }, 'reason', { get: getter })]) expect(schema.safeParse(bad).success).toBe(false)
  expect(getter).not.toHaveBeenCalled()
})
