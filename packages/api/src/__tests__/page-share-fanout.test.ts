import { describe, it, expect, vi } from 'vitest'
import { publishPageShareChange, subscribeToPageShareChanges } from '../page-share-fanout.js'

describe('[COMP:api/page-share-fanout] page-share SSE fanout', () => {
  it('delivers a change only to subscribers of that page', () => {
    const a = vi.fn()
    const b = vi.fn()
    subscribeToPageShareChanges('page-a', a)
    subscribeToPageShareChanges('page-b', b)
    publishPageShareChange('page-a')
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()
  })

  it('stops delivering after unsubscribe', () => {
    const h = vi.fn()
    const off = subscribeToPageShareChanges('page-c', h)
    publishPageShareChange('page-c')
    off()
    publishPageShareChange('page-c')
    expect(h).toHaveBeenCalledTimes(1)
  })

  it('a throwing subscriber never breaks the publish loop', () => {
    const bad = () => {
      throw new Error('boom')
    }
    const good = vi.fn()
    subscribeToPageShareChanges('page-d', bad)
    subscribeToPageShareChanges('page-d', good)
    expect(() => publishPageShareChange('page-d')).not.toThrow()
    expect(good).toHaveBeenCalledTimes(1)
  })

  it('publishing to a page with no subscribers is a no-op', () => {
    expect(() => publishPageShareChange('nobody-home')).not.toThrow()
  })
})
