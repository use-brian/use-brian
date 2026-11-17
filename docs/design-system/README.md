# Frontend design system

Source-backed implementation guide, based on the audit at develop revision `43a70a8e3`
plus F01–F07 consistency fixes, integrated onto develop `52eb85bdf`. This documents the effective system, not a redesign
or a claim of uniform compliance. See [implementation and whole-page review](implementation.md)
and the [after gallery](screenshots/after/index.html) for changes and remaining gaps.
Scope: common authenticated app-web UI, its desktop wrapper, and shared chat presentation.
Surface-specific content and visualization retain the boundaries described below.

Use [audit.md](audit.md) for conflicts and gaps, [coverage.md](coverage.md) for scope,
and [screenshots/README.md](screenshots/README.md) for visual evidence and capture guidance.
This guide is based on source inspection, not runtime or accessibility certification.

## 1. Start here: ownership and cascade

1. Read [app-web/AGENTS.md](../../apps/app-web/AGENTS.md) for product contracts.
2. Start with an existing [UI primitive](../../apps/app-web/src/components/ui), not a new visual abstraction.
3. Use semantic Tailwind utilities backed by shared CSS variables.
4. Check app-level overrides before copying a package rule or a component's classes.
5. Keep surface geometry, loading geometry, and responsive behavior aligned.

The stylesheet entry point is [globals.css](../../apps/app-web/src/app/globals.css).
Its import order is Tailwind, animation utilities, shadcn styles,
[chat-ui/theme.css](../../packages/chat-ui/src/theme.css), then
[chat-ui/appearance.css](../../packages/chat-ui/src/appearance.css).
App rules follow those imports. Explicit `@source` directives include chat-ui and views-renderer utilities.

- **Shared theme:** `theme.css` owns baseline semantic colors, font aliases, radius,
  reading measure, and shared markdown rules. `@theme inline` maps variables to utilities.
- **Shared chat treatment:** `appearance.css` owns composer, message, and action shapes.
- **App policy:** `globals.css` owns neutral interaction overrides, focus behavior,
  document typography, content colors, visualization tokens, and shell treatments.
- **Runtime selection:** [theme.tsx](../../apps/app-web/src/lib/theme.tsx) resolves mode,
  sets `.dark` and `data-palette` on `<html>`, and injects generated theme colors.
- **Root integration:** [app/layout.tsx](../../apps/app-web/src/app/layout.tsx) imports globals,
  integrates theme pre-paint handling, loads the code font, and mounts dialog providers.

Cascade layers, selector specificity, and `!important` matter, not just file order.
For example, primitive focus-ring utilities do not describe final app focus paint.
The app's `:root:root` selectors deliberately outrank generated custom-theme selectors.
Comments mentioning legacy brand palettes or custom glows are not a list of current options:
current types and effective CSS take precedence.

## 2. Theme and semantic colors

Default mode is **light**, not OS-following. Mode choices are `light`, `dark`, `system`;
`system` subscribes to OS changes. Palette is a separate axis: `notion` or `custom`.
The built-in presets are Default and Default Dark. There are no other built-in palettes.

Mode/palette selection is cached locally. The pre-paint script applies the saved state
before React mounts. Custom themes are workspace-shared generated light/dark token maps;
`theme.tsx` filters keys and color values before injecting `style#doc-custom-theme`.
A user-initiated custom apply may select its preferred mode; passive reapplication preserves mode.

### Effective Notion token reference

Hex values describe the default palette in app-web, not every generated palette.
Use semantic utility pairs, rather than copying these literals into components.

