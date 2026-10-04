# Screenshot → AX invoke: bounded review contract

## 1. Status and review boundary

Design only, against source inspected at `26568f55`; nothing here is implemented, enabled or authorized for dispatch.
Task C already authorizes engineering research/design; no fresh generic user authorization is needed to review this contract.
All rollout/pilot/image-approval flags remain off or unchanged; this task changes only this document.
Read with the [active plan](plans/electron-native-computer-use.md) and [feasibility finding](native-computer-visual-ax-design.md).
The reviewer may accept/reject **the public capture cohort and schema independently** of dispatch safety.
Accepting those parts does not close R2/R3, authorize capture/upload, approve release, or satisfy the original no-AX canvas goal.
No new provider/configuration work, CV service, planner, executor or platform abstraction is proposed.

## 2. Exact proposed public fixture cohort

Add a separate launch variant `visual-invoke-v1` to `Fixture.swift`, not an alteration of `SafeCanvas` or `EvaluationCanvas`.
It creates only one borderless, opaque, nonresizable 480 × 240 point window; no general form or canvas sibling.
Identity: existing signed adjacent fixture `com.usebrian.NativeComputerFixture`, plus exact window title
`Brian Public Shapes v1` and AX identifier `brian-public-shapes-v1`; these strings alone never establish trust.
Reuse process-birth, running-code/cohort and window-instance checks. Exact reviewed-renderer admission is additionally required but unresolved (§3).
The variant accepts no text, asset path, seed, layout or other caller-supplied content arguments.

Render specification, content coordinates from top left:
- Solid white background; no titlebar, toolbar, traffic lights, shadow, transparency, vibrancy, menus or tooltips.
- One content AX group, identifier `public-shapes-content-v1`, label `Public shapes`.
- Three ordinary momentary `NSButton`s, bounds `(30,60,120,100)`, `(180,60,120,100)`, `(330,60,120,100)`.
- AX identifiers `slot-1`, `slot-2`, `slot-3`; neutral labels `Option 1`, `Option 2`, `Option 3`; role AXButton, empty subrole.
- Each button is enabled and supports AXPress, exported only as `invoke`; no custom accessibility action implementation.
- Draw one centered black outline triangle, circle or square (48 × 48 points) on each button's opaque white face.
- Use built-in vector paths, not asset filenames, SF Symbol descriptions, image accessibility labels or alternate text revealing shape.
- A read-only AXStaticText at `(30,190,420,24)`, identifier `public-shapes-result-v1`, label `Result`, value initially `None`.
- The only rendered strings are neutral button labels and `Result: None|Triangle|Circle|Square`; no timestamps or counters.

At window creation choose one of the six permutations of the three shapes, using local randomness; freeze it for that window lifetime.
No permutation/shape map enters AX names, identifiers, help, descriptions, values, discovery metadata or model context before invocation.
The permutation is not encoded in window identity, ref order or a supplied task ID. All six layouts must be tested.
The ordinary button target/action updates only `Result` to its displayed shape; subsequent presses replace that value.
This is local reversible state, with no files, clipboard, network, credentials, external effects or special test click endpoint.
The native resolver must not inspect the private shape map; it resolves a proposed point to an ordinary AXPress target.

