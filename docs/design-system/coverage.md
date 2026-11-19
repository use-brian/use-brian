# Audit coverage and source map

Audit/capture baseline: develop `43a70a8e3608ffc53d76207af4aba85cfb37ea76`, plus
F01–F07 fixes integrated onto develop `52eb85bdf`. [Implementation and whole-page review](implementation.md) records current status.

This is a source-backed common-system audit, **not a claim that every frontend state or
all 90 app-web `page.tsx` files were visually tested**. Route inventory is broader than
detailed implementation review. A route file is not necessarily a distinct page: redirects,
intercepting routes, shared layouts, dynamic IDs, and query-driven sections affect that count.

## Evidence levels

- **Foundations read:** theme ownership, common primitives, stylesheets, and relevant shell code.
- **Representative source review:** real implementation inspected in the feature family;
  this does not cover every dialog, permission, lifecycle state, or nested route.
- **Captured:** real public route, explicitly labeled isolated production component, or
  production route body with synthetic read-only transport. Route-body captures do not
  establish authenticated shell/session coverage.
- **Inventoried only:** located and classified, not certified consistent.

See [audit.md](audit.md) for findings and [screenshots/README.md](screenshots/README.md)
for the 16 original and 32 after captures and their exact scope. No authenticated workspace, external integration,
production account, or real customer data was needed or modified.

## Foundations and ownership

| Area | Sources / coverage |
| --- | --- |
| Product contracts | [app-web/AGENTS.md](../../apps/app-web/AGENTS.md), [app-desktop/AGENTS.md](../../apps/app-desktop/AGENTS.md) |
| Default semantic tokens / font / radius / markdown | [chat-ui/theme.css](../../packages/chat-ui/src/theme.css), read |
| Shared chat appearance | [chat-ui/appearance.css](../../packages/chat-ui/src/appearance.css), read |
| Effective app styling | [globals.css](../../apps/app-web/src/app/globals.css), all 3,329 lines covered across the audit |
| Runtime theme behavior | [theme.tsx](../../apps/app-web/src/lib/theme.tsx), [custom-themes.tsx](../../apps/app-web/src/lib/custom-themes.tsx), [root layout](../../apps/app-web/src/app/layout.tsx) |
| Brand-to-theme boundary | [theme-seed.ts](../../packages/shared/src/brand/theme-seed.ts), [build-tokens.ts](../../packages/shared/src/doc-theme/build-tokens.ts) |
| Common primitives | All 17 top-level implementation files in [components/ui](../../apps/app-web/src/components/ui), read |
| Shared layout | Document shell/title/topbar, workspace chrome/sidebar/drawer, chrome topbar and surface skeleton, relevant sections reviewed |
| Shared client contracts | Viewport, sidebar-close, surface-cache/prefetch/invalidation, app popup boundary and viewport helpers, relevant sections reviewed |
| Cross-surface renderers | views-renderer button/boolean/file/timeline sources; office generated text/layout styles; representative review |

The 17 UI files are `back-button`, `button`, `checkbox`, `confirm-dialog`, `dropdown-menu`,
`emoji-picker`, `kind-picker-dialog`, `popover`, `prompt-dialog`, `queued-inputs`,
`searchable-select`, `select`, `switch`, `tooltip`, `user-avatar`, `use-toast`, and
`modal-scrim` (`.tsx` except `modal-scrim.ts`). Re-exported chat-ui implementations were
followed where they own the actual behavior.

## Stylesheet coverage

Product stylesheet entry points and all app CSS modules were covered:

- [App globals](../../apps/app-web/src/app/globals.css).
- [Desktop SPA app.css](../../apps/app-web/desktop/app.css): imports the same globals;
  explicit Tailwind source discovery, not another theme.
- [Chat surface](../../apps/app-web/src/components/chat-app/chat-surface.module.css).
- [Chat sidebar panel](../../apps/app-web/src/components/doc/sidebar-panels/chat-sidebar-panel.module.css).
- [Workspace app rail](../../apps/app-web/src/components/doc/workspace-app-rail.module.css).
- [Workspace status](../../apps/app-web/src/components/chrome/workspace-status.module.css).
- [Plan/trial gate](../../apps/app-web/src/components/chrome/plan-gate.module.css).
- [Feed composition editor](../../apps/app-web/src/components/feed/composition-editor.module.css).
- [Auth globals](../../apps/auth-web/src/app/globals.css).
- [Extension sidepanel](../../apps/browser-extension/static/sidepanel.css).
- [Shared chat theme](../../packages/chat-ui/src/theme.css) and [appearance](../../packages/chat-ui/src/appearance.css).

The drawing-library/feed-composer CSS under `apps/app-web/scripts/fixtures/` is test-harness
styling, not an additional product design system. Office and views-renderer do not have a
standalone product stylesheet: their generated inline styles and component utilities must
be considered too. The documentation-only preview CSS added in this audit styles only its
labeled frame and explicitly scans production sources.

Inline-style entry points reviewed include desktop `offline.html`, `embedded-browser.html`,
`brian-pet.html`, Chromium popup/allow pages, and Firefox popup/allow pages. Embedded-browser
theme synchronization was checked in its preload source; fallback literals alone are not
a forced-light defect. Native pet/artwork is a separate presentation domain.

## Route and feature coverage

Workspace paths below are relative to `/w/{workspaceId}` unless otherwise noted.

