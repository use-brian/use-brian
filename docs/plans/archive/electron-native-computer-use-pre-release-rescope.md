# Electron native computer use — implementation plan (archived)

> **Superseded historical snapshot.** Follow the [active macOS release plan](../electron-native-computer-use.md), not this broader checklist. The user has since clarified that an existing Electron signing certificate/workflow is available and that vision fallback should send screenshots to the configured LLM, not introduce a CV subsystem. Old identity-blocker statements and research/evaluation gates below are retained as history, not current scope.

**Status — active macOS-only delivery; disabled and incomplete**

- **Scope:** The user narrowed current delivery to macOS and will run Mac tests personally. Windows/Linux are deferred, not gates for finishing this macOS scope. The original broader requirements and exit gates below remain historical planning material, unchanged; no macOS gate is waived. Commit/push/PR authorization applies only after macOS scope is verified, which has not happened.
- **Authority:** All execution/acceptance gates remain off; production input is false. macOS is unconditionally probe-only before Broker construction: false authority bits, unknown permissions, empty discovery and refused start/approval/execute, without override. Exact loaded-framework/main bootstrap binding remains unimplemented. Static signatures/fuses and library-constraint feasibility are not loaded-image proof. Stop/channel revocation cannot release a lease before actual helper death.
- **User-run Mac evidence:** On arm64/macOS26.6.2 build25G83/SDK26.5, Swift6.3.3/clang21, the user reports compile/refusal, self kernel/static signing-data match, ad-hoc constraint-format collection, and all four disposable library-load differential cases passed. Earlier v3 status15 and its ABI correction remain in the ledger. These are narrow prerequisites, not parent/Electron/production trust or TCC acceptance. No Developer ID identity is available. The new Swift observed-profile comparator matches JS on 3,046 Linux Foundation vectors (14 matches); 168 combined Node tests pass. Production DER verification remains unsupported; no helper admission wiring or enablement. Subsequent native cryptographic extraction and helper-owned approval-anchor prerequisites pass 288 combined Node tests and 5,347 Linux Swift Crypto vectors (46 matches, three stricter-than-JS rejections). The native build now compiles these modules and links the empty refusing approval record, but operational admission/signing hooks remain unchanged. A subsequent pure own-record/section binding passes6,286 Linux Swift Crypto vectors (135 matches) with separate compilation units and bridge typechecking. Fresh self/parent kernel, selected-slice Developer ID Application, entitlement and generation composition is now implemented as a compiled, non-invoked data collector; parent332 Node tests,359 executed Linux Swift Crypto policy vectors and975 desktop tests pass. Darwin/Security typechecking, actual native composition, loaded framework/digest binding, independent inventory construction and the complete signed bootstrap chain remain open. The user's v5 preflight passed fixture typechecking but failed helper compilation on the C spelling of the offline Security option. V6 uses the documented Swift `SecCSFlags.noNetworkAccess` member without removing offline validation; the user reports its18-file compile/refusal/self-comparison PASS, not operational acceptance. Subsequent all-slice framework/ASAR/fuse artifact binding and a separate release inventory/native signature-verifier backend pass476 Node tests, an injected-CF control-flow test and210 new Linux Swift framework vectors (older corpora rerun). Those later changes are outside v6's native evidence; final inventory approval, loaded-chain proof, signing integration and native operations remain disabled/incomplete.
- **Packaging:** Pinned Electron43.2.0 ASAR integrity-dictionary digest writing before framework signing, all-architecture slot validation/readback and read-only post-sign page-hash coverage checks address the researched `used=false` bypass. This closes a packaging prerequisite, not kernel-CDHash/library-constraint or loaded-image binding. No Helper.swift/C change or barrier removal. Parent40 focused preflight/digest/fuse Node tests and desktop975/50 rerun pass, not packaged/signed Mac acceptance.
- **Source groundwork:** Guarded semantic orchestration, stateVersion-3 profiles, frozen selectors, atomic native OSS accounting and strict actual-model/usage evidence exist. Hosted accounting remains gated; no reconciliation worker is enabled. API/desktop process-local observers and canonical sticky health exist, not distributed host transport/auth or drain. Source spans are not OS delivery; publication remains refused. Receipts are not external payment proof.
- **Open macOS gates:** Exact bootstrap binding, surviving input-release guardian, oracle command-target attribution/terminal drain, genuine vision-only baseline, fresh modal authorization, full 15-family disjoint cohorts, host composition/transport/auth, native SDK/signing/TCC/hardware and live-provider/model evaluation. Full implementation is not complete. Deferred Linux warm AX1456.076 ms still fails <250 ms; deferred Windows publication remains unsupported. Neither deferred result blocks current macOS delivery or excuses a Mac failure.

