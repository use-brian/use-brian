# macOS computer use — release plan

**Status: the coordinate mechanism was retired after a native deadline counterexample; R3 needs a safe replacement.** Both production and experimental mouse emitters have been removed. Production input is unconditionally false, independent of profiles; only null remains runnable in the isolated harness. AX semantics and scoped capture remain implemented behind their existing consent/rollout gates. This is safety remediation, not working coordinate input or completed release acceptance.

This is the active release scope, revised at the user's direction. It supersedes the [previous broad plan](archive/electron-native-computer-use-pre-release-rescope.md). The archive and [acceptance ledger](../native-computer-acceptance.md) preserve prior work and failures; their larger research/evaluation programmes are **not additional release gates**.

**Signing is available.** The user has a working certificate and Electron release workflow. Do not spend time on certificate provisioning, request/export credentials, or treat a missing identity in this Linux workspace as a project blocker. Use the existing workflow for the final Mac package checks; do not replace it with ad-hoc production signing.

## 1. Release outcome

Ship an opt-in, attended **This computer** feature in the macOS Electron app:

1. The user selects a supported local window and gives explicit local consent for a task.
2. Brian reads accessibility information and uses semantic actions where possible.
3. The existing task loop uses Jev for eligible structured decisions and the configured LLM for planning/generation/fallback. Models do not grant authority.
4. If AX cannot ground a step, and capture is authorized, send a screenshot of the selected window to the configured image-capable LLM. Validate its structured next action through the same executor.
5. The user sees activity and can immediately Stop or take over. Uncertain effects are never automatically replayed.

Initial supported scope is the existing TextEdit document workflow and the native fixture's form, selection, menu and canvas workflows. The fixture is acceptance tooling, not a claim of arbitrary-app support. Keep other applications/action classes unavailable until deliberately added and tested. Start acceptance on the operator's Mac; advertise only verified OS/architecture combinations. Windows/Linux work is deferred.

An operational AX inspector and AX task are useful intermediate milestones, **not completion of the screenshot-LLM fallback or the whole release**.

## 2. Vision fallback: screenshot to the existing LLM

The user explicitly wants screenshot input to the LLM, **not a new computer-vision subsystem**.

```text
existing task loop
  → fresh AX observation
  → usable semantic target? use AX
  → otherwise, approved selected-window screenshot
  → existing configured image-capable LLM
  → schema-validated action proposal
  → existing local safety/approval/execution path
  → fresh observation; continue or pause
```

- Reuse the existing provider/model resolver, multimodal adapter, metering, cancellation and task budgets. No second planner or executor.
- Return only supported structured actions. The LLM may propose a point in the supplied image; it cannot execute code or invent permission/grant fields.
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
- **Input ownership:** the minimal one-click guardian candidate is implemented, not accepted. Before enabling it, verify owned press/release cleanup across takeover, overlap, partial delivery and helper/parent failure. Do not release physical user input or relinquish the lease while worker/input ownership is uncertain. General keyboard injection, drag and gesture support are not release requirements.
- **Privacy:** redact secure AX data before transmission; scoped, consented images only; no raw AX/text/images/credentials in routine logs.
- **One loop, honest capabilities:** no alternate executor, silent permission expansion or false success. Unsupported combinations fail closed. Keep existing execution/Stop/watchdog budgets; do not increase them to hide failures.

The current helper supports consented inspector/semantic/capture paths, not the historical probe-only boundary. Production `input=false` remains enforced by the empty accepted-platform registry. The isolated mechanism experiment cannot promote it. This documentation change enables nothing.

## 5. Ordered delivery milestones

Work in this order. Each milestone must produce a useful integrated result, not another standalone research probe.

The implementation column records the required source scope, now present for verification; it is not a Mac coding checklist. Native evidence can still expose defects requiring engineering correction.

