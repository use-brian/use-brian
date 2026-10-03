// Linked native candidate, UNVERIFIED. Production platform registry is EMPTY.
// No transport/content API, environment switches, or claimed OS drain evidence.
import Foundation
import Dispatch

// Deterministic bookkeeping seam, NOT platform acceptance or delivery evidence.
struct ClickGuardianNativeLedger {
    enum Phase: UInt8 { case idle, probing, probeConfirmed, armed, consumed, fenced }
    private(set) var phase: Phase = .idle
    private(set) var expires: TimeInterval = 0
    private(set) var revoked = false

    mutating func beginProbe(now: TimeInterval, budget: TimeInterval) -> Bool {
        guard phase == .idle, !revoked, now.isFinite,
              budget.isFinite, budget > 0, budget <= 1 else { return false }
        expires = now + budget
        phase = .probing
        return true
    }
    mutating func probeArrived(now: TimeInterval) -> Bool {
        guard phase == .probing, live(now) else { fence(); return false }
        phase = .probeConfirmed
        return true
    }
    mutating func arm(now: TimeInterval, deadline: TimeInterval) -> Bool {
        guard phase == .probeConfirmed, !revoked, now.isFinite,
              deadline.isFinite, deadline > now, deadline - now <= 1 else {
            fence(); return false
        }
        expires = deadline
        phase = .armed
        return true
    }
    mutating func consume(now: TimeInterval, trustedScope: Bool, neutral: Bool) -> Bool {
        guard phase == .armed, live(now), trustedScope, neutral else {
            fence(); return false
        }
        phase = .consumed // BEFORE allocation or any insertion; never retry.
        return true
    }
    mutating func expire(now: TimeInterval) {
        if (phase == .probing || phase == .armed) && !live(now) { fence() }
    }
    mutating func fence() { revoked = true; phase = .fenced }
    private func live(_ now: TimeInterval) -> Bool {
        !revoked && now.isFinite && now < expires
    }
}

// One immutable producer reservation, two tail observations, and no inferred
// application effect. This ledger alone NEVER proves provenance or OS ordering.
// Native use additionally requires the source-owned accepted-platform registry.
struct ClickGuardianTailLedger {
    enum Phase: UInt8 { case idle, reserved, producerSealed, downObserved, pairObserved, ambiguous }
    struct Reservation: Equatable {
        let command: UInt64
        let tag: Int64
        let x: Double
        let y: Double
        let downTime: UInt64
        let upTime: UInt64
        let deadline: TimeInterval
    }
    private(set) var reservation: Reservation?
    private(set) var phase: Phase = .idle
    private(set) var producerSealed = false
    private(set) var downSeen = false
    private(set) var upSeen = false
    mutating func reserve(_ value: Reservation) -> Bool {
        guard phase == .idle, value.command != 0, value.tag != 0, value.x.isFinite, value.y.isFinite,
              value.downTime > 0, value.upTime > value.downTime, value.deadline.isFinite else { ambiguity(); return false }
        reservation = value; phase = .reserved; return true
    }
    mutating func sealProducer() {
        guard phase == .reserved else { ambiguity(); return }
        producerSealed = true; phase = .producerSealed
    }
    mutating func observe(down: Bool, matches: Bool, now: TimeInterval) {
        guard let reserved = reservation, producerSealed, matches, now.isFinite, now < reserved.deadline else { ambiguity(); return }
        if down && phase == .producerSealed && !downSeen && !upSeen {
            downSeen = true; phase = .downObserved
        } else if !down && phase == .downObserved && downSeen && !upSeen {
            upSeen = true; phase = .pairObserved
        } else { ambiguity() }
    }
    mutating func ambiguity() { phase = .ambiguous }
    var complete: Bool { phase == .pairObserved && producerSealed && downSeen && upSeen }
}

// Configuration selection only: numeric macOS version is NOT enough. Exact OS
// build, native process architecture and mechanism revision must also match.
// Mechanism changes (including proxy/producer/monitor ordering) MUST bump the
// revision and invalidate prior acceptance. Matching is NOT stale-proxy safety,
// signing/attestation, provenance or native acceptance evidence.
struct ClickGuardianPlatformProfile: Hashable {
    let major: Int
    let minor: Int
    let patch: Int
    let build: String
    let architecture: String
    let mechanismRevision: Int

