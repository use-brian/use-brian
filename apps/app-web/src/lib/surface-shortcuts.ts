/**
 * Surface-shortcut keybinding — which modifier the ⌘/Ctrl+1–4 surface jumps
 * (Home / Brain / Studio / Workflow, wired in `workspace-chrome.tsx`) listen
 * for, per browser. Spec: docs/architecture/features/doc.md → "Surface
 * shortcuts".
 *
 * Chrome/Chromium, Safari, and the Electron desktop shell deliver Accel+digit
 * to the page and honor `preventDefault()`, so they keep the native Accel
 * binding (⌘ on macOS, Ctrl elsewhere). Firefox treats Accel+1–9 as a
 * RESERVED tab-switching shortcut — the keydown still reaches the page but
 * `preventDefault()` cannot stop the tab switch — so there the binding remaps
 * to plain Ctrl+digit, and ⌘+digit is deliberately not matched (a surface
 * jump must never double up with the browser's tab switch). On Windows/Linux
 * Firefox Ctrl+digit is itself the reserved tab switch, so the browser wins
 * when several tabs are open — there is no free single modifier left
 * (Alt+digit also switches tabs on Linux Firefox).
 *
 * UA sniffing is deliberate: there is no feature-detect for "is this shortcut
 * reserved", and the check only picks which binding to listen for. Electron's
 * UA contains "Chrome", never "Firefox", so the desktop shell keeps ⌘.
 *
 * [COMP:app-web/surface-shortcuts]
 */

const runtimeUa = typeof navigator === "undefined" ? "" : navigator.userAgent;

export function isFirefoxUa(ua: string): boolean {
  return ua.includes("Firefox");
}

export function isMacUa(ua: string): boolean {
  return ua.includes("Mac");
}

/**
 * True when a keydown carries this browser's surface-shortcut modifier
 * (and no Shift/Alt, which are always left alone).
 */
export function surfaceShortcutModifierPressed(
  e: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  ua: string = runtimeUa,
): boolean {
  if (e.shiftKey || e.altKey) return false;
  if (isFirefoxUa(ua)) return e.ctrlKey && !e.metaKey;
  return e.metaKey || e.ctrlKey;
}

/**
 * Tooltip chip label for a surface digit — "⌘1" (mac), "⌃1" (mac Firefox),
 * "Ctrl+1" (everything else, and the SSR fallback: `navigator` is undefined
 * on the server, but the tooltip popup only mounts on hover so the fallback
 * never reaches paint).
 */
export function surfaceShortcutLabel(
  digit: number,
  ua: string = runtimeUa,
): string {
  if (!isMacUa(ua)) return `Ctrl+${digit}`;
  return isFirefoxUa(ua) ? `⌃${digit}` : `⌘${digit}`;
}
