# Opt-in macOS library-constraint **format** fixture

This handoff collects format evidence only. **The production admission barrier stays closed.** The operator-reported v4 preflight PASS is not permission to admit a helper or enable signing hooks. This collector does not invoke that preflight, Helper, ProcessIdentity, an app, a GUI, or any generated code.

## Review and build the source-only handoff

Requires Node 20+; no npm, dependencies, installation, provider access, credentials or network. From the repository root, reviewers can run these portable tests (all compiler/signing/process interactions are mocked):

```sh
node --test apps/app-desktop/scripts/mac-library-constraints.test.mjs apps/app-desktop/scripts/mac-library-constraint-fixture.test.mjs apps/app-desktop/scripts/mac-library-constraint-fixture-bundle.test.mjs
```

After independent review, create a new tar **outside the repository**, using a real, nonsymlinked existing parent directory:

```sh
node apps/app-desktop/scripts/mac-library-constraint-fixture-bundle.mjs --output /absolute/outside/repository/library-format-source.tar
```

The bundler prints SHA-256 checksums of source files and the archive, not generated-code hashes. It allows exactly three files (the collector, the raw extractor, and this document), keeps repository-relative paths, fixes tar owner/time/mode metadata, and refuses symlinks, hardlinked sources, nonregular/oversized files and existing output. It does not run anything bundled. It excludes binaries, logs, results, dependencies, shims, environment files and other repository files. Output archives are mode 0600. Extract into a fresh directory and review the sources/checksums. Tests, synthetic fixtures and the bundler remain repository-only; they are not shipped in the handoff. Do not copy dependencies or tool overrides into the handoff.

## Native user-run operation (not run by the implementing agent)

Only on macOS 14+, with **native-architecture Node 20+**, an already-installed and selected Apple Xcode or Command Line Tools compiler, and macOS SDK 14+. Do not use sudo. No installation or tool-selection changes are performed. Translated Node, missing/unknown hardware capability, unsupported compiler output or missing SDK/tooling fail closed. Nonstandard installations may be unsupported.

From the extracted source tree root:

```sh
node apps/app-desktop/scripts/mac-library-constraint-fixture.mjs --allow-ad-hoc-format-fixture
```

This exact opt-in is required before filesystem/child side effects. There are no input path, output path, PID, identity, policy, architecture, tool or environment override flags. Importing the module does nothing. Dependency injection in the exported collector/child runner is a portable-test seam only; the CLI always uses the real implementation.

The collector:

1. Creates a fresh private mode-0700 directory under `realpath(os.tmpdir())`, sets restrictive umask, and prints its location. It never accepts a user-supplied artifact.
2. Checks that the fixed system tools are installed/executable using filesystem checks, then queries `/usr/bin/xcode-select -p`; discovers the selected installed compiler/SDK directly from their filesystem layouts. It never invokes the `/usr/bin/clang`, `xcrun` or `xcodebuild` missing-tools shims, nor any installer. It reads bounded SDK settings, `sw_vers` version/build, `sysctl hw.optional.arm64`, and Apple clang's version. Missing prerequisites stop, without retries/dialogs.
3. Writes exactly `int main(void) { return 0; }` and the fixed XML policy below as private files. Compiles this tiny executable with the installed Apple clang, the actual hardware architecture, and macOS 14.0 deployment target. **It never executes the result.** Generated files/module cache/compiler logs stay private. Child environment is an allowlist; inherited compiler/DYLD/SDK/provider/keychain/proxy overrides are not passed.
4. Invokes `/usr/bin/codesign` **once**, on only that newly generated disposable file, with `--force --sign - --timestamp=none --options runtime --identifier invalid.brian.library-constraint-format-fixture --enforce-constraint-validity --library-constraint <owned-policy> <owned-file>`. `--force` is solely to replace any linker-generated ad-hoc signature on this file, never an app signature. There is no certificate identity, keychain access request, timestamp service, deep signing, signature removal or production packaging. File executable permission is removed before signing and again afterward.
5. Reads the signed bytes with a bound and performs the **separate static-format extraction** routine. This checks the supported thin-Mach-O/signature envelope, every code page, SHA-256 CodeDirectory digest calculation and slot −11's whole-blob hash. The computed digest is not kernel evidence, is not compared to fabricated evidence, and is discarded rather than serialized. Unsupported signature profiles stop; there is no format fallback or guessed DER decoder. Apple's pinned `signer.cpp` wraps zero-length ad-hoc signature data in a header-only signature-slot blob; that empty wrapper (or its absence) is permitted, but any CMS content is rejected.
6. Writes a small mode-0600 `format-fixture.json` containing the bounded base64 generic library blob (including its eight-byte header), the exact original XML input, and allowlisted OS/build/SDK/architecture/Node/Apple-clang facts. System codesign provenance is identified by OS build; no unsupported `codesign --version` probe is invented. The JSON marks static-format-only, unsupported DER policy validation, no execution, no kernel/CMS proof and no production authority.