Concrete task: **“Activate the outlined triangle; finish when Result is Triangle.”**
AX can establish the immutable final objective (`AXStaticText`, name `Result`, value `Triangle`), but cannot choose a slot.
Without pixels, all three neutral slots are equally plausible across the permutations; do not guess or try buttons to discover the answer.
This is a trusted **visual-only Brian cohort**, not a prompt instruction: `buildNativeCandidates` returns no ordinary effects for it.
API `policy.allows` and core's final dispatch gate reject ordinary invoke, generated setValue/text, select/scroll/focus/key/click for this cohort.
Native `beginApproval`/`execute` independently reject those external effect commands on this window, even with a valid ref and absent/forged cohort marker.
Native reserves windows matching either shapes title or identifier: any incomplete/mismatched predicate refuses, never generic fixture fallback.
Core latches visual-only scope on native cohort admission; marker disappearance refuses rather than restoring ordinary candidates.
Only a native-owned visual binding can supply the internal invoke to `permittedSemantic`/the existing AXPress branch; no wire bypass flag is added.
Keep real OS AXPress and truthful node affordances: these ordinary buttons remain locally usable. Existing form/TextEdit AX policy is unchanged.
Require that exact `grant.goal` natively; core freezes it and the Result objective before capture. Other goals/goal changes refuse, not model rewriting.
Fresh Result evidence verifies completion independently of model/receipt; wrong results pause under the deterministic attempt fence in §5.

## 3. Privacy predicate and capture invariants

“Immutable-public” means a closed, compiled public render vocabulary and finite state machine, not pixels that never change.
States are exactly six fixed permutations × four result values; only normal button press changes the result.
The render must have no binding to user/system content, editable controls, drag/drop, paste, file loading, notifications or embedded web views.
Hover/focus/pressed rendering may use only reviewed public button decoration; no dynamic text or external images.
Public AX classification alone cannot prove pixel privacy: source review of every drawing/content path is required.
**Concrete trust gap:** `ProcessTrust.target` checks the kernel-derived adjacent fixture path and `signedProcess(identity, teamRequirement(cohort))`.
`signedProcess` checks running guest validity and static seals; `parentValid` also revalidates the existing helper/parent bootstrap binding.
`build.sh` compiles `Fixture.swift`; `electron-builder.yml` packages it; `sign-mac-app.mjs`/`sealNativeBootstrap` use the existing release signer.
However, `mac-bootstrap-inventory.mjs` explicitly excludes fixture MH_EXECUTE from library pins; its capture digest is not stamped into the anchor.
`BootstrapProcessBinding` pins helper/parent process samples and approved libraries/ASAR, not an exact reviewed fixture renderer hash.
Same-team/identifier plus nested signature validity is therefore not asserted to reject a substituted same-team renderer at the permitted path.
Missing privacy condition: bind the reviewed fixture artifact to a trusted package pin AND the running target to that exact artifact, rejecting substitution.
No such fixture pin/target comparison was found; disk hashing alone or a model-supplied build ID cannot supply it. Keep new capture unavailable.
Resolve this narrowly in the existing build/signing/ProcessTrust path, with a same-team replacement regression; no general attestation or release service.
This document does not invent an anchor field or claim existing bootstrap approval already covers the fixture. Privacy approval remains conditional.

Propose a separate native cohort predicate; **retain `safeCanvas` unchanged**, including its empty-action requirement.
For the new predicate require complete traversal and exact window/group/three-button/result structure, identifiers, roles, labels,
enabled states, allowed result values, fixed relative bounds and child order; no extra child, sheet, menu, unknown wrapper or action.
All ancestors and descendants must be public and completely readable, including AX attributes not exported to the model.
Expected AX wrapper behavior and AXStaticText value exposure must be confirmed on the supported macOS build; unexpected trees refuse.
Do not create custom AXPress to compensate for AppKit differences. Refuse an unsupported OS tree until explicitly reviewed.
The helper needs native identifier reads for this predicate; identifiers need not be added to exported `AxNodeSchema`.

