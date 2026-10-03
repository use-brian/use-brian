# Continue Mac computer-use implementation on the Mac

## User instruction

Deliver working Use Brian Mac computer use. Do not return progress-only reports, test counts, another packaging-only milestone, or a claim that an inspector completes the feature. The user selected **move this coding session to their Mac** so implementation and native verification can continue there. This document is a work transfer, not a release/availability announcement.

## Checkout and immediate action

Use the latest `feature/electron-native-computer-use` branch of `use-brian/use-brian`. Important pushed changes include:

- `1d13292f`: consented TextEdit/fixture semantic task path and independent inspector-only capability ceiling.
- `eb83ce67`: explicitly authorized safe-fixture-canvas capture; coordinate input remains disabled.
- `a7a60c00`: API `/run` pins its exact native session/grant instead of choosing another device in the conversation.
- `23b57954`: scoped, privacy-safe task-result notices after cleanup, including previously silent failures.
- `795870c5`: latest integration evidence before this transfer.

First confirm this session's shell is actually on Darwin, inspect the checkout/status, and read `docs/plans/electron-native-computer-use.md` completely. Then run the existing source compile/refusal check:

```sh
bash apps/app-desktop/native/computer-control/mac-preflight.sh
```

This deliberately compiles without release signing and performs negative refusal only. Fix any current SDK errors before packaging; do not count this as operational acceptance. Continue implementation rather than asking the user for another package-only rebuild.

## Implemented boundary

The signed helper retains the existing hardened parent/private-channel/bootstrap admission. Fresh capabilities stays permissionless/all-false. Explicit discovery initializes Broker and refreshes readiness. Local consent, exact app/window instances, API authorization, relay READY, independent Stop, helper death and device-lease fencing are preserved.

Current native effects are limited to consented TextEdit document assignment and supported fixture semantics. Read-only inspection has no activation or actions. Complete/fresh state, exact per-command approval and revalidation surround effects; uncertain outcomes are never replayed. Verified public AX leaves may omit `AXChildren`; unknown/error/container reads and disappearing declared membership still refuse effects.

Capture needs both control and capture consent, Screen Recording permission, complete public AX, exact safe-canvas identity, unchanged geometry/layout and no occlusion. It uses selected-window SCK filtering with checks around asynchronous work. No TextEdit/general-window screenshots. **Input is still false.** UI and core refuse screenshot-click fallback before capture when input is unavailable.

API direct runs use a service-owned WeakMap binding to the exact execution context/session/grant. Lost/replaced/cloned native contexts cannot fall back to a different session. Generic assistant calls require an unambiguous eligible grant. Task notices allowlist outcomes and exact session identity, retain cleanup barriers, block interfering automatic discovery, recheck account/workspace/generation, and cancel after Stop. No raw provider errors are displayed.

## Remaining work—not optional release claims

1. Implement and verify the minimal click emitter/ownership cleanup. `ClickGuardian.swift`, `ClickGuardianTests.swift` and `ClickGuardian-CONTRACT.md` are an **unintegrated policy prototype**, not an emitter or available capability. They are not included by `build.sh` and do not grant authority. Resolve the concrete active-tap late-proxy/timeout issue described in the contract, or choose a smaller sound public-API mechanism. Preserve physical input, survive worker/parent death, fence uncertain ownership and prevent replay. Do not blindly post up, expand into keyboard/drag support, or enable `input` from synthetic evidence.
2. Finish the existing screenshot-to-configured-image-LLM action path with that executor. Reuse `packages/core/src/computer-use` and API boot/model runtime; no separate planner, OCR/CV service or observer platform. Jev requires its existing exact approved profile; otherwise use the configured LLM lane. Keep strict actual-model/usage provenance and accounting.
3. Verify signed inspector, TextEdit/fixture tasks, actual provider calls, consent/permissions, Stop/takeover, modal/new-window refusal, privacy, capture geometry, termination/cleanup and no uncertain replay on the Mac. R1–R4 remain open where native evidence is missing. Finish onboarding/errors, supported limits, KB/docs and the compact acceptance matrix before claiming availability.

## Package and backend requirements

Reuse the user's existing Developer ID/keychain and `scripts/package-desktop.sh` workflow. Do not provision/export credentials, introduce ad-hoc release signing, disable timestamping or weaken trust. The operator already reported successful signed/notarized arm64 Electron 43.2 packaging, framework-substitution differential and private-helper admission on retry at **609cee57**. That package is older, probe-only code: it does not validate current semantic/capture changes. Initial admission failure remains unexplained; lifecycle scalars now distinguish timeout/spawn/exit stages without raw helper output. No retries or timeout increases were added.

The production updater previously replaced the WIP 0.0.12 application with production 0.0.40. Use the newly built app directly with `USEBRIAN_DISABLE_AUTO_UPDATE=1`; never assume the old build directory or recovered ZIP is current. See `docs/native-computer-r1-package-check.md`. Keep rollout/acceptance claims honest; do not silently flip acceptance flags to make tests appear accepted. Existing explicit inspector opt-in cannot authorize control.

A real task also needs the feature-branch API/relay, normal authenticated account/workspace/assistant/conversation/task, native capability/tool policy, migrated DB and supported accounting. Existing routes cannot be assumed deployed to the cloud. Use an authorized non-production deployment; no production deployment/configuration change is authorized by this transfer. Setup requirements are in `docs/native-computer-r1-inspector.md` and `packages/api/src/computer-use/INTEGRATION.md`. Normal cloud credentials do not automatically establish an account in an independent local DB. Do not bypass auth or create another executor to avoid backend requirements.

## Verification already performed (not native acceptance)

Latest parent runs: 1,046 desktop tests/53 files (three are local pending-CI checks), desktop/API/web typechecks; 170 API runtime/service tests and an overlapping 71 API/relay/revalidation selection including fake-OS E2E. Earlier current-native verification: 599 Node checks, 32 renderer/store tests, real Linux Foundation wire/dispatcher/approval/semantic/privacy/capture checks and generated envelope validation. Prototype ownership tests passed unoptimized and `-O`, including 45 revocation boundaries and exhaustive short traces. These are not Mac effects, input cleanup or live-provider acceptance. All evidence and earlier failures remain in `docs/native-computer-acceptance.md`.

A credential-free Mac SDK GitHub workflow was prepared but **its push was rejected because the existing token lacks workflow scope**. No workflow ran. It is retained only in the Linux checkout/local branch `wip/native-mac-sdk-ci`; do not waste time expanding credentials to reproduce that now that work is moving to Mac. The feature commits above were pushed separately without it. No production workflow or signing credentials were changed.

## Delivery constraints

Work only in the feature scope; browser behavior stays independent. Windows/Linux, broad benchmarks, generalized attestation/telemetry and hosted-accounting expansion are deferred. No production deployment or release publication without authorization. WIP feature commits/pushes are authorized; no force push or hook bypass. KB work is separate (`brian-kb-native-computer` in the previous workspace). Do not mark the feature complete or available until the intended signed package and real workflow/provider configuration are verified.
