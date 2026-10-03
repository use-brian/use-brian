// Pure policy tests: fabricated evidence is NOT macOS delivery/ownership proof.
@main
struct ClickGuardianTests {
    static func check(_ value: @autoclosure () -> Bool, _ label: String) {
        precondition(value(), label)
    }
    static func main() {
        var checks = 0
        for reason in ClickGuardian.Revocation.allCases {
            for boundary in 0...4 {
                var g = ClickGuardian()
                if boundary >= 1 { check(g.reserveDown(), "reserve down") }
                if boundary >= 2 { g.downCompleted(.exclusivelyOwned) }
                if boundary >= 3 { check(g.reserveOwnedUp(), "reserve up") }
                if boundary >= 4 { g.upCompleted(.releasedAndDrained) }
                g.revoke(reason)
                check(!g.reserveDown(), "no post-revoke down")
                check(!g.mayRelinquishLease, "revocation is not drain")
                let ambiguous = [.takeover, .monitorLoss, .permissionLoss, .lockOrSleep]
                    .contains(reason)
                if boundary > 0 && boundary < 4 && ambiguous {
                    check(g.phase == .quarantined, "overlap quarantines")
                    check(!g.reserveOwnedUp(), "never release physical overlap")
                } else {
                    if boundary == 1 { g.downCompleted(.exclusivelyOwned) }
                    if boundary == 1 || boundary == 2 {
                        check(g.reserveOwnedUp(), "surviving owner can clean up")
                    }
                    if boundary > 0 && boundary < 4 { g.upCompleted(.releasedAndDrained) }
                    g.confirmEmitterFencedAndDrained()
                    check(g.mayRelinquishLease, "only fully drained revoked lease")
                }
                checks += 1
            }
        }
        var g = ClickGuardian()
        check(g.reserveDown(), "first command")
        check(!g.reserveDown(), "duplicate blocked")
        g.downCompleted(.notDeliveredAndDrained)
        check(!g.reserveDown(), "no automatic replay even if absent")
        check(!g.mayRelinquishLease, "worker may still exist")
        g.revoke(.stop)
        g.confirmEmitterFencedAndDrained()
        check(g.mayRelinquishLease, "absent and fenced")

        // Uncertainty cannot be repaired by optimistic/late callbacks, death,
        // Stop, a fresh reserve, or a claimed producer drain.
        for up in [false, true] {
            var u = ClickGuardian()
            check(u.reserveDown(), "reserve")
            if up {
                u.downCompleted(.exclusivelyOwned)
                check(u.reserveOwnedUp(), "up reserve")
                u.upCompleted(.uncertain)
            } else { u.downCompleted(.uncertain) }
            for reason in ClickGuardian.Revocation.allCases { u.revoke(reason) }
            u.downCompleted(.notDeliveredAndDrained)
            u.upCompleted(.releasedAndDrained)
            u.confirmEmitterFencedAndDrained()
            check(!u.mayRelinquishLease && !u.reserveDown() && !u.reserveOwnedUp(), "sticky uncertainty")
        }

        // Exhaustive short adversarial callback traces. Invalid ordering fails
        // closed; no trace can exit quarantine or send an up after ambiguity.
        func walk(_ g: ClickGuardian, _ depth: Int) {
            guard depth > 0 else { return }
            for event in 0..<11 {
                var next = g
                switch event {
                case 0: _ = next.reserveDown()
                case 1: next.downCompleted(.exclusivelyOwned)
                case 2: next.downCompleted(.notDeliveredAndDrained)
                case 3: next.downCompleted(.uncertain)
                case 4:
                    let emitted = next.reserveOwnedUp()
                    check(!emitted || (!g.physicalAmbiguity && g.phase == .ownedDown), "up invariant")
                case 5: next.upCompleted(.releasedAndDrained)
                case 6: next.upCompleted(.uncertain)
                case 7: next.revoke(.stop)
                case 8: next.physicalInputOrAttributionLost()
                case 9: next.confirmEmitterFencedAndDrained()
                default: next.revoke(.workerDeath)
                }
                if g.phase == .quarantined { check(next.phase == .quarantined, "quarantine terminal") }
                if g.revoked { check(next.revoked, "revocation terminal") }
                if next.mayRelinquishLease {
                    check(next.phase == .clear && next.revoked && next.emitterFencedAndDrained, "lease invariant")
                }
                walk(next, depth - 1)
            }
        }
        walk(ClickGuardian(), 5)
        print("ClickGuardian policy PASS: \(checks) revocation boundaries; uncertainty, duplicate and exhaustive depth-5 traces (synthetic only)")
    }
}
