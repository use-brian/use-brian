# @use-brian/agent-runtime

The provider-neutral agent runtime of Use Brian, separated out of
`@use-brian/core` in M4 of the OSS chat architecture replacement (plan
section 2, `docs/plans/oss-chat-m4-runtime-separation-plan.md` in the platform
tree). OSS, AGPL-3.0-only, private (not published to npm).

**Status: moved (M4 step 3).** The runtime file set
(`scripts/testing/runtime-file-set.txt`, 73 files) lives here with the same
relative layout it had under `packages/core/src/`:

| Directory | Contents |
|---|---|
| `engine/` | `query-loop`, `query-loop-ports`, `turn-output`, `tool-executor`, `stall-watchdog`, `turn-ledger`, `loop-detector`, `tool-pairing`, `output-provenance`, `hooks`, `turn-inbox`, `tool-discovery`, `document-flow-debug`, `grounding-gate`, `decline-copy` |
| `providers/` | every provider adapter, including `codex-app-server/*` and the lazy `sharp-loader` |
| `tools/` | `types` (the tool contract and `ToolContext`), `capability-gate`, `tool-failure`, `schema-tolerance`, `base/ask-question` |
| `security/` | `sanitize`, `sensitivity`, `derived-scope`, `compartments`, `context-scope`, `evidence`, `source-evidence`, `authority-source`, `access-context`, `access-ceiling`, `execution-context`, `department-read`, `workspace-delegation` |
| `compaction/` | `compact`, `cache-tool`, `index` |
| `billing/` | `cost-tracker` |
| `mcp/` | protocol types: `types`, `classifier`, `input-schema` |

`src/index.ts` stays empty: there is no aggregate barrel.

## Package contract

- **Entry points.** File-level subpaths only:
  `@use-brian/agent-runtime/<path>.js`, resolved by the `"./*.js"` export to
  `dist/<path>.js` with types `dist/<path>.d.ts`, plus `"./package.json"`.
  A small `"."` exposing only the engine contract may be added later; it never
  re-exports provider adapters.
- **Dependencies.** `@use-brian/shared` and the npm packages the moved code
  imports: `@anthropic-ai/sdk`, `undici`, `ajv`, `ajv-formats`, `zod`,
  `@openai/codex` and `@openai/codex-catalog` (resolved by
  `providers/codex-app-server/process.ts`), and `sharp`, which is loaded only
  through `await import()` in `providers/sharp-loader.ts`. Never
  `@use-brian/core`, `@use-brian/api`, a hosted package or a product domain.
- **Closure.** The type-inclusive closure of `packages/agent-runtime/src/**`
  stays inside the package plus the reasoned `closure.allow` entries in
  `scripts/testing/import-graph.config.json` (today the `@use-brian/shared`
  root and `model-registry`). Check it with
  `node scripts/testing/import-graph.mjs --closure @scripts/testing/runtime-file-set.txt`.
  Tests are held to the same rule: a test that needs a core module stays in
  core and imports the runtime through `@use-brian/agent-runtime/<path>.js`.
- **Inversion.** Behaviour that belongs to product domains reaches the runtime
  through injected ports (`QueryLoopOptions.ports`) and `ToolContextExtensions`
  declaration merging, never imports. A core owner augments the runtime module
  by its package specifier, for example
  `declare module '@use-brian/agent-runtime/tools/types.js'`. Augmenting a core
  forwarding path (`'../tools/types.js'` in core) compiles but merges nothing,
  so the field silently disappears from `ToolContext`.
- **Forwarding shims.** Every old `packages/core/src/<path>.ts` is a one-line
  `export * from '@use-brian/agent-runtime/<path>.js'`, never a copy, so a class,
  `WeakMap` or `AsyncLocalStorage` has one module instance across both
  packages. The shims, the `@use-brian/core` root barrel and core's
  `./dist/*` subpath stay until their importers move (M4 plan, step 7).
- **Consumers.** `@use-brian/core` and `@use-brian/api` depend on it. Every
  tsconfig that compiles core references it, and every Docker image that builds
  core copies its manifest, tsconfig, `src/` and `dist/`
  (platform `docs/architecture/platform/deployment.md`, "Dockerfiles").
- **Build and tests.** Composite TypeScript project (`tsc`), output in `dist/`,
  built before its consumers through Turborepo `^build`. `pnpm test` runs the
  colocated Vitest suites (integration suites `*.integration.test.ts` run with
  `vitest.integration.config.ts`). Four department-isolation `security`
  suites remain in core because the acceptance manifest
  (`packages/shared/src/department-isolation-coverage.ts`, suite `kernel`)
  names them there; they import this package by subpath.

Component map: `[COMP:engine/agent-runtime]`.