| Token / utility role | Light | Dark |
| --- | --- | --- |
| `background` | `#FFFFFF` | `#191919` |
| `foreground` | `#37352F` | `#D4D4D4` |
| `card` | `#FFFFFF` | `#1F1F1F` |
| `card-foreground` | `#37352F` | `#D4D4D4` |
| `popover` | `#FFFFFF` | `#252525` |
| `popover-foreground` | `#37352F` | `#D4D4D4` |
| `primary`, `accent-2` | `#2383E2` | `#529CCA` |
| `primary-foreground` | `#FFFFFF` | `#0A1A24` |
| `action` = foreground | `#37352F` | `#D4D4D4` |
| `action-foreground` = background | `#FFFFFF` | `#191919` |
| `secondary` | `#F1F1EF` | `#2F2F2F` |
| `secondary-foreground` | `#37352F` | `#D4D4D4` |
| `muted` | `#F7F6F3` | `#2F2F2F` |
| `muted-foreground` | `#787774` | `#979797` |
| `accent` | `#EFEFEE` | `#2F2F2F` |
| `accent-foreground` | `#37352F` | `#D4D4D4` |
| `border`, `input` | `#EDEDEC` | `#2F2F2F` |
| `destructive` | `#EB5757` | `#EB5757` |
| `sidebar` | `#F7F7F5` | `#202020` |
| `sidebar-foreground` | `#37352F` | `#D4D4D4` |
| `sidebar-accent` | `#EAEAE8` | `#2F2F2F` |
| `sidebar-accent-foreground` | `#37352F` | `#FFFFFF` |
| `sidebar-border` | `#E9E9E7` | `#2F2F2F` |
| `sidebar-primary` | `#2383E2` | `#529CCA` |
| `sidebar-primary-foreground` | `#FFFFFF` | `#FFFFFF` |
| `interaction` (app) | `#373737` | `#D4D4D4` |
| `ring`, `sidebar-ring`, `interaction-border` (app) | `#737373` | `#A3A3A3` |

**Actions are neutral, not blue.** Filled buttons, checked checkboxes, and enabled switches
use `bg-action text-action-foreground`. `primary` is the accent/link channel, not a
synonym for the main CTA fill. Pair a background token with its matching foreground.
Ordinary document links intentionally inherit prose ink with a muted underline; chat links
and timecode pills can use primary. Package ring defaults are blue, but the app overrides
both ring tokens to neutral.

Default selected navigation uses `--nav-active-*`: a stronger-than-hover sidebar mix,
not a hard-coded blue pill. Custom themes retain the neutral interaction/ring policy,
neutral active navigation, and no active glow; their sidebar can keep a primary-tinted wash.
Actions follow the generated foreground/background pair. Validate custom contrast rather
than assuming generated colors or palette names guarantee it.

## 3. Typography, rhythm, shape, and icons

The body uses the native OS UI stack under the legacy name `--font-rocknroll`:
Apple system fonts, Segoe UI, system-ui, then CJK fallbacks. It is not RocknRoll One.
`--font-display` aliases the same stack. Body weight is **450**, with font smoothing.
`--font-code` starts with JetBrains Mono and includes system/CJK fallbacks before monospace.
Do not introduce a separate display face for ordinary UI headings.

| Context | Existing scale |
| --- | --- |
| Document page title | `text-3xl md:text-4xl`: 30px / 36px by viewport, weight 700, `leading-tight` |
| Editable and public doc body | 16px, line-height 1.5 |
| Doc H1 / H2 / H3 / H4 | 28 / 24 / 20 / 18px, weight 600, line-height 1.3 |
| Doc heading tracking | Normal, same display alias as the title |
| Common controls / menu items | `text-sm`; smaller variants are explicit exceptions |
| Chat body | Shared appearance uses 16px, with 15px at reading-container widths of at least 560px |

The title's 30/36 values are responsive font sizes, not a single size/line-height pair.
Doc heading margins differ by level; paragraphs use 3px vertical block padding.
Use the document selectors, not global heading resets, to maintain editor/public parity.
Chat markdown has its own scale and later app overrides; do not treat the package's
markdown block as the complete app rendering specification. App code/pre/table text uses
`max(0.875em, 0.8125rem)` and fenced inner code inherits instead of shrinking twice.
Code blocks reserve space for touch controls on phones or coarse pointers; tables scroll.
Short/keyboard-constrained chat windows suppress the greeting to preserve composing space.
Shared chat actions shrink from 44px to 36px when the named reading container is at least
560px wide, so viewport breakpoint checks alone do not describe their target sizes.

Spacing uses existing Tailwind utilities rather than a separate exported spacing API:
4/8/12/16/24px are common units, with compact 6/10px control gaps/padding where implemented.
Match the surrounding component before introducing a new arbitrary value.
Document gutters are 16px, 40px at `md`, 64px at `lg`.

- Base `--radius`: **0.75rem**. Derived `sm` 0.45rem, `md` 0.6rem,
  `lg` 0.75rem, `xl` 1.05rem. Literal rounded utilities are not all derived tokens.
- Buttons use rounded-lg; menus/popovers use rounded-lg plus a subtle edge and shadow-md.
- Confirm/prompt dialogs use rounded-2xl, a border, shadow-xl, and a foreground-tinted scrim.
- Shared chat composers use 20px corners, 24px at viewport `md`, then reading-container
  overrides; user bubbles have asymmetric 16/16/6/16px corners.