Detailed scoped/historical evidence and bundle checksum: [runtime guide](../../native-computer-use.md), [acceptance ledger](../../native-computer-acceptance.md), [evaluation boundaries](../../native-computer-evaluation.md).

- Worktree: `/workspace/use-brian-native-computer`
- Branch: `feature/electron-native-computer-use`
- Planning base: `83e9723a` from `feature/electron-browser-cursor-file-transfers`, retaining the current Electron browser/cursor/file-transfer work. Before implementation this worktree was fast-forwarded to then-current `origin/develop` (`c555316a`), which already contains that browser work.
- Goal: let Brian operate the signed-in user's local applications through Electron, with a visible, interruptible experience comparable in intent to a desktop computer-use assistant. No dependency on Codex private APIs or claim of exact feature parity.

## 1. Recommended scope and defaults

1. Add an explicit **This computer** target, separate from **My Browser** and cloud browser sessions. Never silently broaden an existing browser grant to the user's desktop.
2. Start with an **attended macOS pilot**, then Windows, then capability-gated Linux. This order is a proposal, not a user-specified OS requirement.
3. Prefer native accessibility (AX) observations and semantic actions; use scoped screenshots and computer vision only when accessibility cannot ground the required target/action.
4. Reuse Brian's structured decision layer for **Jev fast decisions → configured LLM fallback**. Keep perception selection independent of model selection.
5. Require local, per-session authorization for selected applications/windows, visible control status, takeover, and a local emergency Stop. Stop remains latched until explicit local Resume.
6. Default disabled. Start with read-only inspection, then reversible actions, then separately approved external effects. No unattended local desktop operation in the first release.

**Not in v1:** shell execution, filesystem primitives disguised as desktop actions, arbitrary native method invocation, credential/password-manager extraction, secure/elevated desktops, OS security-setting changes, unattended purchases/sends/deletes, or automatic cloud substitution. Browser automation remains on its existing path unless the user explicitly chooses native desktop control.

## 2. Verified foundations and gaps

Paths in this section already exist at the planning base.

| Foundation | Reuse / boundary |
| --- | --- |
| `apps/app-desktop/src/embedded-browser.ts`, `browser-approvals.ts` | Consent, serialized dispatch, identity changes and control-epoch fencing are useful patterns. Browser approval and restart-on-navigation must **not** carry over. |
| `apps/app-desktop/src/main.ts`, `preload.cjs` | Existing `trustedTokenSender` and `Use Brian:browser-control` bridge provide the trusted main-frame pattern. Add a separate narrow native-control bridge. |
| `packages/browser-control/src/{protocol,relay-client,executor,snapshot}.ts` | Authenticated relay and compact ref patterns; current executor is CDP/tab-based. Chromium AX is not OS accessibility. |
| `apps/browser-relay/src/{protocol,relay}.ts`, `packages/api/src/sandbox/relay-transport.ts` | Reuse relay deployment/transport patterns, but native sessions need independent protocol validation, identity and routing. |
| `packages/core/src/sandbox/{types,tools,local-browser-provider,send-gate,effect-contract}.ts` | Tool policy, task context, cancellation and effect/approval patterns. Do not pretend a native desktop is a browser profile or E2B sandbox. |
| `packages/core/src/decisions/{types,hydra}.ts`, `adapters/typesafe.ts` | Provider-neutral choice/boolean/score decisions, uncertainty evidence, budgets and fallback policy. Suitable for selecting bounded actions from textual AX state. |
| `packages/api/src/{decision-runtime,workspace-decision-routing}.ts` | Workspace model selection, attribution, shadow/hybrid routing and exact evaluation-profile gates. Preserve these gates. |
| `packages/core/src/sandbox/providers/e2b/{jev-ultrafast-driver,index}.ts` | Existing Jev → Browser Use browser-agent precedent. Jev attaches to Chromium CDP with `screenshots=False`; it is **not** a reusable native desktop driver. |
| `packages/shared/src/model-registry.ts` | Jev's decision model is declared `vision: false`, `tools: false`. Do not pass desktop screenshots to it or infer grounding support from generic vision capability. |
| `packages/api/src/browser-agent-metering.ts` | Attribution patterns; new routing must record every attempted decision/LLM/vision call, including failures and fallback. |
| `packages/api/src/routes/computer.ts`, `apps/app-web/src/lib/api/computer.ts`, `components/computer/`, computer session page | Reuse task visibility and frame UI where useful. Current `local` / `cloud` contracts are browser-oriented and require an explicit native-target distinction. |

