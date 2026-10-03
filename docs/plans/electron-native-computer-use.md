# macOS computer use — release plan

**Status: the coordinate mechanism was retired after a native deadline counterexample; R3 needs a safe replacement.** Both production and experimental mouse emitters have been removed. Production input is unconditionally false, independent of profiles; only null remains runnable in the isolated harness. AX semantics and scoped capture remain implemented behind their existing consent/rollout gates. This is safety remediation, not working coordinate input or completed release acceptance.

This is the active release scope, revised at the user's direction. It supersedes the [previous broad plan](archive/electron-native-computer-use-pre-release-rescope.md). The archive and [acceptance ledger](../native-computer-acceptance.md) preserve prior work and failures; their larger research/evaluation programmes are **not additional release gates**.

**Signing is available.** The user has a working certificate and Electron release workflow. Do not spend time on certificate provisioning, request/export credentials, or treat a missing identity in this Linux workspace as a project blocker. Use the existing workflow for the final Mac package checks; do not replace it with ad-hoc production signing.

## 1. Release outcome

Ship an opt-in, attended **This computer** feature in the macOS Electron app:

1. The user selects a supported local window and gives explicit local consent for a task.
2. Brian reads accessibility information and uses semantic actions where possible.
3. The existing task loop uses Jev for eligible structured decisions and the configured LLM for planning/generation/fallback. Models do not grant authority.
4. If textual AX information cannot ground a step, investigate using an authorized selected-window screenshot with the configured image-capable LLM to identify a target, then resolve that proposal to a supported, window-bound AX action through the existing executor. This replacement is not implemented or accepted yet. A visual proposal must never fall back to the retired global mouse emitter.
5. The user sees activity and can immediately Stop or take over. Uncertain effects are never automatically replayed.

The immediate delivery target is the existing TextEdit document workflow and native fixture form, selection and menu workflows. The original canvas screenshot-to-action requirement remains **open and unsupported**, not silently completed or removed: an arbitrary canvas with no usable AX action is not covered by screenshot-guided AX. Do not retrofit a test-only click backdoor into the fixture and count it as general native control. If a safe canvas mechanism cannot be established, request an explicit scope decision before calling a narrower AX release complete. The fixture is acceptance tooling, not a claim of arbitrary-app support. Keep other applications/action classes unavailable until deliberately added and tested. Start acceptance on the operator's Mac; advertise only verified OS/architecture combinations. Windows/Linux work is deferred.

An operational AX inspector and AX task are useful intermediate milestones, **not completion of the screenshot-LLM fallback or the whole release**.

## 2. Vision fallback: screenshot to the existing LLM

The user explicitly wants screenshot input to the LLM, **not a new computer-vision subsystem**.

```text
existing task loop
  → fresh AX observation
  → usable semantic target? use AX
  → otherwise, approved selected-window screenshot
  → existing configured image-capable LLM
  → schema-validated visual target proposal
  → trusted native resolution to a supported AX element/action in that window
  → exact local approval and fresh native revalidation
  → existing semantic executor (never global mouse injection)
  → fresh observation; continue or pause
```

- Reuse the existing provider/model resolver, multimodal adapter, metering, cancellation and task budgets. No second planner or executor.
- Return only supported structured proposals. A model point is a hint for native target resolution, never authority to inject a click. The LLM cannot execute code, invent permission/grant fields or declare its target safe.
- Require a uniquely resolved, permitted AX action on a public element belonging to the approved window. Revalidate element identity/membership, frame/geometry, scope and action after approval. Missing, ambiguous, sensitive, unsupported or changed targets pause; no raw-click fallback.
- AX targeting avoids a synthetic mouse down/up pair, but is not automatically deadline-atomic or free of dispatch races. Document and review its actual cancellation/expiry boundary before declaring it safe. A request timeout is not proof that a queued action was cancelled.
- Preserve frame identity, selected-window bounds and the pixel-to-window transform. Reject out-of-bounds, stale, ambiguous or wrong-window proposals; do not guess or silently repair coordinates.
- Use AX again when it becomes useful. Verify progress with fresh evidence, using AX where available or another authorized screenshot when needed.
- No screenshot on the AX-complete happy path. No full-desktop streaming. Secure or unclassifiable sensitive content must cause pause/refusal rather than upload.
- Missing capture consent, Screen Recording permission or image support means pause/ask the user, not provider substitution or a broader capture.
- Reuse the current native vision adapter where it already does this. Change only what is needed to integrate this flow and its real-Mac tests.

