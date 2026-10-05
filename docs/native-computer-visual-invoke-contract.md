# Screenshot → AX invoke: implemented bounded contract

## 1. CURRENT status and scope

Implemented for computer profiles and normal chat; **not native/release/pilot accepted**. This supersedes the design-only contract inspected at `26568f55` and the earlier feasibility blockers at `abdcc89f`. User approval covers accessibility-backed workflows including screenshot-guided AX, defers the original no-AX canvas, accepts best-effort Stop including handoff, and permits separately consented packaged verification before pilot acceptance. No release flags, provider route, image policy or budget were enabled/changed by these decisions.

The [single final Mac checklist](native-computer-mac-handoff.md) owns operator verification. [The ledger](native-computer-acceptance.md) separates portable/source evidence from native effects and preserves prior failures.

## 2. Closed public renderer and signed admission

`Fixture.swift --variant visual-invoke-v1` creates one opaque, borderless, nonresizable 480 × 240 point window titled `Brian Public Shapes v1`, identifier `brian-public-shapes-v1`. Exact arguments only: no supplied text, asset, seed or layout. The adjacent bundle remains `com.usebrian.NativeComputerFixture`.

Three ordinary `NSButton`s draw outlined triangle/circle/square in a private window-lifetime permutation. AX exposes neutral `Option 1`–`Option 3` / slot identifiers, not a shape map. Ordinary target/action AX presses update the fixed result label (`None`, `Triangle`, `Circle`, `Square`). A concrete chat request is (the exact wording is required only by the legacy diagnostic task runner):

> Activate the outlined triangle; finish when Result is Triangle.

This is not a hidden click backdoor or arbitrary canvas support. The old no-AX `SafeCanvas` is unchanged, unsupported for execution and explicitly deferred.

**The reviewed-renderer pin is implemented, not an unwritten packaging gap.** `sign-mac-app.mjs` includes the fixture executable in normal nested signing. Both its executable and bundle signing targets use the empty native entitlement profile and hardened runtime, never inherited Electron allowances; packaging verifies the signed empty profile before accepting hashes and again after sealing. `mac-release-bootstrap.mjs` verifies its Developer ID signature/identifier, required architectures and sealed plist/resources; derives selected CodeDirectory hashes; and rechecks captured bytes. It stamps the sorted one/two 20-byte CDHashes into the helper's fixed 80-byte `__DATA_CONST,__br_visual` record alongside the bootstrap approval record, before final helper signing. Post-sign checks verify record/page coverage, unchanged fixture records and outer sealing. Ordinary signed helpers cannot be patched as an alternative workflow.

`BootstrapApprovalAnchor.c` exposes the mapped record. `ProcessTrust.visualFixtureValid` checks the exact adjacent executable, fresh process birth, parent trust and helper-owned CDHash requirement against **both the running guest and static seal**, with team/identifier constraints. Same-team replacements, title/identifier spoofing or a copied fixture are not sufficient. The normal build signs fixture → pins/signs helper → seals outer app; no ad-hoc acceptance flags or new signer provisioning.

## 3. Privacy and geometry

The cohort requires a dual control/capture grant, either profile `purpose: 'chat-tools'` with no goal or the legacy exact-goal contract, a complete six-node public tree, exact known content/roles/geometry/actions, single application window, no sheet and current pinned process/window identity. Capture remains selected-window ScreenCaptureKit, never full desktop; existing foreground, occlusion, containing non-rotated display, layout, permission and before/after authority checks remain. TextEdit/forms/unknown or secure content are not newly capturable. The old safe-canvas capture policy stays distinct; it does not grant an executable action.

The **localized content-attribute fix** is deliberately narrow: `VisualPolicy.contentAttributes` checks AXTitle/Description/Help/Value and minimized/modal content/state. Optional unsupported/no-value attributes may be absent; failed reads refuse; present text must be empty or match expected exported content (help empty), minimized/modal must be false. Required content still comes from the closed cohort predicate. Localized role descriptions and optional OS relations are not pixel content and do not independently authorize or reject capture. Privacy rests on the exact pinned renderer plus the closed live tree, not a generic AX metadata allowlist or model assertion.

## 4. Implemented public wire and private approval

Backward-compatible optional public fields:

- Capabilities: `visualInvokeVersion?: 1`; raw `input` remains false.
- Observation: `captureCohort?: 'public-shapes-v1'`.
- Action: strict `visualInvoke { kind, target, observationId, frameId, x, y }`, separate from retired `click`. Coordinates are finite nonnegative image pixels and merely a resolution proposal.

The private `VisualApprovalSchema` / `NativeVisualApproval` is strict:

