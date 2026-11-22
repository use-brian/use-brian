# Provider-neutral tool registration and Codex response completion

## Registration is presentation, not permission

`LLMProvider.toolSchemaMode(model)` advertises one of:

- `eager` (also the default when omitted): unchanged complete eager-compatible schemas.
- `dynamic`: declarations can grow between sends in an existing session.
- `native-deferred`: the provider registers a complete catalog once and its runtime discovers schemas internally.

The engine's `deferToolSchemas` option is an opt-in to this capability, not a vendor-name check. Unsupported drivers remain eager; they do not acquire the reserved `discoverTools` name or a new auxiliary executor. Routing, exact-model binding, document adaptation, admission capture, retry/fallback wrappers, credential-pool wrappers and the API's stable Codex manager proxy preserve the selected model's capability.

Stable proxies are part of the contract: testing only a concrete adapter misses a proxy that silently drops the optional capability and turns the real route eager. The Codex manager queries its **current** runtime adapter, so the same captured proxy function survives process replacement and safely reports eager while unavailable. Credential pools consult their existing template; capability lookup must not resolve a lease, construct a new provider, read an account or start a process. These metadata lookups do not establish entitlement or input authority.

Capable requests/sessions receive a separate `toolRegistration` plan:

- `catalog`: the complete capability-filtered, model-visible catalog, including tools specifically marked discoverable-only. It excludes the synthetic host discovery helper.
- `active`: the initial/current declarations, with bounded initial selection. The host preserves the array's identity as discovery loads schemas. Dynamic drivers also see the `discoverTools` helper here.
- Ordinary `tools` always retains the original complete eager-compatible list. Drivers that ignore the new plan, including an eager fallback after a capable primary fails, cannot accidentally receive only the initial subset. Existing hidden/discoverable-only eager exclusions remain unchanged.

`registeredToolDefinitions(options, mode)` selects the appropriate presentation. A new driver must both advertise its capability and implement its registration semantics; changing a provider name or mutating an array does not update an already-started stateful thread.

The original filtered executor registry remains authoritative. Schema discovery cannot add an executor or grant a capability. Canonical tool names, argument validation, confirmation/approval, current input authority checks, tool-result authority checks, cancellation and ledger execution paths are unchanged. Catalogs and selection results are invocation-local, not cached permissions.

## Discovery scope is part of registration

`mcp_search` is the unified **metadata search**, not a universal executor. In a model turn it combines two sources:

- The loop's final admitted Brian registry: memory, files, Office, browser, planning, etc.
- The already-scoped connected-source index, including folded local/remote connector tools and introspection reads.

The source-index count (for example, five introspection tools) is not the total tool count. Exact-name and keyword searches rank across both sources. Results report the searchable native/indexed counts, match count, and pagination state. Each result has an exact invocation route: native operations can use the engine-bound `mcp_call` route with `server:"brian"` when advertised, or their direct schema; indexed operations retain their source-specific `mcp_call` or direct-adapter route. Indexed adapters are not duplicated as native operations, including after policy denial.

For an inventory, call `mcp_search({query:"", limit:8, offset:0})`, then repeat with `nextOffset` until it is `null`. Inventory pages are compact and do not eagerly load every schema. Search an exact name for its parameters. Discovery/proxy helpers are excluded from operation counts. Results are current-turn views, not permission snapshots; visibility changes can change later pages. Keyword results and individual pages must never be presented as a complete inventory.

The core search tool advertises the host-only `acceptsToolCatalog` capability. **After all route, worker, and capability narrowing**, the query loop binds `admittedToolCatalog` to that tool's invocation context while preserving the original guarded `execute`. The supplied `requestTools` is the loop's final registry, not a broader parent or earlier route registry. No executor or permission is added. Outside a model turn, the tool reports source-index-only scope rather than claiming a full Brian inventory.

For dynamic drivers, a capability lookup loads matching native schemas (and indexed direct-only adapter schemas) into the existing active array, so a second `discoverTools` call is unnecessary. Native-deferred drivers keep immutable registration: the advertised host proxy needs no provider-native schema loading, while a direct native call still loads the exact schema through native search when needed. Eager drivers already have their schemas. Turns without unified MCP search retain their original native/`discoverTools` discovery path.

