# F01–F07 implementation and whole-page review

Original audit/capture baseline: `43a70a8e3608ffc53d76207af4aba85cfb37ea76` (`develop`).
The fixes are split into scoped conventional commits based on develop
`52eb85bdf9942ada2864ad27263f0b32ffa74777`. That upstream update did not touch the
captured frontend files. After images were captured before the fixes were committed;
their historical manifest preserves that state, and source hashes verify the same code.
Seven separate implementation agents owned disjoint source/test files, one per finding.
The coordinator reviewed their changes, added the optional theme-context bridge, ran
integration checks, and extended the evidence beyond isolated controls.

[Common system](README.md) · [Original audit](audit.md) ·
[Before gallery](screenshots/index.html) · [After gallery](screenshots/after/index.html) ·
[After measurements](screenshots/after/manifest.json)

## Implemented

| Issue | Change | Verification / remaining boundary |
| --- | --- | --- |
| F01 Auth portal | Imports canonical shared tokens; neutral action/focus/borders; removes navy/cyan gradient/glass styling. OS light/dark and explicit root modes; wrapping, 16px phone fields and 44px phone actions retained. | Real public login pages in light/dark desktop and dark 360px. Login/recovery/locale behavior covered by auth tests; no email sent. The small OS-dark token bridge has a shared-token parity regression test. |
| F02 Rendered views | Renderer Button and attachment Save use action/action-foreground. Boolean inputs use accent-action; enabled editor has an accessible name and associated phone/coarse-pointer label target. Attachment drag/focus feedback uses neutral foreground tokens. | Real renderer/shared-button comparison in both modes, plus full renderer unit suite. Native boolean implementation remains independent of app-web; this is not a migration of the entire renderer to Base UI. |
| F03 Workflow | Neutral selected trigger-card border, wash, ring and icon, matching generic interaction semantics. | Component comparisons in both modes, real route-body trigger inspector at 360px, selection/disabled tests. |
| F04 Association (retired) | Historical neutral choice-card and event-editor styling. | The previous screenshots remain in the audit archive. The retired views have no active implementation checks. |
| F05 Shopify | Analysis/campaign selected cards and hover use interaction, not primary. | Analysis light/dark comparisons, production Shopify route-body captures and campaign/analysis tests. No store query or assistant call. |
| F06 Emoji | Initializes with resolved mode and updates the existing vanilla Picker on changes; does not recreate it on every mode change. Provider-free hosts observe only the root mode class and clean up the observer. | Dark browser capture; theme, system/custom resolution, selection, dismissal and cleanup tests. Optional useOptionalTheme API avoids catching errors from a hook; useTheme still rejects missing providers. Third-party category accent remains its default blue, separate from the fixed forced-white surface. |
| F07 Phone targets | Every shared Button size and Select trigger has a 44×44 minimum below md/768px and independently for coarse pointers; Select items have 44px minimum height. Checkbox/Switch retain compact paint with expanded root pseudo-targets and reserved layout space. | Browser measurements at 360/639/640/700/767/768 and emulated coarse 1024px. Actual corner clicks outside the painted checkbox/switch toggle once, then reset. Unit tests cover labels, refs, forms, disabled and Space behavior. This fixes shared defaults, not every custom control (see below). |

Generic selected-card recipe: `border-interaction/60 bg-interaction/5`, optional
`ring-interaction/20`; selected icon `bg-interaction/10 text-foreground`.
Meaningful status/data colors, authored content and public-site branding were not flattened.

### Target geometry after F07

| Control | Phone below 768px / coarse pointer | Fine-pointer desktop |
| --- | --- | --- |
| Default text / icon Button | 44px minimum height / 44×44px | 32px / 32×32px |
| Default Select trigger | 44px minimum height and width | 32px high |
| Checkbox | 16px paint, 44×44 pseudo-target and reserved area | 16px paint |
| Switch | 36×20px paint, 44×44 pseudo-target and reserved area | 36×20px paint |

Checkbox/Switch add a noninteractive wrapper (`display: contents` on fine-pointer desktop).
The root still receives consumer classes, refs, ID and Base UI semantics. Existing consumers
reviewed did not reveal an active peer/direct-child selector dependency. The decorative table
menu switch uses `ml-auto`, but its preceding label is `flex-1`, so the right alignment remains
allocated. Explicit consumer overrides, clipping parents, new direct-child/peer selectors and
unusual root positioning still warrant composed-surface tests. A minimum is not a claim that
all consumer CSS can never override it.

## Whole-page review: what was actually checked

There are **32 after images**, separate from the preserved 16 original images:

- Five real public account/login captures.
- Sixteen isolated production-component captures (including breakpoint/coarse checks).
- Eleven **production route-body captures with synthetic read-only transport**: Workflow
  detail (Flow, Settings, trigger inspector and short step inspector) and Shopify Analyse.
  Desktop light/dark, 700px and 360px are included.