Electron's existing `desktopCapturer` recording flow is not a native automation backend or permission grant. Desktop packaging exists for macOS, Windows and Linux, but this does not establish native automation support on those platforms.

**Important existing differences:** browser Stop may retain approval and restart on a fresh navigation; native Stop must not. The E2B agent avoids whole-goal fallback after a recorded action, but a missing receipt does not prove no action occurred. Native execution must model that uncertainty explicitly.

## 3. Architecture and ownership

```text
Conversation / task owner
  → native-computer tools + workspace/assistant authorization
  → computer-use orchestrator
      → accessibility observation → bounded candidate actions
      → Jev decision / LLM planner (workspace policy + budgets)
      → vision grounder only if AX is inadequate and capture is authorized
      → deterministic policy + human approval + freshness checks
  → authenticated relay, native-computer protocol namespace
  → Electron main: local grant + device lease + serial command broker
  → private platform helper: permission/scope/epoch checks
      → native AX inspect / semantic action
      → selected-window capture / guarded OS input fallback
  ← execution receipt + fresh post-action observation
```

### Proposed module boundaries (new unless noted)

- `packages/computer-control/`: versioned wire schemas, normalized accessibility/geometry types, action/receipt contracts, validators and client plumbing. Keep browser-specific CDP contracts in `packages/browser-control`.
- `packages/core/src/computer-use/`: provider interface, observation policy, candidate builder, decision operation definitions, LLM/vision adapters, bounded task loop, tool registration and effect policy. `NativeComputerProvider` is separate from `BrowserProvider`/`SandboxProvider`.
- `packages/api/src/computer-use/`: device/session authorization, routing composition, relay transport, persisted audit metadata and usage attribution; proposed `routes/native-computer.ts` for scoped device/session lifecycle. Wire through existing `boot.ts` and tool composition rather than adding a second credential registry.
- `apps/browser-relay/` (existing service): a distinct `native-computer-v1` session/command namespace. The service may keep its name initially. Browser-profile routing and tokens must never authorize native commands.
- `apps/app-desktop/src/computer-control/`: main-process session controller, approvals, helper client, permission readiness, device-local lease, indicator/Stop/takeover UI coordination.
- `apps/app-desktop/native/computer-control/`: platform-specific, killable native helper. Prototype a signed Swift macOS helper first; decide Windows helper implementation after a UI Automation spike. Use framed, bounded messages over inherited private pipes, not a public listening socket.
- `apps/app-desktop/src/{main.ts,preload.cjs}` (existing): typed `computerControl` UI requests for status, permissions, session approval, Stop/Resume and disconnect. No renderer-accessible arbitrary input executor.
- `apps/app-web/src/lib/api/computer.ts` and `components/computer/` (existing): explicit native target/device/app identity and state, permission setup, activity, model/perception status, approval and takeover surfaces. Read `apps/app-web/AGENTS.md` before implementation there.