- Keep resting surfaces quiet. Elevation distinguishes overlays, not every content row.

Lucide is used by the common primitives. Default button/menu icons are generally 16px,
with explicit smaller variants. Use existing stroke icons and muted/foreground semantics.
Give icon-only triggers localized accessible names; tooltips supplement those names.
Do not confuse a small visible glyph or checkbox box with its required touch hit area.

## 4. Component selection matrix

Sources below are under [components/ui](../../apps/app-web/src/components/ui).
Reuse their Base UI behavior and app boundary adapters instead of rebuilding keyboard logic.

| Need | Existing API / source | Usage and caveat |
| --- | --- | --- |
| Action | [Button](../../apps/app-web/src/components/ui/button.tsx) | Base UI button; default, outline, secondary, ghost, destructive, link variants |
| Fixed choices | [Select](../../apps/app-web/src/components/ui/select.tsx) | Base UI select with value, trigger, content, items; label it and check popup constraints |
| Searchable choices | [SearchableSelect](../../apps/app-web/src/components/ui/searchable-select.tsx) | Existing combobox wrapper; prefer it to a second search/dropdown implementation |
| Boolean / bulk selection | [Checkbox](../../apps/app-web/src/components/ui/checkbox.tsx) | Base UI; checked, unchecked, indeterminate, disabled; neutral filled state |
| On/off setting | [Switch](../../apps/app-web/src/components/ui/switch.tsx) | Base UI; checked/unchecked and disabled; pair with a readable label |
| Overflow actions | [DropdownMenu](../../apps/app-web/src/components/ui/dropdown-menu.tsx) | Base UI menu; supports destructive items and separators, not native menus |
| Anchored content | [Popover](../../apps/app-web/src/components/ui/popover.tsx) | Shared chat-ui Base UI primitive plus app popup collision boundary |
| Destructive confirmation | [confirmDialog](../../apps/app-web/src/components/ui/confirm-dialog.tsx) | Queued Promise<boolean>; pass localized title, description, confirm/cancel labels |
| Short text request | [promptDialog](../../apps/app-web/src/components/ui/prompt-dialog.tsx) | Queued Promise<string or null>; multiline and allowEmpty are explicit options |
| Local feedback | [useToast](../../apps/app-web/src/components/ui/use-toast.tsx) | Returns `toast` setter and `feedback`; render feedback near the owning action |
| Supplementary hint | [Tooltip](../../apps/app-web/src/components/ui/tooltip.tsx) | Base UI hover/focus hint, optional shortcut, compact or rail appearance |

`useToast` is an inline `<p role="status">`, not a global floating stack or persistent log.
It has local state, no built-in expiry, and no automatic mounting. Never include credentials.
Confirm/prompt providers are mounted at the root; do not add competing provider stacks.
Their fallback labels are English, so callers must supply translated labels.
Use these helpers instead of `window.confirm`, `window.prompt`, or native choice controls.

### Dimensions and touch-target policy

Fine-pointer desktop Button defaults remain 32px high; sm is 28px, lg 36px, xs 24px.
All Button sizes, including icons, now have a 44×44px minimum below `md`/768px and
independently on coarse pointers. Select triggers follow that minimum, choice rows have
a 44px height floor, and Select trigger/choice text is 16px below md.
Checkbox paint stays 16px; switch paint stays 36×20px. Their roots use expanded transparent
pseudo-targets while noninteractive wrappers reserve 44×44px in phone/coarse layouts;
wrappers use display:contents on fine-pointer desktop. Do not infer hit area from paint alone.
Consumer classes still apply to the actual roots; review positioning, clipping and selectors
when composing them. Raw controls and SearchableSelect do not automatically inherit this
policy: see the remaining [page-level findings](implementation.md).

### Focus and field composition

Effective app focus is achromatic: discrete actions get a neutral ink overlay;
text-entry fields change their existing border to `ring`, without a second halo.
Invalid text fields retain the destructive border. Resize separators have axis-specific paint.
Forced-colors rules restore system Highlight outlines.

For a bordered composite field (textarea plus attach/send controls), put
`focus-within:border-ring` on the enclosing box and suppress nested focus shadows,
as the app CSS convention describes. Do not add a second floating focus frame.
Check keyboard visibility in the effective cascade, not just primitive class names.

