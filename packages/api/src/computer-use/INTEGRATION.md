# Native computer pilot transport (disabled by default)

**Current Mac boundary:** the signed-package admission milestone passed on an earlier operator-tested revision. Current helper source supports lazy AX discovery, read-only inspection and consented semantic TextEdit/fixture actions. The desktop inspector-only opt-in cannot enable control; accepted control rollout remains separately gated. Coordinate input remains disabled. Native safe-canvas capture requires explicit control-and-capture consent, while core screenshot-click fallback still refuses before capture without input capability. Current-source native AX/model outcomes are not yet verified. See `docs/native-computer-acceptance.md`; older probe-only statements below are historical and superseded by this paragraph. Existing API/relay/auth/accounting requirements remain unchanged.

**Historical pre-admission-fix boundary (superseded, not current): macOS was unconditionally PROBE-ONLY before `Broker` construction.** All four authority bits are false, both permission statuses are `unknown`, discovery is empty, start/approvals return false and valid execute returns `denied` / `not_executed`. No permission query/prompt, event tap, target lookup, AX, focus or capture occurs. No environment, acceptance or test override exists. Main/API flags did not independently prevent a qualifying forged parent from exploiting the unenforced loaded-framework binding. This helper barrier closes that authority exposure; it does **not** implement the real loaded-framework/main bootstrap chain. Library-constraint research is feasibility only, not proof. Static signatures/fuses and restored on-disk framework contents do not prove the already-loaded image. Retained macOS operational code and scenarios below are unreachable future requirements, not available features.

## Current runtime and readiness integration

Images resolve to the same configured task provider/model/key source as text; `NATIVE_COMPUTER_VISION_MODEL` is an exact approval pin only. `resolveGrounder(context, selectedRoute)` cannot substitute another route. Image support, approval and live route/policy are checked before upload and before accepting output; opaque custom-endpoint image identities remain unsupported. Core freezes decomposition before capture, then re-observes. After an effect, controller capabilities only decrease within the grant; the relay serializes status publication before its receipt. Readback remains possible after a candidate accepted click, but another effect does not. The real controller/relay/API/concrete-runtime HTTP/WS regression uses a fake helper/provider/database and checks both advancing and unchanged canvas counters; it is synthetic completion evidence, not OS or live-provider acceptance.

`POST /api/native-computer/readiness` accepts only `{workspaceId, assistantId, conversationId, taskId, deviceId}` with session-backed authentication. Boot already mounts `nativeComputerAuth` and passes the shared runtime options through `createNativeComputerReadinessOptions`. Readiness uses `requireAuthWithoutTouch` (including normal case/trailing-slash variants); no outer touching `requireAuth` may precede it. Other native routes retain ordinary auth. Scope/schema/policy/lease reads, registered accounting availability, configured model/budget inspection and the protected relay readiness endpoint are SELECT-only/no-inference checks: no grants, auth activity UPDATE, expiry cleanup, accounting admission/reservation or execution. Opaque runtime overrides cannot inherit default-runtime readiness claims.

See [backend setup](../../../../docs/native-computer-backend-setup.md) for exact build/start/environment inputs and the protected `pnpm native:readiness --non-production` command. It requires an existing normal access token via owner-only regular file or stdin, plus the five context IDs; no credentials in arguments or reports. Readiness and live-provider credentials are deployment-specific and can be checked off-Mac. No deployment/provisioning is claimed. A ready report is configuration only and can retain image warnings, not acceptance. The operator already passed production source SDK preflight and corrected guardian 16 XCTest + C-fake checks at `2fe2e0d2`; do not repeat unchanged checks. [Mac handoff](../../../../docs/native-computer-mac-handoff.md) separates new isolated experiment execution from signed-app/backend verification. Experiment results never enable the empty production input registry.

## Desktop/UI API
Routes use existing access-token authentication under `/api/native-computer`, with the no-touch readiness exception above.
No native credential is returned from create/status. Main must generate PKCE
verifier (43–128 RFC7636 characters), retain it privately, and send only its
SHA256 base64url challenge to a renderer if necessary. Never expose exchange,
verifier, native token, arbitrary grant construction or relay send through preload.
Origin/Sec-Fetch-Site-bearing exchange requests are rejected; that check is defense
in depth, not attestation of an Electron binary.