Prefer a discriminated `targetKind: browser | native-computer` contract while preserving legacy browser `backend: local | cloud`; exact type names are to be finalized in phase 0. A native target is always device-bound. Old clients must hide/refuse unsupported targets, never render one as a legacy local browser.

### Identity, protocol and session lifecycle

Authority is the intersection of workspace membership, assistant/tool grant, initiating user's rights, authenticated device session, local owner consent, OS permissions and action-specific approval. A model can request control but cannot grant it.

Bind every session to deployment, user, workspace, device, conversation/task, local grant ID and control epoch. Bind commands to that session plus command ID, deadline, observation ID and expected app/window. Use scoped, short-lived native tokens with a distinct audience and server-side revocation; do not repurpose browser pairing tokens. Persist minimal device/session/approval/audit metadata via migrations allocated against the current branch during implementation. Tokens remain out of renderers, logs and model context.

Advertise protocol version and actual capabilities (`axRead`, semantic actions, window capture, input, platform limitations). Capabilities report compatibility, not authority. Reject malformed, oversized, expired, wrong-audience, wrong-device and unsupported-version messages at all boundaries. Deploy API/relay compatibility before enabling desktop clients.

Proposed states:

```text
unavailable → permission_required → ready → awaiting_local_consent
  → active → awaiting_action_approval / paused_for_user / stopped / ended
```

Only one native control session may own a physical desktop at a time, across workspaces and Electron instances. Enforce the lease locally as well as server-side. A new task cannot steal it. User input pauses automation; takeover invalidates outstanding action proposals. Resume gets a new epoch and fresh observation. Stop, sign-out, account/deployment/workspace switch, lock/sleep, permission loss, helper death, lease expiry or relay loss revoke execution. Reconnection/relaunch may show readiness but never resume authority automatically.

## 4. Accessibility-first observation and execution

### Observation contract

A normalized observation contains:

- Session/epoch, observation ID, monotonic capture time and explicit completeness/truncation/error status.
- Application identity plus process-instance and window-instance identity (not a reusable PID/window number alone), foreground state, window bounds and display layout version.
- Opaque, short-lived AX refs: role, accessible name, allowed non-sensitive value, enabled/focused/selected state, supported semantic actions, bounds and parent/child relationships.
- Optional frame ID, window crop, pixel dimensions and verified transform between capture pixels and OS input coordinates; retain scale, origin and rotation/mixed-DPI information.

Inspect the selected app/window first. Bound traversal by time, depth, node count and output bytes; prioritize focused/visible interactive nodes. Use accessibility notifications and compact diffs/cached stable structure to reduce repeated traversal. A cached tree is an optimization, never sufficient authorization for an action.

### Selection ladder

1. **AX semantic target + action:** invoke/press, focus, set value, select, expand or scroll using supported native APIs. Prefer refs over coordinates.
2. **AX-grounded input:** if semantics are unavailable but a visible target has trustworthy bounds, allow scoped pointer/keyboard input after foreground, hit-target and geometry checks. AX bounds alone do not prove a target is unoccluded.
3. **Vision fallback:** when AX is absent, incomplete, stale despite refresh, or cannot distinguish the required control (e.g. canvas/custom UI), capture the authorized window/crop and ask the configured vision-capable grounder for a bounded target proposal. OCR can assist labels but is not independent proof of a safe target.
4. **Ask/pause:** missing capture permission, unsupported platform, ambiguous target, unknown sensitive content or inadequate grounding must not become a guessed click.

Fallback is per window/region/step, not a permanent switch for the task. Return to AX as soon as it becomes useful. Permission denial is not an excuse to bypass OS restrictions through vision; distinguish AX application coverage from permission loss. Never expand from a selected window to full-screen capture without new consent.

### Action contract and recovery

Use a small validated action union: inspect, focus approved window, invoke ref, set non-secret text, select, bounded scroll, click grounded target, and allowlisted key chord. Stage drag support later if the pilot does not need it. Text comes from task context/approved generation, never invented by a decision classifier. Clipboard access is off by default; prefer semantic text APIs and only add clipboard fallback with a separate privacy design.

