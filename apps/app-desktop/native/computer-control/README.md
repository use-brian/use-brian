# Killable macOS native helper

## Current R2 semantic task boundary

This section supersedes historical disabled-authority and canvas descriptions below. Supported signed-package admission passed operator evidence. This patch does not alter bootstrap, signing, admission budgets or desktop flags. Native semantic task acceptance remains pending; portable tests are not live Mac evidence.

- Fresh-helper `capabilities` is metadata-only: all capabilities false, permissions unknown, no Broker construction or permission queries. Start/execute/approvals refuse before discovery.
- Only explicit `listTargets` lazily initializes the retained Broker. Main must refresh capabilities afterward. The event tap is created only when AX is already trusted; the helper never prompts. Later AX readiness requires both AX permission and an enabled tap. Screen Recording permission is not queried.
- Start requires an exact valid grant/lease, exactly one discovered live target, enabled takeover monitoring and successful scope subscriptions. Capture grants are rejected, never silently narrowed. Read-only grants retain no-activation inspection and empty snapshot actions. Only explicit `allowControl=true` consent permits foreground restoration, after scope monitoring and watchdog activation.
- After discovery, capabilities may advertise `semanticActions` when AX and the takeover tap are ready. Supported actions are TextEdit writable document text assignment and existing fixture public form/menu presses, writable text, row/radio selection and vertical semantic scrollbar steps. Enabled/native-support/cohort/privacy gates determine node actions; window chrome is excluded.
- Every semantic effect requires exact per-action approval and fresh complete whole-window state, target/identity/epoch/lease/deadline validation, reachable unchanged refs, geometry/layout and foreground ownership. Approval binds every command field, is cleared on cancellation and consumed before dispatch. The command journal prevents retrying uncertain effects.
- Capture, coordinate input, keys and generic focus remain disabled regardless of control grants or approval. Sensitive/unknown nodes remain redacted; partial/truncated observations allow inspection, not effects. Sheets/new windows revoke scope rather than authorize an escape.
- Existing parent/channel, permission-loss, takeover, lock/sleep, deadline and window/sheet scope fencing remain. Failed/malformed child reads mark observations partial. `attributeUnsupported` is accepted as an absent leaf only for a closed public leaf role/subrole after independent successful AX attribute-name enumeration omitting `AXChildren`; containers remain partial. Revalidation preserves declared-vs-absent membership, including declared-empty lists, so an existing child attribute cannot silently disappear. A failed start after scope-monitor installation requires a fresh helper.
- Desktop permission UI, opt-in, readiness lifecycle and the existing API/relay authorization path remain desktop integration responsibilities—not a new local planner/service. Package admission and its budgets are unchanged.

Verification: `node smoke.mjs --portable`, `node wire-boundary.mjs --foundation` (working Swift/Foundation toolchain), and `node --test build-contract.test.mjs`. Foundation tests execute extracted production wire validation, dispatcher, exact approval matcher and semantic node policy with recording backends, including grant combinations and disabled action classes. Source placement tests cover Broker approval/effect gates and unconditional scope termination. These do not compile AppKit/Security or exercise native effects. Signed-parent `smoke.mjs --probe-only` deliberately sends no discovery and remains permissionless.

Remaining native acceptance after desktop integration: signed-package compilation, AX attribution/tap readiness; inspector Start without activation; control Start restoring only the selected window; exact approved TextEdit assignment and fixture form/selection/menu effects with fresh post-action observation. Verify cancellation, forged/changed approvals, stale/partial/secure/truncated state and growth before begin/end/dispatch, target/layout/sheet changes, permission loss, Stop during blocked AX/approval, physical takeover and lock/sleep. Menus outside the granted subtree must refuse. Capture/input/focus/key requests must remain denied. Desktop UI/flag policy is separately owned; no acceptance flags or live Mac results are claimed.

## Historical implementation and acceptance notes

**The user reports successful current-architecture Mac compilation and unsigned bootstrap refusal for the v2 preflight. This Linux workspace cannot reproduce that run; signing, positive parent trust, TCC and operational acceptance remain unverified. Keep the pilot disabled.**

**Active delivery scope: macOS only, per user direction.** Windows/Linux are deferred; their historical implementation, failures and broader-plan requirements remain recorded, but are not gates for finishing the current macOS scope. No macOS safety, bootstrap, input-guardian, oracle/drain, genuine vision, fresh modal authorization, cohort or live-provider gate is waived. The user will run Mac tests personally. Commit/push/PR authorization is conditional on verified macOS scope; that condition is not yet met. Gates remain off and the helper remains probe-only.

## User-run first Mac pass