**Not required:** OCR engines, object detectors, segmentation, template matching, local CV models, a custom grounding service, a new vision capability platform, or a separate vision-only benchmark agent. Geometry/freshness checks are executor safety checks, not a CV pipeline.

## 3. Reuse what exists; stop expanding infrastructure

Keep the implemented native protocol, separate relay namespace, API authorization, Electron controller, Swift helper, single task loop, Jev/LLM adapters, strict provider provenance and usage accounting. Fix integration defects; do not redesign those systems for this release.

- Browser grants/tokens/control remain separate from native authority.
- Use the currently supported single/sticky API and single-relay deployment; no distributed-control redesign.
- Keep durable usage/receipt safeguards already implemented. Do not add a new billing platform, hosted-accounting backend or reconciliation service; unsupported configurations remain unavailable.
- Use existing bounded diagnostics and a small release checklist. Do not build a cross-process observability/publication platform to collect release evidence.
- Retain existing experimental files without expanding or deleting them merely to tidy scope. No unrelated refactor or Windows/Linux cleanup.

## 4. Safety requirements that still block unsafe release

Scope reduction is not permission to disable safeguards:

- **Trusted launch:** private inherited helper channel, correct running parent/helper identity, existing signed Electron packaging and hardened bootstrap. The supported-package admission fix and consented broker path are implemented; earlier signed admission passed, but current signed workflows still need verification. Static on-disk signatures alone must not be relabelled as proof of already-loaded code.
- **Bounded bootstrap work:** retain the implemented release-package admission checks and verify their actual behavior. No general-purpose Mach-O/DER validation platform, arbitrary code-inventory service or whole-process memory attestation project.
- **Consent and scope:** local session consent, exact app/window identity, native-only authorization, fresh epoch on Resume, and action-specific approval where required. Never automate Brian's consent UI, OS security prompts or credential surfaces.
- **Stop:** independent local shortcut/tray/control UI, immediate dispatch revocation, no dependence on network/model/accounting/observers. Lock/sleep, permission loss, disconnect and helper failure revoke authority.
- **Freshness and effects:** revalidate after approval/focus changes; changed windows/modals pause for fresh local authorization. Unknown effects/outcomes stop or ask the user, never retry an uncertain action.
- **Input ownership:** the failed one-click mechanism is retired, not awaiting profile approval. Do not restore down-post/returned-up emission, insert another check/timer as an atomicity claim, or extend deadlines to pass its experiment. Existing uncertain ownership remains fenced; never synthesize a cleanup up or release a lease on process death alone. Screenshot-guided AX must use a semantic action rather than synthesize a mouse pair. Any future raw-input mechanism needs a separate defensible design and native evidence. General keyboard injection, drag and gesture support are not release requirements.
- **Privacy:** redact secure AX data before transmission; scoped, consented images only; no raw AX/text/images/credentials in routine logs.
- **One loop, honest capabilities:** no alternate executor, silent permission expansion or false success. Unsupported combinations fail closed. Keep existing execution/Stop/watchdog budgets; do not increase them to hide failures.

The current helper supports consented inspector/semantic/capture paths, not the historical probe-only boundary. Production `input=false` and coordinate refusal are unconditional; even adding a metadata profile cannot enable the retired mechanism. The isolated harness permits only `null`; historical emitting cases are offline evidence. This documentation change enables nothing.

## 5. Remaining tasks, in execution order

**Engineering owns implementation and integration.** The Mac operator supplies native execution/physical evidence, not unfinished code. The next meaningful Mac session should exercise a task inside Use Brian, not resume the retired standalone input experiments. Verification may expose further engineering defects; do not claim that only verification remains while a replacement is unwritten.

### A. Preserve the safety fix — completed source, ongoing invariant

- [x] Remove both production and experimental down-post/returned-up emitters; refuse coordinate dispatch independently of profiles.
- [x] Reject emitting harness cases at JS, Swift and C boundaries; retain historical classifier data and the operator's counterexample.
- [x] Refuse clicks before consuming AX availability or transferring monitoring; preserve existing uncertainty fences and consent/privacy controls.
- [x] Verify retirement with portable tests and source review. Source pushed through `8f62ec43`; no functional coordinate replacement is claimed.

