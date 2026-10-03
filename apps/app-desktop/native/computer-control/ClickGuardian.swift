// Source-only policy. No CGEvent emitter, launch hook, wire decoder or authority.
// All calls belong on ONE surviving guardian's serialized input lane.
// Evidence below is an adapter obligation, never a worker/parent wire assertion.
struct ClickGuardian {
    enum Phase: Equatable {
        case ready, downPending, ownedDown, upPending, clear, quarantined
    }
    enum Revocation: CaseIterable {
        case stop, takeover, workerDeath, parentDeath, channelLoss
        case deadline, permissionLoss, lockOrSleep, monitorLoss
    }
    enum DownEvidence {
        // Includes proof that no delayed down can subsequently arrive.
        case notDeliveredAndDrained
        // Requires exclusive synthetic ownership, not simply observing a tag.
        case exclusivelyOwned
        case uncertain
    }
    enum UpEvidence {
        // Synthetic press gone AND no delayed down/up remains in the OS path.
        case releasedAndDrained
        case uncertain
    }

    private(set) var phase: Phase = .ready
    private(set) var revoked = false
    private(set) var physicalAmbiguity = false
    private(set) var emitterFencedAndDrained = false

    // One instance per admitted lease/epoch/command. Never reset or replay it.
    // Caller first validates screenshot/window/approval/deadline in existing path.
    // State is reserved BEFORE the adapter may attempt delivery, including failure.
    mutating func reserveDown() -> Bool {
        guard phase == .ready, !revoked, !physicalAmbiguity,
              !emitterFencedAndDrained else { return false }
        phase = .downPending
        return true
    }

    mutating func downCompleted(_ evidence: DownEvidence) {
        guard phase == .downPending else { quarantine(); return }
        switch evidence {
        case .notDeliveredAndDrained: phase = .clear
        case .exclusivelyOwned: phase = .ownedDown
        case .uncertain: quarantine()
        }
    }

    // Only use inside an adapter's atomic ownership arbitration + delivery lane.
    // A sample saying "physical button up" is NOT such arbitration. Without a
    // proven primitive, don't call this and don't inject down in the first place.
    // Revocation stops DOWN, not cleanup of an already exclusively owned press.
    mutating func reserveOwnedUp() -> Bool {
        guard phase == .ownedDown, !physicalAmbiguity,
              !emitterFencedAndDrained else { return false }
        phase = .upPending
        return true
    }

    mutating func upCompleted(_ evidence: UpEvidence) {
        guard phase == .upPending else { quarantine(); return }
        switch evidence {
        case .releasedAndDrained: phase = .clear
        case .uncertain: quarantine()
        }
    }

    mutating func revoke(_ reason: Revocation) {
        revoked = true
        if phase == .ready { phase = .clear }
        // Loss of attribution or physical takeover is NOT permission to send up.
        switch reason {
        case .takeover, .monitorLoss, .permissionLoss, .lockOrSleep:
            physicalInputOrAttributionLost()
        default: break
        }
    }

    // Any physical overlap/unknown provenance is sticky. A subsequent physical
    // up, timer, process exit or aggregate button-state sample cannot clear it.
    mutating func physicalInputOrAttributionLost() {
        physicalAmbiguity = true
        revoked = true
        switch phase {
        case .ready: phase = .clear
        case .clear: break // Already proved no synthetic events outstanding.
        default: phase = .quarantined
        }
    }

    // Not "worker exited" or RPC completed. All producers are fenced, all
    // retained intents cancelled, and OS input queues proved drained. Guardian
    // must finish owned cleanup BEFORE closing its own emission lane.
    mutating func confirmEmitterFencedAndDrained() {
        guard revoked, phase == .clear else { quarantine(); return }
        emitterFencedAndDrained = true
    }

    var mayRelinquishLease: Bool {
        revoked && phase == .clear && emitterFencedAndDrained
    }

    private mutating func quarantine() {
        revoked = true
        phase = .quarantined
    }
}
