# R1 — check the integrated Mac package (source v2)

This checks the actual Electron package and its existing private helper connection. It is **not R1 completion or release acceptance**. This metadata-only check sends no discovery/AX, input, capture or task requests. The operator-tested `609cee57` revision was unconditionally probe-only; current source adds a separate, default-off [experimental inspector](native-computer-r1-inspector.md). Leave `NATIVE_COMPUTER_INSPECTOR_ENABLED` unset for this package-only check. No inspector acceptance follows from it.

## Preferred: fetch the feature branch

The user requested a work-in-progress branch push for Mac testing. Use `feature/electron-native-computer-use` in a clean checkout with the existing local signing setup. It includes the later temporary-keychain Apple-chain correction, which is not in the immutable v2-final archive.

```sh
git fetch origin
git switch feature/electron-native-computer-use
git pull --ff-only origin feature/electron-native-computer-use
git rev-parse HEAD
```

If Git reports overlapping local/archive changes, do not force or discard them; use a separate clean checkout. Follow the build/check commands below. A branch push is not native acceptance and does not enable control.

## Earlier source archive and existing signing workflow

Use `brian-native-r1-package-source-v2-final.tar.gz` in a disposable copy/worktree of your existing signing checkout. Keep its already-configured signing environment local. Do not send, export or provision credentials, or substitute ad-hoc signing.

The earlier snapshot has no `.git`, installed dependencies or credential files. Git now excludes incidental source-adjacent compiler outputs and machine-local fixture receipts from that snapshot. Its base commit is `c555316a132860799a6a8fb366a97049bf861ff8`; the supplied archive checksum, not that commit alone, identifies these uncommitted sources. Overlay only a **disposable** checkout:

```sh
shasum -a 256 brian-native-r1-package-source-v2-final.tar.gz # compare with the handoff checksum first
tar -xzf brian-native-r1-package-source-v2-final.tar.gz --strip-components=1 -C "$DISPOSABLE_SIGNING_CHECKOUT"
```

This preserves its ignored local settings and `.git`. Never include those settings in a report.

The earlier immutable `brian-native-r1-package-source.tar.gz`, SHA-256 `f18f54cd31cc734248922cba9f4364cc5d1fbcc7b27d1c49f5d8662482ed31a9`, does **not** contain the new package-check option, readiness button or later inspector fixes. If that build is already underway, report its result at its original scope; do not mix v1 and v2 evidence.

## Run on the operator's Apple Silicon Mac

```sh
# Snapshot repository root; existing signing environment, no new credentials.
umask 077
pnpm install --frozen-lockfile
pnpm --filter "@use-brian/app-desktop^..." run build
pnpm --filter @use-brian/app-desktop test:mac-bootstrap
bash scripts/package-desktop.sh --arm64 --native-package-check
```

Do **not** publish, bump a version, dispatch the production release workflow, alter production settings, set acceptance flags or grant desktop permissions. The check explicitly refuses `--publish` and `--no-build`. Its build-only switch does not enable native control.

With `--native-package-check`, the wrapper first runs the installed, version-checked Electron package's official installer and checks for its stock macOS runtime/framework files. Electron 43 installs this runtime lazily; electron-builder's separate download does not populate `node_modules/electron/dist`. This step may download the pinned **43.2.0** runtime and happens before keychain creation, version changes and builds. It does not update dependencies, sign anything or run the downloaded Electron app. Ordinary packaging without this opt-in is unchanged.

The existing signing hook finalizes nested libraries with builder's selected certificate/keychain, authenticates the supported Electron 43.2.0 inventory and ASAR/fuses, stamps/signs the empty-entitlement helper, and signs the constrained parent last. Final binding checks run before notarization and read-only afterSign. The inventory verifier is build-host-only, not shipped.

The explicit package check additionally uses **private temporary copies** while that same selected signing keychain is available:

- Retain the original constrained parent in one copy.
- Remove/recreate only the other copy's root signature without a library constraint, with the same certificate and root entitlement profile. Never re-sign nested libraries or alter the original package.
- Substitute the installed pinned stock Electron framework in both copies. Run a fixed, bounded Node stdout marker directly, without a shell, helper, model call or desktop operation.
- Require the baseline to print exactly the marker and exit successfully, and the constrained copy to refuse before that marker. A failed baseline, local timeout/kill, missing close evidence or cleanup failure is **not** a pass.

This is one concrete package regression check, not a general observer/attestation system or operational acceptance. It does not test every substituted library or every process/pipe condition. Private copies are removed after confirmed completion. On a confirmed failure, bounded private logs are retained and their directory is printed with the failing child's status; inspect the numbered stderr log locally rather than uploading the whole directory. Successful runs remove logs too. If termination is uncertain, the build refuses and retains copies as well; inspect locally, do not repeatedly signal an old PID or upload retained artifacts. Signing-file paths are resolved in the packaging caller's directory before launching any child in its private working directory. Only fixed `/usr/bin/codesign` invocations retain the existing builder environment, including its working HOME/keychain context; copy tools and executable canaries still use the minimal private environment without signing credentials or developer overrides.

## Open the package and check its real helper

1. Quit any already-running Use Brian instance. **Do not launch this WIP with Finder or plain `open`: automatic production updates can replace it on quit.** Use the existing per-launch `USEBRIAN_DISABLE_AUTO_UPDATE=1` QA option with the executable directly. This is not a native acceptance/pilot override and changes no signing or permission policy.
2. If an earlier launch replaced the build-path app (the operator observed **0.0.12 → 0.0.40**), recover a separate copy from the original build ZIP, not from the updated `.app`. From the repository root:

   ```sh
   (
     set -e
     test_dir="$(mktemp -d "$HOME/UseBrian-native-check.XXXXXX")"
     ditto -x -k "apps/app-desktop/release/usebrian.zip" "$test_dir"
     app="$test_dir/Use Brian.app"
     version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")"
     [ "$version" = "0.0.12" ] || { echo "STOP: expected test package 0.0.12, got $version"; exit 1; }
     echo "Launching test package $version from $app"
     USEBRIAN_DISABLE_AUTO_UPDATE=1 "$app/Contents/MacOS/Use Brian"
   )
   ```

   The version assertion applies to this recorded 0.0.12 handoff. Keep the terminal open during the check; do not post its entire logs. No installed app, account data or existing build artifact is deleted or overwritten. For a freshly built, unmodified app, the same direct executable launch with that environment option suffices.
3. Confirm **About Use Brian** matches the test version and the existing browser surface opens.
4. In **This computer**, click **Check Mac helper readiness** once. Expect the packaged-helper admission message while native control remains unavailable.

Readiness uses only the existing private helper `capabilities` request, even with rollout disabled. It does not call auth/API/relay/model services, discover targets, grant control or request permissions. It waits for helper death before releasing the device lease and presenting success. Stop/workspace changes discard late results. The page's ordinary account/navigation requests are not part of this helper check.

## Pass/fail and report

**PASS for this intermediate check:** the unmodified build completes; the explicit packaged-parent substitution check passes; the app and browser open; readiness reports packaged-helper admission; native control stays unavailable. No AX/screenshot/input permission prompt should occur.

**FAIL:** any compile/signature/constraint/baseline/refusal/cleanup failure, launch crash, browser regression, readiness failure, unexpected permission prompt or native control becoming available. Stop at the first failure. Do not relax validation or change the signer to manufacture a pass.

Return only:

- Git commit SHA (or archive checksum for an earlier snapshot run), macOS version/build, architecture, Xcode/SDK and Node versions.
- Build, package substitution check, app launch, browser and helper readiness: each PASS/FAIL/not reached.
- Whether native control remained unavailable and whether any permission prompt appeared.
- For failure: stage and a small redacted excerpt. Keep full logs local; omit usernames/paths, environment values, certificates, credential files and desktop content.

These results still do **not** establish TCC/AX inspection, modal/privacy behavior, independent Stop timing, real AX/model workflows, screenshot fallback or input cleanup. Those R1–R4 checks remain open. Do not change the helper's operational barrier based on source tests or this intermediate result alone.
