# Minimal click guardian — source-only, NOT enabled

`ClickGuardian.swift` is a single-use left-click ownership policy, not an OS
adapter or an executable guardian. It has no imports, launch hooks, permissions,
transport, emitter, timer, lease filesystem access or runtime integration. R3
is **not closed**. No Helper/build/signing/desktop changes are included.

## Existing boundaries inspected

- Authoritative `docs/plans/electron-native-computer-use.md`: minimal clicks,
  independent Stop, no physical release, surviving cleanup, no uncertain replay.
- `Helper.swift`: click denied and input false; existing listen-only annotated
  session tap exits on takeover; watchdog exits on parent/channel death. Neither
  survives helper SIGKILL. There is currently no ownership-aware release helper.
- `src/computer-control/lease.ts`: POSIX private directory lease; crashes retain
  it and stale leases are not stolen. Existing comment requires helper death
  before release; that will be insufficient once a separate emitter exists.

## Smallest parent integration contract (future work)

1. Keep the existing native authority, signed-parent admission, private inherited
   channel and device lease. No public socket, service, model authority, telemetry
   or second planner. A separately managed guardian must pass equivalent signed
   package/admission checks; PID alone is not identity. How it is packaged and
   admitted is an integration decision, not supplied by this policy.
2. Parent acquires the existing lease before admitting a guardian. Bind its
   instance to one lease, epoch and command identity. Validate exact selected
   window, fresh screenshot transform, point, consent and deadline in the existing
   executor. This policy neither validates these nor creates wire authority.
3. Guardian is the ONLY emitter; worker cannot post or retain deferred events.
   Guardian owns the policy BEFORE any down can be submitted. Serialize reserve,
   arbitration and submission with independent local Stop/death handling; never
   enqueue a returned reservation to run later. No execution in the AX worker or
   parent thread; no worker success response serves as delivery evidence.
4. Guardian must survive worker and parent termination (not killed as part of
   their process-group cleanup). Parent/worker EOF, generation-aware exit watch,
   local Stop and bounded watchdog revoke dispatch without network/model waits.
   Stop before reservation prevents down. After reservation, ownership remains
   pending until evidence resolves it. A reserved effect cannot be retrospectively
   cancelled by relabeling it absent. Cleanup up may continue after revocation
   ONLY through proven exclusive ownership arbitration.
5. All completion inputs come from the trusted native adapter, never JSON booleans
   or parent/worker claims. One instance accepts at most one down and one up.
   `notDeliveredAndDrained` ends the attempt; it does not authorize retry.
   Uncertain delivery, invalid completion order, lost attribution or overlap while
   outstanding quarantines the instance permanently. No timeout, later physical
   up, process exit or aggregate state sample clears quarantine.
6. Finish cleanup, cancel all retained intents, fence every producer and prove
   queues drained before `confirmEmitterFencedAndDrained`. Only then may the
   revoked policy's `mayRelinquishLease` authorize the parent's existing release.
   Worker exit alone cannot release it. On parent death retain the POSIX lease
   even after cleanup; no stale-directory stealing or automatic restart/reset.
   Guardian failure likewise retains the lease. Restart must not mint a new
   policy over an unresolved lease. Recovery remains explicitly unavailable,
   rather than silently replaying or sending unconditional up.

## Why no concrete CGEvent posting adapter is supplied

A safe adapter cannot presently be implemented from the existing primitives
without inventing guarantees. Specifically unresolved:

- `CGEvent.post` does not return target delivery/consumption or a queue-drain
  acknowledgement. Return, paired calls, pipe reply, worker death and observing
  the tagged event in a tap do not establish delivery, absence or final UI effect.
- Source PID/user-data tags correlate events; they do not create a separately
  owned logical mouse button. No demonstrated primitive here releases only a
  synthetic press while a physical user's left button overlaps it.
- `CGEventSource.buttonState`/event-tap observation followed by posting up has a
  physical-down race. Listen-only taps do not atomically arbitrate ownership and
  delivery. Tap loss, coalescing/order across streams and permission/lock changes
  leave attribution uncertain. A private event source is not proof of isolation.
- A synthetic down submitted before Stop/death can arrive late. No demonstrated
  cancellation/drain boundary excludes that arrival or a delayed up after lease
  handoff. A separately surviving process solves lifetime, not these OS issues.

Therefore **do not connect this policy to CGEvent.post**, even behind a runtime
flag. `exclusivelyOwned`, `releasedAndDrained`, and the atomic arbitration required
by `reserveOwnedUp` are proof obligations, not implemented native capabilities.
On takeover/overlap this policy intentionally withholds up and retains the lease;
that avoids authorizing release of physical input but does NOT guarantee cleanup
of an injected press. This is why injection must remain disabled. No new HID
service/driver or suppression of the user's input is proposed as a workaround.

Before integration, choose and review a concrete OS mechanism that satisfies
these obligations or keep clicks unavailable. Then test the actual signed Mac
package: worker/parent termination and Stop at each down/up boundary; physical
press/release overlap; partial/late delivery; guardian termination; disabled tap,
permission loss, lock/sleep; and attempted lease reacquisition. Observe actual
fixture/UI effects and physical-button preservation. Synthetic tests below prove
only policy transitions and cannot substitute for that evidence.

## Concrete Mac question to resolve next

Apple documents that [`CGEvent.tapPostEvent(proxy)`](https://developer.apple.com/documentation/coregraphics/cgevent/tappostevent(_:)) inserts an event **before** the event returned by that callback, visible to later taps. An active surviving tap could therefore insert an owned up before forwarding an overlapping physical down unchanged. That addresses ordinary ordering, not callback failure.

The unresolved case is suspension/timeout between deciding to release and posting through the proxy: the OS disables the unresponsive tap and forwards physical input, then the old callback resumes. Whether late insertion through that proxy is rejected or retains ordering has not been established. A `tapIsEnabled` check alone introduces another check/post race. Resolve this concrete OS boundary on Mac before authorizing input; do not treat hypothetical ordering, the policy tests, or a permanent lease fence as proof that an already-pending up cannot release physical input. Application consumption is separate and should use existing fresh fixture/AX outcome checks, not a new general UI-drain platform. The prototype is not a mandate to retain this design if a smaller sound mechanism is found.

## Reproduce policy tests

On a Swift toolchain with its runtime available, from this directory:

```sh
d=$(mktemp -d)
trap 'rm -rf "$d"' EXIT
swiftc -swift-version 5 ClickGuardian.swift ClickGuardianTests.swift -o "$d/tests"
"$d/tests"
swiftc -swift-version 5 -O ClickGuardian.swift ClickGuardianTests.swift -o "$d/tests-opt"
"$d/tests-opt"
```

Tests use explicit `precondition` (retained under `-O`, not `-Ounchecked`). They
exercise all nine revocation reasons at five boundaries, uncertain down/up,
duplicates/no replay, and exhaustive depth-five adversarial callback sequences.
There are no native delivery tests or fabricated native adapter receipts.

Local verification: Linux Swift 6.2.4, Swift 5 language mode, unoptimized and
`-O`: PASS (45 revocation boundaries plus depth-five traces). Nix shell linking
required the `swiftPackages.stdlib` output's `lib` directory via `-L` and rpath;
a compiler-only shell failed to link. No Mac runtime verification was performed.
