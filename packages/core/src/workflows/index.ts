// Canonical brain-write workflow tools (WU-6.11) + the `finalizeProduct`
// reference workflow definition.
//
// `tools.ts` — the first-party `createEntity` / `createEdge` /
// `supersedeMemory` tools the `finalizeProduct` workflow calls.
//
// `finalize-product.ts` — the reference workflow definition (per
// `docs/historical/decisions-log.md` 2026-05-14 SV(2)
// "`finalizeProduct` as workflow definition"). The WU-6.5 per-workspace
// boot seeder was removed (2026-05-23) — the workflow is no longer
// auto-inserted into workspaces. The exports below remain so an explicit
// import path can still construct the definition (tests, future user-
// authored variants); they have no runtime callers today.

export * from './tools.js'
export {
  finalizeProductWorkflow,
  finalizeProductPermissionGrants,
  FINALIZE_PRODUCT_WORKFLOW_NAME,
} from './finalize-product.js'