Before and after SCK capture require exact selected process/window instances, unchanged complete state and geometry/layout,
unique AX/CG/SCK window correspondence, foreground/focused window, no sheets, and no intersecting visible preceding CG window.
Reuse `visibleWindowID`/`uniqueCanvasWindow` checks through a narrowly parameterized identity match, not a blanket public-window allowance.
Require containment on exactly one unrotated display; movement, resize, display/scale change, minimization or replacement invalidates evidence.
Use `SCContentFilter(desktopIndependentWindow:)`, selected window only, cursor/shadow excluded; no full desktop or adjacent form capture.
Retain limits: each image dimension ≤1024, PNG ≤2,000,000 bytes, interval ≥1 second, both control/capture consent and Screen Recording permission.
Capture start, not callback completion, anchors age; a failed/new capture clears the prior frame and any pending visual binding.
Privacy checks are scoped samples, not an atomic AX/render transaction. The closed renderer supplies the content invariant between samples.
Any inability to establish it refuses capture; title matching or absence of secure fields is insufficient.
No raw frames, AX content, points or target labels in routine diagnostics; retain only existing bounded metadata.

## 4. Minimal proposed wire delta (not existing APIs)

Keep `native-computer-v1` for existing traffic; add an explicitly versioned optional capability `visualInvokeVersion?: 1`.
Absence means unsupported. Do not emit the field until the mutually compatible deployment is installed; old strict readers reject it.
New readers accept old capabilities without inferring support. No mixed-version visual execution or automatic downgrade to click.
Advertise version 1 only with semantic actions, eligible scoped capture and normal control admission; inspector strips it.
`input` remains **false** everywhere. `semanticActions:true` alone does not authorize this lane.
Add `ObservationSchema.captureCohort?: 'public-shapes-v1'` (Swift optional String with this sole literal).
Only native observation/capture construction emits it after the complete new cohort predicate passes; otherwise omit it.
Core/API require it before capture and on the returned framed observation. It is routing evidence, not authority:
native capture/resolution repeats the predicate against retained state, never trusts an echoed marker. Existing observations remain valid.

Proposed TS shapes below use existing `NativeTarget`, `id` (nonempty ≤256), finite numeric and strict-object validators:
```ts
// New ActionSchema branch; a proposal, never an executable coordinate action.
type VisualInvoke = {
  kind: 'visualInvoke'; target: NativeTarget; observationId: string;
  frameId: string; x: number; y: number;
};
// Helper-private-channel beginApproval result, only for visualInvoke.
type VisualApproval = {
  bindingId: string; commandId: string; frameId: string;
  action: { kind: 'invoke'; target: NativeTarget; observationId: string; ref: string };
};
// Existing beginApproval boolean result remains for all old action kinds.
// visualInvoke: false on refusal, VisualApproval on success; true is invalid.
// Existing command envelope is unchanged:
// {protocol, identity, grantId, epoch, commandId, deadlineAt, action}
// beginApproval/execute payload: {command, leaseId}
// visual endApproval payload: {command, leaseId, approved, bindingId}
```
All objects reject unknown keys; new action has exactly six keys, no ref, safety bit, action name or model-supplied clock.
`x`,`y` are finite nonnegative numbers; reject `x >= width` or `y >= height` against the retained frame, never clamp.
Swift uses existing `Object` dictionaries: add exact key sets to `validWireCommand`/`validWirePayload`,
`wireString` for IDs, `wireNumber` for coordinates, `wireBool` for approval, and identical nested target/action validation.
Swift success returns precisely the `VisualApproval` keys above; the private lease and native binding contents never go to the model/relay.
`endApproval` requires `bindingId` only for visualInvoke; existing payloads/results remain unchanged. No new relay RPC or receipt schema.
`execute` repeats the original visual command, not a caller-edited resolved invoke; helper looks up its pending approved binding.
Coordinate the backend result change: the source protocol is `ObservationBackend` (not `BrokerBackend`), currently `beginApproval -> Bool`.
Propose a Swift typed result enum `.legacy(Bool)` / `.visual(VisualApproval)` serialized by `ObservationDispatcher` to the shapes above;
update Broker, protocol, dispatcher and fake backends together. TS `NativeHelper.beginApproval` returns `boolean | VisualApproval`, parsed by command kind.
Replace helper-client's `=== true` shortcut; controller freezes the validated result with command/lease and uses it for UI and the bindingId echo.
Extend client approval snapshots to retain that binding context; clear pending/approved context on denial, expiry, Stop, disconnect or consumed attempt.