- `POST /sessions`: `{workspaceId, assistantId, conversationId, taskId, deviceId,
  challenge}`; returns 201 `{protocol, identity, expiresAt, state}`. UUIDs except
  deviceId/challenge. Requires session-backed login (legacy sid-less JWT denied).
  Conversation and task must belong to initiating user/assistant/workspace;
  explicit active `native_computer` capability and membership required.
- `POST /sessions/:id/exchange`: **main only**, `{verifier, grant}` where grant is
  shared `GrantSchema`, exact returned identity, positive epoch (>0, chosen after fresh local consent), fresh local grant ID,
  approved targets, permissions, requester/goal and expiry <= now + 15min.
  One-shot within two minutes of create. Returns `{token, relayUrl, expiresAt}`.
- `POST /sessions/:id/revalidate`: main-only session-backed check; body `{commandId, grantId, epoch, deadlineAt, digest}` (64 lowercase hex SHA-256 of the validated command). Returns `{authorized:true}` only for the exact live pending dispatch; wrong/missing/expired scope, Origin/Sec-Fetch-Site or absent auth session is denied. No raw command payload or new authority is accepted.
- `POST /sessions/:id/run`: run the locally approved control goal once, not a new renderer/model goal. An `allowControl=false` grant returns `unsupported` / `local_inspector_only` and never starts a model task.
- `GET /sessions/:id`: owned, live, scoped metadata plus relay status (no token).
- `DELETE /sessions/:id`: idempotently revoke; 204 on success, 503 means retry.
  Local Stop must happen immediately, not await this network call.

WebSocket `/native-computer-v1`: shared protocol hello with native token; send
heartbeat every 10 seconds, active status after hello. Relay revokes at 30 seconds
silence, lease expiry, non-active status, disconnect, invalid receipt or command
timeout. Reconnect cannot reuse old authority. Resume requires a new create/local
consent/exchange. Browser `/ext` remains separate and unchanged.

An `allowControl=false` grant is only a one-shot **local AX inspector**. Main pairs after local consent, observes the sole selected window once locally, kills the helper/releases the lease and closes relay authority, then awaits API DELETE before returning a redacted snapshot. API model binding, run claims and dispatch refuse inspector grants; relay-delivered commands are denied by the main controller. No remote read-only model task or capture is enabled. Discovery display labels remain local metadata, never part of the five-field target or API grant; main ignores renderer label substitutions.

Flags: `NATIVE_COMPUTER_ENABLED=true` on **both API and relay**;
`NATIVE_COMPUTER_DEPLOYMENT_ID` required on API. Existing `BROWSER_RELAY_URL`,
`BROWSER_RELAY_SECRET`, `JWT_SECRET` still configure transport. Migration 620.
Usage accounting also requires migration 621. Relay deployment must remain single-instance; physical desktop exclusion across
client-chosen device IDs/instances additionally requires desktop's local lease.

`POST /api/native-computer/sessions/:id/revalidate` authorizes only the exact pending command’s SHA-256 digest, ID, grant, epoch and deadline against current auth-session, capability, ownership and tool policy. Pending checks are ephemeral on the dispatching API instance: use one instance or sticky routing; restart/another instance fails closed. Remote read-only grants remain denied. Main checks before remote reads/capture, after local approval **before** `endApproval` can restore focus, and again after `endApproval` before effects. After each HTTP check it rereads auth and compares the snapshotted access-token primitive plus account/session binding; replacement or even same-user token rotation denies/stops rather than retries. This adds no second task loop; the one-shot AX inspector remains local.

The helper-client death barrier resolves only on actual process exit or a proven never-spawned process. A kill returning false, throwing or emitting errors revokes authority but does not release the lease; repeated errors remain handled safely. Stop is not proof of death, and uncertain termination cannot authorize a new owner.

API revalidation now intersects the existing session/auth-version/expiry, exact auth-session, membership, capability, conversation/task ownership and tool-policy predicates in **one coherent parameterized SQL authorization snapshot**, with pending-command/grant/deadline checks around it. This prevents mixed database snapshots; it is **not instantaneous distributed revocation** after the check. A PGlite real-SQL/migration plus HTTP regression exercises those predicates and exact auth-session matching. Main’s post-HTTP token checks and pre-effect guards remain; no second task loop or remote inspector authority is introduced.