| Surface family | Route / entry | Review / visual coverage |
| --- | --- | --- |
| Account entry | `/accounts` (public) | Source + real full-page light/dark desktop and light 360px captures |
| Auth portal | Separate auth app `/login` | Source + real full-page desktop/360px with focused email field; no email submitted |
| Document shell / editor | `/p`, `/p/{pageId}`, `/records/{recordId}` | Core geometry/type/colors/primitives reviewed; isolated dark icon-picker capture; no populated editor-page capture |
| Rendered views | Database/view hosts inside document/record surfaces | Representative renderer source + actual button/checkbox-cell comparison, light/dark |
| Chat | `/chat`, root destination via defaultHomePath | Shared chat tokens, CSS, composer/action/container behavior reviewed; no conversation-state captures |
| Brain | `/brain`, entity detail, entry reader, skills and blueprints | Entity/graph tokens, empty/guidance states, representative source; no graph interaction capture |
| Studio / assistants | `/studio/assistants` | Tabs and skill/connector switch source reviewed; full authenticated screenshots pending |
| Studio / knowledge | `/studio/knowledge` | Add-source/control focus source reviewed; no false-positive blue-focus claim from class names alone |
| Studio / other | Connectors, channels, brand, skills, mini-apps, ingest/task rules | Inventoried and representative related source; not exhaustive nested-state review |
| Programmatic access | `/studio/programmatic-access` and applications/capture/history | Route inventory only, not full feature review |
| Workflow | `/workflow`, `/{id}`, `/{id}/runs/{runId}` | Trigger/schedule source; manual TriggerEditor light/dark; after-fix production detail route body with synthetic transport: Flow, Settings, trigger/step inspectors at desktop/700/360 and a short viewport. No real session/sidebar or run-detail coverage |
| Association | `/association`, query-driven sections/event detail | Shared controls, overview, event/member/publication/editor representative source; actual ChoiceCards light/dark, synthetic labels |
| Shopify | `/shopify`, query-driven tabs | Analysis/campaign/choice source; AnalyseTab light/dark; after-fix production ShopifySurface including topbar/section strip at desktop/700/360 with synthetic reachability. No real sidebar/session, store query or assistant call |
| CRM | `/crm`, `/{kind}/{recordId}` | Representative board/activity/status source; not all operations/dialogs |
| Tasks | `/tasks` | Representative status/board source; no populated board screenshot |
| Recordings | `/recordings/{recordingId}`, document panel/list | Transcript/progress/chrome source, no playback/upload capture |
| Feed | `/feed` plus drafts/inbox/posts/voice/campaigns/ready/platform descendants | Representative onboarding/composer and all feature CSS; nested platform flows not exhaustive |
| Settings | Workspace Settings modal, not a `/settings` page | Common modal/control patterns and representative sections; Privacy conflict source only |
| Office | `/office`, artifacts/new/templates and intercepted modal routes | Document-renderer styling + global paper/mobile rules reviewed; toolbar/viewer states not exhaustively reviewed |
| Mini apps | `/apps/{appId}` | Host frame source; sandboxed customer app contents excluded from generic chrome conformity |
| Other workspace routes | Approvals, briefs, computer/profiles/sessions, goals, inbox, live, organization, projects | Inventoried; not comprehensive feature/component review |
| Public document sharing | `/share/{token}`, `/share/p/{pageId}`, shared child pages | Resolution/renderer/CTA representative source; valid published fixtures not captured |
| Public chat | `/c/{token}` | Representative source; valid public token fixture not captured |
| Public sites | `/site/{host}/[[...path]]` internal target, customer-host routing | Source inventory; authored/customer-site branding is a separate domain, no configured site captured |
| Utility / handoff | `/open`, `/s/...`, cloud-link, desktop/mobile auth, recorder-overlay, OAuth authorize, redeem, legacy routes | Inventoried; security/error/success states not visually certified |
| Native desktop | SPA wrapper and standalone recovery/browser/pet | Theme/CSS/source review; no Electron-native or offline cold-start evidence |
| Browser extensions | Chromium popup/allow/sidepanel, Firefox popup/allow | Tokens/focus/inline styles and shared chat boundary reviewed; no installed-extension captures |

Not every repository app is an independently designed frontend. API/relay/connector/native-host
packages are infrastructure; their presence does not imply another browser page family.

## What the evidence does not establish

- Full authenticated-page consistency, permission-specific states, or data-heavy layouts.
- Custom-palette browser rendering or comprehensive system-mode popup behavior. Emoji mode
  changes are unit-tested; provider-free live changes are also checked by the capture script.
- WCAG conformance, contrast certification, screen-reader behavior, or effective touch targets
  in every composed control. The control fixture measures defaults plus expanded pseudo-targets
  and actual corner hit-testing; production route-body inspection still finds custom exceptions.
- iOS keyboard/zoom behavior, real coarse-pointer interaction, 200% zoom, forced-colors, RTL,
  or all four locales. A 360px screenshot is viewport evidence, not an iPhone test.
- Installed desktop/extension rendering, native controls, Electron startup, offline durability,
  reconnect/error recovery, or real integration execution.
- Every document block, exported Office format, customer site, or sandboxed mini-app's design.

Several platform documents named by AGENTS are not present in this OSS checkout. The guide
records the available contracts and source behavior without inventing missing specifications.

## Next visual pass

Use a disposable, synthetic populated authenticated workspace to capture Studio/Privacy,
full-shell Workflow beyond the synthetic route-body evidence,
Association event editor, CRM/Tasks boards, Feed, Office, and sharing flows. Include empty,
loaded, filtered-empty, error/offline, pending, long-text, destructive, disabled, hover and
keyboard-focus states. Run light/dark/non-blue-custom themes, 360/700/768/desktop widths,
short windows, touch/non-drag paths, and the four supported locales. Update the evidence
level per finding rather than marking a source-only item visually verified.