Coordinate convention: pixel-edge continuous image coordinates, origin top-left; pixel centers are `(i+0.5,j+0.5)`.
Use stored frame bounds/dimensions: `screenX = bounds.x + x * bounds.width / width`, likewise Y.
These are top-left screen coordinates for AX hit-testing, not AppKit bottom-left content coordinates or backing-scale assumptions.
Reject nonfinite/out-of-range values, boundary hits and ambiguous containment; require a point strictly inside one eligible button.
Do not round, normalize, infer Retina scale, choose nearest, promote to a parent or synthesize mouse input.

## 5. Native resolution, approval and consumption

1. Core sends one fingerprint-stable visual command through the existing provider/relay/controller execute flow.
2. Controller calls helper `beginApproval` **before** showing approval. Native admission anchors the command deadline first,
   using `SemanticSafety.admit`, fingerprint of the entire original command and the private lease; repeated/denied attempts cannot renew it.
3. Require current authority, cohort predicate, original observation/frame match, unchanged state, geometry/layout and unexpired evidence.
   Hit-test using `AXUIElementCopyElementAtPosition` on the selected application; confirm PID and exact live selected-window membership.
   Match the hit handle using `CFEqual` to exactly one retained ref; require `reachable`, exact ancestor/child structure and public classification.
   Require AXButton, empty subrole, enabled state and AXPress in native action names; only this trusted resolution can enter cohort semantic policy.
   Independently require exactly one eligible button contains the mapped point; overlay, wrong window, missing or wrapper hit refuses.
4. Mint opaque single-use `bindingId`; save only in the Broker. Return the resolved ordinary invoke and IDs to trusted main.
   Bind identity/grant/epoch/lease, full command fingerprint/deadlines, process/window instances, frame/observation IDs,
   original capture/observation clocks, bounds/layout/transform, point, AX handle/ref, ancestry/children, node state and `invoke` (no parameters).
   Keep one pending visual binding; a conflicting command cannot replace it. Denial invalidates it but not the retained command deadline.
5. Main validates the result against its exact command and retained observation; display the native-resolved Option/ref,
   selected app/window, `AXPress / invoke`, frame context and unknown-effect warning. A point-only approval is invalid.
   Use retained public frame context locally if displayed; do not recapture or send the image back through the relay for approval.
   `endApproval` echoes the original command and bindingId; no model-selected ref or edited approval payload may substitute a target.
6. After approval/focus restoration recheck the same handles, structure, privacy, enabled/action state, foreground, bounds/layout,
   unique window and occlusion, whole-state equality, both permissions/consents, channel/monitor and both deadline clocks.
   The local Brian approval window may temporarily obscure the target; no capture/resolution/dispatch occurs while obscured.
   Reuse the existing narrow local-dialog input checkpoint, not a general takeover exemption; close the dialog before revalidation.
7. `execute` consumes that binding once, verifies the original fingerprint, and supplies its **native-derived invoke/ref** to the
   existing `Broker.execute` semantic validation and `case "invoke"` AXPress branch. There is no second dispatch implementation.
   Journal and receipt remain keyed by the original visual command, not a new command with a fresh deadline.
   Reserve/consume the frame for this attempt; never bind it to a second command. Mark uncertainty before entering AX as today.
8. Successful AX return is `executed`, not goal completion; failure is `execution_unknown`, no automatic replay.
   Exact duplicate command retrieves metadata only; modified command ID reuse is denied. Lost receipt fences further effects.
   Fresh post-action observation is permitted only under live authority; revoked sessions neither read back nor continue planning.

