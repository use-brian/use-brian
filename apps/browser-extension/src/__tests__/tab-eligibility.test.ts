import { describe, it, expect } from 'vitest'
import { attachabilityOf, activeTabForConsent, eligibilityOf } from '../tab-eligibility.js'

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

/**
 * Attachability is asked immediately before `chrome.debugger.attach`, which is
 * NOT where eligibility is asked. `TaskGate.requireTab` returns a cached tab
 * for up to ten minutes without re-consulting anyone, and the post-detach
 * retry re-attaches without prompting, so both reach `attach` having skipped
 * `promptForConsent` entirely — the only place eligibility was enforced.
 *
 * The two lists differ by exactly one entry, and these tests exist to keep
 * anyone from "tidying" them into one.
 */
describe('[COMP:ext/agent] Attachability at attach time', () => {
  it('permits about:blank, which consent deliberately refuses', () => {
    // CDP attaches to about:blank happily, and a tab mid-navigation reads as
    // about:blank — rejecting it here would break navigate in flight. Consent
    // still declines to raise an Allow window for an empty page.
    expect(attachabilityOf('about:blank')).toBe(true)
    expect(eligibilityOf('about:blank')).toEqual({ eligible: false, reason: 'restricted_url' })
  })

  it('refuses the pages Chrome will not attach to', () => {
    expect(attachabilityOf('chrome-extension://abcdefghijklmnop/grant.html')).toBe(false)
    expect(attachabilityOf('chrome://settings')).toBe(false)
    expect(attachabilityOf('devtools://devtools/bundled/inspector.html')).toBe(false)
    expect(attachabilityOf('view-source:https://example.com')).toBe(false)
    expect(attachabilityOf('moz-extension://abc/popup.html')).toBe(false)
    expect(attachabilityOf('https://chromewebstore.google.com/search/Use%20Brian')).toBe(false)
  })

  it('permits an ordinary page, including one that mentions a blocked scheme', () => {
    expect(attachabilityOf('https://example.com/dashboard')).toBe(true)
    expect(attachabilityOf('https://example.com/?next=chrome://extensions')).toBe(true)
  })

  it('permits an unknown url rather than refusing on no evidence', () => {
    // The tab already passed eligibility to be consented to, so a blank read
    // here means "still loading" far more often than "privileged". Chrome
    // stays the authority and `TabExecutor.attach` translates its refusal.
    expect(attachabilityOf(undefined)).toBe(true)
    expect(attachabilityOf('')).toBe(true)
  })
})
