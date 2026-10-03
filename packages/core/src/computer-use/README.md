# Native computer core (default off)

**macOS is unconditionally PROBE-ONLY before `Broker` construction.** All four authority bits are false, both permission statuses are `unknown`, discovery is empty, start/approvals return false and valid execute returns `denied` / `not_executed`. No permission query/prompt, event tap, target lookup, AX, focus or capture occurs. No environment, acceptance or test override exists. Main/API flags did not independently prevent a qualifying forged parent from exploiting the unenforced loaded-framework binding. This helper barrier closes that authority exposure; it does **not** implement the real loaded-framework/main bootstrap chain. Library-constraint research is feasibility only, not proof. Static signatures/fuses and restored on-disk framework contents do not prove the already-loaded image. Retained macOS operational code and scenarios below are unreachable future requirements, not available features.

Public exports from `@use-brian/core`:

- `NativeComputerProvider`: `status(signal)`, `observe(command, signal)`,
  `execute(command, signal)` using computer-control v1 contracts. Observation
  commands are `observe`; scoped capture is `execute(capture)` with an observation
  receipt. No browser provider reuse or transport retries.
- `NativeComputerOrchestrator({provider?, policy?, llm, decisionRuntime?, inferenceBudget?})`
  and `.run(NativeTaskOptions)`. Reuse one instance per authenticated session.
- `createNativeComputerTools({resolve(context)})` returns `{nativeComputerTask}`,
  an actual `Tool` requiring `native_computer`. Only model argument is `goal`.
- `NativeAuthority`, `NativeSafetyPolicy`, `NativeLlmAdapter`,
  `NativeInferenceBudget`, `NativeDecisionRuntime`, `NativeTaskResult`,
  `buildNativeCandidates`, `createNativeDecisionOperation`, `NATIVE_NEXT_ACTION`,
  `createNativeProgressOperation`, `NATIVE_VERIFY_PROGRESS`,
  `approvedNativeProfile`, `unavailableNativeComputerProvider`.

`NativeDecisionRuntime` is structurally compatible with existing API
`DecisionRuntime`, including `resolveRoute`, `run` and `observe`. The operation
uses the existing Hydra contract, not a parallel credential/model registry.
Authoritative decisions require an exact recorded approved hybrid profile,
matching response model, native probability evidence and explicit profile policy
`{minProbability: number}`. Operator override never grants native authority.
Shadow results do not cause additional actions. AX/frame content is untrusted;
frames never enter Jev or the text selection adapter.

## Optional source trace (not acceptance)

**Strict native provider evidence:** Trusted internal `ProviderRequest.nativeStrict: true` selects the native adapter path; it is not a model/UI/session permission. The native model runtime consumes only upstream-derived `message_end.nativeMetadata {actualModel, usage}`, never synthetic `message_start` identity or legacy zero-filled usage. Resolved actual identity and valid wire counters are required: missing, malformed or conflicting evidence stays unknown and cannot authorize a usable result. Legitimate explicitly reported zero counters are accepted. Late evidence may settle accounting after Stop, never resume execution. Review found fabricated zero usage, synthetic start identities, hidden Anthropic retries and raw provider error logging in the earlier adapter paths; earlier accounting/runtime tests did not establish this real-adapter contract.

Native Anthropic, Gemini and OpenAI-compatible adapters support stateless text/image inference only and make a single inference HTTP attempt. No SDK retry, schema/system compatibility retry, fallback, routing substitution, content/loop recovery, document distillation, redirect or raw-content logging is allowed in this path. Codex, tools and document transformation are unsupported; the native caller owns cancellation/deadlines. Direct Jev requires `supportsNativeStrict` before calling the adapter, wire response model + usage evidence, canonical actual-model pricing identity and an exact evaluated-profile wire match; legacy unsupported adapters deny before dispatch. Native Jev fetch uses `redirect: 'error'`; transport causes and invalid-response errors are sanitized. Vision must report the evaluated requested wire identity (registry aliases resolved); a substitution is accounted for under its actual identity but its output is never used or retried. Non-native behavior is preserved except respecting an explicit caller retry restriction. Strict evidence does not replace atomic settlement receipts, grant authority or native acceptance.

