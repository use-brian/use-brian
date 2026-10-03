# Isolated native mechanism experiment — NOT production acceptance

**Hazardous, attended, test-only. Use a DISPOSABLE ISOLATED Mac login, with other
applications closed and no valuable work or credentials accessible. Session-level
input CANNOT be guaranteed to stay inside the fixture after focus loss,
suspension, process death or a stale callback return. Do not run on your ordinary
working desktop.** A pending up may affect a physical press. There is no blind
cleanup up, retry, release proof or automatic acceptance promotion.

This directory is deliberately excluded from production compilation/packaging.
It changes neither the helper/Host nor the empty accepted-platform registry.
It is a mechanism experiment, **not signed Host/worker/desktop acceptance**.
No Mac execution is claimed by the portable checks below.

## Finite interface

Build and run are separate. Build does not launch anything, request permissions,
access credentials, explicitly sign artifacts or invoke production build scripts.
Xcode command-line tools and the repository's existing Node installation suffice;
there is no dependency resolution. Output stays in this directory's `.build/`.

```sh
cd apps/app-desktop/native/computer-control/tests/native-acceptance
node --test portable.test.mjs   # portable; no GUI, permission calls or input
bash build.sh                  # future Mac SDK compilation ONLY
node run.mjs --run null         # future attended run; opens per-case GUI consent
node run.mjs --run normal       # another process and fresh consent, not a retry
```

Every `--run` takes exactly one of these names. No PID, coordinates, command,
JSON configuration, acceptance flag, `--yes` or environment enablement is accepted.
Do not automate a loop over these commands. A failed phase must be reviewed, not
retried automatically.

| Case | Actual fault / collection |
| --- | --- |
| `null` | One tagged null probe; owner and downstream correlation, no pair. |
| `normal` | Null probe, distinct null wake, one preallocated pair, independent downstream and fixture receipts. |
| `paused-before-final-check` | SIGSTOP after allocation, before the final scope/neutrality/deadline checks; resume after three seconds. |
| `last-check-to-post` | SIGSTOP after the final checks/sealing and before `tapPostEvent`; resume after three seconds. |
| `after-down-stall` | SIGSTOP after down insertion returns, before returning the retained up; resume after three seconds. |
| `after-down-owner-death` | Same boundary, then kill the stopped owner instead of resuming it. In-flight state remains inconclusive. |
| `worker-death-before-check` | Stop before final validation, kill the actual worker process, observe exit, then resume. |
| `parent-death-before-check` | Same, killing the owner's **actual OS parent**, not a sibling stand-in. |
| `worker-death-after-check` | Stop after final validation, kill worker, observe exit, resume into the posting boundary. |
| `parent-death-after-check` | Same with actual parent death/reparenting. |
| `physical-overlap` | Stop after final validation. Operator presses and releases the fixture target during the three-second cue. Observe untagged traffic and resumed stale sequence. |
| `physical-before-check` | Stop before final validation. Hold left on the target until **SAMPLE RECORDED**; release manually only after that cue. The actual resumed final sample must establish held-left and nonneutral input. |

The death cases resume after observed death rather than deliberately waiting for
the input deadline to expire. Scheduling may still expire that deadline. Records
separately identify expired deadlines and liveness loss; a refusal does not prove
which of several failed guards caused it.

Before each case, an NSAlert requires both a disposable-login acknowledgement
checkbox and the case-specific consent button. Cancel and the 60-second consent
deadline launch no children and post nothing. There is a two-second hands-off
settling interval, followed by permission, foreground and full neutral-button/
modifier checks. The nonmovable-by-drag, borderless 500x350 fixture has one fixed
center target. Its process/window and point are derived internally; scope is
pinned and checked again before insertion. No arbitrary application is admitted.

For physical cases, first leave the mouse over the blue target and release all
buttons/modifiers before the settling interval ends. Only act when the fixture
shows **NOW**. Moving the mouse earlier can revoke the experiment. Missing the
cue produces `inconclusive`; it does not manufacture physical evidence. For
`physical-before-check`, the end of the three-second pause is **not** a release
cue: keep holding through resume until **SAMPLE RECORDED**. The owner samples
AppKit's left-button bit plus HID and combined-session left state, and samples
neutrality, before any final scope/deadline guard can short-circuit. The GUI only
cues release after it receives that sample. Either observer or fixture reporting
an up before the final sample, missing/inconsistent held-left evidence, a neutral
sample, or a missing/early release cue makes the case inconclusive—even if the
deadline subsequently refuses dispatch. Samples are not atomic ownership proof;
refusal still does not attribute causality to one particular failed guard.
On cancellation or experiment termination release manually; that does not turn an
unreached held-input phase into a passing case.