Stop now destroys both private command and observation streams **before** attempting kill. Channel closure independently revokes helper authority, including buffered commands: watchdogs and read/capture, focus-restoration and pre-effect guards detect closed endpoints. Closure is **not process-death proof**; the lease stays held until actual exit or proven never-spawned state. Real Linux pipe/socketpair tests exercise the portable checks; actual Windows/libuv pipe-state query acceptance remains open and unsupported/query-failure cases refuse authority. No guard can retract an OS operation already entered.

## Composition boundary / remaining integration
`NativeComputerService.dispatch(scope, command)` rechecks membership, explicit
capability, conversation/task ownership, auth-session liveness/version and DB
revocation on each dispatch. `createRelayNativeComputerProvider` implements the
core provider structurally and revokes on cancellation. IDs in `scope` must be
selected from authenticated ToolContext, not model tool inputs.

`composeNativeComputerTool(service, runtimeFactory)` is now registered in boot's
`allTools` as `nativeComputerTask` when transport enabled. `OpenApiPorts` accepts
`nativeComputerRuntimeFactory?: NativeRuntimeFactory`, exported from
`computer-use/composition.ts`:

```ts
(context: ToolContext, grant: NativeGrant, trace?: NativeRunTrace) => Promise<{
  llm: NativeLlmAdapter;
  policy?: NativeSafetyPolicy;
  decisionRuntime?: NativeDecisionRuntime;
  inferenceBudget?: NativeInferenceBudget;
} | null>
```

Boot now defaults to `createNativeComputerBootRuntimeFactory`; the port is an
optional override, not a prerequisite for inference. It resolves workspace plan,
credit status and the existing custom/default model route, with endpoint failure
fallback disabled. Blocked credits, denied decision LLM lanes and absent providers
fail closed before inference. Every actual LLM completion, including Hydra
selection/progress, is metered by
the native adapter with trusted user/workspace/session attribution; user-key cost
is zero. The central decision meter bills Jev with native attribution, without
double billing LLM completions. Metadata-only inference-attempt audits include
failed/partial calls and preserve unknown usage rather than inventing zero.
Each attempt retains immutable `requested_model`; nullable `model` and usage resolve only from strict upstream native evidence. For model adapters this is `message_end.nativeMetadata`, not synthetic `message_start` or legacy usage. Direct Jev uses its strict wire response evidence. Missing/malformed/conflicting evidence is unknown, not requested-model attribution or fabricated zero; explicit valid wire zero is accepted. Pricing uses the proven actual identity and trusted key source. Late evidence cannot resume stopped execution or acquire another billing claim.
Native durations use `performance.now()` independently of wall-clock deadlines.
**Strict native provider evidence:** Trusted internal `ProviderRequest.nativeStrict: true` selects the native adapter path; it is not a model/UI/session permission. The native model runtime consumes only upstream-derived `message_end.nativeMetadata {actualModel, usage}`, never synthetic `message_start` identity or legacy zero-filled usage. Resolved actual identity and valid wire counters are required: missing, malformed or conflicting evidence stays unknown and cannot authorize a usable result. Legitimate explicitly reported zero counters are accepted. Late evidence may settle accounting after Stop, never resume execution. Review found fabricated zero usage, synthetic start identities, hidden Anthropic retries and raw provider error logging in the earlier adapter paths; earlier accounting/runtime tests did not establish this real-adapter contract.

Native Anthropic, Gemini and OpenAI-compatible adapters support stateless text/image inference only and make a single inference HTTP attempt. No SDK retry, schema/system compatibility retry, fallback, routing substitution, content/loop recovery, document distillation, redirect or raw-content logging is allowed in this path. Codex, tools and document transformation are unsupported; the native caller owns cancellation/deadlines. Direct Jev requires `supportsNativeStrict` before calling the adapter, wire response model + usage evidence, canonical actual-model pricing identity and an exact evaluated-profile wire match; legacy unsupported adapters deny before dispatch. Native Jev fetch uses `redirect: 'error'`; transport causes and invalid-response errors are sanitized. Vision must report the evaluated requested wire identity (registry aliases resolved); a substitution is accounted for under its actual identity but its output is never used or retried. Non-native behavior is preserved except respecting an explicit caller retry restriction. Strict evidence does not replace atomic settlement receipts, grant authority or native acceptance.