The first Mac pass is **current-architecture compile/typecheck and negative bootstrap refusal only**, following [MAC-PREFLIGHT.md](MAC-PREFLIGHT.md) and `mac-preflight.sh`. The source-only nine-file handoff is `/workspace/brian-mac-preflight.tar`, SHA-256 `1bd660cc6b2c980c54f0e113b3e375e27771e8d2ec2da28f8430d334e2fc3366` (integrity, not authenticity). No fixture launch, permission grant/request, developer signing workflow, network/install or authority enablement belongs to this pass. The unsigned/ad-hoc helper normally rejects its **own signature before parent checks**, so exit 77/zero stdout does **not** prove parent trust. Negative smoke sends no requests, keeps stdin open and drains through child **close**, not merely exit, with bounded deadline/cleanup tests. The first bundle failed helper compilation while fixture typechecking passed. The v2 bundle (`/workspace/brian-mac-preflight-v2.tar`, SHA-256 `1ea2e267c2b8cd7802b2f8235e812e64025511ebf7073db5dc67aaf35bcfc681`) corrects the explicit trust dependency and sheet-role traversal and removes the ineffective activation option. The user reports v2 preflight **PASS**, an unsigned-artifact warning only, and empty fixture typecheck output. The supplied toolchain is arm64 / macOS 26.6.2 / SDK 26.5 / Node 25.5.0 / Swift 6.3.3 / Apple clang 21.0.0, with the script's Swift 5 language mode and macOS 14 deployment target. No x86_64, Rosetta or universal run was reported. That v2 result predates the new kernel-signing snapshot/probe source. This clears the reported current-architecture compile/refusal checkpoint, not any operational or signing gate.

The user subsequently reported v3 status15 with no helper/fixture compiler errors. Source review found the older ABI wrongly treated newer XNU's original-parent-generation field as reserved. V4 corrects that defined field, preserves other reserved/stability checks, and separates malformed identity/slice/hash status codes. The user reports v4 **PASS**, including `kernel_data:true`, `static_match:true`, `untrusted_status:true` and `production_authority:false`, on the same arm64 toolchain; see [KERNEL-SIGNING-PROBE.md](KERNEL-SIGNING-PROBE.md). This verifies only the reported self-process signing-data checkpoint, not loaded-framework or parent trust. This is not a permission or authority workaround.

A separate [opt-in library-constraint format handoff](MAC-LIBRARY-CONSTRAINT-FIXTURE.md) compiles and ad-hoc-signs only a disposable inert file, never executes it, and exports its constraint format with fixed policy/tool provenance. No developer credentials are required. The user successfully collected the native format on arm64/macOS26.6.2 build25G83. The exact fixture is retained, and a separate strict observed-profile policy comparator passes it alongside synthetic negatives. Production DER verification remains unsupported: observed format comparison is not native enforcement or signer trust, and does not change helper admission or existing app signatures.

The user has since clarified that a working certificate and Electron release signing workflow are available; provisioning is not a current blocker. The historical [credential-free library-load diagnostic](MAC-LIBRARY-LOAD-PROBE.md) used a separate explicit opt-in to execute only disposable generated C runners/dummy libraries, comparing baseline and exact-cdhash-constrained loads. The user reports all four native cases passed on arm64/macOS26.6.2 build25G83: both baseline libraries loaded, constrained/approved loaded, and constrained/disallowed returned `dlopen-null`. The exact report is retained with all acceptance/authority flags false. This cannot establish production category/team trust or authorize the helper; Developer-ID and signed Electron acceptance remain open.

`LibraryConstraintPolicy.swift` supplies a source-only counterpart to the strict JS observed-envelope comparator. Parent Linux Foundation execution in Swift 5 language mode matched JS on 3,046 labeled vectors (14 matches), alongside 168 combined Node tests. This is not Mac SDK or enforcement acceptance of the new Swift file; it is now compiled by the native build but is not wired into operational admission. The private test runner is `library-constraint-policy.mjs --foundation`; `--portable` explicitly skips Swift execution.

`MachOLibraryConstraint.swift` adds bounded SHA256 CodeDirectory/page/slot-11 extraction against separately supplied kernel hash/slice data and architecture context. Parent Linux execution with Apple swift-crypto passed 5,347 vectors (46 matches, three intentional stricter-than-JS rejections), plus 288 combined Node tests. The reproducible Nix command is at the top of `macho-library-constraint.mjs`; the test-only temporary source replaces the CryptoKit import, not its cryptographic implementation. This is not Mac CryptoKit/SDK or loaded-code acceptance.

`BootstrapApprovalAnchor.c/.h` defines an initially empty, refusing 1,376-byte volatile `__DATA_CONST` approval record for the pinned Electron version, ASAR dictionary digest and exact approved library-hash inventory. `scripts/mac-bootstrap-anchor.mjs` supports bounded unsigned/linker-only pre-sign stamping and read-only signed-page coverage checks, never CMS authentication. The native build now links the empty C anchor and compiles the Swift extraction, policy, binding and own-symbol-reader modules. Operational admission and signing-hook integration remain absent. Required future order: finalize nested libraries, independently establish the complete inventory and ASAR digest, stamp the helper, sign the helper, then sign the outer app. `BootstrapApproval.bind` now checks an own-mapped record against the exact signature-covered section in captured helper bytes, using separately supplied kernel hash/slice and architecture context. The own-symbol bridge has no alternate source. Parent verification passed 6,286 Linux Swift Crypto vectors (135 matches, including 756 binding cases/26 matches), in separate compilation units, both unoptimized and `-O`, plus bridge typechecking against the production C header. Runtime still needs actual fresh kernel/static-signature provenance and flags/entitlements/generation enforcement around this pure binding; an anchor or caller-provided inventory alone is not authority. Injected Linux C vectors do not verify Darwin section layout. The helper remains probe-only.

