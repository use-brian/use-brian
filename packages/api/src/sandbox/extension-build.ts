/**
 * Re-export so `apps/browser-relay` can reach the expected extension build.
 *
 * The relay depends on `@use-brian/api` but not on `@use-brian/shared`, and
 * under pnpm a transitive dependency is not importable. Adding the direct
 * dependency would edit a manifest inside the OSS submodule, which obliges a
 * matching regeneration of the platform's own lockfile — the exact class of
 * change that has broken deploys here before. One re-export costs nothing and
 * keeps the definition single.
 */
export {
  CURRENT_EXTENSION_BUILD,
  isExtensionBuildStale,
  STALE_EXTENSION_REMEDY,
} from '@use-brian/shared'