Earlier strict-provider follow-up: parent core **695 tests / 36 provider/decision/computer-use files** (`/tmp/native-parent-strict-core.log`) and API **322 / 13 native/runtime/OSS files** (`/tmp/native-parent-strict-api.log`) passed. Fake orchestrator profiles required honest canonical model metadata and explicit strict support before passing. These selections overlap worker/earlier suites; do not sum or treat earlier accounting-only results as adapter coverage. No live-provider, native desktop SDK, signing or gate acceptance is established; at that revision macOS remained probe-only; current production input still stays disabled, independently of the later semantic/capture implementation.

Strict credential-pool native spend now requires the actual model’s registered rates and valid wire counters. It ignores `calculatedCostUsd`, unknown-rate fallback and requested-model substitution; missing evidence stays unknown. Credential spend is not a durable ledger receipt or external payment proof; existing adapter/central Jev ledger ownership is unchanged.

Native-only accounting is implemented in `accounting.ts`, `accounting-capability.ts`, `db/oss-native-accounting.ts` and migration `621_native_usage_receipts.sql`. A known supported native capability (registered or explicitly supplied) and durable admission are required **before inference**; hosted/unsupported stores remain gated with no generic-store fallback. Immutable admission and priced settlement intent use the exact `(nativeSessionId, invocationId)` key. OSS reconciliation commits ledger insertion, receipt and audit acknowledgement atomically on one checked-out transaction, returning the receipt only after commit. Persistent deletion tombstones prevent recharging a recorded key after session/identity/ledger deletion; conflicts and legacy rows cannot authorize replay. Missing settlement receipts block on-time model results and effects as accounting infrastructure failure, not semantic uncertainty. Jev retains central primary ownership; boot never charges it a second time. Pricing requires actual-model registry rates or explicit BYOK; adapter costs are not provider provenance, and neither generic fallback rates nor requested-model substitution is allowed. Receipts prove historical ledger insertion, **not external payment**. Explicit `reconcile(key)` / bounded `reconcileBatch()` are accounting-only recovery, never model/action replay; no automatic reconciliation worker is enabled. Generic `UsageStore` and hosted contracts are unchanged.

Pending/hung invocations are not settled or billed simply because usage is known. Late accounting retains original attribution without resuming stopped work. Legacy `claimed`/ambiguous rows are not permission to charge again.

Production SQL was exercised with synthetic data on isolated PostgreSQL **18.6**: seven scenarios (**8 TAP including harness**) passed in `/tmp/native-final-real-pg.log`, using no TCP, a private 0700 directory and owned cleanup. This tests concurrent exact-key/conflict/deletion/lock behavior, not power-loss durability or live-provider/payment acceptance. No production migration was run for this documentation update.

Custom routes use their own bounded selector, not platform Hydra,
to avoid sending workspace AX data to a different provider.

Grounding is OFF by default. Boot supplies approval for the already resolved configured task route only when `NATIVE_COMPUTER_VISION_ACCEPTED=true` and the exact `NATIVE_COMPUTER_VISION_MODEL` approval pin matches. A host-supplied `resolveGrounder` must return that same provider/model/key source and enforce the workspace-approved destination; it is not a second model resolver. Generic vision capability or model substitution cannot grant approval. Opaque custom endpoints remain text-only in this native runtime. The default non-refundable
per-grant reservation is 262144 tokens / $26.2144, with 32768 tokens / $3.2768 per
attempt (a conservative $100/M token rate). It cannot fund even one conservative image reservation: 4227072 units / $422.7072 at defaults. Readiness reports `vision_budget_insufficient` against effective bounds, including overrides. These are worst-case reservations, not provider invoices. Reviewed bounds must cover image work and all configured decision lanes; do not automatically increase budgets or enable approval to clear warnings. Native strict inference still forbids hidden retries. More expensive custom/decision routes also
require reviewed bounds. Invalid bounds or exhaustion stop inference. No raw AX,
frames, goal or generated text is included in these usage records.