Before **every** side effect, the helper checks permission, session/lease, epoch, deadline, target identity, foreground/visibility as appropriate, and ref/frame freshness. Window move, app switch, display change, user interaction or changed target invalidates the proposal. Approval dialogs themselves may change focus: after approval, reacquire/verify the target and require new approval if the approved effect/target changed.

Return `not_executed`, `executed`, or `execution_unknown`, with action ID and a postcondition observation when possible. Serialize actions; maintain a bounded local action journal/deduplication record. A transport retry may retrieve an existing receipt, not perform the action again. A crash between dispatch and receipt remains unknown. For an unknown non-idempotent outcome, inspect and reconcile or ask the user; do not replay the action or rerun the whole goal with another model.

Verify progress using fresh state rather than trusting a successful input call. Repeated no-progress, oscillation or an unverified postcondition consumes a bounded recovery budget and then pauses. Stop prevents future dispatch and drops queued work; it cannot undo an action already delivered to the OS. Helper cancellation/heartbeat checks and input-release cleanup must remain responsive even if an AX call blocks.

## 5. Jev / LLM routing: separate from perception

The current Jev Ultrafast Python browser agent is **not** the desktop loop. Reuse the TypeSafe structured decision adapter and Hydra through `DecisionRuntime`; keep model credentials and inference in the existing API-side runtime. The native helper has no model keys or network inference role.

Propose versioned decision operations such as `computer.next-action` and `computer.verify-progress`. Given a bounded AX observation, subgoal and policy-filtered candidate IDs, Jev can select an eligible next action or classify progress. Always include abstain/replan/ask-user options. Jev does not generate arbitrary text, coordinates or free-form executable commands.

| Situation | Route |
| --- | --- |
| Exact current ref and explicit task action already known | Deterministic validation/execution; no unnecessary classifier call. |
| Adequate AX and a bounded action choice with an approved evaluation profile | Jev fast path; accept only valid output satisfying calibrated operation policy. |
| Novel task decomposition, text generation, uncertain/inconsistent/invalid decision | Configured text/tool LLM, using AX evidence first. |
| AX cannot ground target; authorized capture available | Vision-capable LLM/grounder on scoped frame; validate proposal through the same executor/policy. |
| Missing Jev configuration, `llm_only`, or recoverable pre-action provider failure | Use configured LLM under existing routing/fallback policy and remaining budget. |
| Authorization/OS permission/policy failure or user Stop | Fail/pause; model fallback cannot bypass the denial. |
| Action may already have executed | Reobserve/reconcile; never blind replay through another model. |

Honor workspace `llm_only`, `shadow` and `hybrid` semantics. Initially run Jev in **shadow** against an LLM baseline with no additional side effects; enable authoritative fast decisions only after an approved exact operation/state/question/model evaluation profile exists. Existing observation routes are shadow-only; if progress verification needs authoritative Jev execution, define and evaluate that operation explicitly instead of quietly weakening the router.

The existing deployment `operator_hybrid` default can bypass exact-profile approval when a workspace has no routing setting. Native routing must independently enforce its exact approved-profile gate and reject that operator override for authoritative desktop decisions; fall back to shadow/LLM-only instead. Do not weaken or silently change unrelated decision operations.

Do not treat an LLM's self-reported confidence as calibrated probability. Calibrate Jev thresholds by task/app cohort, including abstention and wrong-action rates. Unsupported or truncated candidate sets trigger replanning, not forced selection. Safety approval never depends solely on model confidence.

Use the existing workspace/custom-model resolver and capability catalog. A fallback that lacks vision can still reason over AX but cannot receive a screenshot pretending to ground it. Validate actual native grounding through evaluations; add capability metadata only when supported. Preserve cancellation and a shared per-step/task deadline, action/token/cost budget and bounded retries across all lanes. No parallel planners may race to execute actions.