`BootstrapProcessBinding.swift` now composes fresh fixed-self/direct-parent kernel data, offline dynamic and selected-slice Developer ID Application checks, bounded captures, the own-symbol approval binding, exact parent constraint comparison and ASAR dictionary hashing. Missing XML/DER entitlement metadata is refused; the helper has a closed no-positive-entitlement profile. Repeated snapshots/metadata/capture checks are not atomic attestation. Its five-second checkpoint budget cannot interrupt blocked calls or extend existing client/watchdog limits. This collector is compiled but not invoked by the dispatcher: loaded framework/embedded-digest binding, independently complete inventory, signing integration and native acceptance remain open. Parent332 Node tests,359 Linux Swift Crypto policy vectors plus supplementary assertions in both optimization modes, and975 desktop tests/50 files passed. Mac-target parsing is not Security/Darwin typechecking. The user reports v6 PASS for its18-file Mac compile/refusal/self-comparison handoff, covering compilation of these sources but not collector invocation, positive signer validation or operations. That immutable archive does not cover later changes.

After v6, `ElectronFrameworkBinding.swift` and the shared Mach-O parser now verify every captured framework slice against the approved library hashes, signature-covered ASAR digest and fuse wire. Both collector framework checks use the independently bound own-helper approval. The build/manifest now includes this module (19 files); no new Mac archive was requested. Parent executed210 framework vectors (50 matches) under Linux Swift Crypto, both optimization modes, and reran the unchanged5,347/6,286/359 corpora. These do not attest the actual loaded framework.

Release-only `scripts/mac-bootstrap-inventory.mjs` captures candidate libraries and can conditionally obtain a scoped immutable CMS-checked inventory via the separate read-only `BootstrapInventoryVerifier.c` backend. Its fixed-path adapter uses bounded private pipes, actual close and post-verification recapture. The explicit `scripts/build-bootstrap-inventory-verifier.mjs` build is separate from this helper/preflight and performs no signing. Parent476 Node tests and a separate injected-CF C test pass; the new verifier has no actual Mac SDK/Developer-ID acceptance yet. Final inventory approval still always refuses pending dependency/bootstrap/JS closure and signing integration. Control remains disabled.

For maintainers reproducing the Linux-only Swift check from the repository root, use a development environment with both compiler and runtime link inputs (a bare compiler-only shell is insufficient):

```sh
nix --extra-experimental-features 'nix-command flakes' develop --impure --expr '
  let p = import (builtins.getFlake "nixpkgs").outPath {}; in p.mkShell {
    nativeBuildInputs = [ p.swiftPackages.swift ];
    buildInputs = [ p.swiftPackages.stdlib p.swiftPackages.swift-corelibs-foundation
      p.swiftPackages.swift-corelibs-libdispatch p.swiftPackages.swift-foundation ];
  }' --command node apps/app-desktop/native/computer-control/library-constraint-policy.mjs --foundation
```

## Historical unconditional probe-only authority barrier (superseded)

The shipped macOS helper now refuses **all operational authority**, even from a parent that passes the current signature/path/channel checks and even if Main/API/acceptance flags are ignored or enabled. Those flags did not protect direct private-protocol access while loaded-framework binding was unenforced.

The entry point never constructs the operational `Broker`, installs its event tap or dispatches its methods. Strict framing, wire validation and existing parent/private-channel checks remain. `capabilities` reports all four authority bits false, both permission statuses `unknown`, and the fixed limitation `Native authority disabled: parent loaded-framework proof is unenforced.` No permission query or prompt is made. `listTargets` returns an empty array without AX/NSWorkspace target enumeration; `start` and both approval methods return false; every valid `execute` returns `denied` / `not_executed` before target lookup, focus, AX or capture. There is no environment, acceptance or test override.

Private diagnostics negotiation remains (`diagnosticsVersion: 1` on capabilities). Optional timing covers only probe/refusal handling, never an API call. The retained operational Broker and its timing sites are unreachable, not evidence of native execution.

Run `node wire-boundary.mjs --portable` for source checks and `node wire-boundary.mjs --foundation` with a functioning Swift/Foundation toolchain for verbatim production dispatcher tests with operation traps. The latter runs with flags absent, false and true; validates direct requests and all action classes, refusals, strict malformed requests and root-only diagnostics. It does not link AppKit/Security or establish native acceptance.

`smoke.mjs --portable` remains portable; `--bootstrap-negative` tests bootstrap refusal only (`--parent-negative` is a legacy alias), not parent authentication: unsigned/ad-hoc helpers reject their own signature first. The signed-parent smoke now tests only probes/refusals (`--probe-only`), requires no fixture or permission grants, and rejects old operational smoke modes. It has not been run on macOS here.

