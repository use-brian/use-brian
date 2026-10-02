# Kernel signing data prerequisite (macOS only)

**Not production trust or loaded-bootstrap proof. The helper remains unconditionally probe-only.**
The reported mac-preflight v2 result (Helper/Fixture compilation, empty fixture typecheck,
unsigned bootstrap refusal) predates this API/probe. It does not establish these new
primitives. The v2 toolchain was arm64 / macOS 26.6.2 / SDK 26.5 / Swift 6.3.3 /
Apple clang 21.0.0. The user then reported v3 preflight status **15** on the same toolchain, with no
helper/fixture compiler errors. The generic v3 status did not distinguish nonzero
reserved fields from missing identity/hash or an invalid slice. Source review found
that newer XNU assigns offset 36 to `p_orig_ppidversion`, which v3 incorrectly
required to be zero. V4 implements that published field, preserves both remaining
reserved-field checks and full-record stability, and splits the other malformed-data
failures into fixed codes 17–19. The user reports v4 **PASS** on the same arm64
toolchain, with `code:0`, `kernel_data:true`, `static_match:true`,
`untrusted_status:true`, `production_authority:false`. This establishes the
reported self-process primitive checkpoint, not parent or loaded-library trust.

## Standalone native build/run

From the repository root, on an ordinary non-root macOS 14+ account, with the real
Apple Command Line Tools/SDK installed:

```sh
cd apps/app-desktop/native/computer-control
out="$(mktemp -d /tmp/brian-kernel-signing-probe.XXXXXX)"
xcrun --sdk macosx clang -std=c11 -D_DARWIN_C_SOURCE -Wall -Wextra -Werror \
  -mmacosx-version-min=14.0 \
  ProcessIdentity.c KernelSigningProbe.c \
  -framework CoreFoundation -framework Security \
  -o "$out/kernel-signing-probe" && "$out/kernel-signing-probe"
```

No arguments are accepted. No PID/path selector, credentials, `sudo`, signing command,
entitlements, debug exceptions, environment acceptance override, TCC, AppKit, AX,
UI, input, network operation or other-process inspection is used. Nothing is added
to helper admission or `build.sh`. The v3 and later source bundles' `mac-preflight.sh`
builds and runs this probe after successful helper/fixture compilation and negative
bootstrap refusal, recording `kernel-signing-build.log` and `kernel-signing.json`.
The standalone command above is an alternative. Test shims are not bundled.

The ordinary Apple linker may generate an ad-hoc signature (particularly arm64).
That is **untrusted**, not a production signing identity. A truly unsigned executable
may have no kernel cdhash: failure is expected, not a reason to sign/obtain credentials
or weaken the probe. No positive result is promised for every unsigned toolchain.

Example *shape*, not a claimed native result:

```json
{"code":0,"kernel_data":true,"static_match":true,"untrusted_status":true,"production_authority":false}
```

Only fixed booleans/status codes are printed: no PID, UID, username, executable path,
UUID, cdhash, signature contents, raw OS errors, credentials or AX data. Exit status
matches `code`. Status 24 (watchdog/setup failure) may exit **without JSON**; its
signal handler deliberately never writes to a potentially blocked stdout pipe.

| Code | Meaning |
| --- | --- |
| 0 | Self primitive data matched public static signing metadata for the actual slice; **no authority** |
| 10 | Invalid snapshot input (including root) |
| 11 | Kernel primitive/symbol/clock unavailable or syscall denied/failed |
| 12 | Wrong-sized libproc reply |
| 13 | Generation/signing readings changed |
| 14 | Caller/target credentials unsuitable or changed |
| 15 | Nonzero remaining reserved ABI fields (v3 also used this for the failures now separated below) |
| 16 | Snapshot monotonic budget exceeded/clock became unusable |
| 17 | Zero process unique ID or exec generation |
| 18 | Negative active-slice offset |
| 19 | All-zero kernel cdhash |
| 20 | Public static metadata unavailable/unsupported |
| 21 | Self path/file/slice unsupported |
| 22 | Kernel cdhash absent from the actual slice's static digest alternatives |
| 23 | Self/kernel/file identity changed around static comparison |
| 24 | Three-second process watchdog/setup failure |
| 64 | Arguments supplied |

