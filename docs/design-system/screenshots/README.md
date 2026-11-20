# Screenshot evidence: before and after

[Before gallery](index.html) · [After gallery](after/index.html) ·
[Fixes and whole-page review](../implementation.md) · [Original findings](../audit.md) ·
[Common system](../README.md) · [Coverage](../coverage.md)

- **Before: 16 PNGs** directly in this directory, from clean develop
  `43a70a8e3608ffc53d76207af4aba85cfb37ea76`. [Original manifest](manifest.json).
- **After: 32 PNGs** in `after/`, captured from the F01–F07 working tree **before the fixes
  were committed**. [After manifest](after/manifest.json) preserves that historical state.
  The fixes were subsequently integrated onto develop `52eb85bdf`; that upstream update
  did not touch the captured frontend files. Source-file hashes verify the same code.

Both manifests record exact timestamp, URLs, viewport dimensions, computed styles,
blocked browser requests and Chromium version. DPR 1, English, UTC, reduced motion,
default Notion palette. Phone widths are Chromium viewport evidence, not mobile Safari
or physical-device certification.

## Evidence levels and important limits

1. **Real public pages:** Accounts and auth Login. No credentials submitted, email requested,
   or authenticated state. The login captures focus the email field.
2. **Isolated production components:** unchanged by the fixture, imported from current
   production source with real app CSS and synthetic props. The source differs before/after
   because of the fixes; no expected-state mockups or screenshot-only style patches are used.
3. **Production route bodies with synthetic read-only data (after only):** Workflow detail
   and Shopify Analyse include production headers/tabs/content/dialogs. The harness replaces
   the auth transport and only the OperatorTopbar's sidebar-state hook. No real session,
   persistent workspace sidebar/search or full cross-route navigation is mounted. These are
   **not authenticated full-workspace screenshots**. See the conspicuous capture label.

All browser `/api/` and non-local requests are blocked. The route-body transport handles
synthetic GETs in memory and rejects mutations before network. No workflow execution,
Shopify query, assistant call, sign-in request or other external action occurs. The production
picker-preferences store attempts an automatic startup PATCH; it appears in fixtureRequests,
but is rejected by the synthetic transport before forwarding or network, not executed.
The existing Workflow browser fixture is reused with a valid manual trigger (its older
sample event shape is not used). Fixture code is documentation-only, not a product route.

Only documentation framing and the Next development indicator are styled/hidden. Product
component CSS is not patched. Linux font fallbacks differ from macOS/Windows; the preview
does not load Next's mono font. Missing CJK/emoji glyphs in this minimal container are font
artifacts, **not product defects**. F06's fixed dark surface is visible despite missing glyphs.

Full-page PNG mode can extend beyond the viewport, but does not stitch independently
scrolling panels. A 360×500 inspector capture intentionally shows its real scroll window,
not all fields flattened into one synthetic image. The current capture script also checks
that actual overflow scroll owners reach their bottom and then restores their scroll positions.

## What to compare

| Issue | Before | After | Result / boundary |
| --- | --- | --- | --- |
| F01 | [Auth desktop](f01-auth-login-desktop.png), [phone](f01-auth-login-phone.png) | [Dark desktop](after/f01-auth-login-dark-1440.png), [light desktop](after/f01-auth-login-light-1440.png), [phone](after/f01-auth-login-dark-360.png) | Neutral shared foundations, no navy/cyan glass treatment |
| F02 | [Renderer light](f02-renderers-light-desktop.png), [dark](f02-renderers-dark-desktop.png) | [Light](after/f02-renderers-light-desktop.png), [dark](after/f02-renderers-dark-desktop.png) | Renderer and common action now agree; disabled boolean cell is not an enabled-color test |
| F03 | [Workflow light](f03-workflow-light-desktop.png) | [Light](after/f03-workflow-light-desktop.png), [phone inspector](after/page-workflow-light-360-trigger.png) | Selected card/icon neutral; raw endpoint Copy action remains small |
| F04 | [Association light](f04-association-light-desktop.png) | [Light](after/f04-association-light-desktop.png), [dark](after/f04-association-dark-desktop.png) | Neutral selected radio card/dot; event-editor visual evidence still pending |
| F05 | [Shopify light](f05-shopify-light-desktop.png) | [Light](after/f05-shopify-light-desktop.png), [dark route body](after/page-shopify-dark-1440-default.png) | Neutral choices and actions; campaign covered by source/tests |
| F06 | [Dark picker](f06-emoji-dark-desktop.png) | [Dark picker](after/f06-emoji-dark-desktop.png) | Inner picker now follows dark mode; default third-party category accent remains blue |
| F07 | [700px controls](f07-controls-light-700.png) | [700px](after/f07-controls-light-700.png), [360px](after/f07-controls-light-360.png), [768px](after/f07-controls-light-768.png), [coarse 1024px](after/f07-controls-light-1024.png) | Shared targets 44px on phone/coarse, compact fine desktop; see manifest for pseudo-target/flow geometry |

