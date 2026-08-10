import { describe, it, expect } from 'vitest'
import {
  BUILTIN_HOME_APP_KEYS,
  DEFAULT_HOME_APPS,
  HOME_APPS_MAX,
  customHomeAppEntry,
  customHomeAppId,
  isBuiltinHomeAppKey,
  isCustomHomeAppEntry,
  normalizeHomeApps,
  validateHomeApps,
} from '../home-apps.js'

describe('[COMP:shared/home-apps] home-apps config vocabulary', () => {
  it('holds the built-in apps in registry order', () => {
    expect(BUILTIN_HOME_APP_KEYS).toEqual([
      'page',
      'office',
      'tasks',
      'crm',
      'feed',
      'browsers',
      'chat',
      'shopify',
    ])
  })

  it('has MORE built-ins than the strip can hold, on purpose', () => {
    // These were equal until Shopify landed (2026-08-10), and the equality
    // encoded an assumption worth stating now that it is gone: that every
    // built-in could sit on the strip at once.
    //
    // Shopify is opt-in — a store app on the Home of a workspace with no store
    // is noise — so it ships in the Studio "Hidden" group rather than being
    // appended to every workspace. Raising the cap to keep the two equal would
    // change strip density for every user to serve one app nobody asked to see
    // by default, which is the wrong trade.
    expect(BUILTIN_HOME_APP_KEYS.length).toBeGreaterThan(HOME_APPS_MAX)
    expect(HOME_APPS_MAX).toBe(7)
  })

  it('defaults a never-configured workspace to Page + Office + Chat', () => {
    expect(DEFAULT_HOME_APPS).toEqual(['page', 'office', 'chat'])
    expect(normalizeHomeApps([])).toEqual(['page', 'office', 'chat'])
    expect(normalizeHomeApps(null)).toEqual(['page', 'office', 'chat'])
    expect(normalizeHomeApps('page,chat')).toEqual(['page', 'office', 'chat'])
  })

  it('recognises built-in vs custom entries', () => {
    expect(isBuiltinHomeAppKey('chat')).toBe(true)
    expect(isBuiltinHomeAppKey('custom:abc')).toBe(false)
    expect(isCustomHomeAppEntry('custom:abc')).toBe(true)
    // A bare prefix carries no id — not an entry.
    expect(isCustomHomeAppEntry('custom:')).toBe(false)
    expect(customHomeAppId('custom:abc')).toBe('abc')
    expect(customHomeAppId('chat')).toBeNull()
    expect(customHomeAppEntry('abc')).toBe('custom:abc')
  })

  it('filters unknown keys on read instead of failing (additive contract)', () => {
    expect(normalizeHomeApps(['page', 'holodeck', 'chat'])).toEqual(['page', 'chat'])
    // Everything dropped still yields a usable strip, never an empty one.
    expect(normalizeHomeApps(['holodeck'])).toEqual(['page', 'office', 'chat'])
  })

  it('dedupes, preserves the stored order, and caps at seven', () => {
    expect(normalizeHomeApps(['chat', 'page', 'chat'])).toEqual(['chat', 'page'])
    expect(
      normalizeHomeApps([
        'page',
        'tasks',
        'crm',
        'feed',
        'browsers',
        'chat',
        'custom:extra',
        'custom:overflow',
      ]),
    ).toHaveLength(HOME_APPS_MAX)
  })

  it('drops a custom entry the workspace cannot render (T3 drift → hidden)', () => {
    const stored = ['page', 'custom:a', 'custom:b']
    // No filter supplied → both survive (caller has not resolved the app list).
    expect(normalizeHomeApps(stored)).toEqual(['page', 'custom:a', 'custom:b'])
    // `b` dropped to needs_consent → it leaves the set → it leaves the strip.
    expect(normalizeHomeApps(stored, { knownCustomIds: new Set(['a']) })).toEqual([
      'page',
      'custom:a',
    ])
    // A deleted app leaves a dangling entry; the strip simply skips it.
    expect(normalizeHomeApps(stored, { knownCustomIds: new Set() })).toEqual(['page'])
  })

  it('validates writes strictly (a save may not name an unknown app)', () => {
    expect(validateHomeApps(['page', 'chat'])).toEqual({
      ok: true,
      apps: ['page', 'chat'],
    })
    expect(validateHomeApps(['page', 'custom:abc'])).toEqual({
      ok: true,
      apps: ['page', 'custom:abc'],
    })
    expect(validateHomeApps([])).toEqual({ ok: false, reason: 'empty' })
    expect(validateHomeApps('page')).toEqual({ ok: false, reason: 'not-an-array' })
    expect(validateHomeApps(['page', 'page'])).toEqual({ ok: false, reason: 'duplicate' })
    expect(validateHomeApps(['page', 'holodeck'])).toEqual({
      ok: false,
      reason: 'unknown-key',
    })
    expect(validateHomeApps(['custom:'])).toEqual({ ok: false, reason: 'unknown-key' })
    expect(
      validateHomeApps([
        'page',
        'tasks',
        'crm',
        'feed',
        'browsers',
        'chat',
        'custom:extra',
        'custom:overflow',
      ]),
    ).toEqual({ ok: false, reason: 'too-many' })
  })
})
