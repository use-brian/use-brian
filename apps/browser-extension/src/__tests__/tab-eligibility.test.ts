import { describe, it, expect } from 'vitest'
import { activeTabForConsent, eligibilityOf } from '../tab-eligibility.js'

/**
 * Which tabs the extension can actually drive.
 *
 * Chrome refuses `chrome.debugger` on its own privileged pages, so consent
 * there is worthless. The old code recognised that but reported it as a
 * REFUSAL: the user saw "you declined" for a prompt that was never shown, ~1s
 * into a 60s window. Worse, the install instructions end on `chrome://
 * extensions`, so a brand-new user's first task denied itself, and the
 * assistant's own advice ("toggle the extension off and on") guaranteed a
 * repeat. A structural ineligibility is not a human decision and must not
 * borrow its error code.
 */
describe('[COMP:ext/agent] Controllable-tab eligibility', () => {
  it('selects the active tab from a normal window instead of an extension popup', async () => {
    const getLastFocused = async (options: { populate: true; windowTypes: ['normal'] }) => {
      expect(options).toEqual({ populate: true, windowTypes: ['normal'] })
      return {
        tabs: [
          { id: 1, active: false, url: 'https://example.com/' },
          { id: 2, active: true, url: 'https://google.com/' },
        ],
      }
    }
    await expect(activeTabForConsent(getLastFocused)).resolves.toMatchObject({
      id: 2,
      url: 'https://google.com/',
    })
  })

  it('accepts ordinary web pages', () => {
    expect(eligibilityOf('https://example.com/dashboard')).toEqual({ eligible: true })
    expect(eligibilityOf('http://localhost:3003/w/abc')).toEqual({ eligible: true })
  })

  it('rejects the browser settings pages the debugger cannot attach to', () => {
    for (const url of [
      'chrome://extensions',
      'chrome://settings/privacy',
      'edge://settings',
      'about:blank',
      'devtools://devtools/bundled/inspector.html',
      'view-source:https://example.com',
      'chrome-untrusted://print',
    ]) {
      expect(eligibilityOf(url), url).toEqual({ eligible: false, reason: 'restricted_url' })
    }
  })

  it('allows only Firefox empty/new-tab launch pages when explicitly requested', () => {
    for (const url of ['about:blank', 'about:home', 'about:newtab']) {
      expect(eligibilityOf(url, { allowFirefoxNewTab: true }), url).toEqual({ eligible: true })
      expect(eligibilityOf(url), url).toEqual({ eligible: false, reason: 'restricted_url' })
    }
    expect(eligibilityOf('about:config', { allowFirefoxNewTab: true })).toEqual({
      eligible: false,
      reason: 'restricted_url',
    })
  })

  it('rejects extension pages, including our own popup and allow window', () => {
    // Prod logged 10x "Cannot access a chrome-extension:// URL" AFTER consent:
    // these passed the old chrome://-only check, then died inside CDP with an
    // error the user could do nothing about.
    expect(eligibilityOf('chrome-extension://abcdefghijklmnop/popup.html')).toEqual({
      eligible: false,
      reason: 'restricted_url',
    })
  })

  it('rejects the Chrome Web Store, which Chrome protects from the debugger', () => {
    expect(eligibilityOf('https://chromewebstore.google.com/search/Use%20Brian')).toEqual({
      eligible: false,
      reason: 'restricted_url',
    })
  })

  it('reports a missing tab distinctly from a restricted one', () => {
    // Different remedies: "switch to a page" vs "open a page first".
    expect(eligibilityOf(undefined)).toEqual({ eligible: false, reason: 'no_active_tab' })
    expect(eligibilityOf('')).toEqual({ eligible: false, reason: 'no_active_tab' })
  })

  it('does not reject a normal page merely for mentioning a blocked scheme', () => {
    expect(eligibilityOf('https://example.com/?next=chrome://extensions')).toEqual({
      eligible: true,
    })
  })
})