Do not launch pre-retirement experiment binaries. Rebuilding replaces a local artifact; pulling source alone does not. Existing native compile/null/pair observations remain revision-scoped evidence, not acceptance of the retired design.

### B. Establish the actual application/backend path — audited; live/policy blockers remain (R1/R2)

Follow-up: source audit/regressions cover the real controller → HTTP/WS → `/run` → concrete configured-model runtime using fake OS/provider/database dependencies. Fixed bidirectional semantic scroll and preserved its direction in decision state (next-action state v4; progress stays v3), stale UI discovery after Stop/cleanup, trailing-slash tab selection and AX-only onboarding. Added eligible owned/current task discovery with existing clearance/compartment read controls and RLS, context-bound selection and explicit load-error retry; no broad task-title disclosure or dispatch authorization shortcut. No authorized deployment/session/context inputs were supplied, so readiness and live inference were not run. Packaged control requires a pilot-accepted flag that the current instruction prohibits enabling; inspector mode cannot run tasks. This admission-policy conflict needs explicit resolution, not a verification bypass. See the [consolidated handoff](../native-computer-mac-handoff.md).

- [ ] Audit the packaged **This computer** flow from normal login and workspace/assistant/conversation/task selection through native consent, session exchange, relay READY, `/run`, model invocation, result display and teardown. Fix remaining blockers in that path without introducing a second executor or verification authorization bypass.
- [ ] Confirm an existing authorized non-production API/relay destination and normal account/context. Run the implemented [readiness checker](../native-computer-backend-setup.md) against the matching revision: migrations 620/621, auth/scope/tool policy, supported accounting, route configuration and reachable relay. Record actual results, not assumed readiness. This can run off-Mac; unavailable environment inputs require user coordination, not delegation of coding or secret disclosure in chat.
- [ ] Verify the actual configured provider's native-strict text request, provenance/usage and settlement using the existing authorized environment. No provider substitution, fabricated login/grant, unapproved deployment or automatic budget increase. Readiness alone does not exercise inference.
- [ ] Ensure the app exposes only supported AX actions with coordinate input off; missing permissions/configuration and unsupported goals must give bounded, actionable errors. Preserve independent Stop, pending-cleanup UI and account/workspace isolation.
- [x] Extend focused integration regressions for TextEdit-style assignment and fixture invoke/select/scroll, exact approval, fresh whole-goal completion, denial and uncertain receipt handling. Keep browser behavior unchanged. Portable fake-OS/provider evidence only; native menu behavior still needs verification.

**Exit:** source and portable integration checks are ready for a real signed-app AX task, with explicit deployment prerequisites and no known setup/code gap handed to the operator.

### C. Design and implement screenshot-guided AX — blocked at feasibility gate (R3)

[Source/interface investigation](../native-computer-visual-ax-design.md) establishes an empty capture/action intersection: safe-canvas capture requires all actions empty. Existing AX calls also do not provide atomic deadline/revocation dispatch; the same limitation needs R2 safety disposition. A separately reviewed narrow public-controls capture cohort and frame-bound semantic contract are proposed, not implemented or approved. No broader capture, new executor, emitter, gate override or deadline change is justified. Remaining implementation checkboxes deliberately stay open; the operator is not tasked with designing this missing mechanism.

- [ ] Determine whether an image proposal can be resolved to a unique public AX element with a supported semantic action in the approved window. Inspect actual interfaces and define the evidence needed; do not assume a point hit-test, a role/name match or AX membership alone establishes authority.
- [ ] Resolve the capture/action intersection explicitly: current capture is restricted to the public safe canvas, which may expose no suitable AX action. If no eligible surface supports both, record the blocker and propose a separately reviewed, narrowly scoped capture/action extension—not automatic broader capture or a fixture-only execution backdoor.
- [ ] Specify native target binding, frame/geometry lifetime, exact approval and post-approval revalidation. Document dispatch/expiry/cancellation limits and any remaining check-to-OS-call race. If the required safety contract cannot be met, stop at this design gate rather than disguising it with another check or weaker deadline.
- [ ] Define an honest capability/action contract for visual semantic targeting, separate from raw `input`. Update helper/protocol, controller, API/core and UI consistently; do not set `input:true` merely to pass the old screenshot-click gate. Keep inspector grants read-only and capture separately consented.
- [ ] Reuse approved capture, the configured image-capable model, immutable goal decomposition, frame binding, native resolution and the existing semantic executor. No new planner, OCR service, global mouse path or test-only fixture backdoor.
- [ ] Add regressions for absent/ambiguous AX targets, unsupported actions, privacy, stale frames/refs, movement/scale/occlusion, window/app replacement, permission/consent denial, Stop, provider errors and uncertain outcomes. Preserve one-attempt/accounting behavior and independent completion checks.
- [ ] Review existing image approval and conservative reservation bounds with the authorized deployment owner. Defaults cannot fund one conservative image attempt; do not raise budgets or approve uploads automatically to make a test run.