Earlier strict-provider follow-up: parent core **695 tests / 36 provider/decision/computer-use files** (`/tmp/native-parent-strict-core.log`) and API **322 / 13 native/runtime/OSS files** (`/tmp/native-parent-strict-api.log`) passed. Fake orchestrator profiles required honest canonical model metadata and explicit strict support before passing. These selections overlap worker/earlier suites; do not sum or treat earlier accounting-only results as adapter coverage. No live-provider, native desktop SDK, signing or gate acceptance is established; all gates stay off, macOS remains unconditionally probe-only and production input stays disabled.

Strict credential-pool native spend now requires the actual model’s registered rates and valid wire counters. It ignores `calculatedCostUsd`, unknown-rate fallback and requested-model substitution; missing evidence stays unknown. Credential spend is not a durable ledger receipt or external payment proof; existing adapter/central Jev ledger ownership is unchanged.

Native-only accounting is implemented in `accounting.ts`, `accounting-capability.ts`, `db/oss-native-accounting.ts` and migration `621_native_usage_receipts.sql`. A known supported native capability (registered or explicitly supplied) and durable admission are required **before inference**; hosted/unsupported stores remain gated with no generic-store fallback. Immutable admission and priced settlement intent use the exact `(nativeSessionId, invocationId)` key. OSS reconciliation commits ledger insertion, receipt and audit acknowledgement atomically on one checked-out transaction, returning the receipt only after commit. Persistent deletion tombstones prevent recharging a recorded key after session/identity/ledger deletion; conflicts and legacy rows cannot authorize replay. Missing settlement receipts block on-time model results and effects as accounting infrastructure failure, not semantic uncertainty. Jev retains central primary ownership; boot never charges it a second time. Pricing requires actual-model registry rates or explicit BYOK; adapter costs are not provider provenance, and neither generic fallback rates nor requested-model substitution is allowed. Receipts prove historical ledger insertion, **not external payment**. Explicit `reconcile(key)` / bounded `reconcileBatch()` are accounting-only recovery, never model/action replay; no automatic reconciliation worker is enabled. Generic `UsageStore` and hosted contracts are unchanged.

Latest parent host/health revision: **desktop 975 / 50 files**, **API 369 / 18**, **evaluator 105**, **core 711 / 36**, and **Linux 154 units**. Shared/core/API/desktop types and builds passed. Earlier selections below are revision-scoped, overlap and are not additive; none establishes real native SDK/signing/live-provider acceptance.

**Process-local observer owners, not deployed transport:** API `PassiveNativeObserverHost` and desktop `PassiveDesktopObserverHost` (`observer-host.ts` in their respective computer-use/computer-control directories) now provide trusted bounded attachment ownership. API injection uses the existing `OpenApiPorts.nativeComputerObserverFactory`; desktop injection uses constructor-only `NativeIntegrationOptions.observerFactory` and `helperTimingObserver`. Both remain absent by default: no bootstrap enablement, network/auth binding, grant/model/renderer/environment/HTTP selector, helper launch, execution or Stop authority. Bounded queues, scope/start history and original generations close on loss/expiry; old callbacks cannot follow replacement registrations. Uncorrelated desktop helper callbacks are counted globally with missing scope evidence, never assigned to an arbitrary binding. Sinks/factories are deferred and trusted-only; synchronous JavaScript/Proxy blocking cannot be preempted. Actual distributed composition/host transport and authenticated attachment remain unimplemented.

API and desktop **attachment** health use shared `passive-observer.ts`’s strict canonical `PassiveObserverHealthSchema`: `state: incomplete`, fixed nullable reason and `drain: not_observed`. Desktop owner-wide uncorrelated/lost counters are separate from this closed attachment DTO. The evaluator `main-driver.mjs` queries attachment health **only during diagnostics**, never Stop or detach. A fixed failure is sticky and poisons the overall collection even after a valid event prefix. Missing legacy health stays unknown; extra fields, getters, async or throwing health are rejected. An accidentally returned native Promise has its rejection consumed without awaiting or accepting it. Health does not prove drain or control execution; publication is always refused.

The **source-only observer slice is implemented, not accepted live evidence**. Core `NativeRunTrace` and API composition/boot expose a trusted optional observer bound to a validated session UUID + epoch after the durable run claim. It observes the existing loop and correlates actual text/vision/Jev invocation lifecycle metadata: stable IDs, source durations, pending/settled state and late accounting updates, without a second planner, execution loop or billing write. Desktop trusted broker observation and `helperTimingObserver` are default off. Events are bounded, strict and immutable metadata only: no goals, AX values, frames, targets, tokens or raw errors. Durations come from the source clock, not callback arrival; RPC/adapter spans do **not** prove native OS delivery, and logical terminal is **not** a drain watermark.