There is no retry. The process-wide three-second alarm terminates even blocked
output without performing diagnostic I/O in the handler. As usual, this is not a
real-time scheduler guarantee. Each snapshot also checks a 250 ms monotonic budget
around a fixed six libproc reads and six token-checked csops reads. The C API alone
cannot interrupt a blocked kernel call; it rejects overruns when a call returns.

## API contract (data, never admission)

`brian_kernel_signing_snapshot(pid, user, &output)` is additive; existing process
identity and channel exports/implementations are preserved. No call was added to
`Helper.swift`. The generic API accepts only a positive non-system PID and the
caller's ordinary non-root UID; the CLI **only** calls it for `getpid(), getuid()`.

* Checks real/effective/saved target and caller UIDs and consistent GIDs before and
  after. Checks caller real/effective IDs independently and GID stability.
* Brackets fixed signing reads with private libproc unique-ID/idversion records.
  Checks full record equality (including executable UUID and parent unique ID),
  nonzero unique ID/idversion and zero remaining reserved fields at offsets 40/48.
  Offset 36 is the original parent's generation on newer XNU (zero on the older
  layout); its full 32-bit value participates in equality, never peer authentication.
  No birth-time fallback.
* Every signing read uses `csops_audittoken` with a PID/idversion selector assembled
  from libproc data. **This is not a received peer audit token or authentication of
  a channel.** XNU checks those two selector fields against its referenced process.
  No fallback to generation-unchecked `csops` occurs.
* Reads main-executable cdhash (20 bytes), actual active slice offset (signed 64-bit
  `off_t`, nonnegative), and raw 32-bit status twice, in opposite order. Rejects
  differences, an all-zero hash, failures and invalid/unknown ABI structure data.
  Status/offset use fixed-size copyouts in XNU; `csops` returns zero/error, **not a
  byte count**. Libproc must return the exact structure size. Oppositely poisoned
  round buffers additionally catch incomplete-success writes in injected tests.
* Failure codes 10–19 clear the entire output. No partial evidence survives.
* Data result **1, `BRIAN_KERNEL_UNVERIFIED_DATA`**, is still NOT production
  acceptance. Data result **2, `BRIAN_KERNEL_UNTRUSTED_DATA`**, explicitly labels
  missing valid/signed/runtime flags, ad-hoc/linker signatures, get-task-allow,
  invalid-page allowance, killed or debugged status. Both preserve raw data for
  comparison only. Untrusted data must never qualify for production.
  **Do not interpret this enum as a success/authority boolean.**
  Unknown flags cannot confer trust; neither result checks signer, team, CMS,
  entitlements, library inventory, constraints, pages or loaded dependencies.

The API returns an observational snapshot, not an atomic or continuously valid
lease: the process may change immediately after return. PID unique ID + XNU's
32-bit exec idversion, with generation-checked reads and a short sampling window,
are the actual kernel identity primitives; not a cryptographic nonce. Future
admission would need fresh authenticated binding at its own boundaries, and must
not treat this API's data classification as permission.

## Public Security comparison

The probe obtains only its own kernel executable path; opens it read-only, checks
regular-file bounds (64 MiB max), validates the kernel-selected Mach-O header and
universal slice membership (thin, fat32/fat64, at most arm64 + x86_64), and creates
a `SecStaticCode` using public `kSecCodeAttributeUniversalFileOffset`.

The pinned Security implementation scans that attribute as an `int`, so the probe
rejects offsets over `INT_MAX` rather than silently truncating. Offset zero must be
a thin executable, so default architecture selection cannot pick a different fat
slice. The compiled architecture must match the selected Mach-O header.

`SecCodeCopySigningInformation(..., kSecCSDefaultFlags, ...)` extracts public
`kSecCodeInfoUnique` and `kSecCodeInfoCdHashes`. The latter is bounded to eight
20-byte values; these are alternative digest algorithms for **one selected slice**,
not all universal architectures. The array must contain `Unique`, and the kernel
cdhash must match an alternative. No `SecStaticCodeCheckValidity`, trust evaluation,
certificate retrieval, network flags or keychain APIs are called.