There are seven direct child attempts on success: selection query, two OS facts, hardware query, clang version, compilation, signing. Each is single-attempt, without a shell or retry. Each stdout/stderr is capped at 64 KiB in private logs. Deadlines are 15 seconds per query, 60 seconds compilation, 30 seconds signing. Failure/timeout/output overflow triggers at most one SIGKILL attempt against the owned detached child process group, only if its leader has not already emitted `exit`. A known-exited leader's numeric PID/group ID is never signaled later, since it could be reused. Stuck pipes after leader exit remain a failure, not permission to kill by a stale ID. The collector waits up to two additional seconds for `close`; an unconfirmed close or failed kill is explicitly recorded and **never** reported as successful termination. The pipeline stops. `*.status.json` is private diagnostic data, not shareable attestation. A spawn failure may have no child to kill.

If unsuccessful, inspect `collection-failure.json`: it contains only a fixed phase/classification and `productionAuthority:false`. Share that small report first; inspect private numbered tool logs locally before deciding what else to disclose. Filesystem/tool exception text is not copied into the failure report. A known static-parser refusal may contribute its fixed classification, never artifact content. Console output deliberately does not include child errors, hashes or tool/source paths (except the private results-directory notice). No automatic cleanup is attempted while termination might be unconfirmed. After confirming no owned tool remains, the operator may manually delete the entire private results directory. Never run its `inert` file.

## Fixed policy and meaning

The XML has a direct top-level dictionary (implicitly AND):

- `validation-category`: integer **6**, meaning hypothetical **Developer ID libraries**; this is not a claim about the collector's ad-hoc signer.
- `team-identifier`: string `ZZZZZZZZZZ`, deliberately a placeholder, not a real developer identity.
- `cdhash`: dictionary containing `$in`, an array of two plist **data** values: twenty bytes of `0x11`, and twenty bytes of `0x22`. They are fixed fabricated test values, never hashes of an installed or generated image.

The exact bytes of the XML live in `policyPlist` in the collector, and are copied unchanged into the shareable result. A DOCTYPE/network resource is unnecessary and omitted. There is no guessed `requirements`/category/version wrapper. The signed executable is not intended to run or load any third-party library. Operating-system-library exceptions are another reason this is not a complete bootstrap enforcement test.

## What to share, and what remains unresolved

After local inspection, share **only `format-fixture.json`**, not the directory, executable, generated CodeDirectory, source paths, logs, screenshots of directory names, or statuses. The result has no path/environment/keychain fields or generated-code CDHash field. The opaque library blob comes from the fixed policy; it is not decoded or semantically validated here. Review it before sharing as with any native-tool output. No native fixture was generated by the implementing agent. Mock/synthetic tests do not establish Apple wire compatibility.

Format data alone cannot establish operator semantics, native enforcement, authenticated signer provenance, Developer-ID/certificate authentication, exact code membership, kernel CDHash/actual-slice/exec-generation provenance, resistance to loaded-old-image/disk-restore attacks, or production acceptance. Native signing's structural validity check is not a library-load enforcement test. The fact that Apple documents the operators is not a demonstration that a future DER decoder preserves their semantics.

The user has now supplied a successful native result on arm64/macOS26.6.2 build25G83 (SDK26.5, Node25.5.0, clang21.0.0 build2100.1.1.101). The exact 183-byte blob, input and provenance are retained in repository fixture `scripts/fixtures/mac-library-constraint.arm64-macos26.v1.json` under `apps/app-desktop/`. A separate `mac-library-constraint-policy.mjs` comparator accepts only the observed envelope and exact expected policy/inventory, with synthetic negative coverage; it is not bundled here or wired into admission. The production verifier still refuses: general envelope semantics, other native profiles, independently signed provenance and native positive/negative enforcement evidence remain unresolved. Fresh process evidence and genuine constrained-bootstrap enforcement tests remain separate work. No helper admission, existing signing hooks, preflight gates or production configuration is changed by this handoff.

## Exact source references

Apple's published policy facts, type rules, implicit AND, `$in` membership and category 6:

- https://developer.apple.com/documentation/security/defining-launch-environment-and-library-constraints
- https://developer.apple.com/documentation/security/applying-launch-environment-and-library-constraints

Apple codesign manual (the official guide directs users to the installed manual; the second URL is a public transcription, **not an Apple-hosted source**). See `--library-constraint`, `--enforce-constraint-validity`, `--sign`, `--force`, `--identifier`, `--options`, and `--timestamp=none`:

- https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/Procedures/Procedures.html
- https://keith.github.io/xcode-man-pages/codesign.1.html

Pinned Sonoma ABI/binding and Apple's policy dictionary construction (no native DER fixture is claimed):

- https://github.com/apple-oss-distributions/xnu/blob/1031c584a5e37aff177559b9f69dbd3c8c3fd30a/osfmk/kern/cs_blobs.h
- https://github.com/apple-oss-distributions/xnu/blob/1031c584a5e37aff177559b9f69dbd3c8c3fd30a/bsd/kern/ubc_subr.c
- https://github.com/apple-oss-distributions/xnu/blob/1031c584a5e37aff177559b9f69dbd3c8c3fd30a/EXTERNAL_HEADERS/mach-o/loader.h
- https://github.com/apple-oss-distributions/Security/blob/ef677c3d667a44e1737c1b0245e9ed04d11c51c1/OSX/libsecurity_codesigning/lib/LWCRHelper.mm
- https://github.com/apple-oss-distributions/Security/blob/ef677c3d667a44e1737c1b0245e9ed04d11c51c1/OSX/libsecurity_codesigning/lib/signer.cpp

The raw extractor additionally documents pinned CoreEntitlements interface headers and the missing serialization evidence. This handoff adds format collection, **not** that missing DER verification.
