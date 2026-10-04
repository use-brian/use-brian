# Screenshot-guided AX: Task C feasibility gate

## Decision and scope

**Visual execution remains blocked by the capture/action policy inspected at `abdcc89f75241a753cf17dcbe0498740d1bb4e41`. Do not enable it on the strength of this investigation. The user subsequently accepted the in-flight Stop boundary below.**

The source-policy blocker and separate dispatch boundary are:

1. **The native capture/semantic-action intersection is empty by policy.** Capture requires a complete public safe-canvas snapshot with no supported actions on any node. Semantic execution requires a supported action on a node in that snapshot. The fixture canvas itself implements mouse handling, not a usable semantic action.
2. **Public AX dispatch does not establish expiry-atomic or revocation-atomic execution.** The existing executor checks authority and then calls AX. Suspension or revocation can intervene; AX has no command deadline/revocation token in these calls. Timeout, helper death and channel closure cannot establish cancellation of a request already delivered to the target; the user now accepts that in-flight limitation. Another pre-call check still does not prove absence of newly dispatched post-revocation calls.

The existing protocol/loop also implements screenshot-to-`click`, not screenshot-to-AX. That is additional implementation work, not a reason to set `input:true`.

This is a source/interface feasibility finding, not an observed native AX counterexample or a universal impossibility proof about every macOS interface. It does not retire or alter the existing AX-only implementation, approve its release safety, resolve the original no-AX canvas requirement, or claim R3 completion. The initial investigation changed only this document. Subsequent semantic-only hardening is recorded below; it does not change the feasibility decision or enable visual execution.

Read alongside the [active plan](plans/electron-native-computer-use.md), [runtime guide](native-computer-use.md), [acceptance ledger](native-computer-acceptance.md) and [retirement contract](../apps/app-desktop/native/computer-control/ClickGuardian-CONTRACT.md). Their historical probe-only/emitting-harness passages are not current authorization. The plan's Task C feasibility gate and its zero newly dispatched post-revocation effects requirement remain controlling constraints; the runtime guide separately acknowledges that entered OS operations cannot be retracted. Neither statement supplies an atomic dispatch primitive.

## Accepted in-flight Stop boundary

The user accepted this specific explanation: once Brian sends an action to macOS, macOS might still finish it after Stop. Therefore cancellation of already-sent AX work is **not an engineering blocker**. Stop continues to revoke further dispatch; late completion cannot resume planning, publish a new observation or automatically retry an uncertain action. Existing lease/death fences remain. This approval does not waive a new call after revocation, increase deadlines, restore the retired mouse emitter, broaden capture, or remove the no-AX canvas requirement.

The focused Foundation lifecycle harness now includes **48** in-flight cases across invoke, selection, both scroll directions and assignment: native-call entry occurs first, then channel closure or command/grant expiry before return. Success remains `executed`; failed native outcomes remain `execution_unknown`; neither is relabelled certified cancellation. No follow-up reads/effects or automatic replay occur under revoked session authority. These are extracted production methods with fake native dependencies, not native OS evidence or proof of check-to-call atomicity.

## Subsequent semantic-only hardening

`Helper.swift` now retains fingerprint-bound monotonic command deadlines across denied/repeated approvals, preserves the watchdog while approved dispatch is pending, checks both clocks/channel/monitor after blocking action validation and inside queued activation, and latches terminal uncertainty on failed AX mutations. Exact cached metadata remains retrievable without native reads, redispatch or clock renewal. Refused admission releases only its active timer; matching local capture approval is consumed on its attempt without changing capture eligibility.

The existing **0.2-second** timeout is now configured on the system-wide AX object, establishing the process default rather than an application-object-only override. Configuration failure leaves the lazy backend unavailable. Apple's primary documentation confirms the [process-wide timeout semantics](https://developer.apple.com/tutorials/data/documentation/applicationservices/1459345-axuielementsetmessagingtimeout.json) and warns that a [timed-out action need not have failed](https://developer.apple.com/tutorials/data/documentation/applicationservices/1462091-axuielementperformaction.json). Neither establishes target-side cancellation.

