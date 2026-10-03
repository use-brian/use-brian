// XCTest suite: portable ledger/tail cases run via guardian-tests.mjs; Darwin
// cases remain unverified. Synthetic transitions are NOT native acceptance.
// Include with ClickGuardianNative.swift in a separate test target;
// do not combine with the older policy test executable's @main.
import Foundation
import XCTest

final class ClickGuardianNativeLedgerTests: XCTestCase {
    private func confirmed() -> ClickGuardianNativeLedger {
        var value = ClickGuardianNativeLedger()
        XCTAssertTrue(value.beginProbe(now: 10, budget: 0.25))
        XCTAssertTrue(value.probeArrived(now: 10.1))
        return value
    }

    func testNoReadinessWithoutBoundedNullConfirmation() {
        for budget in [0.0, -1, 1.01, .infinity, .nan] {
            var value = ClickGuardianNativeLedger()
            XCTAssertFalse(value.beginProbe(now: 10, budget: budget))
            XCTAssertEqual(value.phase, .idle)
        }
        var dropped = ClickGuardianNativeLedger()
        XCTAssertTrue(dropped.beginProbe(now: 10, budget: 0.25))
        XCTAssertEqual(dropped.phase, .probing)
        dropped.expire(now: 10.25)
        XCTAssertEqual(dropped.phase, .fenced)
        XCTAssertFalse(dropped.probeArrived(now: 10.26))
        XCTAssertFalse(dropped.arm(now: 10.26, deadline: 11))
        XCTAssertFalse(dropped.beginProbe(now: 12, budget: 0.25))
    }

    func testLateProbeCannotBeatDelayedTimer() {
        var value = ClickGuardianNativeLedger()
        XCTAssertTrue(value.beginProbe(now: 10, budget: 0.25))
        // No timer fired: callback itself must enforce the absolute bound.
        XCTAssertFalse(value.probeArrived(now: 10.25))
        XCTAssertEqual(value.phase, .fenced)
    }

    func testOneUseWakeAndNoReplayAfterAmbiguousSequence() {
        var value = confirmed()
        XCTAssertTrue(value.arm(now: 10.2, deadline: 10.5))
        XCTAssertTrue(value.consume(now: 10.3, trustedScope: true, neutral: true))
        XCTAssertEqual(value.phase, .consumed)
        // Covers allocation failure, insertion attempt, and callback-return loss:
        // none is permission to recreate a command or send a later cleanup up.
        XCTAssertFalse(value.consume(now: 10.31, trustedScope: true, neutral: true))
        XCTAssertFalse(value.arm(now: 10.32, deadline: 10.6))
        XCTAssertEqual(value.phase, .fenced)
    }

    func testScopeButtonsModifiersAndDeadlineRefuse() {
        for (scope, neutral, time) in [(false, true, 10.3), (true, false, 10.3),
                                      (true, true, 10.5), (true, true, Double.nan)] {
            var value = confirmed()
            XCTAssertTrue(value.arm(now: 10.2, deadline: 10.5))
            XCTAssertFalse(value.consume(now: time, trustedScope: scope, neutral: neutral))
            XCTAssertEqual(value.phase, .fenced)
            XCTAssertFalse(value.consume(now: 10.3, trustedScope: true, neutral: true))
        }
    }

    func testRevocationAtEveryBoundaryIsSticky() {
        // The native adapter maps every revocation (including parent/worker loss,
        // physical traffic and tap disable) to this same irreversible fence.
        for boundary in 0...4 {
            var value = ClickGuardianNativeLedger()
            if boundary >= 1 { XCTAssertTrue(value.beginProbe(now: 10, budget: 0.25)) }
            if boundary >= 2 { XCTAssertTrue(value.probeArrived(now: 10.1)) }
            if boundary >= 3 { XCTAssertTrue(value.arm(now: 10.2, deadline: 10.5)) }
            if boundary >= 4 {
                XCTAssertTrue(value.consume(now: 10.3, trustedScope: true, neutral: true))
            }
            value.fence()
            value.expire(now: 100)
            XCTAssertFalse(value.beginProbe(now: 100, budget: 0.25))
            XCTAssertFalse(value.probeArrived(now: 10.1))
            XCTAssertFalse(value.arm(now: 10.2, deadline: 10.5))
            XCTAssertFalse(value.consume(now: 10.3, trustedScope: true, neutral: true))
            XCTAssertTrue(value.revoked)
            XCTAssertEqual(value.phase, .fenced)
        }
    }

