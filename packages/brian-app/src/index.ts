/**
 * Public library surface for `@use-brian/brian-app`.
 *
 * ONE validation implementation behind three consumers (T4), the same way
 * `@use-brian/brian-kb` serves both the KB sync worker and the public `kb`
 * CLI:
 *   - the API's import + sync path (`packages/api/src/home-apps/`)
 *   - the assistant authoring tools (`writeHomeApp` re-validates every write)
 *   - this package's own `brian-app lint` CLI, for CI in app repos
 */

export {
  MANIFEST_VERSION,
  parseManifest,
  scopesExceedGrant,
  storeScopeRank,
  isSafeBundlePath,
  isSafeNetOrigin,
  type AppDataScope,
  type AppStoreScope,
  type AppAgentScope,
  type AppManifest,
  type AppScopes,
  type ManifestIssue,
  type ParseManifestResult,
} from './lib/manifest.js'

export {
  MANIFEST_FILENAME,
  BUNDLE_MAX_FILES,
  BUNDLE_MAX_TOTAL_BYTES,
  BUNDLE_MAX_FILE_BYTES,
  BUNDLE_CONTENT_TYPES,
  contentTypeFor,
  validateBundle,
  lintBundle,
  type BundleFile,
  type BundleIssue,
  type LintFinding,
  type ValidateBundleResult,
} from './lib/bundle.js'