**Full bootstrap implementation and acceptance remain open.** Removing this barrier requires real OS-backed loaded-framework/main binding, fail-closed signed constraints and exact allowed-code/fuse verification, race/architecture/entitlement testing and native acceptance. Static paths, inodes, signature/fuse checks, policy markers, permission readiness or successful probe smoke are not that proof. No always-true attestation is supplied. Main feature gates stay off; all release/Stop/input-ownership requirements below remain.

The remaining operational descriptions and fixture scenarios below document the **unreachable implementation and future acceptance requirements**, not currently available helper features. Old action/growth smoke modes must be restored and reviewed only after the authority barrier can legitimately be replaced.

`bash build.sh` uses the macOS 14+ SDK and emits `build/brian-native-computer-helper` and `build/NativeComputerFixture.app`. Optional `CODESIGN_IDENTITY` signs artifacts, but standalone development builds cannot act: a signed packaged desktop parent is mandatory. `build.sh` compiles the small libproc identity shim and links Security. Desktop packaging includes/signs the adjacent fixture and retains helper signing; release verification checks their signatures against the main app’s team. None of this substitutes for notarization and TCC acceptance.

## Coordinate input release defect

macOS previously posted down then up separately; SIGKILL or `_exit` between them leaves no surviving release owner. The emitter was removed rather than claiming a paired post is atomic. Coordinate input is unconditionally disabled (`input=false`), and raw private `click` execution is refused independently of client filtering, approval and every acceptance/environment flag. Capture and semantic AX code remains unreachable behind the probe-only barrier. P5 is not complete. Before restoring input, implement a surviving release guardian with provable synthetic-versus-physical press ownership, termination-safe handoff/drain and lease fencing. It must release only owned presses, survive helper/parent death, and prevent late events or a new owner until release is confirmed. Test partial delivery, physical press/release overlap, takeover, Stop/kill at every down/up boundary, guardian failure, blocked workers, lock/sleep, deadline/relay loss and lease reacquisition on real native systems. Do not weaken attribution, Stop or lease requirements. Source checks and cross-compilation/parsing are not native acceptance.

## Checks

Portable checks (no native execution or Swift type/API validation):

```sh
node --check smoke.mjs
node smoke.mjs --portable
node --test ../../scripts/build-native-computer.test.mjs ../../scripts/electron-fuses.test.mjs
nix --extra-experimental-features 'nix-command flakes' shell nixpkgs#swiftPackages.swiftc --command swift-frontend -parse Helper.swift
nix --extra-experimental-features 'nix-command flakes' shell nixpkgs#swiftPackages.swiftc --command swift-frontend -parse Fixture.swift
```

The Swift commands perform **syntax parsing only**, without AppKit type/API checking, linking or execution. Portable smoke checks framing, source invariants and JS UTF-16 test vectors; it does not execute the Swift limiter or establish native safety.

### Parent trust and smoke limitations

The helper exits **77 before protocol output** unless its inherited pipe parent is the signed `ai.usebrian.desktop` main executable, with the same non-root real/effective/saved UID and the same Apple-issued signing team as the signed helper. Unsigned, ad-hoc, shell/Node and generic Electron parents cannot obtain discovery, grants, AX effects or capture. There is no environment/dev bypass or new permission prompt.

Identity comes from kernel `proc_pidinfo`/`proc_pidpath` (credentials, executable and process birth), then Security’s PID guest lookup, **dynamic** `SecCodeCheckValidity`, static seal validation, signed main-executable URL and signing requirements. Canonical executable paths must have this exact relationship (installation directory may vary):

```text
Use Brian.app/Contents/
  MacOS/Use Brian                         # ai.usebrian.desktop
  Resources/computer-control/
    brian-native-computer-helper
    NativeComputerFixture.app/Contents/MacOS/NativeComputerFixture
```

Escaping symlinks, sibling/prefix paths, copied fixtures elsewhere and wrong teams fail closed. Bundle IDs, AX titles and mutable app metadata do not establish cohort membership. TextEdit must execute `/System/Applications/TextEdit.app/Contents/MacOS/TextEdit` and satisfy `anchor apple and identifier "com.apple.TextEdit"`; a developer-signed clone is not Apple system TextEdit. The adjacent fixture must satisfy the helper/main team requirement and its signed fixture identifier. Root/elevated/cross-user helper, parent and target processes are denied. Kernel birth/path identity is pinned across enumeration and later use; failed/short kernel reads or signature queries deny access.

Parent and target identity are revalidated for grants, approval/restoration, dispatch and before/after capture, not only discovery. Canvas title/identifier/AX completeness remain additional restrictions, never proof that arbitrary fixture-ID pixels are harmless. Validation is not an atomic transaction with AX/SCK; real-device replacement/race and signature-validation latency tests remain mandatory. Static seal checks may be expensive and fail existing freshness/deadline limits; do not relax those limits to hide a failed native test.

### Electron bootstrap is a separate trust requirement