    func testBadDeadlineAndDuplicateAdmissionAreTerminal() {
        for deadline in [10.2, 11.21, .infinity, .nan] {
            var value = confirmed()
            XCTAssertFalse(value.arm(now: 10.2, deadline: deadline))
            XCTAssertEqual(value.phase, .fenced)
        }
        var duplicate = confirmed()
        XCTAssertTrue(duplicate.arm(now: 10.2, deadline: 10.5))
        XCTAssertFalse(duplicate.arm(now: 10.2, deadline: 10.5))
        XCTAssertEqual(duplicate.phase, .fenced)
    }
}

// Synthetic profiles exercise selection, never populate the production registry.
final class ClickGuardianPlatformSelectorTests: XCTestCase {
    private func profile(major: Int = 14, minor: Int = 5, patch: Int = 0,
                         build: String = "23F79", architecture: String = "arm64",
                         revision: Int = 1) -> ClickGuardianPlatformProfile {
        ClickGuardianPlatformProfile(major: major, minor: minor, patch: patch,
            build: build, architecture: architecture, mechanismRevision: revision)
    }

    func testProductionRegistryIsEmptyAndRefuses() {
        XCTAssertTrue(ClickGuardianNativeAcceptedPlatforms.profiles.isEmpty)
        XCTAssertFalse(ClickGuardianNativeAcceptedPlatforms.acceptsCurrentPlatform())
        XCTAssertFalse(ClickGuardianPlatformSelector.matches(profiles: [], runtime: profile(), translated: false))
    }

    func testOnlyExactVersionBuildArchitectureAndMechanismMatch() {
        let accepted = profile()
        XCTAssertTrue(ClickGuardianPlatformSelector.matches(profiles: [accepted], runtime: accepted, translated: false))
        let intel = profile(architecture: "x86_64")
        XCTAssertTrue(ClickGuardianPlatformSelector.matches(profiles: [accepted, intel], runtime: intel, translated: false))
        for mismatch in [profile(major: 15), profile(minor: 6), profile(patch: 1),
                         profile(build: "23F80"), intel, profile(revision: 2)] {
            XCTAssertFalse(ClickGuardianPlatformSelector.matches(profiles: [accepted], runtime: mismatch, translated: false))
        }
    }

    func testTranslatedUnknownAndMissingMetadataRefuse() {
        for translated in [true, nil] as [Bool?] {
            XCTAssertFalse(ClickGuardianPlatformSelector.matches(profiles: [profile()], runtime: profile(), translated: translated))
        }
        XCTAssertFalse(ClickGuardianPlatformSelector.matches(profiles: [profile()], runtime: nil, translated: false))
    }

    func testMalformedAndDuplicateProfilesInvalidateEntireRegistry() {
        let valid = profile()
        let malformed = [profile(major: 0), profile(minor: -1), profile(patch: -1),
            profile(build: ""), profile(build: "23F79\n"), profile(build: "23F79\0"),
            profile(build: " 23F79"), profile(build: "23F79extra"), profile(build: "23F79\u{2028}"),
            profile(build: String(repeating: "2", count: 65) + "F79"),
            profile(architecture: "ARM64"), profile(architecture: "unknown"), profile(revision: 0)]
        for bad in malformed {
            XCTAssertFalse(ClickGuardianPlatformSelector.matches(profiles: [valid, bad], runtime: valid, translated: false))
            XCTAssertFalse(ClickGuardianPlatformSelector.matches(profiles: [valid], runtime: bad, translated: false))
        }
        XCTAssertFalse(ClickGuardianPlatformSelector.matches(profiles: [valid, valid], runtime: valid, translated: false))
        let other = profile(build: "23F80")
        XCTAssertFalse(ClickGuardianPlatformSelector.matches(profiles: [valid, other, other], runtime: valid, translated: false))
    }
}