`NativeRunTrace`, `NativeTraceEventSchema` and `NativeInferenceLifecycleSchema` are the source contract. RPC spans, high-level loop spans and adapter invocation lifecycle updates are distinct scopes; stable invocation IDs correlate pending/settled and late updates without another billing record. `drain: not_observed` remains explicit after terminal. Malformed metadata, overflow, observer failure or backpressure invalidate evidence rather than supplying success. Trusted source clocks are separate from callback delivery clocks.

The legacy step-driving evaluator is now quarantined in `synthetic-sequential-driver.mjs` and accepts synthetic use only. Passive source/helper ingestors and the `main-driver.mjs` observer adapter exist, but **live publication is explicitly blocked**. Source-only passive core, broker/safety and helper ingestion exists (historical 78-test selection; latest host/health evaluator selection: 105). Production host/network attachment, per-command oracle target attribution, terminal UI-thread drain and accepted native telemetry remain missing. A received prefix, settled RPC or terminal event cannot establish complete evidence. See `docs/native-computer-evaluation.md` for the current passive/synthetic split; it does not enable flags or collect accepted live results.

## Composition obligations

API must resolve current user/workspace/task/conversation/device/grant from
runtime context, verify `goal` is within that task's scope, and recheck authority
on every command. Tool argument parsing is not authorization. Keep the session
orchestrator shared and persist unknown-execution latches across process restarts;
only manual reconciliation may create a new execution authority. Parent composition
now revalidates the exact pending API command around remote reads/capture and
approval/focus-restoration awaits, including post-HTTP token identity checks; this
is not a second task loop. Local inspection stays outside the model loop. Helper
lease release requires actual exit or proven never-spawned state, never kill success
assumptions. Main now closes both private streams before kill; watchdog and
pre-operation channel guards revoke buffered work, but closure does not release
the lease. API checks use one coherent SQL authorization snapshot, not
instantaneous distributed revocation. Native Mac signature/kernel identity and Linux ordinary-credential
checks remain independent; no native acceptance follows from core simulations.
Mac static-framework/fuse/ASAR checks do not enforce loaded-framework identity;
that remains an implementation/security gap, not a safe-bootstrap claim. Tools cannot
resume Stop or mint grants. Provider/local helper independently enforce scope,
epoch, capture privacy, freshness, hit testing, foreground, lease and deduplication.

Supply a trusted, supported-app `NativeSafetyPolicy`. Missing policy denies all
actions/capture. The initial candidate builder supports select/invoke/scroll;
credentials and terminal/script surfaces must be denied. Unknown/external effects
may only be proposed when an independent local broker requires exact-action
approval; model labels never approve effects. Optional `llm.plan` generates bounded,
schema/policy-checked candidates (including setValue). A unique current generated
action dispatches without another classifier; ambiguous proposals use selection. Only the protocol navigation-key enum is representable; arbitrary key/text
shortcuts, clipboard, shell and scripts remain unavailable. Helpers may deny keys/focus. Vision proposes only a
bounded frame-relative click and passes the same trusted effect gate.

LLM adapter uses existing API model resolution and per-attempt metering; it must
only upload frames to a configured native-grounding-capable model. Runtime owns
central Jev metering with trusted native attribution; the adapter meters every
actual text/vision LLM completion, including Hydra selection/progress completions.
The parent records metadata-only inference attempts, including failures/partial
usage, separately from billing; do not double bill Hydra completions.
Inject `NativeInferenceBudget` for shared token/cost admission:
reserve worst-case usage before every lane; account incurred usage via existing
runtime callbacks and adapter metering. Without it, core only enforces time,
action, model-attempt and no-progress budgets, not monetary/token ceilings.
There are no credentials or inference implementations in core/helper.

No provider means unavailable. No grant, permission, exact policy or adequate
grounding means pause, never cloud/browser substitution. A dispatch exception,
malformed/mismatched receipt or cancellation after dispatch latches unknown and
never replays. Postconditions require fresh observations and trusted policy
verification, not model assertions. Task-local deadlines also race adapters that
do not honor AbortSignal; API/helper still must cancel queued work locally.

Focused verification: `corepack pnpm --filter @use-brian/computer-control build`,
then `corepack pnpm --filter @use-brian/core exec vitest run src/computer-use`.

## Goal runtime contract (this change)

`NativeLlmAdapter` adds optional methods (legacy adapters remain compatible):

