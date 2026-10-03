# Click guardian — source-only, production input OFF

**R3 remains open. Candidate behavior is UNVERIFIED.**

- `ClickGuardian.swift` remains the abstract ownership policy. Its evidence cases
  are obligations, not receipts supplied by the candidate.
- `ClickGuardianNative.swift` now contains a concrete macOS active-session-tap
  candidate, plus deterministic bookkeeping/allocation seams.
- `ClickGuardianNativeTests.swift` contains source-only XCTest tests. They have
  **not been executed, compiled or typechecked** in this implementation task.
- Private same-binary helper/guardian, desktop lifecycle and build linkage are
  implemented candidates. Existing signed bootstrap admission is unchanged.
  Production input remains disabled. There is no runtime enable flag.

## Narrow native API

One instance belongs to one admitted lease/epoch/command and one dedicated owner
thread with a running CFRunLoop. Retain it until `fencedCleanup()` completes on
that thread; no concurrent or reentrant calls. All outward results are fixed
scalar enums, with no window, screenshot, app or other captured content.

| API | Meaning |
| --- | --- |
| `startProbe(budget:)` | Create an ACTIVE (`defaultTap`, not listen-only), head-insert session tap; post only a tagged `CGEventType.null`; asynchronously await that exact tag at the tap. Budget must be positive and at most one second. |
| `status` | Fixed scalar observation; `probing` is NOT readiness. Current best outcome is `probeConfirmedProductionOff`. |
| `execute(NativeValidatedIntent)` | Admit at most one native-validated command, point and monotonic deadline, then post a distinct tagged null wake. Denied with the current empty accepted-platform registry. |
| `revoke(reason)` | Sticky denial of further dispatch for Stop, parent/worker/channel loss, physical input, permission/session loss, tap disable or deadline. Never posts anything. |
| `fencedCleanup()` | Seal dispatch; distinguish proven never-armed no-emission, future accepted-profile stream cleanup after acknowledged monitor return, and uncertainty retaining the fence. Never global queue drain or application success. Idempotent. |

The injected trusted `validateCurrentScope` callback is a **native authority
boundary**, not a JSON/wire boolean. It must synchronously and without blocking
revalidate exact command/lease/epoch, approval, selected window, fresh screenshot
transform/point, deadline-related authority, session/permission scope, and an
independent Stop/parent/worker/channel-liveness latch. It runs at admission and
again in the click callback, including after event allocation. It must not pump
the run loop or reenter the adapter. Parent/worker liveness must not depend solely
on a death notification queued behind the click callback. The deadline uses
`ProcessInfo.systemUptime`, is rechecked locally, and is at most one second away.
No strings/content are returned; command and point scalars are native inputs.

## Null probe and callback sequence

The public CGEvent API is used literally: allocate a CGEvent, set its type to
`.null`, verify the type, set a private random correlation tag, and post at the
session tap location. There is **no claim that macOS supports delivering that
null to this tap**. Creation, permission, timer or tap-enable failure refuses
initialization. Unsupported, dropped or stripped-tag nulls cannot confirm the
probe and expire into a permanent fence, without any mouse/key effects. No mouse
down, movement or key is ever substituted as a wake. The probe's own callback
checks its absolute deadline, so a delayed timer cannot admit a late probe.
A suspended owner cannot promise an on-time notification, only refusal of late
callbacks. Physical/unknown non-null traffic during probing also revokes.

Only a matching null click wake on an armed, non-revoked instance may attempt:

1. Require a source-owned accepted platform profile, enabled tap, current trusted
   native validation and an unexpired deadline.
2. Require no held buttons or modifier flags. The adapter conservatively samples
   AppKit's full pressed-button bitmask and CoreGraphics HID/combined-session
   named button and modifier state. Aggregate samples are NOT exclusive ownership
   or a sample/post atomicity guarantee.
3. Consume the single-use command BEFORE allocating either event. Preallocate
   both tagged left down and left up; either allocation failing means no insert.
4. Recheck scope, permissions, neutrality, revocation, deadline and tap enable.
5. Fence replay, call `down.tapPostEvent(proxy)`, then return the retained tagged
   up from the **same callback**. The replaced original was a null, not user input.
   There is no delayed up task, second `post`, or later unconditional cleanup up.

Every non-null ordinary event is returned **unchanged by object identity** and
revokes future dispatch. Tags never exempt physical-looking events from this
rule. Disable/timeout notifications fence without re-enabling the tap. Unrelated
nulls are passed unchanged. Duplicate/late matching wakes cannot execute again.
Source/user-data tags correlate, but are not authority or OS delivery evidence.
A terminal attempt reports only `sequenceAttemptedUnproven`, never success,
exclusive ownership, released input, application consumption or queue drain.

## Hard blocker: stale callback proxy after timeout

