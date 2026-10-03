# Experimental Mac R1 inspector

Inspector checkpoint, **not signed Mac acceptance or feature completion**. Current source also implements R2 semantic actions behind the separate control rollout gate; the inspector-only opt-in cannot enable them. Coordinate input and screenshot-click fallback remain unavailable. The helper's safe-canvas capture primitive requires a separate control-and-capture grant and cannot be used by the inspector. No production deployment/configuration change is authorized by this document.

## Boundary

- Fresh helper readiness remains metadata-only, with no AX/Screen Recording queries or permission prompts. Bootstrap validation, signing policy and request timeout are unchanged. Failures now log only a fixed main-process stage and bounded timeout/spawn/exit scalars; no helper stderr, exception text, paths, credentials or window content. The operator's earlier first-attempt failure remains unexplained; there is no automatic retry.
- Explicit discovery lazily constructs the AX backend. Capabilities are refreshed afterward. Accessibility permission and an enabled takeover tap are both required. After explicit discovery the helper may report Screen Recording status using non-prompting preflight, but inspection does not need that permission or acquire capture authority.
- A locally approved grant must have `allowControl=false` and `allowCapture=false`. Only a single selected TextEdit/fixture window can be inspected. Start does not activate, raise or edit it. Native code refuses effects for a read-only grant, independently of renderer choices. The inspector-only main/controller capability ceiling also refuses control/capture grants even when the helper supports semantics. Inspector snapshot actions are empty.
- Closed role/subrole redaction, bounded traversal, fresh process/window membership, sheet refusal, independent Stop, physical takeover and helper-death lease fencing remain. Scope notifications terminate the helper even during Start, before grant/watchdog activation; a short-lived sheet must not be forgotten. Unknown child arrays produce partial observations.
- Existing authenticated session/exchange/relay READY and revocation remain required. The one-shot observation is displayed locally only after cleanup; there is no model request, local authorization bypass or separate service.

## Prerequisites for a meaningful Mac run

Do not request another packaging-only check as inspector acceptance. Before scheduling the operator run, arrange a feature-branch **non-production** backend and ordinary authenticated test account/workspace/assistant/conversation/task with the existing native tool policy enabled. The signed package alone cannot supply the new API routes.

First run the authenticated, SELECT-only `pnpm native:readiness --non-production` check with the existing protected access-token file/stdin and workspace, assistant, conversation, task and intended device IDs. Exact command and inputs: [verification handoff](native-computer-mac-handoff.md); build/start/environment details: [backend setup](native-computer-backend-setup.md). This can run off-Mac. Boot already mounts `nativeComputerAuth`: readiness authenticates without updating session activity; other routes retain normal auth. A passing report is configuration only, not a model call, grant, permission or Mac acceptance. Review warnings; image approval is a pin for the configured task model, not a substitute model, and default budgets cannot fund an image attempt.

The existing API needs `NATIVE_COMPUTER_ENABLED=true`, a nonempty `NATIVE_COMPUTER_DEPLOYMENT_ID`, its normal JWT/auth configuration, `BROWSER_RELAY_SECRET` and a reachable `BROWSER_RELAY_URL`. The existing relay needs native enabled and matching JWT/relay secrets. Use the normal migrated database (including native session migration 620 and usage receipt migration 621) and one API/relay instance or the existing required affinity. Use HTTPS/WSS except permitted loopback development. Authenticate against that deployment through the normal app account flow: a production-cloud login cannot be assumed to exist in a separate local database. This document does not provision credentials or claim a test backend is running.

Use the existing Developer ID/keychain release workflow; no ad-hoc package signing, timestamp bypass or new identity. The previous operator-tested `609cee57` package does **not** contain this inspector implementation. Record the new source SHA and package version. Build/extract/launch commands are in the handoff; package only as preparation for the signed inspector/backend workflow, not as a standalone milestone. Avoid the production updater as described in [the package check](native-computer-r1-package-check.md).

The explicit, runtime-only desktop opt-in is:

```sh
NATIVE_COMPUTER_INSPECTOR_ENABLED=true USEBRIAN_DISABLE_AUTO_UPDATE=1 \
  "$app/Contents/MacOS/Use Brian"
```

Here `$app` is the newly built signed application, not the old recovered ZIP or an automatically updated installation. Keep the terminal open. Do **not** set desktop pilot/platform/vision acceptance flags. The opt-in applies only to packaged Darwin and permits setup/observation, not control or capture. Default desktop rollout remains off.

## Focused acceptance still required

1. Production source SDK preflight and the corrected 16 guardian XCTest cases plus C syscall-fake tests already passed on the operator's Mac (guardian revision `2fe2e0d2`); do not repeat unchanged checks. Verify the current signed app's actual inspector admission. Record the **first** readiness attempt and any fixed lifecycle diagnostics; preserve a failure rather than counting a retry as reliable startup. Do not upload full console logs.
2. With no AX grant, confirm discovery refuses inspection without prompting automatically. Use the explicit permissions UI and verify actual Accessibility attribution to the signed app/helper. Do not grant Screen Recording for this test.
3. With TextEdit containing disposable, nonsensitive text (then repeat with the signed fixture), discover and select one window. Control/capture checkboxes must be unavailable. Supply the existing task context and approve the explicitly read-only local consent.
4. Verify one bounded/redacted local snapshot, no activation/raise/edit/capture, no model invocation, server session revocation, and confirmed helper termination before the snapshot is released. Partial observations must remain labeled partial.
5. Verify Stop during discovery/consent/blocked observation, physical takeover, permission revocation, window replacement and sheet/new-window transitions. Each must refuse/terminate without reusing old selection or authority. Exercise a transient sheet during Start as well as during observation. Fresh discovery and consent are required after scope loss.
6. Record denials for unsupported targets and forged control/capture/approval/action requests. Portable tests cover these protocol refusals, but do not prove native notification delivery or input-monitor behavior.

The separate `tests/native-acceptance` experiment is implemented test tooling, not an inspector mode or production acceptance override. Its new-target SDK build and attended null/tap/death/physical-overlap cases require a **disposable isolated Mac login**, per-case GUI consent and the [experiment README](../apps/app-desktop/native/computer-control/tests/native-acceptance/README.md). Session input can escape the fixture; all reports retain `productionAcceptance: false`, and the production registry stays empty. It does not replace signed Host/task verification or require the operator to implement missing code.

Local Node/Vitest/Foundation results belong in [the acceptance ledger](native-computer-acceptance.md), separately from these pending Mac results. No R1 completion claim follows until the packaged flow above is verified.