`toolDiscoveryInstructions` renders this contract at the **actual driver boundary**, using the engine's `discoveryTool` registration marker. Eager fallback drivers are not told to invoke an unavailable dynamic helper, and native-deferred drivers are not told to invoke synthetic `discoverTools`. Already supplied schemas should be used without another lookup. Discovery never overrides explicit availability or policy refusals.

MCP search indexes source identities/display labels as well as capability text. Hidden local tools stay out of model search and source summaries. Direct-only search uses the exact installed, admitted adapter identity, including surviving qualified aliases; it does not infer permission from a same-named unrelated tool or a hidden proxy. Direct adapters from independently scoped indexes retain their owning index's visibility/denial check and are deduplicated by source identity. Original source dispatchers, blocked-call state, capability checks, and approval gates remain authoritative.

### Canonical native proxy execution

The host-owned `resolveToolCall` on `mcp_call` resolves `server:"brian"` (case-insensitive) against the final admitted registry. This is not another source in the connector index. A real indexed source named Brian takes precedence; native metadata then advertises direct invocation instead. Indexed adapters and discovery/proxy helpers cannot be smuggled through the native route. Missing, hidden, or non-admitted targets fail closed. Standalone `mcp_call.execute` does not execute native targets.

The central tool executor validates the proxy envelope, resolves once, and schedules the canonical tool. It does **not** invoke `target.execute` from inside a proxy or nested executor. The target's schema, capability and workflow gates, confirmation/approval, shared denial/loop state, concurrency slot, sensitivity/evidence checks, live authority and wrapped dispatcher, timeout and result accounting all run normally. Approval records use the canonical name and input.

Provider call IDs and result names remain on the original proxy envelope: a parked Codex `mcp_call` must receive an `mcp_call` result, not a result named after the target. Host control-flow and `tool_input`/`tool_result` events separately observe canonical identities, including brain-write notifications, document rendering, worker suppression, `askQuestion` termination/suspension, citations, and terminal evidence. The provider accumulator and persisted wire call/result pair remain unchanged. Offline pinned-runtime regressions exercise successful, invalid-input, and denied native proxy calls without a second schema-search round trip.

## Gemini

Gemini uses `dynamic` mode. Its common request builder reads `active` on **every** send, for both stateless and stateful operation. The existing bounded host discovery helper adds admitted schemas to that same array. Stateful function-call thought signatures/history are preserved.

An optional initial classifier runs only for dynamic drivers. Trusted preparation preselection can seed either capable mode, subject to the existing initial-schema budget and direct-tool rules. Native search and eager drivers do not incur a separate engine-side selection model call.

## Codex app-server

For verified models, Codex uses `native-deferred` mode:

1. Snapshot the complete admitted catalog at session construction.
2. Register functions once at `thread/start`, under namespace `brian`, with `deferLoading` for functions outside the initial active set.
3. Let the pinned runtime's client-side `tool_search` expose matching schemas. This is metadata search, not Brian tool execution or an external search provider.
4. Accept dynamic callbacks only for that exact namespace and the original allowlist. Emit the original unqualified Brian tool name to the normal executor and return its result through the original parked-call protocol.

The normal hardened process arguments and RPC method boundaries are unchanged. No shell, browser, native MCP server, filesystem or other built-in capability is enabled to make schema search work. Offline tests assert the complete model-visible surface, not merely the presence of one desired tool.

Support is model-specific even within one pinned binary. GPT-5.5 uses top-level Responses tools while newer tested models use `additional_tools` input items; both support deferred search. GPT-5.2 accepts deferred registration but exposes **no** `tool_search`, so deferring its schemas would strand them. It therefore remains eager. An explicit verified model allowlist in `codexToolSchemaMode` also keeps unknown/future model IDs eager. Adding a model or upgrading the runtime requires rerunning the offline wire contract before expanding that allowlist. This capability table does not change account-scoped model entitlement checks.

Native search can make several physical model requests inside one Brian send. Usage is accumulated from fresh increments of the runtime's cumulative **thread** totals, including internal search and detached activity. Duplicate notifications do not double count, and totals are not reset between turns on the same thread. Decreasing totals fail as a redacted protocol error rather than silently misaccounting.

## Completed response text

The previous adapter assembled public text only from `item/agentMessage/delta`; an item/turn completion containing missing text could consequently become `[]` or a truncated answer.