**One visual attempt per authenticated run, not per frame:** add trusted `unused → active → terminal` state to the session orchestrator,
pinned to grant identity/task, exact goal and target. Reserve it before the first shapes capture RPC; failure/abstention/expiry consumes it too.
Active permits only that capture, one image proposal and at most one visual dispatch; no second capture, replan or generated ordinary effect.
Native Broker mirrors this session fence: first shapes capture reserves the slot; bind its frame and then one visual command fingerprint.
A failed capture, denied approval or attempted dispatch terminates the slot; frame/command ID changes, observe, Resume or regrant cannot reset it.
Retain the fence for that helper lifetime; only normal teardown and a separately consented new run can start again, never automatic recovery.
Core retains the fence across `run()` calls on its instance; existing API `claimRun` CAS (`run_state IS NULL`) and `finishRun` revoke/finish
prevent reopening the same session, including restart. Do not add a task-budget service or accept caller/model `maxActions` as this fence.
After known `executed`, check fresh AX frozen postconditions **before** terminal budget/model verification: exact Result=Triangle completes;
wrong/missing/stale evidence pauses; no verifier `continue` can reopen planning/capture. A read/verification failure does not turn known execution into unknown.
`not_executed` pauses without retry; `execution_unknown`/lost receipt retains the existing unknown latch and manual-reconciliation path,
with no automatic verification or further effects. A frame's single-use property alone is not this run fence.

## 6. Evidence lifetime and Stop boundary

Retain native capture-start monotonic time and original snapshot time as immutable binding fields; each must remain younger than
5,000 ms, and all existing tighter command/grant limits still apply. Do not increase budgets for model or human approval latency.
Expiry at any stage pauses; another visual attempt requires a separate normal consented run and new capture, never renewal within this run.
`endApproval` currently refreshes semantic snapshot monotonic time: visual commands must not inherit this renewal.
Core's >1,500 ms semantic ref-refresh branch must exclude visualInvoke; index/name matching cannot transplant a visual binding.
New observation/frame, changed state/geometry/layout, sheet/window/process change, permission loss, takeover, Stop or channel loss invalidates it.
No re-hit-test after approval may silently choose another element; validation must confirm the originally bound handle.

The user accepts **already-sent AX work finishing after Stop**. Timeout/helper death does not prove cancellation of that work.
Stop still revokes further dispatch. Existing `effectAllowed` checks, watchdog and channel fencing remain mandatory but are not atomic send.
A thread can be suspended after its final check and enter a new AX call after revocation/expiry; this contract supplies no primitive preventing it.
Binding, approval or validation is not “already sent.” No new postrevocation OS call is claimed safe or tacitly permitted.
Public-cohort/schema review may proceed now; dispatch/release remains blocked on explicit safety disposition under the unchanged requirement.
The same concern applies to existing AX-only execution; passing mock last-check tests is not a resolution.

## 7. Integration map and implementable sequence

1. Review this finite renderer/privacy contract and schema; record findings separately from the dispatch concern. Keep gates off.
2. Implement the isolated fixture variant and native predicate in `Fixture.swift`/`Helper.swift`; preserve existing canvas negative tests.
   In Helper reuse `captureAuthority`, `capture`/`pixels`/`captureStillValid`, `liveWindow`, `fresh`, `unchanged`, `reachable`,
   `permittedSemantic`, `beginApproval`/`endApproval`, `SemanticSafety` and `execute`; do not route through ClickGuardian.
3. Update `packages/computer-control/src/protocol.ts` strict schemas plus Swift wire checks together; add parity vectors.
   Update desktop `computer-control/helper-client.ts` return parsing, `controller.ts` admission/approval/capability reduction,
   and `native-computer-integration.ts` local wording; preserve immutable command, journal, lease and Stop behavior.
4. Update shared-schema consumers in API `computer-use/service.ts`, `apps/browser-relay/src/native-relay.ts` and core provider/types together; old endpoints
   refuse new actions/capabilities rather than stripping fields. Version-1 advertisement requires all participants updated.