Focused verification passed: **550** extracted production-policy checks, **296** extracted Broker lifecycle checks with fake native dependencies, **653** native/build Node tests, **296** desktop control/integration tests, and the Foundation wire/dispatcher suite. Mac-target Swift syntax parsing and whitespace checks passed. No Mac SDK build or native AX execution was performed. These regressions fix concrete implementation defects, **not** the remaining check-to-call suspension race, queued OS effects, empty capture/action intersection or original no-AX canvas requirement. No backend/provider setup is a prerequisite for these engineering checks.

## Concrete source evidence

Line references below are for the inspected revision. `Helper.swift` and `Fixture.swift` are under `apps/app-desktop/native/computer-control/`.

| Evidence | Consequence |
| --- | --- |
| `Helper.swift:458–469`, `captureAuthority`, `supportedExecution` | Capture requires both `allowControl` and `allowCapture`. Executable classes are observe, capture, invoke, setValue, select and scroll; coordinate execution is not an alternative. |
| `Helper.swift:489–508`, `semanticNodeActions` | TextEdit permits only writable public enabled `AXTextArea` assignment. Fixture invoke requires an allowed button/checkbox/popup/menu-item role, empty subrole and `AXPress`; selection requires row/radio selection support or radio press; scrolling requires a vertical AX scrollbar and increment/decrement. AXGroup is not a supported action target. |
| `Helper.swift:931–946`, `node` | Public-node actions are populated under control consent, using native action names and attribute-settable queries. Read-only empty actions cannot be used to obtain capture authority. |
| `Helper.swift:1422–1432`, `safeCanvas` | Requires live signed-cohort window, title `Brian Safe Canvas`, identifier `brian-safe-canvas-v1`, no sheets, complete snapshot, all nodes nonsensitive, **all node action arrays empty**, and unchanged state. TextEdit and the fixture form window do not qualify. |
| `Helper.swift:1537–1597`, `pixels`, `captureStillValid`, `capture` | Capture calls `safeCanvas` before and after asynchronous ScreenCaptureKit work. Uses `SCContentFilter(desktopIndependentWindow:)`, exact selected PID/window/frame, no cursor/shadow, bounded dimensions ≤1024 each and PNG ≤2,000,000 bytes. Capture interval ≥1 second; frame age is anchored before capture, not callback completion. |
| `Helper.swift:1435–1450`, `visibleWindowID` | Requires containment on exactly one unrotated display; refuses intersecting visible preceding windows in CG window order. Selection matches owner PID, bounds and canvas title. These are scoped checks, not an atomic screen/AX snapshot. |
| `Helper.swift:1035–1046`, `permittedSemantic`; `1358–1375`, `execute` | Semantic approval/execution requires an action in the selected ref's native policy list, public classification, fresh snapshot and unchanged whole state. A model-selected point/name cannot supply that authority. |
| `Fixture.swift:6–29`, `SafeCanvas`; `107–110`, window construction | Borderless canvas exposes `.group`, label and click-count value. The drawn blue rectangle is not an AX button. `mouseDown` changes the count; there is no press/select/setValue/scroll implementation for this target. |
| `Fixture.swift:278–299`, `EvaluationCanvas` | Evaluation canvas also exposes a group/counter; its effect is mouse-down/up based. Readable completion evidence is not an action affordance. |
| `Helper.swift:758–761`; `packages/computer-control/src/protocol.ts:22–65` | `input:false`; capabilities have no visual-semantic lane. Only `click` binds a `frameId` and point. Existing semantic actions bind observation/ref but not a frame or native visual-resolution record. Strict schemas cannot silently carry new fields. |
| `packages/core/src/computer-use/orchestrator.ts:229–246,331` | Vision fallback requires `input`, capture permission/capability and native grounding, then accepts only a frame-bound `click`. It is intentionally unavailable with the current helper, before image upload. |

### Why the intersection cannot be recovered by clever grounding

For a currently capturable snapshot S, `safeCanvas(S)` implies every node has an empty supported-action set. `permittedSemantic(action,S)` requires the requested action to be in one of those sets. Both predicates cannot hold for the same unchanged S.