Use the app's **Stop experiment** menu / Command-Q for local cancellation. It
fences the experiment and terminates owned processes, **not pending OS input**.
Release any held physical button yourself. Do not interpret cancellation, process
exit, neutral state or the eight-second collection interval as a released stream.

### Pre-start refusal diagnostics

A consented report with `started:false` means no child experiment was started.
Older builds collapse all such failures to `preflight-unavailable`; that result
alone cannot identify a missing permission. Current builds add a nullable closed
`preflightFailure` code and use it as the blocked reason:

- `cancelled-before-start`: cancellation was already pending.
- `input-not-neutral`: release buttons/modifiers; keep hands off during startup.
- `fixture-not-frontmost`: the fixture lost foreground. No automatic refocus/retry.
- `listen-permission-unavailable` / `post-permission-unavailable`: the respective
  macOS permission preflight refused. Review Input Monitoring / Accessibility
  for the actual test process or responsible launcher in the disposable login;
  granting Use Brian permission is not permission for this standalone harness.
- `observer-unavailable`: listen-only tap creation/source/enablement failed.
- `fixture-window-unavailable`: the owned window could not be resolved.
- `consent-bootstrap-unavailable`: native consent/bootstrap validation refused.

These diagnostics neither request permissions nor relax any guard. Do not run
`normal` or other emitting cases to diagnose a blocked `null` case.

### Permissions and signing

The harness only calls permission preflight APIs. Missing TCC permissions/tap
support produce a blocked or inconclusive report; there is no prompt fallback.
Manual TCC setup belongs to the disposable login. If your existing signing/TCC
setup requires signing this test app, use that existing setup outside this
harness. There is no new signing pipeline, credential provisioning, ad-hoc signing
command, hardened-runtime exception or production bootstrap bypass here. The
Apple linker may supply its usual linker signature; that is not a release signing
or trust claim.

After an externally managed signature changes the binary, use
`node run.mjs --record-build` to refresh its **local identity only**. This command
never launches the artifact or approves a platform. Hashes are local reproducibility
metadata, not trusted source-to-binary attestation or signer verification.

## Process / callback architecture

```
Node runner (bounded output; never grants consent)
  supervisor + AppKit fixture + independent listen-only tail observer
    worker (real disposable process)
    parent (real disposable process / owned process-group leader)
      tap owner (active head-insert session tap, separate run loop/process)
```

### Closed, consent-rooted bootstrap

`--owned-child` no longer exists. The three fixed internal argv roles
`--owned-parent`, `--owned-worker`, and `--owned-owner` are **not** independent
entry points into an input experiment. `Bootstrap.c` admits each only through a
single-use, two-second-bounded socket grant from its actual issuer. The public
runner accepts none of these roles. There is no bootstrap JSON/env override.

- The GUI supervisor pins itself before constructing the GUI. Its native launch
  latch is set only after this case's modal consent and a check that the fixed
  window belongs to itself. Only that branch can issue parent/worker roles; only
  an admitted parent can issue the one owner role. A failed spawn/admission spends
  its role reservation; no retry or alternate path is available.
- The child first subscribes to its **actual** parent, obtained from the kernel,
  before pinning its identity. `proc_pidinfo` supplies UID/real/saved UID, parent
  and birth data. `proc_pidpath` supplies the executable path, never argv/config.
  Each process must have the same path, opened regular-file device/inode, and
  non-root process UID. A bounded public `PROC_PIDREGIONPATHINFO` scan additionally
  requires the kernel's executable mapping vnode to match that opened file; an
  old mapped inode cannot be accepted merely by replacing its path. Unknown or
  unsupported metadata refuses, with no path-only fallback.
- The owner derives the supervisor from its actual parent's kernel PPID. The
  parent and worker must both be actual direct children of that supervisor; the
  owner must be the actual parent's child. All processes must meet the same
  executable/UID checks. The window owner must be this derived supervisor, not
  an arbitrary supplied PID. The admitted config is overwritten with the derived
  ancestry before Swift scope construction.
- The inherited bootstrap descriptor must be a nonblocking local stream socket:
  kernel `LOCAL_PEERPID` and `getpeereid` must identify the actual parent. Plain
  fabricated pipes, foreign socket creators, different binaries/UIDs/ancestors,
  swapped argv/grant roles, unrelated windows and wrong recipients refuse before
  even null posting. The record/command pipe identities must match the issuer's
  original descriptors. A nonce/recipient/role-bound acknowledge/commit exchange
  prevents a stale or differently issued grant from being substituted.