Kernel snapshots bracket this comparison; simple path/stat checks catch ordinary
changes. These checks are **not** a cryptographic snapshot of file contents, static
signature validation, or proof that dyld consumed those bytes. They do not solve
in-place-write/cached-signature/restored-path attacks. Even a positive native result
proves only availability/consistency of this prerequisite for that self executable.
It does not bind the parent main CodeDirectory, its signed library constraint,
Electron/fuses/ASAR metadata, loaded framework or arbitrary JIT instructions.

## Verified ABI sources and private compatibility warning

Pinned source inspected for this change: Apple **XNU `xnu-10002.1.13`** (Sonoma
line), **`xnu-12377.121.6`** (commit `ac9718fb1af618d5ce8678d0dc6e8a58f252216f`,
newer published layout; not a claim of the user's exact kernel revision), and
Security **`Security-61040.1.3`**. These are source evidence, not a promise
that every future macOS release exports/supports these private primitives.

* [libproc.h](https://github.com/apple-oss-distributions/xnu/blob/xnu-10002.1.13/libsyscall/wrappers/libproc/libproc.h)
  and [libproc.c](https://github.com/apple-oss-distributions/xnu/blob/xnu-10002.1.13/libsyscall/wrappers/libproc/libproc.c):
  `int proc_pidinfo(int, int, uint64_t, void *, int)`; wrapper maps syscall error to
  zero, otherwise returns actual byte count. The header itself labels these
  interfaces private, despite SDK availability declarations.
* [proc_info_private.h](https://github.com/apple-oss-distributions/xnu/blob/xnu-10002.1.13/bsd/sys/proc_info_private.h):
  private `PROC_PIDUNIQIDENTIFIERINFO = 17`; exact 56-byte record: UUID[16], unique
  ID at 16, parent unique ID at 24, **int32** idversion at 32, uint32 reserved at
  36, uint64 reserved at 40 and 48. Local prefixed declaration and static assertions
  avoid requiring a private SDK header; this is **not a public compatibility API**.
  The newer pinned [header](https://github.com/apple-oss-distributions/xnu/blob/ac9718fb1af618d5ce8678d0dc6e8a58f252216f/bsd/sys/proc_info_private.h)
  defines offset 36 as signed `p_orig_ppidversion`, keeping the size and all identity
  offsets unchanged. Its [producer](https://github.com/apple-oss-distributions/xnu/blob/ac9718fb1af618d5ce8678d0dc6e8a58f252216f/bsd/kern/proc_info.c)
  (`proc_piduniqidentifierinfo`) fills this via `proc_orig_ppidversion(p)` and zeros
  the remaining uint64 reserves at 40/48. The local declaration now follows that
  union-compatible layout; older zero at 36 remains valid. A nonzero modern parent
  generation is not a reason to accept ad-hoc code or infer channel ownership.
* [proc_info.h](https://github.com/apple-oss-distributions/xnu/blob/xnu-10002.1.13/bsd/sys/proc_info.h)
  and [proc_info.c](https://github.com/apple-oss-distributions/xnu/blob/xnu-10002.1.13/bsd/kern/proc_info.c):
  SDK-exposed BSD credential record; `proc_piduniqidentifierinfo` fills UUID, unique IDs,
  `proc_pidversion`, zero reserves; exact-size copyout. Flavor 17 itself does not
  enforce same-user access, so explicit BSD credential checks are mandatory here.
* [codesign.h](https://github.com/apple-oss-distributions/xnu/blob/xnu-10002.1.13/bsd/sys/codesign.h):
  `int csops_audittoken(pid_t, unsigned int, void *, size_t, audit_token_t *)`;
  read-only op numbers STATUS=0, CDHASH=5, PIDOFFSET=6. Local exact declaration,
  weak-imported from libSystem; no dlsym or unchecked fallback. An absent entry
  point returns unavailable without making the helper unloadable.
* [kern_proc.c](https://github.com/apple-oss-distributions/xnu/blob/xnu-10002.1.13/bsd/kern/kern_proc.c):
  `csops_internal` references the process, compares token `val[5]`/`val[7]` to PID/
  `proc_pidversion`, applies MAC checks, and reads `p_textvp`/`p_textoff` via
  `vn_getcdhash`. CDHASH requires exactly 20 bytes, PIDOFFSET copies `off_t`, STATUS
  copies uint32. All three operations are read-only and not root-restricted.
* [kern_exec.c](https://github.com/apple-oss-distributions/xnu/blob/xnu-10002.1.13/bsd/kern/kern_exec.c):
  exec identity update calls `proc_setpidversion(p, OSIncrementAtomic(&nextpidversion))`;
  `proc_exec_switch_task` drains references and switches the process in the PID hash.
  This is the exec-generation evidence absent from a birth-only check.
* [mach/message.h](https://github.com/apple-oss-distributions/xnu/blob/xnu-10002.1.13/osfmk/mach/message.h):
  `audit_token_t` is eight unsigned ints. Size and selector offsets are asserted;
  other selector fields remain zero and are not claimed as authenticated credentials.
* [cs_blobs.h](https://github.com/apple-oss-distributions/xnu/blob/xnu-10002.1.13/osfmk/kern/cs_blobs.h):
  raw CS_VALID/ADHOC/GET_TASK_ALLOW/INVALID_ALLOWED/RUNTIME/LINKER_SIGNED/KILLED/
  DEBUGGED/SIGNED status constants used solely to label known-untrusted data.
* [SecStaticCode.h](https://github.com/apple-oss-distributions/Security/blob/Security-61040.1.3/OSX/libsecurity_codesigning/lib/SecStaticCode.h),
  [SecStaticCode.cpp](https://github.com/apple-oss-distributions/Security/blob/Security-61040.1.3/OSX/libsecurity_codesigning/lib/SecStaticCode.cpp),
  [machorep.cpp](https://github.com/apple-oss-distributions/Security/blob/Security-61040.1.3/OSX/libsecurity_codesigning/lib/machorep.cpp),
  [SecCode.h](https://github.com/apple-oss-distributions/Security/blob/Security-61040.1.3/OSX/libsecurity_codesigning/lib/SecCode.h),
  [StaticCode.cpp](https://github.com/apple-oss-distributions/Security/blob/Security-61040.1.3/OSX/libsecurity_codesigning/lib/StaticCode.cpp):
  public static-code attributes, offset selection, generic hash information and
  per-slice alternative-digest semantics. No internal Security information API used.

## Portable validation and remaining native work

```sh
node --test apps/app-desktop/native/computer-control/kernel-signing.test.mjs \
  apps/app-desktop/scripts/build-native-computer.test.mjs
node apps/app-desktop/native/computer-control/smoke.mjs --portable
```

The Linux test creates temporary libproc/Mach type headers and compiles **the real
ProcessIdentity.c** inside `KernelSigningSnapshotTests.c` with injected syscall
names. This tests deterministic validation, not Darwin headers, private exports,
SDK linking, Security.framework or native kernel semantics. No production test
switch, fake production evidence or fabricated signing proof is installed. Tests
cover unavailable symbol, every failed/short/oversized read, exec/PID changes with
unchanged birth, UUID/parent/reserve changes, credential changes, partial syscall
writes, changed hash/offset/status, unsafe signing flags and deadline/clock failures.
The libproc fixture serializes independently specified wire offsets rather than the
production struct. Stable modern positive/negative parent generations and older
zero are supported; changes in that field still reject. Both reserved uint64 fields,
zero identity, missing hash and negative slice remain independent failure cases.

The user reports v4 compile/link and self comparison PASS on arm64/macOS26.6.2,
SDK26.5, Swift6.3.3, clang21, Node25.5.0. The actual JSON is
`{"code":0,"kernel_data":true,"static_match":true,"untrusted_status":true,"production_authority":false}`.
This is operator-reported evidence, not a run reproduced in this Linux workspace.
Native x86_64, Rosetta/universal, other supported OS versions, parent-process
sampling and adversarial race tests remain unverified. Signed bootstrap/constraint
adversarial acceptance remains separate future work; **none of this lifts the
helper's unconditional probe-only barrier**.