**ASAR packaging prerequisite, not loaded-image proof:** `mac-asar-integrity.mjs` and updated `electron-fuses.mjs` implement the pinned Electron **43.2.0** integrity-dictionary embedded digest, written before framework signing with all-architecture structural slot validation/readback and read-only post-sign page-hash coverage verification. Research found Electron’s `used=false` bypass; populating/verifying the digest closes that packaging prerequisite, not kernel-CDHash/library-constraint binding or proof of the loaded image. This slice changes neither `Helper.swift` nor the C identity code and does not remove the authority barrier. Parent **40 focused local Node tests** across preflight/digest/fuses and a **975/50 desktop rerun** (`/tmp/native-parent-mac-digest-desktop.log`) passed; these overlap earlier selections and are not Mac compilation, signing or native acceptance.

A signature and team ID **alone do not prove a secure Electron bootstrap**. A legitimately signed Electron runtime can otherwise execute attacker JavaScript via RunAsNode, Node environment preload options or the main-process inspector. macOS `afterPack` now uses the supported `@electron/fuses` API **before credential lookup or signing**, with:

- `FuseV1Options.RunAsNode = false`
- `FuseV1Options.EnableNodeOptionsEnvironmentVariable = false`
- `FuseV1Options.EnableNodeCliInspectArguments = false`
- `FuseV1Options.EnableEmbeddedAsarIntegrityValidation = true`
- `FuseV1Options.OnlyLoadAppFromAsar = true`