Record decision model, planner/grounder model, perception path, fallback reason, latency, usage/key source and outcome for every attempt. Meter each call once via the existing decision/provider accounting paths, including failed/partial/fallback calls; do not copy the current browser receipt path's omission of Browser Use fallback usage. Record billable incurred cost separately from budget reservations, and stop scheduling new calls when the remaining budget is exhausted.

## 6. Consent, security and privacy

- Add a separate explicit native-desktop capability (proposed key `native_computer`) and opt-in feature flag. Existing default-on `computer` capability and remembered browser consent must not grant it. Effective permissions are enforced API-side and device-side on every command.
- Local start dialog names the requester/task, deployment/workspace, selected apps/windows, allowed action classes, duration, AX data access, screenshot fallback and model/cloud disclosure. Observation-only and control permissions are separate. OS permission prompts follow user intent, not app startup.
- Keep a trusted local indicator visible while active, with current app, AX/vision mode, pause/takeover and Stop. Provide an emergency shortcut and tray/menu Stop independent of the task renderer/network. If required safety controls cannot be installed, fail closed.
- All action paths, including AX invoke, keyboard shortcuts, menus and vision clicks, pass the same effect gate. External sends/uploads/submits, deletion, purchase, installation and account/security changes require exact-effect approval or are denied in v1. Bind approval to session, target, payload/effect digest, expiry and observation context; changed effects invalidate it.
- Native UI semantics cannot reliably classify every external effect. Limit the pilot to supported app/action cohorts and ask or deny unknown effects; do not claim generic UI control is a sandbox. Agents must not use terminal/address-bar/script input to bypass unavailable tools or grants.
- Treat AX text, screen content, OCR and app titles as untrusted data, not agent instructions. The model cannot expand its app allowlist, enable permissions, approve its own request or dismiss Stop through desktop input. Exclude Brian's approval/control UI and OS permission/security surfaces from automation.
- Redact secure/password fields locally before any model/relay transmission. Block password-manager/credential surfaces and pause for manual entry. Masking screenshots is best-effort; if sensitive regions cannot be confidently excluded, do not upload the frame. Capture only necessary authorized regions, at bounded resolution/frequency, without full-desktop background streaming by default.
- Default raw frames, AX values and typed text to ephemeral processing, not audit logs. Persist metadata/receipts and sanitized diagnostics with existing retention/access controls. Debug evidence capture requires separate opt-in, retention and deletion controls. Explain that local execution does not mean local inference; apply existing workspace provider/data policies to both AX text and images.
- Local takeover is v1. Remote viewing/input is a later, separately authorized feature: existing computer polling/SSE/WS/takeover endpoints must reject native targets unless deliberately updated. Viewer permission never implies input or authority to resume a locally stopped session.

## 7. Platform strategy and packaging

| Platform | Implementation spike and acceptance requirements |
| --- | --- |
| macOS pilot | Native AX APIs; window capture via supported native capture APIs; semantic actions then guarded native input. Accessibility and Screen Recording permissions are distinct. Validate helper/app TCC attribution, signing, hardened runtime, notarization, upgrade behavior and permission revocation on packaged builds. No AppleScript/shell escape hatch. |
| Windows next | UI Automation patterns plus scoped capture and guarded input. Test DPI awareness, per-monitor scaling and integrity/UIPI limits. Elevated apps, UAC and secure desktop are unsupported; never request privilege escalation as fallback. Resolve helper packaging/signing before enabling. |
| Linux later | AT-SPI for accessible apps; capability-specific X11 path and portal/compositor-mediated capture/input on Wayland. Advertise the actual supported combination and refuse unsupported sessions; do not promise X11-equivalent unrestricted input on Wayland. |

All platforms need tests for multi-monitor/negative origins, display scaling/rotation, window movement/occlusion, keyboard layouts/IME, app restarts, lock/sleep, permission revocation and helper hangs/crashes. Do not enable an OS merely because the Electron package builds there.

## 8. Phased implementation and exit gates

Each phase is a reviewable implementation slice with tests and truthful documentation. P0 precedes contracts/helper work; model routing can proceed against the mock provider after P1, independently of native implementation.