| Milestone | Required source scope | Evidence to close it |
| --- | --- | --- |
| **R1 — Packaged Mac inspector** | Close the supported-package admission gap; connect the existing helper/broker/discovery/consent path; finish permission readiness and selected-window AX inspection. Reuse the user's signing workflow. | On the packaged Mac app: select TextEdit/fixture, consent, see a bounded redacted snapshot, Stop, and refuse wrong-parent/channel/scope, denied permissions and lost identity. |
| **R2 — Working AX task** | Run the existing API/relay/task loop against real macOS semantic actions. Complete TextEdit editing and fixture form/selection tasks with configured LLM planning, fresh completion checks and existing usage accounting. | Real UI outcomes, no unintended images, cancellation/takeover, stale refs, duplicate commands, lost receipts and modal/new-window refusal. No helper-only or fake-provider result counts as an end-to-end task. |
| **R3 — Jev routing and screenshot fallback** | Exercise existing Jev decisions/fallback; keep exact approved-profile requirements. Integrate screenshot input to the configured image-capable LLM and minimal safe click execution in the same loop. | Approved Jev route and configured-LLM fallback behave correctly; the real canvas fixture completes via an actual screenshot/LLM call. Capture denial, no-image model, stale frame, bad coordinates and Stop refuse safely. |
| **R4 — Release candidate** | Finish UI errors/onboarding, supported-target descriptions and rollback; package through the existing Electron release process; run the compact acceptance matrix below; update user/KB docs. | Recorded real-Mac results for the actual package/provider configuration, no open safety failure, reviewed default-off/opt-in rollout and regression results. Then cohesive commits, push and PR. |

**Fresh next work is verification, not implementation transfer.** The operator already passed production source SDK preflight and corrected guardian 16 XCTest + public-header C syscall-fake tests at `2fe2e0d2`; do not repeat unchanged checks or request packaging-only tests. Source now pins images to the configured task route (global vision setting is approval only), decomposes before capture, monotonically reduces post-effect capabilities and publishes relay status before receipts. A real controller/relay/API/concrete-runtime regression verifies synthetic click/readback completion and unchanged-counter refusal; fake OS/provider/DB results do not close R3.

Use [the handoff](../native-computer-mac-handoff.md) for exact fresh commands. First separate deployment-specific work: authenticated SELECT-only readiness with no-touch auth and protected token-file/stdin CLI, existing context IDs, supported accounting/migrations and existing non-production API/relay/provider configuration. [Backend setup](../native-computer-backend-setup.md) can run off-Mac; no deployment or credentials are provisioned or claimed. Readiness is not inference or acceptance, and default budgets cannot fund one conservative image attempt.

The subsequent source-owned platform selector matches exact OS version/build/native architecture/mechanism revision and rejects malformed, duplicate or translated profiles. Its immutable registry remains empty; four portable matcher tests bring the current Mac runner to 20 non-emitting cases. One fresh SDK check covers this new source, not repeated unchanged evidence.

Mac-only work: compile the new isolated `tests/native-acceptance` target, then inspect individual null/tap/death/physical-overlap cases with fresh GUI consent in a **disposable isolated login**, never the working desktop. Input can escape the fixture; a clean result is narrow observation with `productionAcceptance: false`, not ownership/drain proof or registry promotion. Separately build the current signed app through the existing workflow for meaningful inspector/backend execution and remaining R1–R4 checks. Keep unavailable production gates blocked; do not bypass them to obtain a result. Engineering owns any source correction here; the operator is not asked to finish code/tooling on Mac.

## 6. Compact release acceptance

Use the existing fixture and TextEdit, the operator's Mac and the actual configured provider. Record app/package revision, OS/architecture, model/profile, attempts, outcome and failures. Do not save secrets or raw desktop content as routine evidence.

| Area | Minimum evidence |
| --- | --- |
| User flows | Permissioned inspector; TextEdit document task; fixture form/selection; one modal/new-window pause and reauthorization; canvas screenshot-to-LLM task. Repeat workflows and report every failure/intervention rather than cherry-pick a pass. |
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

Commit/push/open the PR only after that verification, as already authorized. Keep native rollout opt-in and browser behavior unchanged. Do not ship or advertise deferred capabilities.

Tracking: `feature/electron-native-computer-use` in `/workspace/use-brian-native-computer`; related KB work remains in `/workspace/brian-kb-native-computer`. Implementation evidence belongs in the [acceptance ledger](../native-computer-acceptance.md), runtime behavior in the [runtime guide](../native-computer-use.md). The [evaluation document](../native-computer-evaluation.md) describes optional deferred tooling, not an additional release programme.