The route-body harness mounts the actual production page/surface and its headers, tabs,
content and dialog portals. It does **not** mount a real authenticated session, persistent
workspace sidebar, global workspace search or complete cross-route navigation. In particular,
the phone Shopify topbar's empty launcher space belongs to that omitted shell; it is **not**
reported as a product defect. The labeled framing is documentation-only, not a proposed UI.

The production picker-preferences store attempts an automatic background PATCH on startup;
the synthetic transport logs and rejects it before forwarding or network. JSON fixtureRequests
therefore records a **blocked attempt**, not a completed write. No user mutation action was invoked.

The review covered page hierarchy, alignment, card rhythm, selected/navigation states,
responsive wrapping, primary actions, scroll ownership and overlay bounds. The captured pages
have no document-level horizontal overflow or uncaught browser exceptions. The 360×500 step
inspector fits the viewport and has its own scroll body and persistent Done action. Full-page
PNG mode does not stitch the contents of independently scrolling panes; these remain actual
browser views, not composites. Data-heavy, long-localized and keyboard-raised states need a
populated-workspace follow-up.

### Confirmed remaining page-level conflicts

These are **not silently marked fixed** by the seven component changes:

| ID | Observation | Evidence / source | Follow-up |
| --- | --- | --- | --- |
| P01 | Workflow header raw Run now and pin action are 32px at 700px, while shared actions are now 44px. Their classes switch at sm rather than md. | [700px route body](screenshots/after/page-workflow-light-700-default.png); [workflow page](../../apps/app-web/src/app/w/[workspaceId]/workflow/[id]/page.tsx) (`sm:h-8`, `sm:size-8`) | Align these custom actions with the phone breakpoint or use shared Button; verify header wrap/long names before changing. |
| P02 | Workflow name/description edit triggers are only 28/24px high at 360px; trigger Copy endpoint is 30px, and step Move up/down/Remove actions are 36px. | [360px page](screenshots/after/page-workflow-light-360-default.png), [trigger inspector](screenshots/after/page-workflow-light-360-trigger.png), [short step inspector](screenshots/after/page-workflow-light-360-inspector.png); [manual-trigger-panel](../../apps/app-web/src/components/workflow/manual-trigger-panel.tsx), [step-editor](../../apps/app-web/src/components/workflow/step-editor.tsx) | Audit effective targets in each custom row. Do not expand invisible targets into adjacent actions without reserving space. |
| P03 | Shopify phone section tabs and Period SearchableSelect are 36px, next to the now-44px Run it Button. The period text is 14px. Shared Select and SearchableSelect are different components. | [360px Shopify](screenshots/after/page-shopify-light-360-default.png), [700px Shopify](screenshots/after/page-shopify-light-700-default.png); [shopify-surface](../../apps/app-web/src/components/shopify/shopify-surface.tsx), [shopify-shared](../../apps/app-web/src/components/shopify/shopify-shared.tsx), [searchable-select](../../apps/app-web/src/components/ui/searchable-select.tsx) | Extend target/font policy to SearchableSelect and raw section tabs. This is the broader F07/F11 follow-up, not a failure of shared Select's new sizing. |

Raw compact-control candidates in the JSON are a review aid, not an accessibility verdict:
small visible glyphs may have larger label/pseudo targets; hidden Base UI inputs and tooltip
triggers must not be counted as demonstrated touch-target failures without checking the DOM.

F08–F12 from the [original audit](audit.md) remain open: Studio/Privacy custom controls,
cross-client focus policy, phone font/overlay risks, promotional/native recovery exceptions.
Their broad redesign or replacement was not part of the seven-agent implementation.

## Regression checks

Coordinator checks:

- app-web focused integration run: **20 files / 122 tests passed** (all UI tests plus affected
  workflow, association, Shopify and theme tests).
- auth-web full suite: **15 files / 113 tests passed**.
- views-renderer full suite: **22 files / 397 tests passed**.
- TypeScript `--noEmit`: app-web, auth-web and views-renderer passed.
- `git diff --check` passed; artifact verifier covers both galleries.
- The event-workspace test logs a refused local auth-refresh request while using its media
  preview mock; assertions pass. No external service was contacted by that request.

Example commands (package-local binaries avoid needing pnpm on PATH):

```sh
cd apps/auth-web && node node_modules/vitest/vitest.mjs run
cd ../../packages/views-renderer && node node_modules/vitest/vitest.mjs run
# From the repository root:
node docs/design-system/preview/verify.mjs
```

This is not the complete app-web suite, a production Next build, a mobile Safari/device test,
all-locale coverage or an accessibility certification. ESLint in the agent checks was blocked
by the checkout's existing circular configuration; it is not reported as passing. No dependencies,
lockfiles, credentials, customer data or pre-existing agentbox files were changed.
