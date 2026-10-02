# Mac preflight: compile, negative refusal and self signing-data comparison

This is a local, user-run macOS 14+ handoff. It does **not** enable native computer control, validate parent trust, test TCC, or establish operational acceptance. The unsigned/ad-hoc helper normally rejects its **own signature before checking its parent**. Keep the probe-only barrier unchanged.

## Requirements

- macOS 14 or later; Xcode 15 / Command Line Tools 15 or later, with a selected macOS SDK 14+ and Swift 5.9+. Swift is compiled in Swift 5 language mode.
- Node 20+ already installed. No npm, pnpm, Electron, downloaded dependencies, credentials, developer signing identity, or services are needed.
- Only the current `uname -m` architecture is compiled (arm64 or x86_64), not a universal binary. Use a native Terminal session, not Rosetta, for a native-architecture result.

Install/select prerequisites separately before running; this handoff does not install or download anything. If `xcrun` reports missing developer tools, stop and arrange those separately. Do not grant Accessibility, Screen Recording, or Input Monitoring for this test.

## Exact source-bundle allowlist

These nineteen regular files, at the archive root, are the current source bundle manifest. The historical v4 archive remains unchanged (eleven files); its reported pass does not verify these added bootstrap sources:

```text
build.sh
Helper.swift
ProcessIdentity.c
ProcessIdentity.h
Fixture.swift
smoke.mjs
bootstrap-negative.mjs
mac-preflight.sh
MAC-PREFLIGHT.md
KernelSigningProbe.c
KERNEL-SIGNING-PROBE.md
BootstrapApprovalAnchor.c
BootstrapApprovalAnchor.h
LibraryConstraintPolicy.swift
MachOLibraryConstraint.swift
BootstrapApproval.swift
BootstrapApprovalReader.swift
BootstrapProcessBinding.swift
ElectronFrameworkBinding.swift
```

No executables, built apps, logs, credentials, dependencies, node_modules, symlinks, or injected syscall test shims belong in the archive. `Fixture.swift` is needed by the build and portable checks, but the fixture must **not be launched**.

The repository-only bundler creates an uncompressed deterministic tar using precisely this allowlist, with fixed metadata. It prints SHA-256 checksums of the exact archived source bytes and of the tar; it does not execute any bundled source. Checksums are integrity evidence, not authenticity/signing evidence. The output path must be explicit, absolute, outside the repository, new, and have an existing nonsymlink parent path. Symlink source/output paths are refused. There are no implicit output files or network operations.

From the repository root, for example (choose a new filename if it already exists):

```bash
node apps/app-desktop/scripts/mac-preflight-bundle.mjs \
  --output "$HOME/brian-mac-preflight.tar"
```

Send only that tar. Share its printed archive checksum separately if desired. No repository installation is required on the receiving Mac.

## On the Mac

Inspect the archive first; it should contain exactly the nineteen files above. Extract into a fresh directory, not over an existing checkout. For example:

```bash
shasum -a 256 "$HOME/brian-mac-preflight.tar"
tar -tf "$HOME/brian-mac-preflight.tar"
DEST="$(mktemp -d "$HOME/brian-mac-source.XXXXXX")"
tar -xf "$HOME/brian-mac-preflight.tar" -C "$DEST"
cd "$DEST"
bash ./mac-preflight.sh
```

The script:

1. Checks macOS, architecture, Node, and the selected `xcrun --sdk macosx` SDK.
2. Creates a private fresh local temporary directory (mode 700, private log files) and prints its path.
3. Runs dependency-free portable framing/source checks.
4. Typechecks `Fixture.swift` independently with the selected SDK, without executing it.
5. Calls `build.sh` with **`CODESIGN_IDENTITY` explicitly unset**, the selected SDK in `SDKROOT`, and an output directory inside the private temporary directory. It collects this build log even if the independent fixture typecheck failed. The current build also compiles the empty refusing approval-anchor C section and the Swift policy/extraction/binding/own-symbol-reader/process-collection sources. The process collector is compiled but not invoked by the probe-only dispatcher; its Security calls and mapped-record binding are not exercised by this negative preflight. It copies the probe-only dispatcher to a private temporary `main.swift` for multi-file compilation, removing that copy on success or failure. This does not populate an approval record, validate Darwin section layout, invoke signing, or enable operational admission.
6. Only if compilation succeeded, launches the helper alone to require exit 77 with zero stdout. It sends **no requests** and leaves stdin open until refusal/child close. It drains output through `close`, not just `exit`. The deadline is five seconds, followed by at most one second waiting for SIGKILL cleanup. Any stdout, excess stderr, process/stream error, unexpected exit, or timeout fails the test. Output is counted/discarded, not forwarded. If killing fails, it reports the PID for local investigation and never reports a pass.