Whole-page route-body examples:
[Workflow desktop](after/page-workflow-light-1440-default.png) ·
[Workflow 700px](after/page-workflow-light-700-default.png) ·
[Workflow 360px](after/page-workflow-light-360-default.png) ·
[Settings](after/page-workflow-light-1440-settings.png) ·
[Short inspector](after/page-workflow-light-360-inspector.png) ·
[Shopify 360px](after/page-shopify-light-360-default.png).

The page pass found remaining custom-control target-size conflicts, documented as P01–P03
in the [implementation report](../implementation.md). F08–F12 still have source evidence only.
No claim of whole-product uniformity or accessibility certification is made.

## Reproduce the current after evidence

Repository dependencies from the normal pnpm workflow must already be installed.
Run from the repository root; use separate terminals for the four local servers.
Use safe local configuration: Next dev reads repository `.env`, while the fixture servers
explicitly avoid exposing it to their clients. Never point this workflow at production.

```sh
NEXT_TELEMETRY_DISABLED=1 \
  apps/app-web/node_modules/.bin/next dev apps/app-web --hostname 127.0.0.1 --port 3203
```

```sh
AUTH_PORTAL_URL=http://127.0.0.1:3205 AUTHED_APP_URL=http://127.0.0.1:3203 \
OUTPOST_AUTH_EMAIL_ENABLED=true OUTPOST_AUTH_OIDC_ENABLED=false NEXT_TELEMETRY_DISABLED=1 \
  apps/auth-web/node_modules/.bin/next dev apps/auth-web --hostname 127.0.0.1 --port 3205
```

```sh
apps/app-web/node_modules/.bin/vite --config docs/design-system/preview/vite.config.mjs
```

```sh
apps/app-web/node_modules/.bin/vite --config docs/design-system/preview/page.vite.config.mjs
```

Next dev may generate auth-web AGENTS.md/CLAUDE.md startup artifacts; these are not deliverables.
Preview URLs: `http://127.0.0.1:3210/?surface=workflow&mode=dark` and
`http://127.0.0.1:3211/page.html?page=workflow&mode=light`. Isolated surfaces: renderers,
workflow, association, shopify, emoji, controls. Route-body surfaces: workflow, shopify
(use `section=analyse` for the captured Shopify section).

Install browser tooling **outside the repository**, then capture:

```sh
mkdir -p /tmp/brian-design-audit
npm install --prefix /tmp/brian-design-audit --no-save --package-lock=false playwright
(cd /tmp/brian-design-audit && npx playwright install chromium)
AUDIT_TOOLS_DIR=/tmp/brian-design-audit node docs/design-system/preview/capture-after.mjs
```

Minimal Linux/Nix containers can use the portable Chromium path instead:

```sh
npm install --prefix /tmp/brian-design-audit --no-save --package-lock=false playwright @sparticuz/chromium
AUDIT_TOOLS_DIR=/tmp/brian-design-audit AUDIT_SERVERLESS_CHROMIUM=1 \
  node docs/design-system/preview/capture-after.mjs
```

That path extracts bundled shared libraries into system temp. Install suitable fonts for
glyph-complete images. Browser/font changes can affect metrics. Keep manifests with captures.
URL overrides: `AUDIT_APP_URL`, `AUDIT_AUTH_URL`, `AUDIT_PREVIEW_URL`, `AUDIT_PAGE_URL`.
All must remain on localhost/127.0.0.1 for the request guard.

`capture-after.mjs` writes only `after/`; `capture.mjs` is a compatibility alias for that
single maintained recipe. Source hashes are recorded on both clean and modified checkouts.
The 16 before images and their manifest are immutable historical evidence, not regenerated
by this command. Re-creating before-state visuals requires a disposable checkout at the
original baseline plus the documentation fixture and baseline-specific assertions; do not
label captures of fixed components as before evidence.

## Offline artifact verification

```sh
node docs/design-system/preview/verify.mjs
```

Checks local documentation/source links and line ranges, PNG signatures/dimensions/hashes,
manifest provenance, recorded browser errors/overflow, renderer agreement, target-size
boundaries and the expanded pseudo-target geometry. It needs Node, no browser or service.
