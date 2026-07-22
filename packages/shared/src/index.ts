// NOTE: env.js is intentionally NOT re-exported here. This barrel ('.') is the
// CLIENT-SAFE / OPEN public surface — it must never pull in `env.ts`, which reads
// `process.env` (60+ secrets). Server code that needs `getEnv()`/`Env` imports the
// closed `@use-brian/shared-server` package (which re-exports this barrel + env).
// This split is load-bearing for the OSS extraction (the open package ships no
// secrets); `@use-brian/shared-server` stays in the platform, not the submodule.
// See packages/shared/CLAUDE.md → "Subpath exports".
export * from './transcript-format.js'
export * from './transcript-citations.js'
export * from './recording-anchor.js'
export * from './connector-registry.js'
export * from './builtin-connectors.js'
export * from './tool-display-names.js'
export * from './follow-ups.js'
export * from './control-tags.js'
export * from './delivery-sanitize.js'
export * from './app-types.js'
export * from './mini-apps.js'
export * from './emoji-reactions.js'
export * from './page-icon.js'
export * from './doc-theme/index.js'
export * from './ingest-append-contract.js'

/**
 * Sentinel assistant ID used for app-level (L1) tool policies.
 * L1 rows in mcp_tool_settings use this instead of a real assistant ID
 * so they never collide with assistant-level (L2) rows.
 */
export const APP_LEVEL_ASSISTANT_ID = '00000000-0000-0000-0000-000000000000'