| Phase | Deliverables | Exit gate |
| --- | --- | --- |
| **P0 — Scope, compatibility and ADR** | Confirm OS/task pilot matrix; reconcile branch base; finalize target/capability/token/session schemas, data disclosure, threat model, effect policy and native helper packaging approach. Spike real AX coverage and Jev candidate-selection feasibility. | Reviewed contracts/security boundaries, measurable evaluation dataset and no assumption of native Jev vision support. |
| **P1 — Protocol, lifecycle and fake provider** | New shared contracts; isolated relay namespace and scoped auth; device/session storage; core provider interface; fake desktop; Electron bridge, local grant, lease, Stop/Resume fencing and cancellation. Feature remains off. | End-to-end mock session works; forged/cross-scope commands and stale epochs are rejected; Stop cannot be undone by model/reconnect. |
| **P2 — macOS read-only vertical slice** | Signed helper, bounded AX traversal, opaque refs, selected-window inspector, permission readiness and local indicator/Stop. No input capability enabled. | Packaged app reads approved fixture windows only, handles denial/hangs/revocation, leaks no secure values and ends on identity/lock transitions. |
| **P3 — Guarded AX actions** | Semantic invoke/fill/select/scroll, action journal, preconditions/postconditions, input arbitration, takeover and effect approval; reversible fixture tasks first. | No stale/wrong-window/duplicate actions in safety fixtures; helper enforces revocation; unknown effects/outcomes pause. |
| **P4 — Jev/LLM task loop** | Versioned decision operations, LLM baseline, Jev shadow evaluation then gated hybrid, bounded recovery, model settings and complete usage tracing. | Same safety policy under both routes; Jev fast path improves measured latency/cost without unacceptable correctness loss on held-out tasks. |
| **P5 — Vision fallback** | Authorized scoped capture, crop transforms, grounded pointer/keyboard path, redaction, no-vision refusal and mixed AX/CV recovery. | Custom-drawn fixture works when AX is inadequate; no screenshot for AX-complete happy path; stale frames/occlusion/sensitive regions fail closed. |
| **P6 — Attended macOS pilot** | This computer UI, supported-app cohort, packaged E2E tests, signed distribution, rollout flags, diagnostics and user/KB docs. | Security review plus real-device acceptance; explicit enablement only for tested cohorts; kill switch verified. |
| **P7 — Expansion** | Windows then Linux adapters under the same contract, more app cohorts, optional separately permissioned remote viewing/takeover. | Each OS/cohort passes the same safety and accuracy suite before being advertised. Unattended mode needs a separate design/review. |

First useful milestone: **P2**, a permissioned AX inspector and reliable Stop on a real Mac. First action milestone: a harmless local fixture form completed via AX with typed LLM proposals, never a broad desktop agent enabled before policy is proven.

## 9. Verification and performance criteria

### Automated tests

- Shared contracts/property tests: bounded parsing, version negotiation, enum validation, geometry transforms, expired observations and reused process/window IDs.
- Helper/broker tests: mismatched scope, forged renderer/subframe, app allowlist, global lease, queue cancellation, Stop during blocked AX/action/approval, disconnect, stale epoch, duplicate command and unknown receipt outcomes.
- Decision tests: `llm_only`/shadow/hybrid, absent key, uncertainty/abstain, generation required, timeout/rate limit, invalid answer, auth/policy failure, no-vision fallback, total budget and cancellation. Shadow must never dispatch extra actions. An unset workspace under deployment `operator_hybrid` must remain shadow/LLM-only for native decisions until its exact profile is approved.
- Policy/privacy tests: no inherited browser consent; AX/key/vision all gated; task data prompt injection cannot authorize actions; approval payload changes; secure AX values and sentinel secrets never enter frames/logs/provider requests; no raw observations in audit storage.
- Orchestrator tests: progress verification, semantic-action failure → fresh observation, bounded CV fallback, no-progress stop, changed foreground/window/display, takeover race, no automatic replay of external effects, cost attribution on every failed/fallback route.
- Integration tests using real relay/API + fake helper, followed by signed native fixture apps on real desktop sessions. Mocks/Xvfb do not establish macOS TCC, Windows UIA/UIPI or Wayland permission behavior.
- Regression suites: existing `embedded-browser`, browser relay/transport, `decisions/hydra`, `workspace-decision-routing`, `decision-runtime`, browser metering and computer UI tests. Existing browser/extension/cloud sessions must remain unchanged.

