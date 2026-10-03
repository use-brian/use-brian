# Mac computer use — verification handoff

## Scope and completed checks

Finish code/tooling in the engineering checkout; the operator executes finished tooling and verifies real Mac behavior, not an implementation backlog. No availability or full-completion claim follows. The accepted-platform registry remains empty and production coordinate input remains unavailable.

The operator already passed the production source SDK preflight and, at **`2fe2e0d2`**, the corrected **16 non-emitting XCTest cases plus public-header C syscall-fake fence tests**. Do not repeat unchanged preflight/guardian checks or request another packaging-only test. The earlier XCTest overlay compilation failure remains in the acceptance ledger; the corrected run does not prove event delivery or physical ownership. Earlier signed/notarized arm64 Electron 43.2 admission/differential evidence at `609cee57` concerns an older package, not current AX/provider outcomes; its initial admission failure remains unexplained.

Since that run, source-owned platform selection was added: exact OS version/build, native architecture and mechanism revision, with malformed/duplicate/translated profiles refused. Its immutable registry is still **empty**. Four portable selector cases bring the current guardian runner to **20** non-emitting Mac cases (14 portable). This source change needs one fresh SDK check—not repetition of unchanged work:

```sh
bash apps/app-desktop/native/computer-control/mac-preflight.sh && \
  node apps/app-desktop/native/computer-control/guardian-tests.mjs
```

## Implemented source boundary

Permissionless fresh readiness, lazy discovery, inspector-only capability ceiling, consented TextEdit/fixture semantics, scoped safe-canvas capture, approved frame/point binding, private same-binary guardian candidate, standing lifetime fences and uncertainty-retaining lease cleanup are implemented. The candidate is not accepted input ownership.

Images use the **same configured task provider/model** as text. `NATIVE_COMPUTER_VISION_MODEL` is only an exact approval pin, never a replacement route. Unsupported/custom-endpoint image identities, route/policy changes, absent approval and insufficient budgets refuse rather than substitute. Goal decomposition precedes capture; fresh observation follows decomposition before the frame freshness clock starts. After an effect the controller monotonically reduces capabilities; relay publishes status **before** the receipt. A candidate accepted click leaves fresh observation/capture readback, not a second effect. Completion needs independent whole-goal evidence. The real controller/relay/API/concrete-runtime regression covers advancing and unchanged synthetic canvas counters; its helper/provider/DB are fake, not native or live-provider evidence.

## Deployment-specific readiness — may run off-Mac

No backend is claimed deployed and no provisioning is authorized. Use an existing authorized **non-production** deployment with this API/relay revision, normal session-backed login, owned workspace/assistant/conversation/current task, explicit `native_computer` capability/tool policy, supported native accounting and migrations **620 + 621**. Use one API or existing sticky routing and one relay. API needs native enabled, deployment ID and its existing JWT/relay/database/provider settings; relay needs native enabled and matching secrets. The relay URL must be reachable by both API and Mac over HTTPS/WSS except permitted loopback. Linux localhost is not Mac localhost. Cloud login does not create a local DB account.

Follow [backend setup](native-computer-backend-setup.md) for existing build/start commands and inputs. With an existing access token in an owner-only regular file (0600 or stricter, no symlink), run from the repository root:

```sh
pnpm native:readiness --non-production \
  --api https://api.your-test-deployment.example \
  --token-file /private/path/existing-access-token \
  --workspace-id "$WORKSPACE_ID" --assistant-id "$ASSISTANT_ID" \
  --conversation-id "$CONVERSATION_ID" --task-id "$TASK_ID" \
  --device-id "$DEVICE_ID"
```

Use existing context IDs and the intended desktop device ID. `--token-file -` accepts credential-manager stdin; never paste tokens in arguments, history or reports. The protected CLI issues one authenticated SELECT-only readiness POST; `nativeComputerAuth` is wired in boot and suppresses auth session activity UPDATE only for this route. No grants, expiry cleanup, reservations, accounting writes, inference or commands occur. Exit 0 means configuration checks passed, **not** native/live-model acceptance. Review blockers and warnings, including exact image approval and effective budget. Default text budgets cannot fund one conservative image reservation (4227072 units / $422.7072 at defaults); do not automatically raise bounds or enable approval. Live-provider credentials/configuration are deployment-specific and can be checked elsewhere, not a Mac SDK blocker.

## Fresh Mac-only work: isolated mechanism experiment

Read [the experiment README](../apps/app-desktop/native/computer-control/tests/native-acceptance/README.md) first. **Hazardous: use a disposable isolated Mac login, close other apps, and expose no valuable work or credentials. Session input cannot be guaranteed to remain in the fixture after focus loss, suspension, death or stale callback return. A pending up may affect physical input. Never use the ordinary working desktop.**

This new target is excluded from production compilation/packaging. Its twelve finite cases are implemented; no operator coding is requested. First compile only:

```sh
cd apps/app-desktop/native/computer-control/tests/native-acceptance
bash build.sh
```