    var wellFormed: Bool {
        major > 0 && minor >= 0 && patch >= 0 &&
            build.utf8.count <= 64 &&
            build.range(of: "\\A[0-9]+[A-Z][0-9]+[a-z]?\\z", options: .regularExpression) != nil &&
            ["arm64", "x86_64"].contains(architecture) && mechanismRevision > 0
    }
}

enum ClickGuardianPlatformSelector {
    // Pure seam. Unknown translation state, any malformed entry, and duplicate
    // entries invalidate the whole registry, even if another entry would match.
    static func matches(profiles: [ClickGuardianPlatformProfile],
                        runtime: ClickGuardianPlatformProfile?, translated: Bool?) -> Bool {
        guard !profiles.isEmpty, profiles.allSatisfy({ $0.wellFormed }),
              Set(profiles).count == profiles.count,
              translated == false, let runtime = runtime, runtime.wellFormed else { return false }
        return profiles.contains(runtime)
    }
}

enum ClickGuardianNativeAcceptedPlatforms {
    // Source-owned and immutable. NO accepted profiles or external overrides.
    // Future entries still require native acceptance of stale-proxy, epoch-race
    // and input-provenance behavior; metadata matching supplies none of that.
    static let profiles: [ClickGuardianPlatformProfile] = []
    static let mechanismRevision = 1

    static func acceptsCurrentPlatform() -> Bool {
        guard !profiles.isEmpty else { return false } // Do not probe metadata when empty.
        #if os(macOS)
        guard let metadata = currentMetadata() else { return false }
        return ClickGuardianPlatformSelector.matches(profiles: profiles,
            runtime: metadata.profile, translated: metadata.translated)
        #else
        return false
        #endif
    }

    #if os(macOS)
    private static func currentMetadata() -> (profile: ClickGuardianPlatformProfile, translated: Bool)? {
        // Public APIs only, fixed-size buffers; no shell, files, environment or
        // JSON. Failure/truncation/unknown translation values refuse selection.
        var bytes = [UInt8](repeating: 0, count: 65)
        var size = bytes.count
        guard sysctlbyname("kern.osversion", &bytes, &size, nil, 0) == 0,
              size > 1, size <= bytes.count, bytes[size - 1] == 0,
              !bytes[..<(size - 1)].contains(0),
              let build = String(bytes: bytes[..<(size - 1)], encoding: .utf8) else { return nil }
        var translated: Int32 = 0
        size = MemoryLayout<Int32>.size
        let result = sysctlbyname("sysctl.proc_translated", &translated, &size, nil, 0)
        if result != 0 {
            // Apple's documented ENOENT means this translation facility is absent.
            guard errno == ENOENT else { return nil }
            translated = 0
        } else {
            guard size == MemoryLayout<Int32>.size, translated == 0 || translated == 1 else { return nil }
        }
        guard translated == 0 else { return nil }
        let architecture: String
        #if arch(arm64)
        architecture = "arm64"
        #elseif arch(x86_64)
        architecture = "x86_64"
        #else
        return nil
        #endif
        let version = ProcessInfo.processInfo.operatingSystemVersion
        return (ClickGuardianPlatformProfile(major: version.majorVersion, minor: version.minorVersion,
            patch: version.patchVersion, build: build, architecture: architecture,
            mechanismRevision: mechanismRevision), false)
    }
    #endif
}

#if os(macOS)
import Darwin
import CoreGraphics
import CoreFoundation
import AppKit

// Availability of the PUBLIC implementation, not installation success, a
// numeric generation, or platform acceptance. Each scope must install/poll its
// own fence; any unsupported registration refuses with no birth-only fallback.
enum ClickGuardianNativeIdentitySupport {
    static func hasPublicEpochFenceSupport() -> Bool {
        #if os(macOS)
        return true
        #else
        return false
        #endif
    }
}

final class ClickGuardianNative {
    enum Status: UInt8 {
        case idle, probing, refused, probeConfirmedProductionOff, ready
        case awaitingWake, sequenceAttemptedUnproven, fenced
    }
    enum Revocation: UInt8 {
        case stop, parentLoss, workerLoss, channelLoss, physicalInput
        case permissionLoss, lockOrSleep, tapDisabled, deadline
    }
    enum CleanupResult: UInt8 {
        case neverArmedNoEmission, inputStreamReleasedCandidate, fencedLeaseRetained
    }