## 5. Layout recipes

**Persistent workspace surface**

- [workspace-chrome.tsx](../../apps/app-web/src/components/doc/workspace-chrome.tsx)
  owns the sidebar/drawer, app frame, shared status, transitions, and cache invalidation subscription.
- Put route content inside that frame. Do not duplicate the workspace sidebar or mobile launcher.
- Use `min-h-0 min-w-0` on shrinking flex panes; assign the intended scroll owner.
- Subscribe to update signals in persistent layouts rather than relying on a mount-only fetch.
- Reuse [workspace-topbar.tsx](../../apps/app-web/src/components/chrome/workspace-topbar.tsx)
  and neighboring chrome patterns instead of inventing another header geometry.

**Reading/editing document**

- Follow [doc-shell.tsx](../../apps/app-web/src/components/doc/doc-shell.tsx):
  one page scroll area, `px-4 md:px-10 lg:px-16`, and the shared title/editor stack.
- `.doc-page-content` centers a 45rem (720px) maximum reading column.
  Full-width mode swaps to `w-full` but retains outer gutters.
- Use [page-title.tsx](../../apps/app-web/src/components/doc/page-title.tsx) and shared
  `.doc-collab-editor .ProseMirror` / `.doc-public-body` typography.
  Do not impose reading-column limits on a graph, board, or master-detail pane.
- Phone document tables own horizontal scrolling. Touch append rails grow to 44px,
  but axis grips remain 44×22 / 22×44px; review effective targets rather than assuming compliance.

**Menu, popup, or dialog**

- Use the primitive's portal/positioner and app collision boundary.
  [app-viewport.ts](../../apps/app-web/src/lib/app-viewport.ts) accounts for native browser docking.
- Clamp width to available app/viewport width with gutters; bound height and provide internal scrolling.
  Collision handling alone is not proof that long content fits.
- For blocking work use a titled dialog with clear cancel/commit actions and readable scrim.
  Verify focus entry/return, Escape/cancel behavior, and phone keyboard reachability.

## 6. Responsive and accessible interaction contract

[AGENTS.md](../../apps/app-web/AGENTS.md) defines phone as **below `md` (768px)**.
Use [viewport.ts](../../apps/app-web/src/lib/viewport.ts) helpers for phone/coarse-pointer logic;
touch-reveal applies to coarse/no-hover pointers even on a wide screen.

- Preserve feature reach on phone; do not merely hide desktop controls.
- Provide at least 44px touch targets and 16px text-entry fonts.
- Reveal hover-only actions for touch and keyboard. Offer tap/menu paths for drag operations.
- Use `dvh` for viewport-height overlays; account for safe areas and the on-screen keyboard.
- Clamp overlays, long labels, and menus. Verify the top bar at 360px without collisions.
- Close drawers after navigation/action using [sidebar-close.ts](../../apps/app-web/src/lib/sidebar-close.ts).
- Avoid native select/checkbox/menu/confirm replacements; preserve project semantics and localization.
- Preserve accessible labels, selected/expanded/checked state, disabled behavior, and keyboard operation.
- Respect reduced motion; reuse the existing skeleton/transition rules rather than adding perpetual animation.

Existing sizing or unbounded surface code is not an exemption. Track conflicts in
[audit.md](audit.md); test keyboard and touch paths rather than inferring compliance from screenshots.

## 7. States, offline continuity, and perceived performance

Treat initial, cached, refreshing, empty, filtered-empty, error, offline, pending,
disabled, invalid, selected, and successful states as part of the component design.
Keep feedback close to its action and distinguish an empty result from a failed read.
Do not use color as the only explanation of a destructive or invalid state.

The offline contract requires preserving mounted work and local durability through transport/5xx
failures, automatic recovery/sync, and installed-desktop offline cold start of a previously verified
local environment. New persistent operations need a scoped local/recovery design.
Do not replace usable cached content with a blank error screen on transient refresh failure.
Use [workspace-status.tsx](../../apps/app-web/src/components/chrome/workspace-status.tsx)
and existing error/recovery patterns rather than a parallel global connectivity banner.
These are required outcomes, not assertions that every route already implements them.

For instant navigation, first paint must not await the network:

- Use [surface-cache.ts](../../apps/app-web/src/lib/surface-cache.ts): `useCachedResource`,
  `markSurfaceCacheStale`, `invalidateSurfaceCache`.
