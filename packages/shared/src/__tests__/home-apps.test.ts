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
  it('holds the six built-in apps in registry order, Chat 6th', () => {
    expect(BUILTIN_HOME_APP_KEYS).toEqual([
      'page',
      'tasks',
      'crm',
      'feed',
      'browsers',
      'chat',
    ])
    expect(HOME_APPS_MAX).toBe(BUILTIN_HOME_APP_KEYS.length)
  })

  it('defaults a never-configured workspace to Page + Chat (D2)', () => {
    expect(DEFAULT_HOME_APPS).toEqual(['page', 'chat'])
    expect(normalizeHomeApps([])).toEqual(['page', 'chat'])
    expect(normalizeHomeApps(null)).toEqual(['page', 'chat'])
    expect(normalizeHomeApps('page,chat')).toEqual(['page', 'chat'])
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
    expect(normalizeHomeApps(['holodeck'])).toEqual(['page', 'chat'])
  })

  it('dedupes, preserves the stored order, and caps at six', () => {
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
      ]),
    ).toEqual({ ok: false, reason: 'too-many' })
  })
})
