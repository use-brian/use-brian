import Foundation
import CoreGraphics
import Darwin

// Historical report numbering: never reorder or remove. Only null is runnable.
enum Scenario: String, CaseIterable {
    case null, normal, beforeFinal = "paused-before-final-check"
    case lastCheck = "last-check-to-post", afterDown = "after-down-stall"
    case ownerDeath = "after-down-owner-death"
    case workerBefore = "worker-death-before-check", parentBefore = "parent-death-before-check"
    case workerAfter = "worker-death-after-check", parentAfter = "parent-death-after-check"
    case overlap = "physical-overlap", held = "physical-before-check"
    var runnable: Bool { self == .null }
    var index: UInt32 { UInt32(Self.allCases.firstIndex(of: self)!) }
    var before: Bool { [.beforeFinal, .workerBefore, .parentBefore, .held].contains(self) }
    var after: Bool { [.lastCheck, .workerAfter, .parentAfter, .overlap].contains(self) }
    var physical: Bool { self == .overlap || self == .held }
}
// Fixed scalar records. Tags, PIDs, coordinates and input contents never leave the process tree.
enum Code: UInt32 {
    case consent = 1, launched, blocked, resourcesStopped, resourcesUncertain, resumed, killedWorker, killedParent, killedOwner
    case probeSent = 10, probeReceived, armed, clickWake, beforeCheck, finalChecked, downInserted, returningUp, refused, terminal, stoppedBoundary, tapDisabled, takeover
    case observerProbe = 40, observerWake, observerDown, observerUp, observerOther, observerPhysicalDown, observerPhysicalUp, observerDisabled
    case fixtureDown = 60, fixtureUp, fixturePair, fixturePhysicalDown, fixturePhysicalUp
    case timeout = 80, workerReaped, parentExited, ownerExited, observerReady, scopeLost, resumedBoundary
    case ownerStopped = 90
    case resumedTapEnabled = 92, resumedTapDisabled, observationClosed, resumeLivenessLost, resumeDeadlineExpired
    case finalSampleHeldLeft = 97, finalSampleNotHeldLeft, finalSampleNeutral, finalSampleNonNeutral, heldReleaseCue
}
func record(_ source: UInt32, _ code: Code) {
    if experiment_record(source, code.rawValue) != 1 {
        // A child must not continue toward insertion after losing phase evidence.
        if source == 3 { _exit(74) }
    }
}
func clickTag(_ tag: Int64) -> Int64 { tag ^ 0x4000000000000000 }
func neutral() -> Bool { ClickGuardianNative.Observations().neutral() }
func windowRect(pid: pid_t, number: CGWindowID) -> CGRect? {
    // Front-to-back, metadata only. Unknown/overlapping front windows refuse;
    // this sampling is NOT atomic containment after a stall or scope change.
    guard let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
          let index = rows.firstIndex(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == number }) else { return nil }
    let row = rows[index]
    guard (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
          (row[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
          (row[kCGWindowAlpha as String] as? NSNumber)?.doubleValue == 1,
          let bounds = row[kCGWindowBounds as String] as? [String: Any],
          let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary), rect.width == 500, rect.height == 350 else { return nil }
    for peer in rows.prefix(index) {
        guard let alpha = peer[kCGWindowAlpha as String] as? NSNumber else { return nil }
        if alpha.doubleValue == 0 { continue }
        guard let b = peer[kCGWindowBounds as String] as? [String: Any],
              let other = CGRect(dictionaryRepresentation: b as CFDictionary), !other.intersects(rect) else { return nil }
    }
    return rect
}
