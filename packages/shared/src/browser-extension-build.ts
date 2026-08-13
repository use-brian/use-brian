/**
 * Which browser-extension build this repo expects to be talking to.
 *
 * On 2026-08-03 a user's assistant reported a Chrome internal
 * (`Cannot access a chrome-extension:// URL`) as a system permission error.
 * The cause was not in any of the code it named: the extension loaded in that
 * browser had been built eleven days earlier, from a folder left orphaned by
 * the open-core cutover, and was missing three fixes that each addressed
 * exactly the failure being reported. Nothing anywhere said so. Establishing
 * which build was running took a SHA256 of a filesystem path.
 *
 * `CURRENT_EXTENSION_BUILD` is the fingerprint of
 * `apps/browser-extension/src/**` plus `static/manifest.json`, produced by
 * `apps/browser-extension/scripts/build-hash.mjs` — the single implementation,
 * which `pnpm check` shells out to rather than reimplementing. The extension
 * stamps the same value into `dist/build-info.json` at build time and reports
 * it to the relay on hello.
 *
 * Do not hand-edit. `pnpm check` (`invariants/browser-extension-build-stamp`)
 * prints the value to paste when extension source moves.
 */
export const CURRENT_EXTENSION_BUILD = 'b0e3c0f82da0'

/**
 * A reported build is stale unless it matches exactly.
 *
 * Absence counts as stale, deliberately and without a special case: an
 * extension that reports nothing was built before the stamp existed, which
 * makes it strictly older than the commit that introduced this file. That is
 * the population the incident came from, so exempting it would exempt the only
 * users who need telling.
 *
 * The flip side is that any source edit, comment included, flags every
 * installed extension. That is honest while the extension is loaded unpacked
 * by hand. Once it ships through the Chrome Web Store this should become a
 * minimum-supported comparison rather than an equality one, so a cosmetic
 * commit does not nag the whole install base.
 */
export function isExtensionBuildStale(reported: string | null | undefined): boolean {
  return (reported ?? '') !== CURRENT_EXTENSION_BUILD
}

/**
 * Appended to a backend error when the failure came from a stale extension.
 *
 * The point is the ordering: the model still reports what actually failed, and
 * this rides along as the thing the user can act on. Without it the assistant
 * has no way to know that the remedy is "reload the extension" rather than
 * anything to do with the website it was asked to visit.
 */
export const STALE_EXTENSION_REMEDY =
  'The browser extension in this browser is out of date, which may be the cause. Ask the user to rebuild and reload it, then try again.'
