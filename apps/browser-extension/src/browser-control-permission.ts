/** Browser-control capability check, kept separate for honest diagnostics. */

/** The slice of `chrome.permissions` this module needs. */
export type PermissionsApi = {
  contains(p: { permissions: string[] }): Promise<boolean>;
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
 * caller reports that the extension must be reloaded or reinstalled.
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