#if os(macOS)
import CoreGraphics

final class ClickGuardianNativeGateTests: XCTestCase {
    func testPairIsPreallocatedTaggedAndNeverPostedByPreparation() {
        var order: [CGEventType] = []
        let pair = ClickGuardianNative.preallocate(point: CGPoint(x: 20, y: 30), tag: 42) {
            type, point in
            order.append(type)
            return CGEvent(mouseEventSource: nil, mouseType: type,
                           mouseCursorPosition: point, mouseButton: .left)
        }
        XCTAssertEqual(order, [.leftMouseDown, .leftMouseUp])
        XCTAssertNotNil(pair)
        XCTAssertEqual(pair?.0.type, .leftMouseDown)
        XCTAssertEqual(pair?.1.type, .leftMouseUp)
        XCTAssertEqual(pair?.0.getIntegerValueField(.eventSourceUserData), 42)
        XCTAssertEqual(pair?.1.getIntegerValueField(.eventSourceUserData), 42)
        // These are memory objects only; no event posting is performed here.
    }

    func testEitherAllocationFailureReturnsNoPair() {
        for failure in [CGEventType.leftMouseDown, .leftMouseUp] {
            var order: [CGEventType] = []
            let pair = ClickGuardianNative.preallocate(point: .zero, tag: 42) { type, point in
                order.append(type)
                if type == failure { return nil }
                return CGEvent(mouseEventSource: nil, mouseType: type,
                               mouseCursorPosition: point, mouseButton: .left)
            }
            XCTAssertNil(pair)
            XCTAssertEqual(order, failure == .leftMouseDown
                ? [.leftMouseDown] : [.leftMouseDown, .leftMouseUp])
        }
    }

    func testNoAcceptedPlatformAndNoEffectsFromExecute() {
        XCTAssertFalse(ClickGuardianNativeAcceptedPlatforms.acceptsCurrentPlatform())
        // Implementation availability is not successful installation/acceptance.
        #if os(macOS)
        XCTAssertTrue(ClickGuardianNativeIdentitySupport.hasPublicEpochFenceSupport())
        #else
        XCTAssertFalse(ClickGuardianNativeIdentitySupport.hasPublicEpochFenceSupport())
        #endif
        var allocations = 0
        var validations = 0
        var observations = ClickGuardianNative.Observations()
        observations.now = { 10 }
        observations.neutral = { true }
        observations.mouseEvent = { _, _ in allocations += 1; return nil }
        let adapter = ClickGuardianNative(validateCurrentScope: { _ in
            validations += 1
            return true
        }, observations: observations)
        let intent = ClickGuardianNative.NativeValidatedIntent(
            command: 1, x: 100, y: 100, deadline: 10.5)
        XCTAssertEqual(adapter.execute(intent), .refused)
        XCTAssertEqual(adapter.execute(intent), .refused)
        XCTAssertEqual(allocations, 0)
        XCTAssertEqual(validations, 0)
        XCTAssertEqual(adapter.fencedCleanup(), .neverArmedNoEmission)
    }

    func testInvalidProbeBudgetDoesNotCreateTapOrRequestPermissions() {
        let adapter = ClickGuardianNative(validateCurrentScope: { _ in
            XCTFail("invalid probe must not validate an intent")
            return false
        })
        XCTAssertEqual(adapter.startProbe(budget: 0), .refused)
        XCTAssertEqual(adapter.fencedCleanup(), .neverArmedNoEmission)
    }

    func testReturnAcknowledgmentCannotManufactureAcceptedStreamEvidence() {
        let adapter = ClickGuardianNative(validateCurrentScope: { _ in true }, validateMonitoringScope: { true })
        XCTAssertFalse(adapter.beginMonitorReturn(deadline: ProcessInfo.processInfo.systemUptime + 1))
        // No producer reservation, no pair, no platform or identity acceptance.
        XCTAssertEqual(adapter.completeMonitorReturn(), .neverArmedNoEmission)
        XCTAssertFalse(adapter.sequenceAttempted)
        XCTAssertFalse(adapter.tailObservationComplete)
    }