7. Compiles and runs the self-only `KernelSigningProbe.c` against the same `ProcessIdentity.o`. A three-second process watchdog bounds execution (not compilation). It compares kernel main-executable signing data and actual slice with public static metadata, producing only fixed booleans/status codes. It does not validate certificates or confer authority. See [KERNEL-SIGNING-PROBE.md](KERNEL-SIGNING-PROBE.md) for the private-API compatibility limits and result codes. Failure does not fall back to weaker checks or retry.

There is no explicit codesign, notarization, network, package manager, fixture launch, permission request, or operational Broker construction on this path. Apple’s linker may automatically apply an **ad-hoc** signature; “unsigned” here means no developer signing identity or signing workflow. Standard OS/toolchain behavior is not a promise that system daemons never run.

Logs and artifacts stay local at the printed path. **Compiler logs may include your local filesystem paths. Inspect/redact before sharing.** Do not upload the entire temporary directory. Useful logs are `logs/toolchain.log`, `logs/portable.log`, `logs/fixture-typecheck.log`, `logs/build.log`, `logs/bootstrap-negative.log`, `logs/kernel-signing-build.log`, `logs/kernel-signing.json`, and `logs/kernel-signing-stderr.log`. Compilation failure is useful diagnostic evidence; do not change trust checks to force a pass.

A passing v3-or-later run is only current-architecture compilation, negative bootstrap refusal and self kernel/static metadata comparison. V4 corrects the newer XNU original-parent-generation field rejected by v3 and adds distinct malformed-data status codes; the user reports v4 PASS on arm64/macOS26.6.2 with SDK26.5 and the expected code0/untrusted/no-authority JSON. An ad-hoc/linker-signed probe should remain explicitly `untrusted_status:true` with `production_authority:false`. The user's earlier v2 compile/refusal PASS predates this new primitive check; v4 supplies the later current-architecture compile/self-comparison result. It does not prove private-channel admission, parent authentication, loaded-framework binding, signed-parent probes, capture, AX actions, or input safety. Do not launch `NativeComputerFixture.app`, use `--probe-only`, run desktop packaging, or grant permissions as part of this handoff. No authority-enabling environment variable is set.

The user reported v5 fixture typecheck status0 and build status1: three references to the C spelling `kSecCSNoNetworkAccess` were unavailable in Swift. The corrected source uses the documented public Swift option `SecCSFlags.noNetworkAccess` via option-set union, retaining offline validation at every check. It does not substitute raw flag bits or retry without the option. V5 did not reach helper refusal or the kernel self-probe. The user subsequently reported v6 PASS for its18-file compile/refusal/self-comparison handoff. The current19-file source set adds `ElectronFrameworkBinding.swift` and updates parser/collector composition; v6 does not cover these changes. No new archive or Mac result exists for the current set. The separate release inventory verifier is not part of this handoff. Linux source/policy tests and syntax parsing do not establish SDK typechecking.

For a later standalone repeat against the same built helper:

```bash
node ./bootstrap-negative.mjs /absolute/printed/temp/path/build/brian-native-computer-helper
# Equivalent explicit smoke mode; --parent-negative remains a legacy alias only:
node ./smoke.mjs --bootstrap-negative /absolute/printed/temp/path/build/brian-native-computer-helper
```

Both CLI paths retain the macOS platform gate. The fake-child unit tests run on Linux but are not included in the source bundle and do not constitute Mac execution.
