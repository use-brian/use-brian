import { describe, it, expect } from 'vitest'
import {
  MINI_APPS,
  getMiniApp,
  isSelfServeMiniApp,
  findMiniAppByIntent,
} from '../mini-apps.js'

describe('[COMP:shared/mini-apps] Mini-app registry', () => {
  it('marks Feed (distribution) as a contact-gated alpha', () => {
    const feed = getMiniApp('distribution')
    expect(feed.status).toBe('alpha')
    // Still a paid mini-app underneath — the gallery just suppresses the Pro
    // pill in favor of the Alpha pill while access is trial-only.
    expect(feed.requiresPaid).toBe(true)
  })

  it('keeps Doc (views) self-serve available', () => {
    expect(getMiniApp('views').status).toBe('available')
  })

  it('excludes alpha apps from the self-serve set the onboarding wizard uses', () => {
    expect(isSelfServeMiniApp(getMiniApp('distribution'))).toBe(false)
    expect(isSelfServeMiniApp(getMiniApp('views'))).toBe(true)

    const selfServe = MINI_APPS.filter(isSelfServeMiniApp)
    expect(selfServe.every((m) => m.status === 'available')).toBe(true)
    expect(selfServe.some((m) => m.id === 'distribution')).toBe(false)
  })

  it('still resolves the feed intent for deep-links — pre-select gating happens at the call site', () => {
    // findMiniAppByIntent matches on defaultIntent, not status, so a
    // ?intent=feed deep-link still resolves; the onboarding wizard is what
    // declines to pre-select it (via isSelfServeMiniApp).
    expect(findMiniAppByIntent('feed')?.id).toBe('distribution')
  })
})