**Exit:** an implementable, reviewed window-bound semantic path and its integration tests exist. If no supported AX action exists, the result is an explicit unsupported/pause, not a synthesized click. This does not establish arbitrary canvas support.

### D. Deliver the first real task inside Use Brian — Mac evidence (R1/R2)

Complete feasible implementation/tooling in B/C before requesting this Mac session. If C is infeasible, record that engineering blocker explicitly; do not hand unresolved implementation to the operator. The first actual task remains AX-only, followed by visual verification only when ready.

- [ ] Build the current package with the existing signing/notarization workflow for an actual workflow run. Reuse existing prerequisites; no packaging-only milestone or repetition of unchanged probes. Prevent production auto-update from replacing the WIP app during verification.
- [ ] Verify current-package helper admission, permission attribution, selected-window discovery and redacted inspector result; preserve and investigate any recurrence of the earlier first-attempt admission failure.
- [ ] Through the app and real configured model, complete an approved TextEdit document task and fixture form/selection/menu tasks. Confirm the actual UI result with fresh whole-goal evidence and usage records—not an `executed` receipt alone. The AX-complete path must upload no screenshot.
- [ ] Exercise independent Stop during model wait/approval/dispatch, physical takeover, wrong/stale targets, modal/new-window changes, duplicate commands, lost receipts and cleanup uncertainty. Keep gated paths unavailable unless their normal authorization requirements are satisfied; never manufacture acceptance by toggling flags.
- [ ] Fix failures in engineering, then rerun only affected workflows. Record package/OS/provider identity, outcomes and interventions.

**Exit:** reproducible attended AX tasks work inside Use Brian with real native/provider evidence. This closes neither screenshot fallback nor the original canvas requirement.

### E. Verify visual semantics and resolve original canvas scope (R3)

- [ ] Inside the signed app, demonstrate a genuinely image-needed task on a currently privacy-approved capture surface with a real supported AX action, using the actual configured image-capable model. Do not broaden capture eligibility just to find a passing example.
- [ ] Confirm image-to-target binding, exact local approval, native semantic action, fresh completion and actual usage settlement; exercise negative cases from C on the Mac. No raw mouse pair should be created.
- [ ] Exercise Jev only with its existing exact approved operation/profile and probability policy; otherwise use the configured LLM or abstain and disclose the unavailable lane.
- [ ] Keep the original no-AX canvas case explicitly unsupported until a different defensible mechanism exists. Either implement and verify such a mechanism, or obtain the user's explicit approval to narrow the release to AX-backed workflows. Screenshot-guided AX alone must not be presented as completing the original canvas requirement.

**Exit:** verified visual-semantic capability with accurately stated limits, plus an explicit disposition of the still-open canvas requirement.

### F. Product and release acceptance (R4)

- [ ] Finish onboarding and supported-target/action descriptions; clearly distinguish Accessibility control, capture permission and unsupported coordinate input. Provide actionable refusal/Stop/cleanup feedback without leaking prior task content.
- [ ] Run the compact matrix below against the actual package/provider configuration; verify rollback/default-off behavior and existing browser functionality.
- [ ] Update the evidence ledger, runtime/handoff instructions and KB to the implemented support boundary. Preserve counterexamples and unresolved limitations.
- [ ] Only after the agreed release scope and safety gates pass, prepare the release PR/rollout for review. A narrower release requires the scope decision in E; tests or disabled code do not substitute for it.

## 6. Compact release acceptance

Use the existing fixture and TextEdit, the operator's Mac and the actual configured provider. Record app/package revision, OS/architecture, model/profile, attempts, outcome and failures. Do not save secrets or raw desktop content as routine evidence.