Apple documents that
[`CGEvent.tapPostEvent(proxy)`](https://developer.apple.com/documentation/coregraphics/cgevent/tappostevent(_:))
inserts before the event returned by that callback, visible to subsequent taps.
That motivates this candidate's down insertion followed by returned up. It does
**not** establish safety after suspension/timeout: the OS may disable a stalled
tap and forward physical input before the old callback resumes. Late insertion
or return through the stale callback may then interact with physical input.
A `tapIsEnabled` check has another check/post race and cannot settle this.

`ClickGuardianNativeAcceptedPlatforms` has **NONE** accepted. Null confirmation
alone never yields `.ready`. Both admission and callback dispatch check the
registry. There is no environment, JSON, command-line or injected-observation
acceptance override. A future source-reviewed profile must bind trusted platform
identity to actual native acceptance of this exact ordering/timeout boundary;
an OS version string or synthetic test is insufficient. If safe null probing
cannot be supported, initialization must remain refused, not redesigned around
a physical-event wake. No OS delivery/drain evidence has been invented here.

Physical overlap, attribution loss, callback timeout, partial sequence, permission
loss, process death and ambiguous delivery retain/fence the lease. Even normal
callback return retains it: this candidate has no accepted delivery/drain proof.
`fencedCleanup()` means local dispatch is fenced, NOT that an in-flight OS event
has vanished. A surviving process or permanent lease fence cannot undo an up
already pending in the OS. The candidate deliberately does not call the policy's
`exclusivelyOwned`, `releasedAndDrained`, or `confirmEmitterFencedAndDrained`.

## Standing public lifetime epoch fence (implemented, UNVERIFIED)

`ProcessEpochFence.c/.swift` uses public Darwin `sys/event.h`: a dedicated
CLOEXEC kqueue with `EVFILT_PROC`, `NOTE_EXEC | NOTE_EXIT`, and a checked
`EV_RECEIPT` registration. Installation precedes target birth/signature/AX/CG
pinning. Unsupported flags, failed registration/receipt, descriptor errors or
allocation failure refuse admission; there is no birth-only fallback.

A synchronous zero-timeout poll runs at final identity barriers, including
callback validation after event allocation, cleanup/monitor-return validation,
and worker transfer/return acknowledgements. Any queued event (including
coalesced execs, exit/PID reuse, unknown events, EOF/error), syscall failure, or
poll contention permanently poisons that object. C atomics are lock-free; the
poll gate is try-only. No AX, Security, blocking synchronization, delayed
DispatchSource process callback or private proc selector supplies this fence.
The descriptor stays open until the strongly retained lifetime object dies;
there is no reset, rearm, clear-poison or replacement during an admitted grant.

This supplies evidence of **no exec/exit since subscription**, not a numeric
kernel generation and not atomicity between a poll and subsequent input. Public
birth/signature/path checks and pinned public AX/CG scope checks are retained.
The fence is local native state, never a generation counter/boolean accepted
from JSON. Existing bootstrap identity admission is independent and unchanged.

The worker retains its original target fence from target discovery/admission
through guardian installation and subsequent readback. The guardian independently
subscribes before its own identity/scope pinning and retains that same object
through reconstruction, event callbacks, tail proof and monitor return. Only
then does it offer `prepared`; the worker polls its ORIGINAL fence before the
authenticated `workerTransferred` acknowledgement. The guardian polls its own
fence again before arming/emission. An exec between worker admission and guardian
subscription therefore cannot be hidden by a clean new guardian subscription.
Parent/worker liveness in the guardian also uses standing public fences alongside
the existing trust/channel/liveness checks.

## Surviving owner and readback integration (implemented, UNVERIFIED)

The owner is a separate private role of the existing signed helper executable,
not a service, public protocol, signing identity or AX-worker emitter. Main
binds every stage to the immutable pending execute and original approval/scope.
The worker permanently spends the command/frame and effect authority. The old
producer cannot be reopened or replayed.

For a future accepted stream proof, worker privacy/scope revalidation and monitor
enablement precede its return acknowledgement; guardian monitoring overlaps.
Only a complete valid transcript plus observed normal owner exit permits main
to forward delivery and accept the exact worker `executed/ok` receipt. This is
stream delivery, not goal success. Fresh observe/consented capture are then
allowed for core's independent completion loop, never another effect or approval.
Uncertain emission/cleanup/return, death or malformed/lost acknowledgements fence
the lease; release requires worker death and owner safety, not timeout/death alone.
A proven never-armed no-emission refusal is distinct from uncertain emission.

## Remaining acceptance boundary

The former missing numeric-generation implementation prerequisite is replaced
by this standing lifetime fence, not fabricated. No numeric generation is
claimed or needed by this implementation. Subscription semantics, registration
and PID-reuse/exec races, final-poll-to-post races, stale callback proxies, tail
provenance, monitor overlap and native notification/loss behavior remain native
acceptance obligations. The accepted-platform registry is EMPTY. Compilation
availability is not registration success or platform acceptance. Neither written
tests nor source availability enable production; no override exists.

## Test scope / verification record

The written `ProcessEpochFenceTests.c` includes the production C source with
translation-unit-local syscall substitutions (never linked into the helper).
It covers registration/receipt/CLOEXEC failure, queued/coalesced exec, exit/PID
reuse, EOF/error, poisoned repeated polls, try-only contention, and readiness
overlap. Source contracts cover install-before-pin and original-fence handoff
placement. These tests are written only, not native acceptance.

The other source tests cover bounded/dropped/late probes at the bookkeeping seam,
invalid deadlines, scope/neutrality rejection, one-use consumption, irreversible
revocation at each phase, allocation order/tagging/failure, empty registry,
no-effect denied execution and lease-retaining cleanup. Injected observations
cannot accept a platform. Allocation tests create memory events only, not input.
The tests do not simulate a valid OS proxy, prove physical pass-through ordering,
or provide native delivery, drain, timeout or survival acceptance.

The older policy tests and their historical results are separate from this
candidate. After the implementation pass, portable guardian ledger/tail tests,
Foundation click-policy tests, desktop transport/lifecycle tests and typechecks
were run. `guardian-tests.mjs` supplies a runnable target; its Darwin branch also
includes the non-emitting API cases and C syscall-fake fence tests, which remain
unrun. Mac-target Swift parsing is not SDK compilation. See the project acceptance
ledger for exact results/fixes. Native behavior remains unverified and production
input stays off; no platform has been accepted from these portable checks.
