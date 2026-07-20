import { describe, it, expect } from 'vitest'
import { handleConnectCommand } from '../_connect-command.js'

const APP_URL = 'https://usebrian.ai'

describe('[COMP:api/connect-command] handleConnectCommand', () => {
  it('returns handled=false for unrelated text so the caller falls through', () => {
    const r = handleConnectCommand({ text: 'hello there', isLinked: true, appUrl: APP_URL })
    expect(r).toEqual({ message: null, handled: false })
  })

  it('tells unlinked users to /start first', () => {
    const r = handleConnectCommand({ text: '/connect', isLinked: false, appUrl: APP_URL })
    expect(r.handled).toBe(true)
    expect(r.message?.text).toContain('/start')
  })

  it('renders a menu with one web_app button per enabled connector', () => {
    const r = handleConnectCommand({ text: '/connect', isLinked: true, appUrl: APP_URL })
    expect(r.handled).toBe(true)
    expect(r.message?.actions?.length).toBeGreaterThanOrEqual(4)
    for (const a of r.message?.actions ?? []) {
      expect(a.kind).toBe('web_app')
      if (!('url' in a)) continue
      expect(a.url.startsWith(`${APP_URL}/tg-link?next=`)).toBe(true)
      // `next` is URL-encoded inside the query string; decode to verify payload.
      const next = new URL(a.url).searchParams.get('next') ?? ''
      expect(next.startsWith('/studio/connectors?connect=')).toBe(true)
    }
  })

  it('renders a single-button reply for /connect <known-id>', () => {
    const r = handleConnectCommand({ text: '/connect gdrive', isLinked: true, appUrl: APP_URL })
    expect(r.handled).toBe(true)
    expect(r.message?.actions?.length).toBe(1)
    const a = r.message?.actions?.[0]
    expect(a && 'url' in a && a.url).toContain(encodeURIComponent('connect=gdrive'))
  })

  it('rejects unknown connector IDs with the list of known IDs', () => {
    const r = handleConnectCommand({ text: '/connect plutonium', isLinked: true, appUrl: APP_URL })
    expect(r.handled).toBe(true)
    expect(r.message?.text).toContain('Unknown connector')
    expect(r.message?.text).toContain('gdrive')
  })

  it('recognizes help/list/? synonyms', () => {
    for (const form of ['/connect help', '/connect list', '/connect ?']) {
      const r = handleConnectCommand({ text: form, isLinked: true, appUrl: APP_URL })
      expect(r.handled).toBe(true)
      expect(r.message?.text).toContain('Usage')
    }
  })

  it('refuses BYO non-owners with a pointer to @use_brian_bot', () => {
    const r = handleConnectCommand({
      text: '/connect gdrive',
      isLinked: true,
      appUrl: APP_URL,
      byoNonOwner: true,
    })
    expect(r.handled).toBe(true)
    expect(r.message?.text).toContain('owner')
    expect(r.message?.text).toContain('@use_brian_bot')
  })

  it('falls back to plain text when appUrl is missing', () => {
    const r = handleConnectCommand({ text: '/connect gdrive', isLinked: true, appUrl: undefined })
    expect(r.handled).toBe(true)
    expect(r.message?.actions).toBeUndefined()
    expect(r.message?.text).toContain('unavailable')
  })

  it('is case-insensitive on the command itself', () => {
    const r = handleConnectCommand({ text: '/Connect', isLinked: true, appUrl: APP_URL })
    expect(r.handled).toBe(true)
    expect(r.message?.actions?.length).toBeGreaterThan(0)
  })

  it('threads botUsername as ?bot=<username> on every Mini App button for BYO bots', () => {
    const menu = handleConnectCommand({
      text: '/connect',
      isLinked: true,
      appUrl: APP_URL,
      botUsername: 'gm_bro_bot',
    })
    expect(menu.handled).toBe(true)
    for (const a of menu.message?.actions ?? []) {
      if (a.kind !== 'web_app') continue
      expect(a.url).toContain('bot=gm_bro_bot')
      expect(a.url).toContain('next=')
    }

    const single = handleConnectCommand({
      text: '/connect gdrive',
      isLinked: true,
      appUrl: APP_URL,
      botUsername: 'gm_bro_bot',
    })
    const btn = single.message?.actions?.[0]
    if (btn && btn.kind === 'web_app') {
      expect(btn.url).toContain('bot=gm_bro_bot')
    }
  })

  it('omits the bot param on the official bot (no botUsername supplied)', () => {
    const r = handleConnectCommand({ text: '/connect', isLinked: true, appUrl: APP_URL })
    for (const a of r.message?.actions ?? []) {
      if (a.kind !== 'web_app') continue
      expect(a.url).not.toContain('bot=')
    }
  })
})
