# Chrome extension releases

The canonical Chrome Web Store item is
`nnmbbacnkekaoccmkmlfaghjaamgdpjn`. Chrome and Firefox have separate builds;
Chrome releases package only the contents of `apps/browser-extension/dist/`.

## Building and publishing locally

`pnpm release:browser-extension` builds workspace dependencies, runs extension
tests and typechecking, verifies the committed source fingerprint, and creates
`apps/browser-extension/release/use-brian-browser-extension-VERSION.zip`.
The manifest must be at the ZIP root, and timestamps are normalized to the source
commit for reproducible packaging.

The manifest version must be greater than the published Store version. The
public update response is XML: read the version on its `updatecheck` element,
not the XML declaration's `version="1.0"`. A missing extension version must fail
the preflight rather than silently comparing against the XML format version.

To submit manually, use `pnpm release:browser-extension --publish` (staged after
approval), or add `--auto-publish` to publish automatically after Google review.
The script accepts an access token, service-account impersonation, or the OAuth
client ID/client secret/refresh token trio, plus a publisher ID. Store listing,
privacy, distribution, and reviewer details must be completed in the dashboard.
Dirty/offline packages cannot be published; `--offline --allow-dirty` is only for
local artifact checks. `--yes` is for a deliberate release runner.

## Verification

`[COMP:ext/chrome-release]` covers the package script, including public Store
responses with an XML declaration and missing extension versions.
No test uploads to Chrome Web Store.