| Area | Minimum evidence |
| --- | --- |
| User flows | Permissioned inspector; TextEdit document task; fixture form/selection/menu; one modal/new-window pause and reauthorization; a genuinely image-needed screenshot-to-AX task. The original no-AX canvas task remains a separate unmet requirement until implemented/verified or explicitly removed by the user. Repeat workflows and report every failure/intervention rather than cherry-pick a pass. |
| Authority | Wrong parent/private channel, wrong account/task/window, stale epoch, duplicate command, revoked grant and approval-target changes are denied. Browser authority never authorizes native control. |
| Stop and ownership | Stop during observation, model wait, approval and action dispatch; physical takeover; helper/parent termination; blocked AX; permission loss, lock/sleep and relay loss. Confirm safe input cleanup/fencing and no uncertain replay. |
| Privacy and capture | Secure fields/sentinel secrets excluded; AX path sends no images; selected-window-only capture; movement, resize, display scale and occlusion invalidate stale proposals. |
| Models and usage | Actual configured LLM image input; no-image refusal; Jev approved-profile path and abstention/fallback; one-attempt/error handling; correct usage accounting without treating infrastructure failure as permission to retry. |
| Package and regression | Existing signed/notarized distribution workflow; helper launch/permissions on the real package; targeted desktop/API/core/relay tests; existing browser functionality unchanged; disable native control without affecting browser control. |

Zero unauthorized, wrong-window, newly dispatched post-revocation or duplicated effects in this matrix. Any such result blocks release. Retain the local targets of scoped warm AX p95 <250 ms and Stop-to-local-gate p95 <100 ms, with sample counts and hardware; a hung helper must not defeat Stop. Do not claim OS delivery/UI drain from an RPC receipt. Use the fixture's observable outcome and small command-linked evidence where needed, not a new generalized oracle service.

Exact Jev profiles and structured output validation still apply. If a Jev profile is not accepted, stay on configured LLM routing rather than weakening that gate; disclose the unavailable lane. Do not claim hybrid performance improvement without measurements. No fabricated/provider-mocked run counts as live acceptance.

## 7. Explicitly deferred — not macOS release blockers

- Windows/Linux adapters, ACL/logind/Wayland acceptance and Linux latency work.
- Remote viewing/input, unattended operation, arbitrary applications, shell/scripts, clipboard, credential handling, drag/gestures and broad keyboard automation.
- Generalized attestation/inventory tooling and support for extra binary/signature profiles beyond the supported Electron release package; **not** the concrete admission fix in R1.
- The 15-family disjoint benchmark programme, a separate vision-only baseline, statistical Jev-vs-LLM cost/latency superiority claims and broad model comparisons. Retain practical workflow checks and exact Jev routing approval.
- Distributed observer transport/authentication, passive-evaluation publication infrastructure, universal UI-thread-drain instrumentation and new telemetry dashboards. Retain local safety/fencing and honest outcome reporting.
- Hosted accounting expansion, automatic reconciliation workers and a new billing/credential platform. Retain existing accounting correctness and deny unsupported deployments.
- Certificate acquisition, keychain/provisioning research and another signing pipeline. The user's established Electron signing workflow is available.

These are deferred scope, not silently marked complete. Historical test failures remain in the ledger. If release implementation truly needs a deferred item, identify the concrete blocker and choose the smallest change before reopening that workstream.

## 8. Completion and publication

The release is complete when R1–R4 are demonstrated on the intended package, the in-scope checklist has no outstanding required failures, and user-facing support/limits are accurate. Compile-only preflights, test counts and source modules are supporting evidence—not completion percentages or operational acceptance.

Previously authorized feature-branch WIP commits/pushes may preserve implementation and fixes before acceptance; they are not release approval. Open the release PR and seek rollout approval only after verification of the agreed scope. Keep native rollout opt-in and browser behavior unchanged. Do not ship or advertise unsupported or deferred capabilities.

Tracking: `feature/electron-native-computer-use` in `/workspace/use-brian-native-computer`; related KB work remains in `/workspace/brian-kb-native-computer`. Implementation evidence belongs in the [acceptance ledger](../native-computer-acceptance.md), runtime behavior in the [runtime guide](../native-computer-use.md). The [evaluation document](../native-computer-evaluation.md) describes optional deferred tooling, not an additional release programme.