```ts
decompose?(input: NativeModelInput): Promise<void>
verify?(input: NativeModelInput, llm?: DecisionCompletionRoute):
  Promise<DecisionCompletion<NativeSelection>>
```

`verify` returns `complete | continue | abstain | ask_user`. It assesses the **whole
goal**, not permission to act. The concrete API adapter checks every LLM evidence
item against a unique current ref, observation ID and exact `value`, `selected`
or `name`. Completion additionally requires a complete, newer AX observation and
all frozen goal objectives (`role`, `name`, optional `ancestors`, `property`,
`equals`) to match uniquely against the full raw graph.
Generated document text is an exact-value objective. Replanning cannot silently
remove unfinished objectives. Missing/contradictory evidence pauses. Successful
input receipts, arbitrary confidence, labels saying “done”, or previous refs do
not prove completion. Semantic name ambiguity without a uniquely grounded stable ancestor selector prevents completion.
Goal interpretation remains model-assisted, not a formal natural-language proof.

Bounded AX next-action selection runs before generation when suitable candidates
exist. Abstention can request a bounded proposal; generated candidates pass the
same schema, current-state and policy checks. A single remaining generated
proposal needs no second selector; built-in AX candidates (even one) and ambiguous
proposals still use the selection lane. The first effect, including a vision click,
freezes decomposition if planning has not already done so. Decomposition receives
AX only, never frame pixels; failure or cancellation prevents dispatch. Read-only
AX counters/status outputs can establish a click goal’s exact final postcondition.
A successful click receipt without the expected fresh result cannot complete it. After
each executed effect the loop observes again, verifies progress, and returns to
AX planning. CV is per-step fallback, never a whole-task replay. Verification does
not consume receipt observations. Freshness is checked relative to the last effect
as well as the goal contract. Cycles/no-progress, deadlines, cancellation and
unknown execution remain bounded and fail closed.

`NATIVE_VERIFY_PROGRESS` is `{id:'computer.verify-progress', version:'1',
stateVersion:'3', questionVersion:'1'}`. `createNativeProgressOperation(input,
adapter, allowPrimary)` uses the same calibrated distribution checks as next-action.
Its choice question ID is `next` (shared choice implementation), with `complete`,
`continue`, `abstain`, `ask_user`. A `computer.next-action` profile cannot authorize
this operation. `approvedNativeProfile(profile, model?, operationId?)` defaults to
next-action for compatibility. Progress primary completion is **still** gated by
local full-goal postconditions; neither Jev nor LLM approves effects.

The API file exports `createNativeComputerModelRuntimeFactory(options)` and
`NativeModelRuntimeOptions`, now with optional `modelTimeoutMs` (default 15000).
Uncooperative streams are raced against abort/deadline and failed attempts metered
without payloads. Direct pre-dispatch selection failure may replan; Hydra fallback
remains owned by DecisionRuntime. Denied routes never bypass into a direct lane.
Unknown or potentially delivered effects are never retried. A matching authenticated
`not_executed` / `stale_observation` receipt for a ref action permits only bounded
fresh-state recovery: no old-command replay, no reset of committed progress and
no loss of frozen whole-goal objectives. Default model-attempt bound is 24,
hard maximum 40; action bound remains 8/default, 20/maximum. Token/cost reservations
remain shared, conservative and non-refundable, including verification and
potentially cached decomposition.

## Parent integration and remaining limits

- No boot/service/desktop/shared/protocol changes are included here. The core
  `computer-use/index.ts` already wildcard-exports the new helpers/types; rebuild
  core declarations before consuming from API. Existing composition can spread the
  returned adapter as before; no additional model-controlled tool parameters.
- Configure/permit the separate progress operation in existing DecisionRuntime
  routing/evaluation policy. No approved native profile or calibrated threshold is
  invented by this code. Without one, use the configured LLM lane; operator override
  and shadow cannot acquire primary authority. Parent central metering bills Jev;
  adapter metering owns actual LLM completions, including Hydra calls.
- Cohort IDs match helpers: `com.apple.TextEdit`, `com.microsoft.Notepad` (only
  System32 Notepad advertised by Windows Broker, not Store Notepad),
  `org.gnome.gedit`, and `com.usebrian.NativeComputerFixture` (all fixture platforms).
  Text roles include AX text fields/areas, UIA `ControlType.Edit`/`Document`, and
  AT-SPI `text`/`entry`. Parent/helper OS allowlists and exact-effect approval remain
  stricter than proposals; this does not enable unsupported app features.
