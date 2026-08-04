/**
 * Which tabs `chrome.debugger` can actually drive.
 *
 * Chrome refuses to attach to its own privileged pages, so asking for consent
 * there is pointless. The old check knew this but reported it as a REFUSAL:
 * the user was told "you declined" about a prompt that was never shown, ~1s
 * into a 60s window. Two things made that vicious rather than merely wrong —
 * the install instructions end on `chrome://extensions`, so a new user's very
 * first task denied itself; and the assistant, reading `consent_denied`,
 * advised toggling the extension there, which guaranteed the next one did too.
 *
 * A structural ineligibility is not a human decision and must not borrow its
 * error code. Separating them is what lets the assistant say "switch to the
 * page you want me to work on" instead of "you declined".
 */

/**
 * The one sentence for "this tab is off limits to the debugger", wherever we
 * discover it — at consent time, at attach time, or from Chrome's own refusal.
 * Three copies of this text would drift, and the user cannot tell which of the
 * three checks fired, so they must not read differently.
 */
export const RESTRICTED_TAB_MESSAGE =
  'Use Brian cannot act on a browser settings or extension page. Ask the user to switch to the website they want it to work on, then try again.'

/** Not exported: callers narrow through `TabEligibility`, never this alone. */
type TabIneligibility = 'restricted_url' | 'no_active_tab'

export type TabEligibility = { eligible: true } | { eligible: false; reason: TabIneligibility }
export type TabEligibilityOptions = { allowFirefoxNewTab?: boolean }

const FIREFOX_NEW_TAB_URLS = new Set(['about:blank', 'about:home', 'about:newtab'])

/**
 * Resolve consent against a normal browser window, never an extension popup.
 * Firefox can keep an allow/browser-action popup as `lastFocusedWindow` after
 * the user returns to a website, which made an eligible page look restricted.
 */
export async function activeTabForConsent<T extends { active?: boolean }>(
  getLastFocused: (options: { populate: true; windowTypes: ['normal'] }) => Promise<{ tabs?: T[] }>,
): Promise<T | undefined> {
  const window = await getLastFocused({ populate: true, windowTypes: ['normal'] })
  return window.tabs?.find((tab) => tab.active === true)
}

/**
 * Schemes the debugger cannot attach to. `chrome-extension:` covers our own
 * popup and allow window: prod logged 10x "Cannot access a chrome-extension://
 * URL" AFTER consent, because those passed the old `chrome://`-only check and
 * then died inside CDP with an error no user could act on.
 *
 * DO NOT merge this with `RESTRICTED_SCHEMES` below. The two answer different
 * questions and the difference is exactly one entry, `about:`:
 *
 *   attachable — will CDP accept this tab? `about:blank` YES, Chrome attaches
 *                to it happily, and a tab mid-navigation reads as `about:blank`.
 *   eligible   — is this tab worth raising an Allow window about? `about:blank`
 *                NO, prompting for a page with nothing on it is noise.
 *
 * Attachability is the strictly narrower question and the only one
 * `chrome.debugger.attach` cares about. Collapsing them back into one list
 * makes the attach-time guard reject tabs mid-navigate.
 */
const UNATTACHABLE_SCHEMES = [
  'chrome:',
  'chrome-error:',
  'chrome-extension:',
  'chrome-search:',
  'chrome-untrusted:',
  'devtools:',
  'edge:',
  'extension:',
  'moz-extension:',
  'view-source:',
]

const RESTRICTED_SCHEMES = ['about:', ...UNATTACHABLE_SCHEMES]

/** Chrome protects the Web Store from extensions, the debugger included. */
const RESTRICTED_HOSTS = new Set(['chromewebstore.google.com', 'chrome.google.com'])

function hasRestrictedHost(url: string): boolean {
  try {
    return RESTRICTED_HOSTS.has(new URL(url).hostname.toLowerCase())
  } catch {
    return false
  }
}

/**
 * Can `chrome.debugger.attach` accept this tab? Asked immediately before
 * attaching, NOT at consent time.
 *
 * Consent-time eligibility is not enough on its own: `attach` is also reached
 * from the cached-consent fast path (`TaskGate.requireTab` returns a tab it
 * approved up to 10 minutes ago) and from the post-detach retry, neither of
 * which re-prompts. A tab that was a website when the user allowed it and is a
 * settings page by the time the next command lands used to reach `attach`
 * unguarded, and Chrome's own refusal wording became the model's answer.
 *
 * An unknown or empty URL counts as attachable on purpose. The tab already
 * passed eligibility to be consented to, so a blank read here means "still
 * loading" far more often than "privileged" — refusing would break navigation
 * mid-flight. Chrome remains the authority, and `TabExecutor.attach` translates
 * its refusal into a coded error, so this guard only has to catch the case we
 * can name.
 */
export function attachabilityOf(url: string | null | undefined): boolean {
  const trimmed = (url ?? '').trim()
  if (!trimmed) return true

  const lower = trimmed.toLowerCase()
  if (UNATTACHABLE_SCHEMES.some((scheme) => lower.startsWith(scheme))) return false
  return !hasRestrictedHost(trimmed)
}

export function eligibilityOf(
  url: string | null | undefined,
  options: TabEligibilityOptions = {},
): TabEligibility {
  const trimmed = (url ?? '').trim()
  if (!trimmed) return { eligible: false, reason: 'no_active_tab' }

  const lower = trimmed.toLowerCase()
  // Firefox's native BiDi companion can navigate an empty/new-tab context to
  // an ordinary website. Chromium still uses its stricter debugger posture,
  // and every other privileged Firefox about: page remains blocked.
  if (options.allowFirefoxNewTab && FIREFOX_NEW_TAB_URLS.has(lower)) {
    return { eligible: true }
  }
  // Prefix-match the raw string rather than parsing: a scheme is only blocked
  // when the page IS one, never when a query parameter merely mentions one.
  if (RESTRICTED_SCHEMES.some((scheme) => lower.startsWith(scheme))) {
    return { eligible: false, reason: 'restricted_url' }
  }

  try {
    if (RESTRICTED_HOSTS.has(new URL(trimmed).hostname.toLowerCase())) {
      return { eligible: false, reason: 'restricted_url' }
    }
  } catch {
    // Unparseable means we cannot reason about it; refuse rather than attach.
    return { eligible: false, reason: 'restricted_url' }
  }

  return { eligible: true }
}
