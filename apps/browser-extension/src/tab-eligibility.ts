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

/** Not exported: callers narrow through `TabEligibility`, never this alone. */
type TabIneligibility = 'restricted_url' | 'no_active_tab'

export type TabEligibility = { eligible: true } | { eligible: false; reason: TabIneligibility }

/**
 * Schemes the debugger cannot attach to. `chrome-extension:` covers our own
 * popup and allow window: prod logged 10x "Cannot access a chrome-extension://
 * URL" AFTER consent, because those passed the old `chrome://`-only check and
 * then died inside CDP with an error no user could act on.
 */
const RESTRICTED_SCHEMES = [
  'about:',
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

/** Chrome protects the Web Store from extensions, the debugger included. */
const RESTRICTED_HOSTS = new Set(['chromewebstore.google.com', 'chrome.google.com'])

export function eligibilityOf(url: string | null | undefined): TabEligibility {
  const trimmed = (url ?? '').trim()
  if (!trimmed) return { eligible: false, reason: 'no_active_tab' }

  const lower = trimmed.toLowerCase()
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