- The issuer keeps the original child/ancestor/worker epoch fences and pinned
  executable descriptors through commit. Receiver subscriptions begin before
  pinning and overlap those original fences. Every bootstrap barrier rechecks
  the pinned process/file identities and polls the original epochs; these are
  not replaced after handoff. The owner continues polling its **original C
  bootstrap fences** as well as the existing Swift scope fences before probing
  and before the final click check.

This is a narrow check for this unmodified, locally built test executable, not a
new signing or attestation platform. It does not attest immutable loaded bytes,
resist debugger/code injection into an already admitted process, or create a
production signer/parent policy. Bootstrap checks export no paths, UID/PID values or grants. The existing build
source/binary digests remain bounded reproducibility metadata. Actual socket peer-credential, mapped-vnode and lifetime-subscription
behavior still requires Mac verification; unsupported results fail closed.

The observer/fixture stay responsive while the owner is SIGSTOPped. The parent
observes actual stopped status with `waitid`, not just the owner's preceding
phase record. The supervisor only injects a fault after that acknowledgement.
Parent/worker/supervisor epoch fences use the unchanged production public C/Swift
implementation and are installed before owner scope pinning. This is actual
subscription, not syscall-fake evidence. Subscription failure refuses the case.

The owner's parent manages signals/reaping for its direct child while alive.
For real parent death, the supervisor retains that direct child's zombie until
all owned-group signaling ends: the parent PID/PGID cannot be reused underneath
those signals. Only parent+owner belong to that created group. Worker signaling
uses its unreaped direct-child identity. Owner exit is also observed through a
real kqueue registration. Registration races/failure are inconclusive, not an
assumed exit. Normal teardown asks the parent to kill/reap its child before a
bounded group fallback. An orphan owner's exit is observed, not falsely reported
as reaped by the supervisor; the supervisor reaps its own children.

**Orphaned stopped process groups may receive SIGHUP/SIGCONT automatically.**
The owner ignores SIGHUP (test lifetime only); automatic resume/reparenting is
recorded, not suppressed or represented as a supervisor-requested resume.
Liveness-loss records allow this distinction. It may make a case inconclusive.

The shared candidate's pure ledger and memory-only `preallocate` function are
compiled unchanged. The test adapter independently creates the same active head
session tap and uses literal null probes/wakes. Its only pair emission is:

```swift
down.tapPostEvent(proxy)
// optional test-only after-down suspension/death barrier
return Unmanaged.passRetained(up)
```

Both allocations precede insertion; the producer is sealed before insertion;
all ordinary non-null callbacks return the same event object and fence future
work. There is no later up post, extra sequence, mouse/key wake substitute,
production `.execute` invocation or platform-acceptance override.

This is **not the full candidate**: it omits Host signed admission, approval/
screenshot reconstruction, candidate tail-ownership proof, monitor-return
handshakes and production lease release. The test scope checks use fixture window
metadata and foreground APIs; their timing is not production Host callback-time
validation. Instrumentation itself changes timing. Source tests check posting
order/correspondence, not equivalence of all generated instructions or OS behavior.

## Records, verdicts and bounds

Callback phase/event records are fixed 24-byte scalars, written once to an
inherited **nonblocking** pipe (within PIPE_BUF). No allocation/JSON/string
logging/locks/retries in the C record writer. Record failure prevents an owner
from proceeding; missing terminal/sequence evidence is inconclusive. Supervisor
storage is capped at 2,048 records and output at 256 KiB. Only monotonic timestamps,
source-local sequence numbers and closed codes are exported. A private parent
record supplies the internally spawned owner identity solely to the supervisor's
exit watcher; it is consumed and never exported. No event key contents, screenshots,
window titles, arbitrary application metadata, PIDs, coordinates or tags are
reported. Ordinary mouse/key traffic is reduced to fixed classes.

Sources: 0 supervisor, 1 independent observer, 2 fixture, 3 owner, 4 supervisor
fault/lifecycle control, 5 real parent. `Model.swift` defines the code values;
`report.mjs` constrains which source may produce each. In particular:

- 10–22: probe, arming, callback/check/insertion/return/fencing phases;
- 40–47: downstream null/pair/ordinary-traffic/tap-disable observations;
- 60–64: fixture pair and untagged-button receipts;
- 80–86: timeout, lifetime observations, scope/monitor state, callback resume;
- 90: actual stopped status acknowledged by the parent;
- 92/93: tap enabled/disabled sampled immediately after resume;
- 94: independent observation window closed;
- 95/96: liveness loss/deadline expiry sampled after resume;
- 97/98: consistent held-left / not-established held-left at final check;
- 99/100: neutral / nonneutral sample at that same final-check boundary;
- 101: supervisor's sample-received release cue (held-input case only).