```ts
{
  bindingId: string,
  commandId: string,
  frameId: string,
  action: { kind: 'invoke', target, observationId: string, ref: string }
}
```

Swift's typed `VisualApproval` returns this DTO only from native `beginVisualApproval`. Legacy approvals remain boolean; visual approval cannot accept a boolean or a model-supplied resolved action. Desktop `freezeBinding` parses it, checks command/frame/observation/target equality and freezes nested action/target. The controller displays the **resolved ordinary invoke**, not approval of an unbound pixel; private binding context is retained for end/execute and cleared on denial/consumption/teardown. The binding is not model, renderer or relay authority.

## 5. Native resolve → approve → consume → ordinary AX execute

1. Begin binds immutable command fingerprint, lease and retained deadline, reserves the single visual attempt and requires the exact frame/current observation. Transform pixels using the original frame bounds/dimensions; reject out-of-bounds rather than clamp.
2. Resolve exactly one enabled public AXButton with `invoke`, containing the point. Float-converted hit-test must agree; `AXUIElementCopyElementAtPosition` must return that exact element, with unique membership and matching PID. No parent promotion, guessed ref or nearest-target repair.
3. Native `VisualBinding` retains command, lease, resolved invoke, original frame, original capture/observation monotonic times, element/window/process identity and point. Validate before returning typed private approval.
4. End-approval requires exact command/lease/binding echo and fresh authority. Restore only the approved window and revalidate. Dialog input time may change, **capture and observation ages do not**. Denial spends the lease's attempt, not a fresh opportunity.
5. Consume terminates the attempt before validation/dispatch, requires approved binding and exact fingerprint, then feeds the resolved action through ordinary semantic `AXUIElementPerformAction(..., kAXPressAction)`. No CGEvent/coordinate emitter or parallel executor. Post-action AX evidence must establish the requested result (for example `Result = Triangle`); a receipt alone is not completion.

Freshness is five seconds from **original capture and observation**, including model wait and human approval. New/replaced evidence, geometry/layout/occlusion change, window/process/sheet change, missing permissions, Stop or channel loss invalidates authority. Revalidation never renews clocks. Command/grant deadlines, watchdog and uncertainty journal also remain.

## 6. Normal chat, one attempt, policy and Stop

`computerCapture` and `computerAct` operate within the normal chat loop, not an autonomous task/goal runner. Capture requires the exact public cohort. Server-side frame binding and native policy prevent neutral-slot semantic guesses and limit capture/visual invocation to one attempt per lease. Original evidence ages are not renewed.

Screenshot bytes stay in bounded process memory. Ordinary tool events/history carry opaque references. Immediately before each actual upload, the engine validates the authoritative current provider/model, live profile/lease/consent, original age and approved budget. Unsupported, expired, foreign or revoked references are withheld, including on replay/failover. The strict image-chat mode admits normal tool history without changing the legacy strict task-inference contract. Only verified complete output may reach the tool executor.

Consumed image calls settle durably against validated usage and observed model identity before output publication; Stop cannot erase their accounting. Unknown evidence stays unpriced for reconciliation. Ordinary chat consumers exclude separately settled image usage. No provider substitution, budget increase or uncertain action replay occurs. AX-only operations upload no image.

Stop remains local and independent of provider/network/accounting. **Approved semantics are best-effort through action handoff, not only after an action has already been sent.** A final check is not atomic with AX; macOS may receive/finish work despite Stop. No cancellation/drain promise, deadline extension or raw-input restoration follows. Late results cannot restart planning, return a fresh observation or cause another action. Unknown effects remain fenced; exact cached metadata is not redispatch. Helper death remains required for lease release, not proof of cancellation of target-side work.

## 7. Temporary packaged verification admission

**Connect computer** obtains explicit attended-verification consent in trusted main when needed on packaged Mac with `NATIVE_COMPUTER_ENABLED=true`. No separate verification button or pilot flag is required. Main rechecks account/workspace/generation and fresh TCC/capabilities before connecting. Each chat gets its own locally approved window grant; known Release discards that authority while preserving metadata connectivity. Stop, uncertainty and context changes disconnect. Inspector remains local read-only/no-capture, with no task or API pairing.

## 8. Verification boundary

Portable tests exercise policy and extracted actual begin/end/consume/execute, strict typed responses, binding/age/geometry refusal, pin stamping/coverage, no replay and Stop-after-entry. The profile extension's Foundation visual suite passed 298 checks; Foundation and syntax parsing are not AppKit/TCC/native effect evidence. The ledger records review findings, fixes, source suites and earlier failures. Current signed package, native tree conformance, real image request/settlement and observable effect results remain to be verified via the single handoff. Actual defects return to engineering; there is no outstanding unwritten renderer pin or atomicity design requirement.