- The generic fixture-only CV algorithm requires helper input capability before
  capture and again before vision inference, plus an attested exact grounder.
  **No production helper advertises input:** macOS, Windows and Linux all report
  `input=false` and independently refuse raw clicks; no flag/approval bypass exists.
  macOS/Windows coordinate emitters were removed for release-ownership defects.
  Capture and supported semantic actions remain, but generic core CV coverage is
  fake-provider support, not enabled native vision. Restoring input requires a
  surviving ownership-aware release guardian, physical-overlap/partial-delivery/
  kill tests and native acceptance (see the acceptance ledger). TextEdit/Notepad/
  gedit capture and frame-only completion remain unsupported; any future CV path
  must return to verifiable AX state.
- No filesystem/network verification, arbitrary apps, secure/settings surfaces,
  hidden/ambiguous fields, or offscreen final objectives are claimed. Tasks without
  expressible current AX postconditions pause. A multi-step goal may exceed the
  parent's default token/cost budget: configure reviewed budgets, never waive them.
- Keep workspace/custom-provider resolution, capability checks, durable one-run
  claims, consent, local broker approval, Stop and unknown-outcome persistence in
  parent composition. Do not restart a completed/paused grant to replay a goal.
- Tests are deterministic protocol/provider simulations, not real OS or live-model
  acceptance. OS signing, UIA/AT-SPI/AX behavior, latency, model quality and prompt
  injection resistance require parent real-device evaluation before rollout.