“Physical” record names mean **untagged traffic in an explicitly attended
exercise**, not authenticated hardware provenance. Tags correlate only. The
fixture counts a pair only after a tagged target down followed by a tagged up;
that is application receipt, not global drain or exclusive press ownership.

The checker requires a complete bounded observation window, real reached phases,
source-local record continuity, final supervisor/observer/fixture/control record counts, null confirmation and required downstream/fixture
receipts. Unknown/extra fields, overflow, observer disable, scope loss, missing
phases or ambiguous process termination cannot produce a positive verdict.

- `observed-as-specified` (exit 0): narrow observations/refusal criteria only.
- `blocked` (exit 2): consent/preflight/build/launch unavailable.
- `inconclusive` (exit 3): missing phase/evidence, partial input, ambiguous loss.
- `counterexample` (exit 4): concrete unexpected ordering/duplicate/input after
  the observed disabled or liveness-loss boundary.

A delayed disabled notification alone does not establish that the tap was already
disabled when resumed: the stale-proxy counterexample requires the actual resumed
`tapIsEnabled` sample to be false. No downstream event in eight seconds is **not**
proof that insertion was dropped or no event remains pending. Finite clean trials
cannot establish the absence of a race.

Every result has `productionAcceptance: false`, including successes. No code reads
reports back into production. Build identity contains bounded SDK/compiler data,
source hashes and binary hash; runtime adds architecture and OS/build string.
Nothing is uploaded or automatically persisted outside the explicit build output.

The GUI closes collection at eight seconds; the real parent and runnable children
also have independent bounded lifetimes. The runner requests graceful cancellation
at 90 seconds, then reports uncertain process state after another 20 seconds if
necessary. It does not blindly kill an unresponsive supervisor and claim cleanup.
SIGSTOP prevents a stopped owner's own alarm from executing. **Simultaneous loss
of supervisor and parent while owner is stopped is outside this finite matrix and
can strand the stopped process.** An unresponsive/abnormally exited supervisor or
uncertain resource report requires ending the disposable login, not running more
cases. Even known process termination cannot retract OS events.

## Verification and explicit remaining scope

All twelve named cases have executable implementations; none uses a fabricated
proxy, transcript, synthetic “physical” injector or acceptance Boolean.

Portable checks include a compiled, executed C **synthetic-data-only** topology/
identity seam (95 admissions/refusals, no native APIs linked), plus native-source
ordering checks for peer credentials, role grants, original fence overlap and
GUI-only launch. They also exercise strict reports/verdicts/consent handling, malformed and
incomplete records, case selection, source correspondence, production build/
packaging exclusion, shell syntax and C bridge layout compilation. They are not
Darwin compilation, actual kernel process topology/credential tests or native input evidence.
Parent verification also parsed the Swift sources for an arm64 macOS target
using the available Nix Swift compiler. Parsing is not SDK typechecking or linking.
Do not confuse portable C header/policy compilation with compiling `Experiment.c`
against Darwin headers.

Remaining native verification: SDK compile/link of this new target; AppKit/TCC
startup; null delivery/tag survival; actual waitid/kqueue/group behavior; tap
insertion/return ordering; disable/timeout/stale-proxy behavior; manual physical
exercises; and report/result inspection on the isolated Mac. Missing or unexpected
API behavior must stay blocked/inconclusive/counterexample, not gain a fallback.

Intentional non-implementation outside this bounded experiment: production Host
acceptance and signing/bootstrap integration, full monitor-return/lease protocol,
PID-reuse/exec adversarial matrix, lock/sleep/TCC-revocation matrix, simultaneous
supervisor+parent failure recovery, global input containment/release/drain proof,
and automatic platform promotion. No additional experiment framework is required
for the twelve cases above.

For parent-provided Swift syntax checking only (does not compile/link the Mac
APIs and does not execute input):

```sh
swiftc -frontend -parse -target arm64-apple-macosx14.0 \
  main.swift Model.swift Adapter.swift ../../ClickGuardianNative.swift ../../ProcessEpochFence.swift
```

The native bootstrap additionally needs real Mac SDK compilation and negative
launch tests with fabricated descriptors/foreign ancestors before any attended
emitting case is considered. No such native result is claimed here.