    // Only constructed by trusted native executor, never decoded from wire.
    // Callback must revalidate command/lease/epoch, approval, fresh selected
    // window/screenshot transform/point, native scope, and independent liveness
    // + Stop latch. It must not block, pump the run loop, or call this adapter.
    struct NativeValidatedIntent {
        let command: UInt64
        let x: Double
        let y: Double
        let deadline: TimeInterval // ProcessInfo.systemUptime, not wall clock
    }
    typealias ValidateCurrentScope = (NativeValidatedIntent) -> Bool

    // Native observation/allocation seams for source-level tests. No seam can
    // accept a platform, replace the active tap, or bypass the registry.
    struct Observations {
        var now: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
        var neutral: () -> Bool = {
            let flags = CGEventSource.flagsState(.combinedSessionState)
            // Includes caps lock/function/numeric-pad and unknown flag bits.
            // AppKit's bitmask includes auxiliary buttons, not just the three
            // named CGMouseButton cases. Aggregate state is conservative, NOT
            // proof of exclusive ownership or an atomic sample/post barrier.
            guard flags.isEmpty, NSEvent.pressedMouseButtons == 0 else { return false }
            for button in [CGMouseButton.left, .right, .center] {
                if CGEventSource.buttonState(.combinedSessionState, button: button) ||
                    CGEventSource.buttonState(.hidSystemState, button: button) { return false }
            }
            return CGEventSource.flagsState(.hidSystemState).isEmpty
        }
        var mouseEvent: (CGEventType, CGPoint) -> CGEvent? = { type, point in
            CGEvent(mouseEventSource: nil, mouseType: type,
                    mouseCursorPosition: point, mouseButton: .left)
        }
    }

    private let owner = Thread.current
    private let runLoop = CFRunLoopGetCurrent()!
    private let validate: ValidateCurrentScope
    private let validateMonitoring: () -> Bool
    private let observations: Observations
    private var ledger = ClickGuardianNativeLedger()
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var timer: CFRunLoopTimer?
    private var intent: NativeValidatedIntent?
    private var tail = ClickGuardianTailLedger()
    private var tailTap: CFMachPort?
    private var tailSource: CFRunLoopSource?
    private var producerIntent: NativeValidatedIntent?
    private var retainedUp: CGEvent? // keep alive THROUGH callback return and tail observation
    private var everArmed = false
    private var cleanupResult: CleanupResult?
    private var monitorReturnOffered = false
    private var monitorReturnAcknowledged = false
    private var monitorReturnDeadline: TimeInterval = 0
    private(set) var sequenceAttempted = false // sticky; status changes cannot erase uncertainty
    var tailObservationComplete: Bool { tail.complete }
    private let probeTag = Int64.random(in: 1...Int64.max / 2)
    private let clickTag = Int64.random(in: (Int64.max / 2 + 1)...Int64.max)
    private(set) var status: Status = .idle

    init(validateCurrentScope: @escaping ValidateCurrentScope, validateMonitoringScope: @escaping () -> Bool = { false }) {
        validate = validateCurrentScope
        validateMonitoring = validateMonitoringScope
        observations = Observations()
    }
    // Internal test seam; it still cannot enable production dispatch.
    init(validateCurrentScope: @escaping ValidateCurrentScope, observations: Observations) {
        validate = validateCurrentScope
        validateMonitoring = { false } // allocation seams cannot accept a return/provenance profile
        self.observations = observations
    }