Focused checks (allow enough Node heap for the repository's type graph):

```sh
corepack pnpm --filter @use-brian/core exec vitest run src/computer-use
corepack pnpm --filter @use-brian/api exec vitest run src/computer-use/model-runtime.test.ts
NODE_OPTIONS=--max-old-space-size=6144 corepack pnpm --filter @use-brian/core exec tsc --noEmit
NODE_OPTIONS=--max-old-space-size=6144 corepack pnpm --filter @use-brian/api exec tsc --noEmit
```

## Document-only model context (next-action state 4; progress state 3)

New exports: `nativeModelContext(input, objectives?, documentProjection?)`,
`NativeGoalObjective`, and the readonly `NATIVE_DOCUMENT_APPS` cohort set.
`NativeLlmAdapter.contextObjectives?(input)` is a **trusted optional hook**, not a
model tool: it checks the full raw observation's scope/safety and returns every
frozen whole-goal objective. The concrete API adapter implements it. Legacy
adapters without the hook retain full context. No provider credentials, control
approvals, or helper/protocol observation types change.

Only TextEdit, System32 Notepad (`com.microsoft.Notepad`), and gedit may project.
The API policy restricts those cohorts to advertised text `setValue` effects;
menu/select/scroll/key/focus/click effects remain refused. All actionable nodes
(including disabled nodes), all focused nodes, every candidate ref, every match
of every frozen objective, and their complete ancestor chains are retained in
original order with exact values. More than 24 actionable document nodes, missing
objective matches/ancestors, cycles, duplicate refs, sensitive nodes, or incomplete
document observations fail closed. Duplicate semantic fields are **all** retained
for verification; only a uniquely grounded stable ancestor selector can disambiguate them. No candidate/value
truncation occurs. Fixtures and other cohorts are never projected.

Projection is model-only: API scope/credential/secure-surface checks inspect the
entire raw tree **first**. Core freshness/recovery/whole-state geometry checks,
helper validation, exact local approval, and API evidence/postcondition checks
continue to use full raw observations. Passive content cannot conceal a safety
finding; non-document goals requiring omitted context must abstain. Completion
still checks ALL evidence and whole-goal objectives on fresh complete raw AX.

Next-action uses `stateVersion: '4'`: directional scroll candidates include
`deltaY` in decision state. Progress remains `stateVersion: '3'`; its state is
unchanged. Operation and question versions remain `1`. State includes `objectives` plus `context: { mode:
'document' | 'full', omittedPassiveNodes, completeness }`; next-action state now
retains the full fields of the included nodes, including parent refs/focus/actions.
LLM payloads use the same shared projection and explicit omission metadata.
Instructions require abstention if omitted context is necessary for any part of
the goal. All native primary profiles for state versions 1 and 2 fail the authority gate;
Next-action also rejects state-version-3 profiles. Parent evaluation/routing must
explicitly approve the exact operation/state version before native primary
authority is enabled. No profiles are automatically promoted here.

The 24,000-byte UTF-8 JSON ceiling remains mandatory **after** projection for each
Hydra request (including questions/request/profile metadata) and each direct LLM
context. Giant documents and large retained trees still pause before inference;
there is no CV escape or chunking scheme. The conservative 32,768-token reservation
retains headroom for static provider instructions/framing and bounded output.

Coverage includes a 233-node gedit observation completing one generated write
through direct verification and real Hydra LLM fallback, with raw state unchanged;
primary next-action/progress projection; all ancestor/candidate/objective retention;
byte-limit refusal, fixture non-projection, partial/sensitive/hostile raw surface
refusal, missing objectives, duplicates, and state-version-1/state-version-2
profile rejection. These
are deterministic protocol/provider tests, not live gedit/model acceptance.

The previously verified parent API selection includes corrected complete
boot-runtime observations; subsequent native API/E2E checks passed (see the
acceptance ledger). Earlier parent core 210/11 and native API 321/17 scoped tests, core/API builds
and API/E2E typechecks passed for native accounting, not strict-adapter coverage; overlapping
counts are not summed. Incomplete document mocks remain correctly refused.
See `docs/native-computer-acceptance.md` for scoped evidence, not live-model
acceptance. Read-only local inspector grants never enter this model task loop.

## Stable ancestor selectors (decision state version 3)

Audit finding: older `plan` and completion checks filtered only by role/name and
refused every duplicate. Evaluation fixtures actually expose duplicate `Apply`
buttons under native named NSBox/WinForms GroupBox/GTK Frame groups:
`<context> target` versus `Archive distractor`, with order varied. Their underlying
AX/UIA/AT-SPI roles and any intervening content wrappers must be read from the
current tree, never guessed. Legacy ungrouped duplicate buttons remain ambiguous.
The new multi-field tests are protocol simulations of grouped duplicate editors,
not a claim that the shipped fixtures contain those exact editor controls.

`NativeGoalObjective` now extends exported `NativeNodeSelector`:

```ts
{
  role: 'textField', name: 'Draft', property: 'value', equals: 'Hello',
  ancestors: [{ role: 'group', name: 'Primary target' }]
}
```

`ancestors` is optional for backward-compatible unique fields. When present it has
1–4 `{role,name}` entries: an **exact contiguous nearest-parent-first prefix** of
the current parent chain. No skipped unnamed wrappers, positional indices, fuzzy
labels or persisted opaque refs. The complete actual chain to a root is validated,
even beyond the prefix. Each specified ancestor must itself be unique under the
specified outer context; duplicated group labels without enough context refuse.

New exports: `NativeAncestorSelector`, `NativeNodeSelector`, `matchNativeNode` and
`nativeSelectorForNode`. The shared matcher checks full raw completeness, sensitive
nodes, unique refs, missing parents and cycles, then requires one exact contextual
match. Candidate construction/grounding, generated-value replanning, API policy,
completion and evidence binding use this matcher. Candidate selectors may be
derived from fresh AX only; frozen objective selectors are never re-derived to
reinterpret a changed goal. Scoped objectives must resolve from the actual model-
provided current nodes when frozen. API projection retains **all role/name rivals**
and their ancestors, including rival ancestor-label matches with no target descendant,
not just the winning scoped field. Missing/ambiguous frozen
ancestry pauses before further inference, rather than escaping into CV.

Generated writes into goal fields must match a frozen value objective and its
unique scoped ref. Replanning cannot replace selectors or drop unchanged-sibling
postconditions. Progress evidence must cover each objective's own fresh ref; one
same-valued duplicate field cannot serve as proof for both. Relabel/reparent/cycle
changes fail closed. Inference refresh compares canonical parent relationships as
well as node content/geometry, permitting only genuine ref churn to rebind.

Both operations keep operation/question version 1. Next-action requires state
version 4; progress requires state version 3. Mismatched profiles are denied,
**not** automatically approved or upgraded; parent routing/
evaluation fixtures must migrate explicitly after reviewed evidence. Rebuild core
declarations before consuming the new types in API. No boot/meter/helper/service/
shared files were modified. The earlier invalid boot observation mocks were corrected in the previously
verified parent selection; do not loosen raw validation to satisfy any stale mocks.

Limits: ancestor paths longer than four distinguishing entries, indistinguishable
groups, incomplete/malformed trees, and goals without unique observable evidence
remain unsupported. There is no measured 95% benign-task result or live OS/model
acceptance claim. Exact local broker approval and no-replay fencing are unchanged.
