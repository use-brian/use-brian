# Opt-in ad-hoc library-load diagnostic — reported native differential pass

**This harness EXECUTES disposable generated C programs and calls `dlopen` on its
own generated dummy libraries. It is NOT the earlier never-executed format collector.**
Parent reviewed the C/driver and independently passed the 15 new portable tests.
No native compilation, signing or load test follows from those portable tests.
The user subsequently reported the complete four-case diagnostic PASS on the
arm64 toolchain below; that separately reported native result is retained in
`apps/app-desktop/scripts/fixtures/mac-library-load.arm64-macos26.v1.json`.

The earlier arm64 macOS 26.6.2/25G83, SDK 26.5, Apple clang
21.0.0/2100.1.1.101, Node 25.5.0 preflight and format-collector results are separate
evidence. This harness neither changes nor imports ProcessIdentity, Helper, the
observed-policy comparator, production DER wrapper, fixture collector or signing
hooks. The helper remains **unconditionally probe-only**. No Developer ID identity
is available/required here; signed production acceptance awaits later setup.

## User operation (only after parent review)

On a native non-root macOS 14+ machine, using existing Node 20+ and installed Apple
Command Line Tools or Xcode/SDK 14+, from the source-tree or extracted bundle root:

```sh
node apps/app-desktop/scripts/mac-library-load-probe.mjs --allow-ad-hoc-library-load-tests
```

That exact sole argument is mandatory **before any filesystem or child side effect**.
No arbitrary path, PID, policy, identity, target, source or tool arguments exist.
A missing flag, extra argument, wrong platform, root/elevated account, or old Node
refuses. Rosetta Node on arm64 is unsupported; no automatic fallback/retry occurs.

The driver only queries `xcode-select -p`, `sw_vers`, and hardware `sysctl`; it locates
an **already installed** compiler and SDK beneath the selected developer directory.
It never invokes installer shims (`xcrun`, `/usr/bin/clang`, `xcodebuild`, `--install`),
a package manager, network operation, `security`, certificate/keychain lookup, UI,
TCC, AppKit, AX or input APIs. Missing/unsupported prerequisites stop the pipeline.

All driver-created sources, binaries, entitlements, policy, module cache and capped
logs stay in one fresh owned **0700** `brian-library-load-*` temporary directory.
Children get a fixed minimal environment, private HOME/TMPDIR/module cache, no
inherited DYLD/SDK/compiler/credential/proxy overrides, and no shell. No existing
application, executable, entitlements or signature is changed. Code signing is
**only** `--sign - --timestamp=none` on newly generated disposable files. `--force`
replaces only their possible linker-generated signatures. No credentials are used.

There is no automatic cleanup/reuse or output-path option. The directory is retained
for local review; `diagnostic.json` is the shareable result. Stdout contains the same
bounded JSON (at most 8 KiB), not directory paths. To locate retained private files
locally, inspect your normal macOS `$TMPDIR` for `brian-library-load-*`. **Do not share
numbered logs, dummy binaries or `allowed-policy.plist`: they may contain private
paths, identifiers, hashes or tool error text.** Only the sanitized JSON is shareable.

## Fixed experiment

1. Compile two inert thin dylibs from exact fixed strings. Each exports only
   `brian_library_load_value`, returning a distinct integer (211 or 307). No custom
   constructors, destructors, I/O or application code is supplied.
2. Compile `LibraryConstraintLoadProbe.c` once and copy its fresh unsigned/linker-signed
   bytes to the second runner. Both runners use the same code, signing identifier,
   **hardened runtime**, and the same entitlement plist containing **only**
   `com.apple.security.cs.disable-library-validation = true`. No JIT, unsigned
   executable memory or debugger entitlement is added. This isolates the constraint
   experiment from legacy library validation. This exception applies only to these
   disposable runners, never to any app/helper configuration.
3. Ad-hoc sign both dylibs using SHA256; sign the baseline runner with runtime and
   that entitlement, **without a library constraint**. Verify each disposable
   signature with `codesign --verify --strict`. This verifies local ad-hoc content,
   not CMS/certificate/signer authentication.
4. Execute baseline `prepare-policy`. It reads the two adjacent fixed-named thin
   dylibs via public selected-slice Security metadata, requiring SHA256 (algorithm 2)
   and consistent 20-byte cdhash/unique values, not guessed names or catalog labels.
   Hashes must differ. It serializes via `CFPropertyListCreateData` exactly:
   `{ cdhash: { $in: [ NSData(allowed-library-actual-cdhash) ] } }`.
   That file is created exclusively at adjacent `allowed-policy.plist`, then made
   read-only (0400). No hash/policy enters stdout or the shareable report.