### Evaluation fixture matrix

Use repeatable, non-production tasks: native form filling and selection; a menu/dialog workflow; an accessible app with duplicate labels; a custom-drawn/canvas control; mixed AX and visual content; window movement/occlusion mid-step; typing with a non-US layout/IME; a mock external send/delete requiring approval; and deliberate app-provided prompt injection. Split train/calibration/held-out app/task sets; include task variants, not just repeated identical screenshots.

Measure task success, correct-target action rate, incorrect/unauthorized actions, duplicate effects, abstention, fallback frequency/reason, AX vs CV coverage, p50/p95 observation/decision/dispatch/verification latency, total task duration, token/cost per task and user interventions. Compare **LLM-only AX-first**, **Jev hybrid AX-first**, and a **vision-only baseline** on the same fixtures/hardware/network/model versions.

Provisional pilot gates (calibrate in P0; not measured claims):

- Zero unauthorized, wrong-window, post-revocation newly dispatched or duplicated effects in the safety suite; any occurrence blocks release. Stop cannot retract already delivered input.
- At least 95% task completion and 99% correct-target action selection on the agreed benign pilot corpus, reported with sample counts/confidence intervals. Report human interventions and abstentions separately rather than hiding them as success.
- Hybrid task success no more than 1 percentage point below LLM-only on held-out fixtures, with at least 25% lower median decision latency on accepted Jev fast-path steps. Keep LLM-only if this is not demonstrated.
- Initial local targets: warm scoped AX observation p95 under 250 ms; Stop reaches the local execution gate p95 under 100 ms. These exclude network/model time and must be benchmarked on target hardware. A hung helper must not defeat Stop.
- AX-complete fixtures require no screenshot/model-image upload; no arbitrary fixed confidence threshold or speed target overrides safety.

## 10. Documentation, rollout and next decisions

Keep this plan in use-brian; add a stable runtime/security guide (proposed `docs/native-computer-use.md`) as behavior ships. Correct related browser/computer docs where target terminology changes without rewriting existing browser guarantees.

During implementation, create a separate brian-kb worktree/branch (suggested `/workspace/brian-kb-native-computer`, `docs/native-computer-use`) from its then-current agreed base. Implementation documentation now lives in `/workspace/brian-kb-native-computer` on `docs/native-computer-use`; it explicitly describes the disabled experimental scope, not a completed rollout. Update together:

- `engine/computer-use.md`: native vs browser targets, AX/CV path, model routing, effect governance and latched Stop.
- `features/app-desktop.md`: permissions, helper/platform support, onboarding and troubleshooting; reconcile existing stale platform descriptions with actual implementation.
- `features/builtin-primitives.md`, `platform/capability-grants.md`: explicit native grant versus device consent and OS permissions.
- `engine/preflight-confirmation.md`, `integrations/agent-capability-surface.md`: approval/discovery boundaries and inability to self-authorize control.
- Relevant indexes; honor KB frontmatter/source-of-truth pairing conventions and lint each repo independently. Do not label unshipped phases as available.

Roll out behind independent server and local feature gates: mock/internal → signed macOS read-only → supported-app attended AX actions → evaluated Jev hybrid → opt-in vision → broader cohorts/platforms. Maintain independent kill switches for all native execution, Jev authority and vision upload. Disabling a lane must not broaden another lane's permissions; rolling back native control revokes active leases while leaving browser control intact. Keep protocol/storage changes additive and make old clients fail closed.

**Confirm before P0 exits:** pilot OS/app list; accepted model/data-disclosure policy; supported action/effect classes; default session duration and evidence retention; signing/distribution ownership; and whether remote viewing is needed after the local pilot. None prevents drafting contracts, but these decisions gate enabling real desktop control.