This is stronger than merely failing to find a button on one Mac. It is a source-policy contradiction. A hidden action not exported by `semanticNodeActions` is still unsupported. Adding an actionable child to the current canvas would make capture fail, not fix the intersection. Capturing before the child appears then acting afterward fails freshness/whole-state binding and would misrepresent the screenshot. Capturing the canvas and acting on a sibling form window violates selected-window binding. Clearing actions for export cannot help: the readback branch explicitly preserves native ref actions so `safeCanvas` cannot misclassify interactive content (`Helper.swift:1340–1352`).

Full AX-tree completeness/public classification alone does not prove pixels contain no secrets. Therefore removing the empty-action predicate or allowing every public fixture/TextEdit window is a privacy-policy expansion, not an integration fix.

## AX target resolution: available interfaces and their limits

Public interface research used the [published macOS 11.3 SDK `AXUIElement.h` mirror](https://github.com/phracker/MacOSX-SDKs/blob/master/MacOSX11.3.sdk/System/Library/Frameworks/ApplicationServices.framework/Versions/A/Frameworks/HIServices.framework/Versions/A/Headers/AXUIElement.h) and the [archived Apple header documentation mirror](https://leopard-adc.pepas.com/documentation/Accessibility/Reference/AccessibilityLowlevel/AXUIElement_h/CompositePage.html). These are public-header evidence, not compilation against the operator's current SDK. Attempts to fetch Apple's current Swift-shaped documentation URLs returned 404 and were not used as evidence.

- `AXUIElementCopyElementAtPosition(application,x,y,&element)` hit-tests top-left-relative **screen coordinates**, according to window z-order. A system-wide application argument is not application-restricted. Even application-restricted lookup is not restricted to the consented window and does not prove an action is supported, uniquely intended or public.
- `AXUIElementGetPid` establishes only a PID, not process birth, signed identity, selected-window membership or grant authority. `AXUIElementCopyActionNames` and `AXUIElementIsAttributeSettable` establish available operations, not permission to use them.
- Native `CFEqual` handle matching plus exact process/window lifetime, membership, role/subrole/privacy, action, enabled state and geometry checks are necessary. The existing `liveWindow`, `reachable`, `fresh` and `unchanged` functions provide useful parts, not a visual resolver (`Helper.swift:807–855,1013–1033,1599–1608`). A role/name match or nearest/first bounding box is not enough. Overlapping eligible controls, unidentified wrappers and an unclassifiable ancestor must refuse, not select heuristically.
- AX membership/geometry can change after they are read. Hit-testing is evidence at a moment, not a reservation or a transaction with subsequent `AXUIElementPerformAction`.

A future visual resolver should consume only a bounded proposal tied to the exact native frame/observation; a point is a hint, not an executable click. Trusted code must convert pixel coordinates with the stored frame dimensions/bounds/layout, reject out-of-range values without clamping, and resolve exactly one already permitted native action. For pixel-edge coordinates the mapping is `screenX = bounds.x + x * bounds.width / frame.width` (similarly Y); coordinate convention and edge rules must be specified and tested. Current SCK output requests roughly one pixel per point, but rounded dimensions must not become an assumed universal 1:1 transform.

## Dispatch, expiry and cancellation: exact boundary

### Inspected baseline (`abdcc89f`; hardening above supersedes changed details)

1. `scopedAuthority` checks exact identity/grant/epoch/lease/target, live process/window, wall expiry/deadline, monotonic expiry/command deadline, AX trust and private-channel liveness (`Helper.swift:911–919`). It does not atomically couple these predicates to the target application's mutation.
2. Semantic approval compares the entire command (`472–478`), checks supported ref/whole state, restores the selected window, and revalidates handles, geometry/layout and state (`1259–1300`). **Semantic `endApproval` resets the snapshot monotonic timestamp** after unchanged-state checks (`1298`). This is not evidence that earlier pixels became fresh. The local capture path instead retains its original frame/command age (`1195–1256`). A visual extension must not inherit the semantic timestamp refresh as frame renewal.
3. `execute` anchors its command watchdog and records `execution_unknown` before dispatch (`1316–1338`). After whole-state, membership, freshness and authorization checks (`1358–1375`), branches call `AXUIElementPerformAction` or `AXUIElementSetAttributeValue` (`1377–1409`). There is a nonblocking channel check immediately before each call (with a timing marker between them), not an atomic check-and-send. Select/scroll branches also perform AX reads after the general authority check.
4. The independent watchdog polls at 50 ms, exits on channel/parent loss and active deadline/permission/tap failure (`703–752`). Physical takeover/tap failure, lock and sleep terminate the helper. These are useful revocation controls, not real-time scheduling or target-queue cancellation guarantees.
5. `apps/app-desktop/src/computer-control/helper-client.ts:156–160,311–314` destroys command/observation streams before SIGKILL and awaits actual exit plus any guardian safety barrier. Closing pipes is not death; death is not proof that the target discarded an earlier AX request.
6. AX failure returns `execution_unknown`; the helper never reports a failed AX call as certified nondelivery (`Helper.swift:1411–1416`). AX success returns `executed`, with post-observation only if still authorized. Neither success nor readback is a global target-queue drain watermark or whole-goal completion proof.

### What the public API does not promise

`AXUIElementPerformAction(element,action)` and `AXUIElementSetAttributeValue(element,attribute,value)` have no command ID, absolute deadline, expected-state predicate, cancellation handle or revocation generation argument. The header explicitly warns that `kAXErrorCannotComplete` from `PerformAction` can occur during modal processing when the application has not returned within the messaging timeout: **it does not necessarily mean the action failed**. Its generic retry/increase-timeout suggestions are not acceptable under this project's no-replay/unchanged-budget contract.

`AXUIElementSetMessagingTimeout` configures messaging timeout, not deadline-enforced execution. Its object-specific setting does not even apply to other equal AX objects. The inspected baseline set 0.2 seconds on the application AX object during discovery (`Helper.swift:784`), not a descendant-wide setting. The hardening above corrects this to the process default; it still does not guarantee a 200 ms effect deadline or target-side cancellation.

Two distinct residual races matter:

- **Before OS call:** authority/channel check passes → executing thread is descheduled → deadline expires or Stop closes the channel → thread resumes and enters AX before termination takes effect. Another check merely moves this last-check-to-call interval. A whole-process suspension can also stop its watchdog; no scheduler ordering proof here guarantees the watchdog runs first on resume. This is a reasoned possible schedule, not a newly observed AX test result.
- **After OS call entry:** request may have been accepted/queued → caller times out, dies or is stopped → target may process/finish later. Existing uncertainty fencing correctly prohibits retry but cannot retract that effect. Killing the target app is not an authorized cancellation strategy.

A client lock, serial queue, approval digest, shorter timeout or additional check cannot make an external AX operation conditional on the same atomic revocation state. Calling the pre-call check a “commit” and declaring later work pre-authorized would change the contract, not satisfy it. The existing AX-only executor shares this dispatch limitation; adding screenshot guidance neither causes nor fixes it. It needs explicit safety disposition in R2 review as well, not an unearned assertion of existing native safety.

## Narrow extension proposal — requires separate review, not approved

### A. Capture/action cohort, only if dispatch safety is resolved

The smallest useful privacy proposal is **one separately identified, bounded, immutable-public-content fixture window with real standard AX controls and only local reversible state**, initially one `invoke` class. Keep the existing no-AX safe canvas unchanged as the negative case. Review the entire rendered surface, including chrome/overlays and every supported state; no editable user text, secrets, arbitrary images, menus/sheets or external effects. Require existing signed adjacent-fixture identity plus a new exact cohort identity/schema, complete expected public structure, per-control action allowlist, unique window binding and the existing SCK geometry/occlusion limits. Merely recognizing a title or finding no secure AX node is insufficient.

This would be a deliberate, separately reviewed capture eligibility extension, not something done in this task. Use an ordinary public AX button action, not a custom “click here” endpoint or test-only execution bypass. An image-needed case must genuinely lack sufficient textual grounding while retaining a unique native geometric/action binding. If it can be solved from current AX text, it is not evidence of fallback necessity. Fixture success would establish only that explicitly reviewed cohort, not arbitrary-app capture or original canvas support. Capturing TextEdit, the general fixture form or the desktop is not proposed.

### B. Frame-bound semantics in the existing loop

If A and the dispatch blocker are resolved, review a versioned visual-semantic capability (illustratively `visualSemanticActions`, not `input`) and a native-owned resolution binding carried through the existing semantic executor. A mere replacement of the core `input` check with `semanticActions` is unsafe.

The binding must cover identity/grant/epoch, exact target instances, command/deadline, original frame ID and capture-start age, observation ID, bounds/layout/transform, native element identity/ref/ancestry, selected action and exact parameters. Keep it ephemeral, single-use and invalidated by observation replacement, new frame, movement/resize/scale/occlusion, modal/window/process change, permission loss, takeover or Stop. No model-provided safety bit, forged ref or guessed parent promotion may mint it.

Show the exact native-resolved action/context for local approval; revalidate the same target/action/frame after approval without refreshing the original capture clock. An approval or model response that outlives the existing budgets must pause. New images need new consent-compliant capture/approval, not renewal of old frame evidence. Preserve immutable whole-goal objectives and independent fresh completion evidence; absent reliable postconditions means unsupported.

Implement consistently in Swift validation/resolution, shared schemas, desktop approval/controller capability reduction, relay/API validation and policy, core grounding/verification, and UI wording. Reuse configured image model, strict provenance, one-attempt usage settlement and existing cancellation. Inspector remains read-only; capture still needs both consents and Screen Recording permission; raw input stays false. Image approval and conservative budget admission remain deployment-owner decisions, never automatically raised to make this case run.

### C. Dispatch is a separate blocking design decision

A/B do **not** solve future-dispatch safety. The accepted boundary above permits an already-sent request to finish; no cancellation/drain proof for that work is required. Stop must still prevent further dispatch, and process suspension between the last check and a new OS call remains a separate review/acceptance concern. The inspected AX interfaces do not supply an atomic check-and-send primitive. Do not treat the in-flight approval as authorization for that distinct race.

A cooperating target-side transactional protocol could be investigated separately, but would require a defined shared revocation/commit boundary and target-side enforcement—not another target-side pre-call check. It would not be ordinary AX support for TextEdit/arbitrary apps, and a fixture-only protocol must not be passed off as the requested general mechanism. That architectural work is outside this narrow proposal.

Alternatively the user may explicitly choose a narrower release scope and separately review the actual non-atomic AX cancellation contract. This document does **not** recommend silently weakening Stop/expiry guarantees, redefining dispatch to mean validation, or increasing deadlines. Under the unchanged requirement and presently inspected public AX path, keep Task C blocked and visual execution unavailable. An AX-only release also still owes its own safety/native review and an explicit disposition of the original no-AX canvas requirement.

## Verification and next evidence

Performed by the initial feasibility investigation (before the hardening above):

- Read the active plan, runtime guide and full acceptance ledger; traced native capture, fixture, semantic approval/dispatch, protocol/core vision gate and helper termination source at the stated revision.
- Read public AX header/documentation evidence; no live desktop access, capture, AX operation, provider call or permission request.
- Ran `node --test apps/app-desktop/scripts/build-native-computer.test.mjs`: **8 passed, 0 failed**. These are source/build contract checks; the existing pre-call ordering assertion does not test atomicity.
- `git diff --check` and `git diff --no-index --check /dev/null docs/native-computer-visual-ax-design.md` reported no whitespace errors; local Markdown links resolved. Only this document was written by this investigation. Existing untracked CI files and concurrent tracked web/API/core edits observed at final status were left untouched; the findings above remain pinned to `abdcc89f`, not a review of those concurrent edits. No new native regression was run or claimed, and no Mac SDK/signed-app result follows.

Before any extension is authorized, review the privacy cohort and dispatch boundary independently. Subsequent implementation tests must cover empty/ambiguous/wrong-window AX resolution, unsupported action, public/sensitive ancestry, stale ref/frame, pixel edges/transforms, movement/scale/occlusion, process/window replacement, approval changes, expiry/Stop during model wait and dispatch, blocked AX/late completion, lost/duplicate receipts and no uncertain replay. Retain explicit no-AX-canvas refusal and zero-image AX happy-path tests. Native suspension/queued-request evidence must not be substituted by mock success or another passing pre-call-check test. Do not ask the Mac operator to discover or implement a missing safety primitive; this remains an engineering blocker.