5. In `packages/core/src/computer-use/orchestrator.ts`, replace the screenshot-click gate with visualInvokeVersion + semantic/capture gates,
   validate exact frame/observation, keep frozen whole-goal objectives, skip ref refresh, and dispatch through the same provider.
   In `packages/api/src/computer-use/model-runtime.ts`, `vision.propose` requests `{x,y}` or null for a **button to invoke**, not a click;
   strict `pointSchema`/`framePoint` validation stays, but trusted adapter wraps `kind:'visualInvoke'` with current target/observation/frame IDs.
   Policy admits this proposal only with `captureCohort:'public-shapes-v1'` and an exact framed observation; it must not require a model-provided ref.
   Apply §2 refusal in `buildNativeCandidates`, generated-plan filtering and final policy, and §5 run fence before planning/capture.
   Native-only resolved invoke reuses semantic validation without admitting external ordinary invoke. Never downgrade to click.
6. Keep `boot-runtime.ts` exact configured image-route approval/assertCurrent, same provider/model pinning, native-strict provenance,
   no substitution, cancellation, conservative reservation, one-attempt usage settlement and unknown-accounting fences unchanged.
   Default image approval/budget may prevent a live attempt; report that result, never raise limits or add provider configuration here.
7. Run focused portable regressions, then supported signed-Mac tests only after separate dispatch/operational gates are satisfied.
   No implementation or live test is performed by this documentation task.

## 8. Focused acceptance and actual remaining decisions

- Fixture: all six permutations; AX-only context cannot identify triangle, no map leaks, all 24 public states render only reviewed content.
- Privacy: injected extra node/attribute/render source, secure ancestor, truncation, unknown wrapper, wrong signed build/title/identifier refuse.
- Capture: sibling form/TextEdit/desktop refused; original noAX canvas remains noninvokable; control/capture consent both required.
- Geometry: fractional pixels/scale, negative/NaN/infinite/right-bottom edge, overlap/wrapper/empty/wrong-window hits refuse without repair.
- Binding: forged ref/bindingId, altered target/frame/point/deadline/epoch, changed ancestry/AXPress/enabled state, duplicate window refuse.
- Approval: native resolution precedes UI; late/denied approval cannot refresh clocks; local overlay removed before checks; changed handle refuses.
- Lifetime: slow SCK callback/model/approval, wall rollback, >5s frame, semantic ref refresh and new observation cannot revive evidence.
- Execution: one existing invoke call, zero coordinate events; duplicates metadata-only, lost receipt/AX error uncertain, no retry or next button.
- Stop: model wait/approval/queued execution revoke; in-flight success/failure retain truthful outcomes without follow-up read/plan.
  Suspension at the last-check-to-call interval is a separate native safety investigation, not asserted solved by these regressions.
- Integration: strict TS/Swift vectors, old/new capability matrix, inspector strips support, input false, AX happy path uploads zero images.
- Models/accounting: malformed point/null, policy revocation, provider mismatch/error, insufficient reservation and settlement failure fail closed.
- Completion: fresh Result AX evidence required; wrong result/receipt-only/model assertion never completes the goal.
- Bypass/fence: neutral invokes, generated text/direct commands and forged markers refuse; changed frame/command/goal, second run(), Resume,
  denial, stale receipt and `maxActions:20` cannot buy a second attempt; verify success before budget pause, wrong result before replanning.
- Trust/results: same-team/id renderer substitution must refuse capture; typed backend/client/controller parity rejects true-for-visual,
  object-for-legacy and binding echo mismatch; Stop clears UI/client binding while retaining spent/uncertain fences.

Outstanding blockers: exact reviewed-renderer package-to-running-target binding (§3), native AppKit tree/value conformance evidence,
and independent dispatch safety disposition. Cohort/schema review remains conditional on those findings; latency within unchanged budgets is unverified.
The original no-AX canvas scope and deployment-owner image admission remain existing release decisions, not new research-authorization requests.
No Mac SDK build, native rendering/AX run, provider invocation or safety acceptance is claimed here.