Binding resolves user/workspace/assistant/conversation from ToolContext, not
model IDs; if taskAuthority exists its task IDs further constrain the binding.
Direct `/run` requests retain the exact session/grant selected by the authenticated
route through a service-owned context binding. Revocation, replacement or a cloned
native-channel context cannot fall back to another device. Generic assistant-tool
resolution requires one unambiguous eligible grant after task filtering; multiple
eligible grants refuse before inference or run claiming. Raw grant remains
in API-process memory only. Restart requires fresh local consent; multi-instance
API needs sticky session routing (no serialized grant fallback). Model goal must
exactly equal the locally approved grant goal; local grant requester/task text
must be derived from trusted UI context. Shared orchestrator per session; provider
bounds each core command deadline to 29s to fit relay's <=30s envelope.

Document-only model projection (TextEdit, System32 Notepad, gedit) retains every
actionable/focused node, candidate ref, frozen-objective match and ancestor with
exact values. Full raw observations still drive all safety/freshness/approval and
whole-goal verification. The post-projection bound is 24,000 UTF-8 JSON bytes;
fixtures are not projected. Both native decision operations use stateVersion 3
with separate exact-profile gates; state-version-1 and state-version-2 profiles cannot authorize either.

`NativeNodeSelector` (`packages/core/src/computer-use/selector.ts`) uses exact `role`/`name` plus optional `ancestors`: 1–4 exact, contiguous, nearest-parent-first `{role,name}` entries, including any intervening wrappers. Grounding requires a unique match in the complete raw graph and validates the entire parent chain, even beyond the prefix. Frozen objective selectors survive genuine ref churn and remain unchanged on replan; they never use positional indices or persisted opaque refs. Grouped duplicate-field goals can resolve through unique semantic ancestry, but indistinguishable duplicates remain unsupported. Cycles, missing parents, relabelled/reparented or ambiguous/sensitive ancestry are refused. Projection retains all role/name rivals and their ancestors, including rival ancestor-label matches without a target descendant, so it cannot manufacture uniqueness. Each objective needs its own fresh evidence; one duplicate cannot prove two fields.

Before dispatch, DB state is durably latched `execution_unknown`; only a valid,
correlated non-unknown receipt clears it. Unknown receipt/exception/process death
requires manual reconciliation and blocks new sessions for that device even
after revocation/expiry. No model/UI endpoint currently clears that latch;
operator reconciliation is a deliberate outstanding human workflow. DELETE
cannot clear the unknown latch. This prevents automatic replay after restart.
A matching authenticated
`not_executed` / `stale_observation` receipt for a ref action permits bounded
fresh-observation recovery only, never old-command replay or loss of frozen
whole-goal objectives/committed progress.

Raw goal/text/AX/frame are ephemeral only. DB stores identity/lease/grant ID and
created/paired/revoked/action metadata and inference-attempt audit records,
without raw observations or model payloads. Relay disconnect immediately destroys
execution authority but DB lease metadata remains until explicit DELETE/expiry
(fail-closed; no automatic takeover). Sign-out must locally Stop/disconnect;
subsequent API commands independently reject revoked auth sessions. No remote
native takeover/browser session registration was added.

## Source observer and evidence status

The **source-only observer slice is implemented, not accepted live evidence**. Core `NativeRunTrace` and API composition/boot expose a trusted optional observer bound to a validated session UUID + epoch after the durable run claim. It observes the existing loop and correlates actual text/vision/Jev invocation lifecycle metadata: stable IDs, source durations, pending/settled state and late accounting updates, without a second planner, execution loop or billing write. Desktop trusted broker observation and `helperTimingObserver` are default off. Events are bounded, strict and immutable metadata only: no goals, AX values, frames, targets, tokens or raw errors. Durations come from the source clock, not callback arrival; RPC/adapter spans do **not** prove native OS delivery, and logical terminal is **not** a drain watermark.

All three helpers now implement private source timing. Trusted constructor opt-in remains default off. Platform/Linux hardcoding is replaced by negotiation of `diagnosticsVersion: 1` in the private **capabilities RESPONSE envelope**, outside public `result`; only subsequent requests may carry `diagnostics:true`. Old helpers receive unchanged requests. Malformed/unknown, changed or non-capabilities advertisements latch diagnostics invalid for that helper lifetime. macOS timing covers harmless probes/refusals only, never native API effects. Source request/API spans are not OS delivery, callback arrival is not source time, missing timing is not zero, and terminal is not drain.

