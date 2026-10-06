// Appended to the verbatim Foundation-only policy in Helper.swift. No native bypass.
var checks = 0
func check(_ condition: @autoclosure () -> Bool, _ message: String = "") {
    checks += 1
    precondition(condition(), message)
}
let fingerprint = Data([1, 2, 3])
var policy = SemanticSafety()
var wall = 1_000.0
var clock = 100.0
let original = policy.admit(id: "a", fingerprint: fingerprint, wallDeadline: 100_000,
                            wall: wall, monotonic: clock)!
check(original == 30_100) // Distant wall deadline cannot remove 30s ceiling.
// A denied approval, repeated begin, or wall rollback cannot renew an ID.
wall = 0; clock = 29_000
check(policy.admit(id: "a", fingerprint: fingerprint, wallDeadline: 100_000,
                          wall: wall, monotonic: clock) == original)
check(policy.admit(id: "a", fingerprint: Data([9]), wallDeadline: 100_000,
                          wall: wall, monotonic: clock) == nil)
check(policy.deadline(id: "a", fingerprint: Data([9])) == nil)
check(policy.deadline(id: "a", fingerprint: fingerprint) == original)
func allowed(_ p: SemanticSafety, _ mono: Double, _ wall: Double = 0,
             grant: Double = 200_000, expiry: Double = 200_000,
             channel: Bool = true, monitor: Bool = true) -> Bool {
    p.permitsEffect(monotonic: mono, wall: wall, commandDeadline: original,
                    grantDeadline: grant, wallDeadline: 100_000, wallExpiry: expiry,
                    channelAlive: channel, monitorLive: monitor)
}
check(allowed(policy, original - 1))
check(!allowed(policy, original))
check(!allowed(policy, original + 1, -100_000))
check(!allowed(policy, 100, grant: 100))
check(!allowed(policy, 100, 500, expiry: 500))
check(!allowed(policy, 100, 100_000))
check(!allowed(policy, 100, channel: false))
check(!allowed(policy, 100, monitor: false))
// Fake independent clocks and blocking AX reads / main-queue delay. All use the
// same production final guard, not a parallel implementation of its predicates.
for boundary in ["validation", "selectionAttribute", "actionNames", "mainQueue", "raiseValidation"] {
    clock = original - 1
    check(allowed(policy, clock))
    func blockingRead() { clock += 2; wall -= 5_000 }
    blockingRead()
    var effects = 0
    if allowed(policy, clock, wall) { effects += 1 }
    check(effects == 0, boundary)
}
// Earlier wall deadline is retained too, including an already-expired attempt.
var short = SemanticSafety()
check(short.admit(id: "b", fingerprint: fingerprint, wallDeadline: 1500,
                         wall: 1000, monotonic: 100) == 600)
check(short.admit(id: "expired", fingerprint: fingerprint, wallDeadline: 999,
                         wall: 1000, monotonic: 100) == 99)
check(short.admit(id: "expired", fingerprint: fingerprint, wallDeadline: 999,
                         wall: 0, monotonic: 500) == 99)
// No eviction: full admission table cannot revive a spent ID.
for i in 0..<510 {
    check(short.admit(id: "id\(i)", fingerprint: fingerprint, wallDeadline: 1500,
                             wall: 1000, monotonic: 100) != nil)
}
check(short.admit(id: "overflow", fingerprint: fingerprint, wallDeadline: 1500,
                         wall: 1000, monotonic: 100) == nil)
check(short.deadline(id: "b", fingerprint: fingerprint) == 600)
// Simulate one entered AX call with an uncertain return, then fresh IDs and replay.
var effects = 0
if allowed(policy, 100) { effects += 1; policy.markUncertain() }
check(policy.uncertain)
check(!allowed(policy, 100))
check(policy.admit(id: "new", fingerprint: fingerprint, wallDeadline: 100_000,
                          wall: 0, monotonic: 100) == nil)
check(policy.admit(id: "a", fingerprint: fingerprint, wallDeadline: 100_000,
                          wall: 0, monotonic: 100) == nil)
// Exact metadata replay remains possible after expiry, but never invokes an effect.
for _ in 0..<3 {
    check(SemanticSafety.cachedReceiptMatches(fingerprint: fingerprint, recorded: fingerprint,
                 lease: "lease", expectedLease: "lease", channelAlive: true))
}
for (recorded, lease, alive) in [(Data([9]), "lease", true), (fingerprint, "wrong", true),
                                (fingerprint, "lease", false)] {
    check(!SemanticSafety.cachedReceiptMatches(fingerprint: fingerprint, recorded: recorded,
                  lease: lease, expectedLease: "lease", channelAlive: alive))
}
check(!SemanticSafety.cachedReceiptMatches(fingerprint: fingerprint, recorded: nil,
              lease: "lease", expectedLease: "lease", channelAlive: true))
check(effects == 1)
print("PASS \(checks) production semantic policy checks: immutable deadlines, blocking-read fences, uncertainty and exact metadata replay; Foundation only, not AX atomicity")

// Real production takeover policy: passive movement versus meaningful input,
// including parent input outside approval and unknown monitored events.
for (kind, code) in [(SemanticInputKind.pointer, nil), (.key, Int32(80)),
                     (.button, Int32(81)), (.scroll, Int32(82)), (.drag, Int32(83)),
                     (.modifier, Int32(84)), (.unknown, Int32(73))] {
    for parent in [false, true] {
        check(SemanticInputPolicy.exitCode(active: false, approving: false, parentTarget: parent, kind: kind) == nil)
        check(SemanticInputPolicy.exitCode(active: true, approving: false, parentTarget: parent, kind: kind) == code)
        check(SemanticInputPolicy.exitCode(active: true, approving: true, parentTarget: parent, kind: kind) == (parent ? nil : code))
    }
}
print("PASS production semantic input policy: passive movement only; global meaningful takeover; local approval exception")
