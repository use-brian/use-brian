/**
 * The `debugger` permission — "may Use Brian manage this browser" — asked for
 * at the moment the user chooses it, not silently granted at install.
 *
 * It used to sit in the manifest's required `permissions`, so accepting the
 * install accepted browser control forever, bundled with everything else and
 * revocable only by uninstalling. It is now an **optional** permission: Chrome
 * shows its own prompt when we ask, the user can say no and still keep the
 * extension, and they can revoke it later from chrome://extensions without
 * losing their pairing. That is a narrower grant than before, in the same
 * spirit as the §6 refusal of `<all_urls>` (my-browser.md).
 *
 * Two Chrome constraints shape every caller:
 *  - `permissions.request()` works ONLY from an extension context, so our web
 *    app can never raise this prompt itself. It asks the background to open
 *    `grant.html`, and the click in THAT window does the asking.
 *  - `permissions.request()` must run inside a real user gesture. Calling it
 *    from a message handler or on load throws; it has to hang off a click.
 *
 * The API is injected so the decision logic is testable outside Chrome.
 */

/** The slice of `chrome.permissions` this module needs. */
export type PermissionsApi = {
  contains(p: { permissions: string[] }): Promise<boolean>;
  request(p: { permissions: string[] }): Promise<boolean>;
};

/** The one capability that means "can drive this browser". */
export const BROWSER_CONTROL_PERMISSIONS = ['debugger'] as const;

function api(explicit?: PermissionsApi): PermissionsApi | null {
  if (explicit) return explicit;
  const p = (globalThis as { chrome?: { permissions?: PermissionsApi } }).chrome?.permissions;
  return p && typeof p.contains === 'function' ? p : null;
}

/**
 * Has the user granted browser control? A missing `chrome.permissions` (an old
 * Chrome, a non-extension context) answers **false** rather than throwing: the
 * callers use this to decide whether to offer the prompt, and offering it
 * needlessly is a far smaller harm than crashing the popup.
 */
export async function hasBrowserControl(explicit?: PermissionsApi): Promise<boolean> {
  const p = api(explicit);
  if (!p) return false;
  try {
    return await p.contains({ permissions: [...BROWSER_CONTROL_PERMISSIONS] });
  } catch {
    return false;
  }
}

/**
 * Ask Chrome to show the permission prompt. MUST be called from inside a user
 * gesture (a click handler) — see the module note. Returns whether the user
 * granted it; a throw (no gesture, no API) is reported as "not granted" so a
 * caller never treats a failed ask as a grant.
 */
export async function requestBrowserControl(explicit?: PermissionsApi): Promise<boolean> {
  const p = api(explicit);
  if (!p) return false;
  try {
    return await p.request({ permissions: [...BROWSER_CONTROL_PERMISSIONS] });
  } catch {
    return false;
  }
}