    func testAllLossSignalsFenceWithoutCleanupEvents() {
        let reasons: [ClickGuardianNative.Revocation] = [
            .stop, .parentLoss, .workerLoss, .channelLoss, .physicalInput,
            .permissionLoss, .lockOrSleep, .tapDisabled, .deadline
        ]
        for reason in reasons {
            var observations = ClickGuardianNative.Observations()
            observations.mouseEvent = { _, _ in
                XCTFail("revocation/cleanup must never allocate an up")
                return nil
            }
            let adapter = ClickGuardianNative(validateCurrentScope: { _ in false },
                                               observations: observations)
            adapter.revoke(reason)
            XCTAssertEqual(adapter.status, .fenced)
            XCTAssertEqual(adapter.fencedCleanup(), .neverArmedNoEmission)
            XCTAssertEqual(adapter.fencedCleanup(), .neverArmedNoEmission)
        }
    }
}
#endif

// Pure producer/tail bookkeeping only. Neither these transitions nor matching
// event tags can accept a platform or prove real OS cleanup.
final class ClickGuardianTailLedgerTests: XCTestCase {
    private let reservation = ClickGuardianTailLedger.Reservation(command: 7, tag: 42,
        x: 20, y: 30, downTime: 100, upTime: 101, deadline: 11)
    func testImmutableProducerAndOrderedPair() {
        var ledger = ClickGuardianTailLedger()
        XCTAssertTrue(ledger.reserve(reservation))
        XCTAssertEqual(ledger.reservation, reservation)
        XCTAssertFalse(ledger.complete)
        ledger.sealProducer()
        ledger.observe(down: true, matches: true, now: 10)
        XCTAssertFalse(ledger.complete)
        ledger.observe(down: false, matches: true, now: 10.01)
        XCTAssertTrue(ledger.complete)
        XCTAssertEqual(ledger.reservation, reservation)
        // Any extra observation destroys the one-pair evidence.
        ledger.observe(down: false, matches: true, now: 10.02)
        XCTAssertFalse(ledger.complete)
        XCTAssertEqual(ledger.phase, .ambiguous)
    }
    func testUnsealedProducerAndUpBeforeDownNeverProveCleanup() {
        for seal in [false, true] {
            var ledger = ClickGuardianTailLedger(); XCTAssertTrue(ledger.reserve(reservation))
            if seal { ledger.sealProducer() }
            ledger.observe(down: false, matches: true, now: 10)
            ledger.observe(down: true, matches: true, now: 10.01)
            XCTAssertFalse(ledger.complete)
            XCTAssertEqual(ledger.phase, .ambiguous)
        }
    }
    func testWrongTagPhysicalOverlapLateTailAndTapLossAreSticky() {
        for loss in 0..<4 {
            var ledger = ClickGuardianTailLedger(); XCTAssertTrue(ledger.reserve(reservation)); ledger.sealProducer()
            ledger.observe(down: true, matches: true, now: 10)
            if loss == 0 { ledger.observe(down: false, matches: false, now: 10.1) }
            if loss == 1 { ledger.observe(down: true, matches: false, now: 10.1) }
            if loss == 2 { ledger.observe(down: false, matches: true, now: 11) }
            if loss == 3 { ledger.ambiguity() }
            ledger.observe(down: false, matches: true, now: 10.2)
            XCTAssertFalse(ledger.complete)
            XCTAssertFalse(ledger.reserve(reservation))
        }
    }
    func testIncompletePairAndRepeatedReservationCannotBeReplayed() {
        var ledger = ClickGuardianTailLedger(); XCTAssertTrue(ledger.reserve(reservation)); ledger.sealProducer()
        ledger.observe(down: true, matches: true, now: 10)
        XCTAssertFalse(ledger.complete)
        XCTAssertFalse(ledger.reserve(reservation))
        ledger.observe(down: false, matches: true, now: 10.1)
        XCTAssertFalse(ledger.complete)
    }
}