This does not launch, request permissions or explicitly sign anything. Review native bootstrap refusals and manual TCC/signing prerequisites in the README before emission. Use only the existing signing/TCC setup if required; after externally signing the test artifact, `node run.mjs --record-build` refreshes local identity, not trust or acceptance. Then run **one case at a time**, review its result, and obtain fresh per-case GUI consent:

```sh
node run.mjs --run null
# Only after reviewing that result and prerequisites, separately:
node run.mjs --run normal
```

The same command accepts exactly one of: `paused-before-final-check`, `last-check-to-post`, `after-down-stall`, `after-down-owner-death`, `worker-death-before-check`, `parent-death-before-check`, `worker-death-after-check`, `parent-death-after-check`, `physical-overlap`, `physical-before-check`. Do not loop or auto-retry. Physical cases require the README's manual cues; held-left uses **SAMPLE RECORDED**, not the end of the pause, as its release cue. Stop experiment / Command-Q fences and terminates owned processes, not pending OS events; release physical buttons manually. Uncertain process state requires ending the disposable login before further cases.

`observed-as-specified` is narrow observation only; blocked/inconclusive/counterexample remain failures or missing evidence, not acceptance. Every result has `productionAcceptance: false`. The harness does not prove full signed Host/worker admission, monitor-return/lease protocol, global containment/release/drain or absence of races. No report automatically populates the empty production registry. Preserve native defects for engineering correction here; do not improvise an emitter or weaken guards on the Mac.

## Signed app and backend workflow

Once the authorized backend is ready, build the current app through the user's existing Developer ID/keychain workflow **for an actual inspector/workflow run**, not another package-only milestone. From the repository root on the operator's arm64 Mac:

```sh
bash scripts/package-desktop.sh --arm64
test_dir="$(mktemp -d)"
ditto -x -k "apps/app-desktop/release/usebrian.zip" "$test_dir"
app="$test_dir/Use Brian.app"
NATIVE_COMPUTER_INSPECTOR_ENABLED=true USEBRIAN_DISABLE_AUTO_UPDATE=1 \
  "$app/Contents/MacOS/Use Brian"
```

No publish, version bump, credential export, ad-hoc release signing or timestamp bypass. The production updater previously replaced the WIP app; run the new extracted app directly and keep the terminal open. Authenticate normally against the intended backend, not an assumed cloud deployment. Follow [the inspector checks](native-computer-r1-inspector.md): first admission attempt, permission attribution, selected-window redaction/no effects, cleanup, Stop/takeover and scope loss. The inspector opt-in cannot run semantic tasks or capture. Do not set pilot/platform acceptance flags to manufacture a pass. Real semantic/provider/canvas and termination/physical checks remain gated acceptance work; unavailable gates must be recorded as blocked, not bypassed. An isolated mechanism pass is not authority to run production clicks.

Record source/package revision, SDK/OS/architecture, bounded result and every failure/intervention without secrets or raw desktop content. R1–R4 remain open where signed workflow, real input or configured-provider evidence is absent. Deployment readiness and live credentials are separate from Mac execution; neither this document nor a successful checker deploys anything.

## Historical evidence and constraints

### Preserved earlier verification record (historical, not a new request)

After the implementation-first pass: 603 native/build/signing Node tests, 1,111 desktop tests/54 files (three are local pending-CI checks), 38 web tests, 151 core-loop tests, 73 API/relay tests and desktop/web typechecks passed. The Foundation wire/click-policy runner passed in all three flag configurations, and the new guardian runner passed 10 portable ledger/tail cases. Mac-target Swift parsing passed but is not SDK typechecking. Earlier parent runs included API typechecking and 170 API runtime/service tests. Earlier current-native verification: 599 Node checks, 32 renderer/store tests, real Linux Foundation wire/dispatcher/approval/semantic/privacy/capture checks and generated envelope validation. Prototype ownership tests passed unoptimized and `-O`, including 45 revocation boundaries and exhaustive short traces. These are not Mac effects, input cleanup or live-provider acceptance. All evidence and earlier failures remain in `docs/native-computer-acceptance.md`.

A credential-free Mac SDK GitHub workflow was prepared but **its push was rejected because the existing token lacks workflow scope**. No workflow ran. It is retained only in the Linux checkout/local branch `wip/native-mac-sdk-ci`; do not waste time expanding credentials to reproduce that as a substitute for the operator-reported SDK results. The feature commits above were pushed separately without it. No production workflow or signing credentials were changed.


The [acceptance ledger](native-computer-acceptance.md) preserves earlier 603 native/build/signing checks, 1,111 desktop tests, 38 web tests, 151 core-loop tests, 73 API/relay tests, Foundation runs and earlier failures. Those overlapping revision-scoped results are not current native acceptance. The earlier rejected workflow push ran no Mac workflow; it is not a reason to expand credentials or repeat the operator's completed SDK checks. Earlier source/session/notice milestones (`1d13292f`, `eb83ce67`, `a7a60c00`, `23b57954`, `795870c5`) are historical, not the required current checkout.

Browser behavior remains independent. Windows/Linux, generalized telemetry/attestation and hosted-accounting expansion remain deferred. No production deployment or release publication is authorized. KB edits remain separate and preserve existing work.