The shared `helper-timing.ts` now owns the full canonical `HelperTimingEventSchema`, reused by producer and evaluator rather than a separate evaluator envelope validator. It validates extra fields, correlation UUIDs, method/request binding and bounded drop counts. The evaluator applies bounded descriptor-safe copying before canonical parsing; the producer validates its constructed metadata-only callback envelope, omits invalid events and counts them as loss without changing execution outcomes. Schema validation is not delivery or drain evidence.

Latest parent host/health revision: **desktop 975 / 50 files**, **API 369 / 18**, **evaluator 105**, **core 711 / 36**, and **Linux 154 units**. Shared/core/API/desktop types and builds passed. Earlier selections below are revision-scoped, overlap and are not additive; none establishes real native SDK/signing/live-provider acceptance.

**Process-local observer owners, not deployed transport:** API `PassiveNativeObserverHost` and desktop `PassiveDesktopObserverHost` (`observer-host.ts` in their respective computer-use/computer-control directories) now provide trusted bounded attachment ownership. API injection uses the existing `OpenApiPorts.nativeComputerObserverFactory`; desktop injection uses constructor-only `NativeIntegrationOptions.observerFactory` and `helperTimingObserver`. Both remain absent by default: no bootstrap enablement, network/auth binding, grant/model/renderer/environment/HTTP selector, helper launch, execution or Stop authority. Bounded queues, scope/start history and original generations close on loss/expiry; old callbacks cannot follow replacement registrations. Uncorrelated desktop helper callbacks are counted globally with missing scope evidence, never assigned to an arbitrary binding. Sinks/factories are deferred and trusted-only; synchronous JavaScript/Proxy blocking cannot be preempted. Actual distributed composition/host transport and authenticated attachment remain unimplemented.

API and desktop **attachment** health use shared `passive-observer.ts`’s strict canonical `PassiveObserverHealthSchema`: `state: incomplete`, fixed nullable reason and `drain: not_observed`. Desktop owner-wide uncorrelated/lost counters are separate from this closed attachment DTO. The evaluator `main-driver.mjs` queries attachment health **only during diagnostics**, never Stop or detach. A fixed failure is sticky and poisons the overall collection even after a valid event prefix. Missing legacy health stays unknown; extra fields, getters, async or throwing health are rejected. An accidentally returned native Promise has its rejection consumed without awaiting or accepting it. Health does not prove drain or control execution; publication is always refused.

Earlier narrow follow-up evidence (overlapping selections, not a new aggregate): parent evaluator **80** and desktop **936 / 49 files** passed serially. An earlier concurrent desktop run timed out in an unrelated desktop-release fixture; the serial pass did not relax budgets. Parent observer-host **25** + composition **20** = **45** passed; worker computer-use **187** and API types passed. A separate parent strict-provider regression selection passed **16 / 4 files**, beyond the earlier **322 / 13** selection; core/API types passed. Earlier 78/935 and strict-provider results retain their historical scope, not coverage of these new slices. No gate or native/provider acceptance changed.

The legacy step-driving evaluator is now quarantined in `synthetic-sequential-driver.mjs` and accepts synthetic use only. Passive source/helper ingestors and the `main-driver.mjs` observer adapter exist, but **live publication is explicitly blocked**. Source-only passive core, broker/safety and helper ingestion exists (earlier 78-test selection; subsequent selection: 80; latest host/health selection: 105). Distributed production host/network attachment, deployed desktop host composition/auth binding, per-command oracle target attribution, terminal UI-thread drain and accepted native telemetry remain missing; the new process-local attachment owner does not supply them. A received prefix, settled RPC or terminal event cannot establish complete evidence. See `docs/native-computer-evaluation.md` for the current passive/synthetic split; it does not enable flags or collect accepted live results.

`composeNativeComputerTool(service, runtimeFactory, observerFactory?)` creates one trace only after the durable claim. Boot’s optional `nativeComputerObserverFactory` is a trusted host port, not a renderer/environment/model option. Its frozen binding contains only session UUID and epoch, not ToolContext, grant authority or user content. The trace reaches the existing runtime and orchestrator, and actual text/vision/Jev lifecycle updates reuse existing accounting IDs/durations. Late observer updates do not re-execute work or charge again; billing acknowledgement/reconciliation limitations above remain unchanged.