Official references: [Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses), [fuses API](https://github.com/electron/fuses), [ASAR integrity](https://www.electronjs.org/docs/latest/tutorial/asar-integrity). The exact API includes the `Enable` prefix on three options. Disabling Node options also disables `NODE_EXTRA_CA_CERTS`; no production behavior relies on injecting Node options/certificates that way. No ad-hoc reset or environment opt-out is used to confer authority. The hook returns before any fuse work on Linux/Windows (embedded ASAR validation is unsupported on Linux).

`afterPack` verifies the API readback **and every Mach-O architecture** of the fixed bundled Electron framework; the API's first-wire read alone is insufficient for universal binaries. Missing, duplicate, unsafe, removed, unknown or truncated wires/states fail packaging. Only the reviewed v1 schema (8 or 9 fuses) and arm64/x86_64 framework slices are accepted; upgrading the schema requires review. Unrelated fuses (including cookie/file-protocol behavior) are not changed. `afterSign` independently re-verifies without repairing anything. Both verify electron-builder's `ElectronAsarIntegrity` SHA256 against the actual `Resources/app.asar` header, canonical paths and the packed, integrity-protected `package.json`/`dist/bootstrap.js` entry point. Missing ASAR or integrity metadata fails; a loose-app fallback is not allowed.

**Runtime decision: packaging checks alone are insufficient.** Before attesting the bundle, the hook writes `BrianElectronFusePolicy` into the plist only after successful verification. The subsequent parent signature seals that policy. On every parent authorization check the helper requires this policy and ASAR integrity metadata from **Security-validated signing information**, not mutable app metadata; checks the parent's nested seals; and independently checks the canonical framework's same-team signature and actual fuse bytes on all slices, with fresh signature/process validation afterward. There is no cached fuse/signature verdict sufficient for later side effects. A legacy signed main without the sealed policy cannot borrow a new framework or claim its earlier launch was hardened. Missing metadata/framework, unknown formats, races detected by signature/path/process revalidation or errors refuse authority.

The framework is checked as its **own static bundle**, with strict resource/seal validation, all architectures, a same-team requirement and a Security-reported main-executable path matching the canonical file, both before and after the bounded file read. The launcher’s signature or default nested requirement check is not substituted for that. Exactly one wire per architecture, no extra sentinel in file padding, identical wires across architectures and explicit known states are required.

**Remaining loaded-image gap:** these checks validate the current **on-disk** framework, not the identity or fuse state of the dyld image already mapped in the parent. Restoring a hardened signed framework on disk after loading a different image is a distinct tampering case; neither the static checks nor the policy marker prove loaded-library identity. That case is not enforced here and remains a security acceptance/release blocker pending native evidence or an appropriate OS-backed loaded-image binding design. No additional task-port privilege prompt or speculative API was added.

This is defense in depth, not remote attestation of every loaded instruction or an atomic snapshot with AX/SCK. It relies on the trusted signer following the verified packaging pipeline and on macOS code-signing enforcement. Framework scans/nested seal validation add cost: measure on real hardware without weakening existing lease/deadline/freshness gates. The five fuses restrict Node bootstrap/inspector paths; they are not a claim to disable Chromium renderer DevTools or to make arbitrary application IPC safe.

Runtime process-launch review found no `child_process.fork`/RunAsNode dependency in desktop, browser-control or the Firefox companion. Firefox still launches the packaged executable into `dist/bootstrap.js`, selects native-host mode from its existing Firefox arguments before importing GUI main, and can spawn the normal desktop deep link. Native helper and updater/platform launches use ordinary executable `spawn`/`execFile`, not Electron-as-Node. Bootstrap, browser code, IPC and helper-client code were not changed. Packaged native-host framing/deep-link launch and ordinary browser/preload behavior must still be tested on a real Mac.

#### Mandatory native bootstrap negatives (not run here)

Use disposable copies of a correctly signed, hardened package on each supported architecture, including both slices/Rosetta of a universal build. Run the actual `Contents/MacOS/Use Brian` executable, with no existing instance masking startup. Never relax signatures or use production accounts for these tests.

1. Set `ELECTRON_RUN_AS_NODE=1` and supply a harmless sentinel script / `-e` that would create a local marker if executed. It must not execute as Node or acquire a private-helper session.
2. Set `NODE_OPTIONS=--require /absolute/probe.cjs`, then `--import` to a probe module. Also try a Node preload argument on the CLI. Probe code must never run; normal packaged startup may continue or refuse. Verify the native-host launch is also unaffected by malicious environment preload.
3. Launch with `--inspect`, `--inspect-brk`, `--inspect-port` and send `SIGUSR1`. No main-process inspector/debugger execution may become available. Test actual socket/debugger behavior, not just stdout. Renderer DevTools is a different feature and is not covered by this fuse claim.
4. Replace `app.asar` with an untrusted archive, modify its header, and separately modify a bootstrap payload block while keeping the header unchanged. No attacker code may run; integrity/seal errors must refuse helper authority. Remove `app.asar` and supply `Resources/app` or `default_app.asar`; neither may be loaded. Include symlink escapes.
5. Test a same-team legacy/unhardened parent, missing/tampered policy marker, altered single fuse, unsafe second universal slice, missing/removed/unknown wire, and framework/ASAR replacement after discovery and during approval. The helper must refuse effects/capture, not accept an earlier cached verdict. Do not re-sign malicious copies with release credentials; signature-tamper rejection and a separately authorized test-signing environment are distinct acceptance cases.
6. Loaded-framework restoration: in an authorized isolated native test environment, launch with a different/unsafe mapped framework, then restore the correctly signed hardened framework **on disk** before helper startup, and again between approval and dispatch. Do not count static fuse/signature success as proof of the loaded image. Demonstrate OS prevention or bind/refuse the actual mapped image before clearing this remaining security gate. No such native result is claimed.
7. Positive compatibility: hardened signed main, adjacent fixture and actual system TextEdit; Firefox native-host framing and open-control deep link; ordinary browser navigation, sandboxed preloads and capture. Input remains false. Record startup/signature-check latency, OS/Electron version and all failures.

Portable tests run the actual fuse API on **synthetic** thin/universal framework files and construct real test ASARs; signing-hook tests mock OS tools. These are not real Electron execution, macOS signing, SDK compilation or acceptance results. The native wire parser/read path is bounded to a regular file of at most 1 GiB, two Mach-O slices and nine fuses; it has source cross-checks and Swift parsing only. Real AppKit/Security linking, authenticated libuv pipes, TCC attribution and native bootstrap negatives remain external release gates.

Standalone native **negative** smoke on a Mac:

```sh
node smoke.mjs --bootstrap-negative /Applications/Use\ Brian.app/Contents/Resources/computer-control/brian-native-computer-helper
```

This requires exit 77 and zero protocol bytes, keeping stdin open and waiting for child close rather than exit with bounded cleanup. An unsigned/ad-hoc helper rejects its own signature first; this does not prove that parent checks ran or passed. It is not positive acceptance. The former standalone `node smoke.mjs --fixture-actions` recipes can no longer authorize anything. Positive protocol scenarios retained in `smoke.mjs` require integration into the signed, packaged desktop **main process**, using its packaged helper and adjacent fixture; no such harness integration or successful native run is claimed here. Running the script with generic Electron is also insufficient. An optional positional path chooses the helper but cannot bypass its tree/parent checks.

For future signed-main acceptance, explicitly grant existing Accessibility/Screen Recording permissions to the correctly attributed signed app, open exactly one packaged fixture process, leave its two windows open, and avoid physical input. Start a fresh fixture for each scenario: default safe form (`--fixture-actions`), safe canvas (`--fixture-actions --canvas`), secure (`--secure-negative`), longtext (`--longtext-negative`), and growth (`--growth-negative=begin|end|dispatch`). These scenario flags describe the retained harness logic, **not runnable standalone approval commands**. The harness selects only the fixture, checks the single process/two windows/title, and must not approve TextEdit or substitute for the production human consent UI.

Scripted macOS acceptance covers form fill → radio selection → semantic scrollbar step → mock send/delete → review sheet confirmation, with fresh AX progress checks; secure redaction, exact-command approval mismatch/rejection, wrong lease/epoch/deadline, stale observations, duplicate-label ambiguity refusal, and duplicate-effect suppression. It requests no screenshots in the form path. Canvas smoke separately checks scoped capture, raw private click refusal and an unchanged AX counter. Capture capability follows permission state; input must always be false.

These are acceptance scripts, **not results measured on Linux**. Missing native scrollbar actions or unreachable/unfocused sheet controls fail the script rather than substituting input or expanding authority. Report the macOS version, failed stage and actual AX coverage. Native popup-menu workflow, dialog focus restoration and model injection/ambiguity handling remain manual gates.

## Supported action/cohort boundary

- **TextEdit:** non-secret document `AXTextArea` value assignment only, with no sheets. No menus, toolbar invocation, selection, scroll, capture or input fallback.
- **Fixture:** `invoke` via advertised `AXPress`; `setValue` on writable non-secure text fields/areas; `select` via writable `AXSelected`, or `AXPress` on a radio button. Radio numeric state is normalized into `selected` and `value`. Checkbox presses are invokes, never mislabeled selections.
- **Fixture scroll:** only an enabled vertical `AXScrollBar` exposing `AXIncrement`/`AXDecrement`. A finite nonzero integer `deltaY` in [-600, 600] requests **one native semantic step in that direction**, not that many pixels. Missing direction/action is refused; no wheel emulation, arbitrary scroll-area or horizontal scrolling.
- **Fixture menu/dialog:** native popup and review sheet supplied. Only safe AX roles reachable under the exact granted window can be invoked. Menus/sheets surfaced outside that subtree or changing focused-window identity are refused; they do not authorize a new window. Native API behavior requires real-device validation.
- **Canvas:** capture and coordinate clicks are disabled. Retained capture code is unreachable through dispatcher/Broker execution gates.
- **Denied:** generic focus, keys, drag, clipboard, shell, arbitrary applications/windows, unsupported semantic actions and real external sends/deletes. No fallback silently broadens a cohort.

## Fixture variants

Default `safe` includes deliberately malicious app text, duplicate buttons, and mock send/delete counters, but no secure field. `secure` and `all` are intentionally partial, read-only negative fixtures; they cannot be used for the successful action smoke. Isolate variants with:

```sh
open -n build/NativeComputerFixture.app --args --variant baseline
# Also: safe (default), duplicate, approval, injection, secure, all, longtext, growth
```

Close other instances before smoke. The successful form action smoke expects `safe`; secure/long-text/growth negatives use their separate flags. Every variant includes a native text form, radio choices, popup menu, scrollable review content, review sheet (confirm/cancel), and separate custom canvas. Duplicate buttons have different local statuses but identical labels: ambiguity must cause clarification/contextual grounding, not first-label selection. Mock send/delete have no network/filesystem effects and still require exact-action approval. Injection text is untrusted observation data, never authority. Secure nodes are redacted locally; their presence makes the entire scoped observation partial and refuses all effects/capture, including on unrelated non-secret controls.

## Exact observation limits and truncation regression gates

Names and string values are limited to **4096 UTF-16 code units**, roles to **100 UTF-16 code units**, matching shared Zod/JavaScript limits. Export stops before a Unicode scalar that would exceed the limit (so a split-surrogate boundary can export 4095 units). Non-BMP characters cost two units; graphemes/combining sequences are not the unit of account. Any truncated exported name/value/role marks the observation **partial**, even if the bounded prefix is identical to a previously complete value. Internal AX strings used for identity/security comparisons are not silently prefixed.

Partial inspection remains available without effect authority. `fresh`, approval begin/end and dispatch require a **complete** snapshot. Whole-state revalidation reads **every** observed node, not only the action target: current truncation, changed semantics/values, sensitive/unknown nodes, unreachable handles or changed child/sheet membership fail closed. End approval checks current readability before consent-based foreground restoration, then compares full state after restoration. Capture remains disabled. Ref lists/advertised node actions in partial reads are inspection data, not authority.

Traversal limits remain 500 nodes, depth 16, 300 ms, 400,000 serialized node bytes and 1000 queued entries; exhausted/truncated traversal is partial. These are safety bounds, not an atomic OS snapshot or proof that an application truthfully exposes its entire content. Each action still needs live identity, geometry, lease/deadline, foreground and exact approval. TextEdit documents over 4096 UTF-16 units (or any window with another truncated/secure/unknown node) are inspection-only: no whole-document replacement of an unseen suffix. Input `setValue` also remains limited to 4096 UTF-16 units.

`longtext` starts with 2048 emoji (exactly 4096 UTF-16 units) plus an unseen suffix. Run `--longtext-negative`, let the helper exit, physically click **Mutate unseen suffix**, then rerun. Both runs must export the identical bounded prefix, remain partial, and refuse even selection of the unrelated Review draft radio. Inspect the actual suffix locally if needed; do not transmit it as test evidence. This mutation-between-runs check is a **manual macOS gate**, not established by Linux source checks.

`growth` starts with the same prefix **without** a suffix (complete boundary case). Its local **Arm complete-to-long growth (3s)** button schedules only a suffix change, leaving labels/status and the radio target unchanged. On a fresh fixture for each run, `--growth-negative=begin`, `--growth-negative=end` and `--growth-negative=dispatch` exercise growth respectively before approval begin, during approval, and after exact approval. The script must refuse the unrelated radio action, verify partial state afterward and the unchanged exported prefix. It rejects slow setup/expired-snapshot confounders; a timing failure is not a safety pass. These native scripts are unrun on Linux. Also manually cover oversized AX names/roles, surrogate boundaries and suffix mutations in actual TextEdit with no loss of unseen content.

## Private protocol and safety

Inherited stdin/stdout only (FIFO pipes or libuv anonymous connected same-user Unix socketpairs; no named/network endpoint): uint32 big-endian length then UTF-8 JSON, maximum 4 MiB. Requests `{id,method,payload}`; responses `{id,ok:true,result}`. Methods: `capabilities`, `listTargets`, `start`, `beginApproval`, `endApproval`, `execute`. No shell, network, clipboard, arbitrary selectors or test-only approval bypass in the helper.

Only enumerated live TextEdit/fixture process-launch/window instances can be granted. One grant per helper, with local lease, identity, epoch, expiry and deadline checked before effects. The parent lease uses `os.userInfo().homedir` (OS account home), not `HOME`/`USERPROFILE`, across macOS/Linux profiles and for the Windows pipe key; explicit roots are test-only. Helper launch inherits only an allowlisted environment (macOS does not inherit `HOME`). Windows retains its independent per-session helper mutex. Parent lease release must still await helper death, including blocked helpers. Opaque refs bind to the latest scoped AX observation. Traversal has time/depth/node/byte bounds and locally redacts secure/unknown subtrees. The journal prevents redispatch; errors after possible dispatch report unknown outcomes, not safe-to-retry failure.

Every effect requires the exact locally approved command. Consent permits foreground restoration at start and after the native approval dialog, not a model-callable focus operation. Approval and pre-dispatch revalidation check the same handles, child membership, semantics, values and geometry; never substitute a ref. A mutation requires fresh observation and approval. Capture additionally checks exact approved pixels. Unsupported operations remain denied.

Out-of-band SIGKILL does not wait for blocked AX. The independent watchdog checks parent death, deadlines, permissions and event-tap health. Physical input revokes; only trusted-parent approval interaction is excepted while execution is blocked. No helper coordinate emitter or blanket own-PID input exemption remains; semantic AX/capture APIs do not need either. Lock/sleep notifications and parent powerMonitor hooks revoke. These mechanisms remain subject to native acceptance.

## Mandatory manual/release gates

- Compile/link Swift + C for supported architectures using the actual macOS SDK; AppKit/Security/libproc API availability, signing/notarization, helper/parent TCC identity across install/update/revocation. Linux Swift parsing is NOT native compilation.
- Native negative matrix: spoof TextEdit/fixture bundle IDs and canvas title; wrong-team/unsigned/ad-hoc signatures; copied or symlink-escaped fixture/helper; generic Electron/wrong-ID parent; root, elevated and cross-user processes; parent/target exec, PID replacement and signature/resource tampering after discovery, before grant, during approval and before dispatch/capture. Check no effects or pixels escape. Verify real libuv stdio socketpair acceptance and refusal of named/network endpoints.
- Positive signed packaged parent + adjacent signed fixture and actual system TextEdit; measure repeated signature/seal validation against the existing freshness/deadline gates. This and AppKit/Security linking remain external gates.
- Native popup → menu item and form → sheet confirm/cancel with exact-ref approval and focused-window restoration; report unsupported AX exposure honestly.
- Actual model loop: multi-step AX success with no screenshots; duplicate-label abstention; injection cannot authorize actions; secure values/labels never enter frames, logs or provider requests.
- Current canvas: verify capture privacy/geometry and raw click refusal. Future mixed AX/CV workflow remains blocked on release ownership and native acceptance.
- Foreground/window/PID replacement, same-window mutation between approval and dispatch, stale refs and exact payload changes.
- Multi-display DPI/rotation/negative coordinates, movement and transforms.
- Stop during blocked AX, inference, capture, approval and action; no future input or stuck synthetic button. Stop cannot undo delivered input.
- Physical takeover, lock/sleep, disconnect, helper death, permission loss, duplicate delivery and unknown-outcome reconciliation without automatic retry.

Full plan: `docs/plans/electron-native-computer-use.md`; runtime/configuration: `docs/native-computer-use.md`. P3/P5 and pilot exit gates are not claimed complete.

### Private-channel Stop fence

Main destroys command stdin and observation stdout before attempting SIGKILL.
Neither stream closure nor a failed kill releases the device lease: confirmed
process exit (or proven failure to spawn) is still required. Native watchdogs,
read/capture boundaries, approval-focus restoration and final effect guards
independently reject disconnected private endpoints, including commands already
buffered before Stop. They do not consume protocol bytes or rely on readability,
writability, byte counts or zero-byte writes as proof of connection.

macOS uses a nonblocking POSIX `poll` HUP/ERR/NVAL check, separate from the
unchanged signed-parent/fuse/credential checks. The exact portable poll primitive
is exercised on real Linux pipes and socketpairs by `linux/tests/test_channel.py`.
That is not Darwin kernel, AX, signing, or hardware acceptance. Swift parse and
source-boundary checks likewise are not a native macOS build/acceptance result.
A guard cannot retract an OS operation already entered before revocation;
request issuance alone is never evidence that its OS effect was delivered.