    // Owner thread must run this CFRunLoop and retain this object through cleanup.
    // ClickGuardianHost is the separate child of the same signed helper binary;
    // it supplies admission, private channel and process watches. Never attach
    // this adapter to the AX worker that Stop may kill.
    @discardableResult
    func startProbe(budget: TimeInterval = 0.25) -> Status {
        checkLane()
        guard ledger.beginProbe(now: observations.now(), budget: budget) else {
            refuse(); return status
        }
        guard CGPreflightListenEventAccess(), CGPreflightPostEventAccess(),
              let port = CGEvent.tapCreate(tap: .cgSessionEventTap,
                  place: .headInsertEventTap, options: .defaultTap,
                  eventsOfInterest: CGEventMask.max,
                  callback: { proxy, type, event, context in
                      guard let context = context else { return Unmanaged.passUnretained(event) }
                      return Unmanaged<ClickGuardianNative>.fromOpaque(context)
                          .takeUnretainedValue().receive(proxy: proxy, type: type, event: event)
                  }, userInfo: Unmanaged.passUnretained(self).toOpaque()) else {
            refuse(); return status
        }
        tap = port
        guard let loopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0) else {
            refuse(); return status
        }
        source = loopSource
        guard installTail() else { refuse(); return status }
        CFRunLoopAddSource(runLoop, loopSource, .commonModes)
        CGEvent.tapEnable(tap: port, enable: true)
        guard CGEvent.tapIsEnabled(tap: port), let wake = nullWake(tag: probeTag) else {
            refuse(); return status
        }
        status = .probing
        scheduleExpiry()
        guard status == .probing else { return status }
        // Null only. If unsupported/dropped, timer fences. Never mouse/key fallback.
        wake.post(tap: .cgSessionEventTap)
        return status
    }

    @discardableResult
    func execute(_ value: NativeValidatedIntent) -> Status {
        checkLane()
        guard status == .ready, ClickGuardianNativeAcceptedPlatforms.acceptsCurrentPlatform(),
              ClickGuardianNativeIdentitySupport.hasPublicEpochFenceSupport(),
              value.command != 0, value.x.isFinite, value.y.isFinite,
              validate(value), ledger.arm(now: observations.now(), deadline: value.deadline) else { refuse(); return status }
        everArmed = true
        guard let wake = nullWake(tag: clickTag) else { refuse(); return status }
        intent = value
        status = .awaitingWake
        scheduleExpiry()
        guard status == .awaitingWake else { return status }
        wake.post(tap: .cgSessionEventTap)
        return status
    }

    func revoke(_ reason: Revocation) {
        checkLane()
        // Never sends an up, never re-enables a disabled tap, never resets a command.
        ledger.fence()
        if everArmed { tail.ambiguity() }
        intent = nil
        cancelTimer()
        status = .fenced
    }

    // A tail sample is NOT permission to close the last takeover monitor.
    // The producer remains irreversibly fenced while the return handshake runs.
    private func ownedStreamProven() -> Bool {
        guard ClickGuardianNativeAcceptedPlatforms.acceptsCurrentPlatform(),
              ClickGuardianNativeIdentitySupport.hasPublicEpochFenceSupport(), sequenceAttempted,
              tail.complete, let port = tap, let end = tailTap,
              CGEvent.tapIsEnabled(tap: port), CGEvent.tapIsEnabled(tap: end),
              let reservation = tail.reservation else { return false }
        if monitorReturnOffered {
            return observations.now() < monitorReturnDeadline && validateMonitoring()
        }
        return observations.now() < reservation.deadline && producerIntent.map(validate) == true
    }
    func beginMonitorReturn(deadline: TimeInterval) -> Bool {
        checkLane()
        guard !monitorReturnOffered, cleanupResult == nil, ownedStreamProven(),
              deadline.isFinite, deadline > observations.now(), deadline - observations.now() <= 3,
              validateMonitoring() else { return false }
        monitorReturnDeadline = deadline // original HOST/command budget, not a renewed input deadline
        monitorReturnOffered = true
        scheduleExpiry()
        // Pair already observed, producer forever sealed. Keep monitors alive
        // during read-only return checks; never renew ledger.expires or intent.
        return status == .sequenceAttemptedUnproven
    }
    func completeMonitorReturn() -> CleanupResult {
        checkLane()
        guard monitorReturnOffered, !monitorReturnAcknowledged, ownedStreamProven() else {
            revoke(.stop); return fencedCleanup()
        }
        monitorReturnAcknowledged = true
        return fencedCleanup() // Worker independently installed its monitor FIRST.
    }

    @discardableResult
    func fencedCleanup() -> CleanupResult {
        checkLane()
        if let result = cleanupResult { return result }
        // Empty registry prevents tail observations from ever releasing a live
        // production lease. Even a future accepted result is INPUT STREAM ONLY,
        // not proof of application consumption/success or global queue drain.
        let result: CleanupResult
        if !everArmed && !sequenceAttempted { result = .neverArmedNoEmission }
        else if monitorReturnAcknowledged && ownedStreamProven() {
            result = .inputStreamReleasedCandidate
        } else { result = .fencedLeaseRetained }
        revoke(.stop)
        disposeTap()
        retainedUp = nil
        cleanupResult = result
        return result
    }

    private func installTail() -> Bool {
        guard let port = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .tailAppendEventTap,
            options: .listenOnly, eventsOfInterest: CGEventMask.max,
            callback: { _, type, event, context in
                guard let context = context else { return Unmanaged.passUnretained(event) }
                Unmanaged<ClickGuardianNative>.fromOpaque(context).takeUnretainedValue().observeTail(type, event)
                return Unmanaged.passUnretained(event) // no swallowing/replacement at tail
            }, userInfo: Unmanaged.passUnretained(self).toOpaque()),
              let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0) else { return false }
        tailTap = port; tailSource = source
        CFRunLoopAddSource(runLoop, source, .commonModes); CGEvent.tapEnable(tap: port, enable: true)
        return CGEvent.tapIsEnabled(tap: port)
    }
    private func observeTail(_ type: CGEventType, _ event: CGEvent) {
        checkLane()
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput { revoke(.tapDisabled); return }
        guard let reservation = tail.reservation else {
            if type != .null { revoke(.physicalInput) }
            return
        }
        // Once reserved, EVERY other event (including unrelated null, physical
        // overlap, duplicate or wrong-order up/down) destroys cleanup evidence.
        let down = type == .leftMouseDown
        let expectedTime = down ? reservation.downTime : reservation.upTime
        let matches = (down || type == .leftMouseUp) && event.flags.isEmpty &&
            event.location == CGPoint(x: reservation.x, y: reservation.y) &&
            event.timestamp == expectedTime &&
            event.getIntegerValueField(.eventSourceUserData) == reservation.tag &&
            event.getIntegerValueField(.mouseEventClickState) == 1 &&
            event.getIntegerValueField(.mouseEventButtonNumber) == 0 &&
            event.getIntegerValueField(.eventSourceUnixProcessID) == Int64(getpid())
        // Tags/timestamps are correlation, NOT authentication. The immutable
        // producer reservation plus accepted exact tap-ordering profile is needed.
        let scopeLive = producerIntent.map(validate) == true
        tail.observe(down: down, matches: matches && scopeLive, now: observations.now())
        if !matches || !scopeLive || tail.phase == .ambiguous { revoke(.physicalInput) }
    }

    private func receive(proxy: CGEventTapProxy, type: CGEventType,
                         event: CGEvent) -> Unmanaged<CGEvent>? {
        checkLane()
        let unchanged = Unmanaged.passUnretained(event)
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            revoke(.tapDisabled)
            return unchanged
        }
        // All non-null traffic is returned by identity; no tag can exempt it.
        // Conservative: other synthetic input also revokes, provenance is unknown.
        guard type == .null else { revoke(.physicalInput); return unchanged }
        let tag = event.getIntegerValueField(.eventSourceUserData)
        if tag == probeTag && ledger.phase == .probing {
            guard ledger.probeArrived(now: observations.now()),
                  let tap = tap, CGEvent.tapIsEnabled(tap: tap) else {
                refuse(); return unchanged
            }
            cancelTimer()
            status = ClickGuardianNativeAcceptedPlatforms.acceptsCurrentPlatform() &&
                ClickGuardianNativeIdentitySupport.hasPublicEpochFenceSupport() ? .ready : .probeConfirmedProductionOff
            return unchanged // observed null is NOT delivery/drain/ownership proof
        }
        guard tag == clickTag, ledger.phase == .armed else { return unchanged }
        guard ClickGuardianNativeAcceptedPlatforms.acceptsCurrentPlatform(),
              ClickGuardianNativeIdentitySupport.hasPublicEpochFenceSupport(),
              let value = intent, let tap = tap, CGEvent.tapIsEnabled(tap: tap),
              ledger.consume(now: observations.now(), trustedScope: validate(value),
                             neutral: observations.neutral()) else {
            refuse(); return unchanged
        }
        intent = nil
        cancelTimer()
        let point = CGPoint(x: value.x, y: value.y)
        // Both allocations precede the only down insertion. Failure has no input
        // effects and consumes the command; no cleanup up is ever synthesized.
        guard let (down, up) = Self.preallocate(point: point, tag: clickTag,
                                                make: observations.mouseEvent) else {
            refuse(); return unchanged
        }
        // Recheck after allocation, but this is NOT an atomic timeout barrier.
        guard validate(value), observations.neutral(),
              CGPreflightListenEventAccess(), CGPreflightPostEventAccess(),
              CGEvent.tapIsEnabled(tap: tap), !ledger.revoked,
              observations.now() < value.deadline else {
            refuse(); return unchanged
        }
        guard let tailPort = tailTap, CGEvent.tapIsEnabled(tap: tailPort) else { refuse(); return unchanged }
        let time = DispatchTime.now().uptimeNanoseconds
        guard time < UInt64.max, tail.reserve(.init(command: value.command, tag: clickTag,
            x: value.x, y: value.y, downTime: time, upTime: time + 1, deadline: value.deadline)) else { refuse(); return unchanged }
        down.timestamp = time; up.timestamp = time + 1
        retainedUp = up
        producerIntent = value
        // Seal BEFORE insertion: exactly these two immutable objects are the only
        // producer sequence. No timer, child, callback retry or deferred up exists.
        tail.sealProducer()
        sequenceAttempted = true
        status = .sequenceAttemptedUnproven
        ledger.fence() // no replay, even if posting has no observable effect
        scheduleExpiry() // lost tail/producer return cannot wait without a fence
        guard status == .sequenceAttemptedUnproven else { return unchanged }
        // KNOWN BLOCKER: suspension here may invalidate proxy ordering. A later
        // enabled check cannot repair that race. Registry stays EMPTY pending
        // trusted native acceptance of this exact boundary on a platform profile.
        down.tapPostEvent(proxy)
        // The original event is a null, NEVER physical input. Return the retained
        // preallocated up from THIS callback (no second post, queue or timer).
        return Unmanaged.passRetained(up)
    }

    // Allocation-only seam: cannot post and cannot grant platform acceptance.
    static func preallocate(point: CGPoint, tag: Int64,
                            make: (CGEventType, CGPoint) -> CGEvent?) -> (CGEvent, CGEvent)? {
        guard let down = make(.leftMouseDown, point),
              let up = make(.leftMouseUp, point), down !== up,
              down.type == .leftMouseDown, up.type == .leftMouseUp else { return nil }
        for event in [down, up] {
            event.flags = []
            event.setIntegerValueField(.eventSourceUserData, value: tag)
            event.setIntegerValueField(.mouseEventClickState, value: 1)
        }
        return (down, up)
    }

    private func nullWake(tag: Int64) -> CGEvent? {
        guard let event = CGEvent(source: nil) else { return nil }
        event.type = .null
        event.setIntegerValueField(.eventSourceUserData, value: tag)
        guard event.type == .null else { return nil }
        return event
    }
    private func scheduleExpiry() {
        cancelTimer()
        let deadline = monitorReturnOffered ? monitorReturnDeadline : ledger.expires
        let fire = CFAbsoluteTimeGetCurrent() + max(0.001, deadline - observations.now())
        guard let t = CFRunLoopTimerCreateWithHandler(kCFAllocatorDefault, fire, 0, 0, 0,
            { [weak self] _ in
                guard let self = self else { return }
                if self.monitorReturnOffered {
                    if self.observations.now() >= self.monitorReturnDeadline { self.revoke(.deadline) }
                    else { self.scheduleExpiry() }
                    return
                }
                self.ledger.expire(now: self.observations.now())
                if self.ledger.phase == .fenced { self.revoke(.deadline) }
                else { self.scheduleExpiry() }
            }) else { refuse(); return }
        timer = t
        CFRunLoopAddTimer(runLoop, t, .commonModes)
    }
    private func cancelTimer() {
        if let timer = timer { CFRunLoopTimerInvalidate(timer) }
        timer = nil
    }
    private func refuse() {
        revoke(.stop)
        disposeTap()
        status = .refused
    }
    private func disposeTap() {
        if let tailTap = tailTap { CGEvent.tapEnable(tap: tailTap, enable: false) }
        if let tailSource = tailSource { CFRunLoopRemoveSource(runLoop, tailSource, .commonModes) }
        if let tailTap = tailTap { CFMachPortInvalidate(tailTap) }
        tailSource = nil; tailTap = nil
        if let tap = tap { CGEvent.tapEnable(tap: tap, enable: false) }
        if let source = source { CFRunLoopRemoveSource(runLoop, source, .commonModes) }
        if let tap = tap { CFMachPortInvalidate(tap) }
        source = nil
        tap = nil
    }
    private func checkLane() { precondition(Thread.current === owner) }
    deinit {
        // Host must call fencedCleanup on the owner lane before releasing self.
        // Never interpret process/object destruction as synthetic release proof.
        precondition(tap == nil && tailTap == nil && timer == nil)
    }
}
#endif