Historical diagnostics/atomic-accounting revision evidence (not strict-provider adapter coverage): desktop **935 / 49 files**, types/build passed (`/tmp/native-parent-diagnostics-desktop*.log`); parent core **210 / 11** (`/tmp/native-parent-atomic-core.log`), API **321 / 17** (`/tmp/native-parent-atomic-api.log`). At that earlier revision, core/API builds, types and standalone native E2E checks passed (`/tmp/native-final-core-build-types.log`, `/tmp/native-final-api-build-types.log`). Child Core175/API309 overlap parent selections: do not sum. At that earlier revision, source-only passive three-producer ingestion had **78 tests**; publication remains blocked. Windows **27** portable checks/cross-build and Linux Foundation **1127 wire + 458 probe cases + 54 schema envelopes + 14 regressions/parsing** are not native SDK acceptance. Linux **147 units** do not change the preserved cold/approval/warm latency failures or 1800/3500 ms limits.

## Production helper safety boundary

All three production helpers advertise `input=false` and independently refuse raw coordinate clicks; no environment flag, acceptance flag or local approval bypasses this. Scoped Windows/Linux capture and supported UIA/AT-SPI semantics remain; macOS now has the consented inspector/semantic/capture implementation described above; the input registry remains empty. Generic core CV tests use fake providers, not enabled native vision. macOS/Windows coordinate emitters were removed: macOS down/up posting had no release owner surviving SIGKILL; Windows unconditional finally-up could release a physical press, while termination bypassed cleanup. Restoring P5 input requires a surviving ownership-aware release guardian, physical-overlap/partial-delivery/kill tests and real native acceptance; source checks are not that evidence.

The parent lease derives its fixed home from OS `userInfo().homedir`, never `HOME`/`USERPROFILE`. Linux independently authenticates the system-logind session owner and uses `User.RuntimePath`; unsafe/missing paths or an `XDG_RUNTIME_DIR` mismatch fail closed. Environment-selected directories cannot split device authority.

Public Stop/disconnect responses redact prior identity/expiry; integration-level Stop erases the private grant. Stale controller callbacks are ignored, without releasing a live helper’s lease: helper death remains the release barrier. A completed inspector snapshot is retained only under its authenticated account/workspace/generation binding, not exposed as cross-account stopped status.


macOS `ProcessIdentity.c/.h` and `Helper.swift` now require kernel executable/birth identity, the same ordinary non-root UID, and fresh dynamic and static signature validation. The parent must be signed `ai.usebrian.desktop`, on the helper’s Apple-issued team, in the exact `Contents/MacOS/Use Brian` → `Contents/Resources/computer-control/` helper/adjacent-fixture tree. Operational target checks require real Apple system TextEdit or the adjacent signed same-team fixture; titles, bundle IDs alone, copied fixtures and path prefixes are not authority. Unsigned/ad-hoc builds, generic Electron and standalone Node cannot obtain helper authority. Packaging/signing includes the fixture; direct Node smoke is negative-only. The operator has since passed production source SDK compilation and earlier signed admission; current workflow TCC and Node/libuv behavior still require Mac verification; repeated-signature latency/cost and race behavior are unknown.

Linux ordinary-credential checks reject root, mismatched real/effective/saved/filesystem UID/GID and nonzero effective/permitted/inheritable/ambient capabilities. Supplementary groups and capability bounding sets remain permitted. These checks supplement authenticated logind/lease paths; isolated fixture/focus tests do not establish production logind, hardware or packaged acceptance.


macOS-only `afterPack` hardens and verifies Electron fuses before signing; `afterSign` independently verifies without repair. RunAsNode, NodeOptions environment loading and CLI inspection are disabled; embedded ASAR integrity and OnlyLoadAppFromAsar are enabled. The helper checks the framework as its own static signed/sealed bundle, parses bounded Mach-O fuse data across architectures, and validates sealed fuse/ASAR policy. Firefox launch behavior is unchanged. **Historical finding before the later supported-package admission fix:** a different dyld image already mapped in the parent is not proven safe by restoring a hardened signed framework on disk. File signatures, static fuse checks and ASAR policy do not close that implementation/security gap or prove a safe bootstrap. At that checkpoint SDK/linking and bootstrap/pipe behavior were unaccepted. The later operator SDK and signed-admission results above supersede that status; current workflow behavior and hardware signature-validation cost still need verification.