- Import keys/warmers from [surface-prefetch.ts](../../apps/app-web/src/lib/surface-prefetch.ts);
  never rebuild cache keys by hand. The chrome-mounted invalidation spine marks affected keys stale.
- With an empty cache, render the appropriate route `loading.tsx` or
  [SurfaceSkeleton](../../apps/app-web/src/components/chrome/surface-skeleton.tsx), not a “Loading...” sentence.
- Skeletons mirror actual page/list/grid/rail geometry, are decorative and aria-hidden,
  and use the existing Skeleton animation/reduced-motion behavior. Home/chat intentionally have no content skeleton.
- Preserve stable geometry during refresh and pending actions; do not imply a durable save before it is durable.

## 8. Copy, localization, and exception boundaries

All user-visible strings go through `useT()` from
[i18n/client.tsx](../../apps/app-web/src/lib/i18n/client.tsx). Update all four
[dictionaries](../../apps/app-web/src/lib/i18n/dictionaries) together: `en`, `ja`, `zh`, `zh-cn`.
This includes accessible names, tooltips, placeholders, validation, dialog labels, and feedback.
Use concise action-oriented language, no em dash in product copy, and test long localized labels.

Separate these color/typography domains:

- **Theme chrome:** semantic background/foreground/action/interaction/sidebar tokens.
  Generated palettes may recolor surfaces, but neutral interaction policy remains app-owned.
- **Authored content:** `--doc-color-*` / `--doc-bg-*` map persisted named block color IDs
  to light/dark values. Inline code and editor/public typography have dedicated rules.
- **Visualization:** `--entity-*` and `--graph-*` encode data meaning, not CTA branding.
  Entity hues intentionally do not follow custom palettes. Graph background follows page background;
  canvas support/entity/highlight colors need six-digit hex for canvas color math.
  Keep CSS values aligned with [brain-colors.ts](../../apps/app-web/src/lib/brain-colors.ts).
- **Specialized renderers:** Office documents, chat bubbles/composers, canvas views, and rail tooltips
  have source-owned geometry or presentation exceptions. Office paper intentionally retains light
  local tokens and canonical desktop print geometry, but reflows below 768px; exported content
  retains its own document styling. Comment anchors intentionally remain warm yellow, while
  find results and block selections use neutral fills. Do not flatten these into generic cards.
- **Native shell:** desktop SPA imports the web theme; standalone offline recovery and the pet
  have independent styling. Embedded-browser preload synchronizes theme tokens. Preserve native
  titlebar clearance and never transform an ancestor of a draggable chrome region.
- **Promotional surfaces:** trial gate/native recovery retain branded treatments;
  these are documented exception decisions, not templates for ordinary controls. Auth portal
  now shares the neutral default tokens and OS light/dark treatment. See the implementation report.

## 9. Review checklist and supporting references

- [ ] Reused a primitive and semantic token pair; no accidental blue action fill or new font family.
- [ ] Checked light/dark, system resolution, and custom palette interaction/contrast where applicable.
- [ ] Reviewed hover, focus-visible, selected/expanded, disabled, invalid, pending, and empty/error states.
- [ ] Verified labels and keyboard paths, touch reveal, non-drag alternatives, and focus return.
- [ ] Checked 360px, below/above 640px and 768px, long translations, popup clamps, and keyboard overlap.
- [ ] Preserved scroll ownership, document measure, header clearance, and stable loading geometry.
- [ ] Designed local durability/recovery and applicable offline fault checks for persistent operations.
- [ ] Used shared cache keys and invalidation, not a network-blocked first paint or mount-only refresh.
- [ ] Updated all locales; supplied translated confirm/prompt labels; kept secrets out of feedback.
- [ ] Recorded exceptions/evidence in the companion audit, coverage, and screenshot documents.

AGENTS also names platform documentation not present at those paths in this checkout:
root `CLAUDE.md`, `docs/architecture/features/doc.md` (responsive contract),
`docs/architecture/features/perceived-performance.md`,
`docs/product-roadmap/offline-and-unstable-network.md`, and
`docs/workflow/ai-native-development.md`. These are reference names, not working links here;
do not invent their missing contents. Follow the available AGENTS contract and source.
It calls for applicable `pnpm check` invariants, the `offline-continuity` lane, Vitest component tags,
a component-map row, and a manual `/ui-debug` phone pass. The [implementation report](implementation.md) lists the checks actually run; it does not
claim the missing platform checks, full app suite or native/device certification passed.
