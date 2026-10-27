# Chrome extension releases

The Chrome extension is released independently of Electron. A new version means
a committed increase to `apps/browser-extension/static/manifest.json`, not an
Electron version or an npm package version. The canonical Store item is
`nnmbbacnkekaoccmkmlfaghjaamgdpjn`.

## Automatic release contract

`.github/workflows/browser-extension-release.yml` follows the desktop release
trigger: a successful `CI` **push** run on `main` in `use-brian/use-brian`, or a
manual dispatch on `main`. Feature branches, `develop`, PR CI, forks, and failed
CI never publish. The workflow checks out the exact tested SHA with persisted
Git credentials disabled. Before using Store credentials, and again immediately
before uploading, it verifies that this SHA is still current `main` and that its
latest push CI run succeeded. Queued stale runs skip before building; a production
change during a build fails before uploading.

The publish job uses the existing `browser-extension-release` GitHub environment
and its four secrets:

- `CHROME_WEB_STORE_PUBLISHER_ID`
- `CHROME_WEB_STORE_CLIENT_ID`
- `CHROME_WEB_STORE_CLIENT_SECRET`
- `CHROME_WEB_STORE_REFRESH_TOKEN`

No service account or additional enable variable is required. Configure the
environment to allow `main`; leave required reviewers disabled for unattended
publishing. Secrets are passed only to the publishing step. The job uses a
read-only GitHub token and serializes releases without cancelling active uploads.

`apps/browser-extension/scripts/release.mjs` exchanges the OAuth refresh token
for a short-lived access token, then reads authenticated Store status before
starting a build. It skips versions already published (including equivalent
Chrome versions such as `1.1` and `1.1.0`), active reviews/staged revisions, and
in-progress async uploads. It never cancels or replaces an active review. A newer
version blocked by an earlier review is retried on the next successful main CI
run, or by manually dispatching the workflow after that review finishes.

Invalid versions/status responses, policy warnings, takedowns, authentication
errors, and a rejected/cancelled submission at or above the candidate version
fail visibly. Resolve a rejection in the dashboard and commit a corrected,
higher version. The initial listing must already be published and its Store
listing, privacy, distribution, and reviewer details completed in the dashboard.

For a new version, the wrapper runs the existing release script with
`--publish --auto-publish --yes`. It builds workspace dependencies, tests and
typechecks the extension, verifies its committed source fingerprint, builds a
reproducible ZIP, checks Store status again, uploads, and submits using
`DEFAULT_PUBLISH`, `skipReview: false`, and `blockOnWarnings: true`. Google review
still applies; approval automatically publishes using the listing's existing
visibility. Workflow success means submission was verified, not that review
has finished. ZIPs are retained as workflow artifacts, including when a later
upload/submission fails.

## Preparing a new version

1. Increase `apps/browser-extension/static/manifest.json`'s `version` using one
   to four dot-separated integers, each between 0 and 65535 (not all zero).
2. Run `node apps/browser-extension/scripts/build-hash.mjs` and update
   `CURRENT_EXTENSION_BUILD` in `packages/shared/src/browser-extension-build.ts`
   with its output. The manifest itself contributes to this fingerprint.
3. Commit both changes together with the extension changes, then merge through
   `develop` into `main`. Publishing begins only after main CI passes.

The workflow does not rewrite source versions, create version-bump commits, or
publish extensions for unrelated Electron releases.

## Local releases

`pnpm release:browser-extension` prepares a ZIP only. To submit manually, use
`pnpm release:browser-extension --publish` (staged after approval), or add
`--auto-publish` to publish after approval. `--yes` is for a deliberate release
runner. Dirty/offline packages cannot be published. The local script also accepts
an access token or service-account impersonation instead of the OAuth trio.

The public Store-version preflight reads the version from the XML `updatecheck`
element. A missing extension version fails the check; the XML declaration's
`version="1.0"` must never be treated as the published extension version.

The package is `apps/browser-extension/release/use-brian-browser-extension-VERSION.zip`,
with `manifest.json` at its root. Firefox has a separate build and distribution
process and is not part of this workflow.

## Verification

`[COMP:ext/chrome-release]` covers the package script and
`[COMP:ext/chrome-release-ci]` covers workflow trust boundaries, version/status
decisions, token refresh, and submission orchestration using fake services.
No test uploads to Chrome Web Store.

References: [Store API](https://developer.chrome.com/docs/webstore/using-api),
[Store status schema](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/fetchStatus),
[GitHub workflow_run](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run).
