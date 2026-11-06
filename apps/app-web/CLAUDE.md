# apps/app-web

The **single authenticated product** (`app.usebrian.ai`, and the OSS self-host):
the doc page editor + Brain + Studio + Workflow + Feed + Approvals + settings +
chat, workspace-scoped at `/w/[workspaceId]/...`. `apps/app-desktop` wraps it.
Project-wide rules in the platform root `CLAUDE.md` (read that first); the
per-surface specs live under `docs/architecture/features/` (start at
`docs/architecture/features/doc.md`, the shell).

## Contracts every surface in this app is held to

- **Offline and unstable-network contract** - `docs/product-roadmap/offline-and-unstable-network.md`. Preserve mounted work and local durability through transport/5xx failures; recover and sync automatically. Installed desktop must cold-start its previously verified local working environment offline. New persistent operations need a scoped local/recovery design. Verify applicable fault scenarios and the `offline-continuity` CI lane; never interpret a missing implementation as an exception to the target.
- **Responsive contract (M1-M11)** - `docs/architecture/features/doc.md` ->
  "Responsive contract". Phone = below `md`. Reach parity, touch reveal, 44px
  targets, 16px text entry, overlay clamps, `dvh`, drawer hygiene, the top bar
  at 360px, non-drag paths, no native controls, no desktop-geometry copy.
  Helpers: `src/lib/viewport.ts` (`isPhoneViewport`, `isCoarsePointer`,
  `useCoarsePointer`); drawer close: `src/lib/sidebar-close.ts`.
- **Instant-navigation contract (N1-N8)** -
  `docs/architecture/features/perceived-performance.md` -> "Instant-navigation
  contract". First paint never waits for the network. ONE cache primitive:
  `src/lib/surface-cache.ts` (`useCachedResource`, `markSurfaceCacheStale`,
  `invalidateSurfaceCache`), keys built in `src/lib/surface-prefetch.ts`
  (`surfaceDataKey`, `crmConfigCacheKey`, `warmTargetFor`) and imported by the
  surface that reads them - never rebuilt by hand. The event spine marks keys
  stale through `src/lib/surface-cache-invalidation.ts`, mounted once in
  `src/components/doc/workspace-chrome.tsx`. Empty cache paints a
  `SurfaceSkeleton` (`src/components/chrome/surface-skeleton.tsx`) or the
  route's `loading.tsx`, never a "Loading..." sentence.

These are graded by `pnpm check` where a machine can see them
(`invariants/touch-reveal`, `mobile-input-font`, `viewport-dvh`,
`popover-width-clamp`, `topbar-chip-gate`) and reviewed by hand where not
(`docs/workflow/ai-native-development.md` -> rule 7, and the `/ui-debug` phone
pass).

## Conventions that bite here

- Every user-visible string through `useT()` and the four dictionaries under
  `src/lib/i18n/dictionaries/` (`en`, `ja`, `zh`, `zh-cn`) in the same commit;
  the `Dictionary` type makes a missing locale a compile error.
- Project primitives over native controls: `Select`, `Checkbox`,
  `confirmDialog`, `promptDialog`, `useToast` from `src/components/ui/`.
- No em dash in copy.
- A surface that lives inside the persistent `/w/[workspaceId]` layout must
  subscribe to a signal, never rely on a mount-only fetch (root `CLAUDE.md`
  anti-patterns).
- Tests are Vitest, tagged `[COMP:app-web/<name>]`, with a row in
  `docs/workflow/component-map.md`.