5. Ad-hoc sign the second runner with identical runtime/entitlements plus
   `--enforce-constraint-validity --library-constraint allowed-policy.plist`.
   This policy is intentionally **cdhash-only**, NOT category 6 + team, and does not
   stand in for production policy or its opaque DER format.
6. Execute four independent, single-attempt load cases, stopping at the first failure:

   | Case | Required diagnostic observation |
   | --- | --- |
   | Baseline / allowed | `loaded`, expected function result |
   | Baseline / disallowed | `loaded`, expected function result |
   | Constrained / allowed | `loaded`, expected function result |
   | Constrained / disallowed | `dlopen-null`, normal structured runner completion |

The C runner accepts only `prepare-policy`, `load-allowed`, `load-disallowed`, and
only the expected baseline/constrained executable basenames. Policy creation is
baseline-only. It obtains **its own** executable path from libproc, requires a
canonical owned 0700 adjacent directory, and only opens fixed adjacent filenames.
There is no caller-selected `dlopen` path. It checks ordinary real/effective/saved
credentials, owned regular files, single links, strict read-only modes, bounded
thin Mach-O architecture/type, and inode/stat/path stability around metadata/load.
It checks its own runtime/ad-hoc static flags and its self disable-library-validation
entitlement through Security APIs. The driver supplies the single-key entitlement
plist and never preserves old entitlement metadata.

Runner modes are 0500; dylibs and policy are 0400. FDs remain held while paths are
checked. Directory changes during `dlopen`/function execution also invalidate a load
observation. Driver-private full-file SHA256/stat pins protect source/entitlement/
artifact consistency around each invocation. Symlinks, hardlinks, unexpected file
modes, detected replacement/mutation, changed credentials or malformed metadata
stop rather than becoming a rejection observation.

These ownership/canonical-path/stat checks are accident/race detection in a
controlled diagnostic, **not an atomic file-to-loaded-image binding**. They cannot
attest against a malicious same-UID process able to rewrite files or control the
runner/driver. Nothing here claims to close restored-on-disk/in-place-write attacks.
The optional old-library-loaded/path-restored demonstration is deliberately omitted.

## Process/output safety and interpretation

The native runner has a five-second single-invocation SIGALRM watchdog, explicitly
unblocked, including blocked stdout; its handler only `_exit(24)` and never attempts
blocking diagnostic writes. Core dumps are disabled for the runner. This is not a
real-time scheduling guarantee. There are no retries, children or peer protocols
inside C. `dlerror()` strings are never requested/printed.

The driver gives each tool one deadline (query/verify 15 s, compile 60 s, sign 30 s,
runner 8 s), caps each private stdout/stderr log at 64 KiB, and permits at most 2 s
for close after cancellation. Only the **owned detached child group's** PID may be
signaled, once, and **never after known leader exit**. Exit/kill success is not close
confirmation. Errors, excess output, signals, timeout, nonzero exit and unconfirmed
close stop the pipeline. No later step runs after failure. No crash/termination is
ever interpreted as constraint rejection.

C emits a fixed schema and result enum through private child pipes. The driver
accepts only exact canonical one-line `loaded`, `dlopen-null` or `policy-created`
messages with consistent booleans, **and normal zero exit plus confirmed close**.
`invalid`, `symbol-mismatch`, exit 24, malformed/noisy output, or a failure carrying
otherwise valid-looking JSON cannot pass. The provenance of an observation is its
locally compiled, pinned, private owned child and private pipes—not a certificate or
cryptographic attestation. The driver never accepts a user's report as evidence.

A normal `dlopen-null` means only that `dlopen` returned NULL. We do not claim a
specific kernel errno or cause from that alone. Cases without a validated result
are labeled `not-run` or `incomplete`, not a refusal. Only the complete baseline/constrained
comparison yields `observedDifferential: true` / `status: "passed-diagnostic"`.
Unexpected baseline refusal or constrained loading is `failed`, never a fallback.

Shareable output includes fixed per-case result enums/booleans, sanitized numeric
OS/SDK/compiler/Node and architecture facts, a fixed stage/failure classification,
and `executionAttempted`. It omits raw paths/errors, hashes, policies, identifiers,
source code, credentials and log contents. All of these remain **false**, even on a
positive differential: `productionAuthority`, `certificateAuthentication`,
`electronAcceptance`, `loadedBootstrapProof`, `kernelSigningEvidence`,
`opaquePolicyValidation`.

