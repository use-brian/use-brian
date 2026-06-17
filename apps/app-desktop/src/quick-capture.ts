/**
 * Quick-capture target URL.
 *
 * Pure helper shared by the global hotkey, the tray menu, the app menu, and the
 * `sidanclaw://capture` deep link so they all jump to one place.
 *
 * Spec: docs/architecture/features/app-desktop.md → "quick-capture.ts"
 * [COMP:app-desktop/quick-capture]
 */

/**
 * The canvas URL the quick-capture hotkey navigates to.
 *
 * `?capture=1` is the hint app-web reads to auto-open a blank draft and
 * focus the input. Until that web-side hook lands the param is harmless and the
 * user starts a draft manually after the window is summoned.
 *
 * @param appUrl base canvas URL with no trailing slash (see `resolveConfig`)
 */
export function quickCaptureUrl(appUrl: string): string {
  return `${appUrl}/?capture=1`;
}