The adapter now reconciles agent-message deltas, `item/completed` snapshots and completed `turn.items` snapshots by item ID:

- Recover the full text when deltas are absent, or only a missing prefix-compatible suffix after partial deltas.
- Deduplicate completed snapshots and ignore redundant late deltas for a completed item.
- Observe item creation order; validate authoritative turn-item ordering before repairing unseen earlier messages. Validate a complete turn atomically before emitting its suffixes.
- Fail closed on non-prefix/conflicting snapshots, duplicate identities, unsafe ordering or bounds violations. Failure is applied in the same notification reaction, before a coalesced successful terminal frame can close the stream and mask the error.
- Recover only `agentMessage` text, never reasoning/tool snapshots. Preserve commentary, partial-answer, final-answer and legacy absent/null phase compatibility.
- Do not recover snapshots from failed/interrupted turns. Preserve the existing start barrier, parked/detached tool lifecycle, cancellation and usage handling.
- Release reconciliation state at completion, interruption, runtime/session closure and before a fresh native turn. Limits are 8 Mi JavaScript code units per item, 32 Mi aggregate and 1,024 tracked items; transport frame and output queue limits remain independent.

First observation alone cannot reveal the chronology of wholly unseen items. Item-start events and authoritative ordered completion snapshots supply additional evidence; contradictory observed order fails instead of silently rearranging already-streamed text. Ordinary interleaved deltas retain their original delivery order.

Genuinely empty responses still use the existing bounded engine recovery plan and wall-clock budget. Snapshot recovery fixes a concrete reproducible adapter defect; it does not prove that every historical live empty response had this cause.

## Offline verification

No running app, account endpoint, real model endpoint or existing database is needed:

```sh
# Provider + engine unit suites; integration suites are excluded by this config.
node packages/core/node_modules/vitest/vitest.mjs run --root packages/core \
  --maxWorkers 1 src/providers src/engine

# The actual API manager → wrapper → router → engine path, with in-memory RPC.
node packages/core/node_modules/vitest/vitest.mjs run --root packages/api \
  --maxWorkers 1 src/__tests__/codex-provider-manager.test.ts \
  src/routes/__tests__/codex-provider.test.ts

# Only this explicitly synthetic pinned-runtime integration suite.
node packages/core/node_modules/vitest/vitest.mjs run --root packages/core \
  --config vitest.integration.config.ts --maxWorkers 1 \
  src/providers/codex-app-server/__tests__/deferred-tools.integration.test.ts

node node_modules/typescript/bin/tsc --noEmit -p packages/core/tsconfig.json
node node_modules/typescript/bin/tsc --noEmit -p packages/core/scripts/tsconfig.json
node node_modules/typescript/bin/tsc --noEmit -p packages/api/tsconfig.json
```

The native fixture uses temporary isolated `CODEX_HOME`/cwd directories, synthetic inputs and a fake loopback Responses endpoint, with the production hardening profile unchanged. It checks every currently registered Codex selector: native discovery or the eager GPT-5.2 fallback, exact model-visible tools, schema withholding/loading, canonical execution, invalid argument rejection, denied confirmation, complete final text without an empty-response retry and all internal-call usage. Other suites cover Gemini discovery/signatures, stateful/stateless paths, routing/eager fallback, authority withdrawal, cancellation, usage duplication and coalesced completion/error races.

Mixed-catalog regressions exercise unified MCP lookup of memory and non-memory tools, automatic dynamic schema loading, and pinned-runtime native schema loading and canonical execution, without making all native tools eager. Inventory tests page through five introspection operations plus twenty native operations without duplicates; final-admission tests reject broader inherited registries in eager/dynamic/native and stateful/stateless modes. MCP unit tests also cover source-label queries, hidden/capability-filtered entries, qualified direct-only aliases, and scoped misses.

Successful discovery and dispatch do not waive data-layer source checks. See [native Memory write lineage](native-memory-write-lineage.md) for index-read → save behavior and its DB-backed regressions.

These are correctness and wire-shape checks, not real-provider latency measurements. Deferral reduces initial schema presentation but can add a discovery model round trip when a tool is needed. System instructions, history and other provider context still contribute input tokens; no specific production token or latency reduction is claimed.