This is only a differential mechanism diagnostic for disposable ad-hoc images. It
is not Developer ID acceptance, production category/team policy validation,
Electron/JIT/addon enforcement, opaque DER semantics, library inventory completeness,
loaded-image proof, or computer-control authority. Apple-signed system libraries
have special constraint treatment and are not the negative fixtures here.

## Deterministic source-only handoff bundle

Maintainer command from repository root (use a new **canonical absolute** destination
outside the repository; no existing target is overwritten):

```sh
out="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
node apps/app-desktop/scripts/mac-library-load-probe-bundle.mjs --output "$out/library-load-source.tar"
```

The archive contains exactly three allowlisted source/document files: driver, C
runner, this document. No imports beyond Node built-ins; no node_modules, existing
collectors/parsers, binaries, policies, manifests with private data, logs, fixtures
or test shims. Tar entries are deterministic regular 0644 UTF-8 files with zero
uid/gid/time. Source path escapes/symlinks/hardlinks, non-text or oversized files,
symlink ancestors, in-repo output and overwrites are rejected. The bundler itself
never compiles, signs or executes bundled code. It prints source/archive SHA256
checksums (not dummy-library cdhashes). Preserve the directory layout when extracting.

Portable validation (no native tools):

```sh
node --test apps/app-desktop/scripts/mac-library-load-probe.test.mjs \
  apps/app-desktop/scripts/mac-library-load-probe-bundle.test.mjs
```

Tests use mocked processes and synthetic private artifacts, plus source guards and
bundle/refusal tests. They do **not** simulate native acceptance or fabricate kernel
evidence. Real-SDK compile/link, macOS ad-hoc signing, self-entitlement retrieval and
actual four-case load behavior are separately **operator-reported PASS on the
listed arm64 toolchain**: both baseline libraries loaded, constrained/approved
loaded, and constrained/disallowed returned `dlopen-null` with normal completion.
All production/certificate/Electron/bootstrap/kernel/opaque-policy flags remained
false. This is not a claim that the implementing agent reproduced the Mac run;
other architectures/OS versions and production signer/bootstrap acceptance remain
unverified.

## ABI/behavior references

* Apple [Defining launch environment and library constraints](https://developer.apple.com/documentation/security/defining-launch-environment-and-library-constraints)
  and [Applying launch environment and library constraints](https://developer.apple.com/documentation/security/applying-launch-environment-and-library-constraints):
  direct plist constraints, `cdhash` binary `$in`, implicit AND, Sonoma support.
* Apple [WWDC 2023 session 10266](https://developer.apple.com/videos/play/wwdc2023/10266/):
  library constraints work with disable-library-validation; special Apple-library
  treatment. This does not assert equivalent production/ad-hoc signer acceptance.
* Apple Security `Security-61040.1.3`
  [SecStaticCode.h](https://github.com/apple-oss-distributions/Security/blob/Security-61040.1.3/OSX/libsecurity_codesigning/lib/SecStaticCode.h),
  [SecStaticCode.cpp](https://github.com/apple-oss-distributions/Security/blob/Security-61040.1.3/OSX/libsecurity_codesigning/lib/SecStaticCode.cpp),
  [SecCode.h](https://github.com/apple-oss-distributions/Security/blob/Security-61040.1.3/OSX/libsecurity_codesigning/lib/SecCode.h),
  [StaticCode.cpp](https://github.com/apple-oss-distributions/Security/blob/Security-61040.1.3/OSX/libsecurity_codesigning/lib/StaticCode.cpp):
  public selected-slice static metadata and per-algorithm cdhash arrays. Here only
  native thin offset-zero images and a sole SHA256 algorithm are supported.
* Apple [TN3126](https://developer.apple.com/documentation/technotes/tn3126-inside-code-signing-hashes):
  CodeDirectory hashes and 20-byte cdhash truncation; this is not a filename hash.
* Apple [SecTask.h](https://github.com/apple-oss-distributions/Security/blob/Security-61040.1.3/sectask/SecTask.h):
  `SecTaskCreateFromSelf` / `SecTaskCopyValueForEntitlement`, only the current task.
  No private signing snapshot or guessed kernel status implementation is involved.
* Installed Apple `codesign(1)` ([public manual transcription](https://keith.github.io/xcode-man-pages/codesign.1.html))
  and `dlopen(3)`: ad-hoc `-`, runtime/entitlements/constraint/digest options,
  `--timestamp=none`, and NULL load-failure semantics. The actual selected system
  tool may reject unsupported behavior; the harness stops, never repairs/falls back.
