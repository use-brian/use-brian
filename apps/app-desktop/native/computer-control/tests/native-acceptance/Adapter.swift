import Foundation
import AppKit
import CoreGraphics
import CoreFoundation

// TEST ONLY. Not ClickGuardianHost admission, not an accepted platform, and never
// linked into production. Deliberately exercises the stale-proxy boundary.
final class MechanismOwner {
    let config: ExperimentConfig
    let scenario: Scenario
    let rect: CGRect
    let fences: [ProcessEpochFence]
    var ledger = ClickGuardianNativeLedger()
    var tap: CFMachPort?
    var source: CFRunLoopSource?
    var retainedUp: CGEvent?
    var timer: Timer?
    var attempted = false
    var finished = false
    var deadline = 0.0
    var now: Double { ProcessInfo.processInfo.systemUptime }
    init?(_ c: ExperimentConfig) {
        guard experiment_bootstrap_live() == 1 else { return nil }
        config = c; scenario = Scenario.allCases[Int(c.scenario)]
        // Subscribe before pinning scope. These are actual owned processes, not fakes.
        var subscriptions: [ProcessEpochFence] = []
        for pid in [c.supervisor, c.parent, c.worker] {
            guard let fence = ProcessEpochFence(pid: pid) else { return nil }
            subscriptions.append(fence)
        }
        fences = subscriptions
        guard let bounds = windowRect(pid: c.supervisor, number: c.window) else { return nil }
        rect = bounds
        guard scope() else { return nil }
    }
    func scope() -> Bool {
        experiment_bootstrap_live() == 1 && getppid() == config.parent && fences.allSatisfy { $0.clean() } &&
            NSWorkspace.shared.frontmostApplication?.processIdentifier == config.supervisor &&
            windowRect(pid: config.supervisor, number: config.window) == rect &&
            CGPreflightListenEventAccess() && CGPreflightPostEventAccess()
    }
    func wake(_ tag: Int64) -> CGEvent? {
        guard let event = CGEvent(source: nil) else { return nil }
        event.type = .null
        event.setIntegerValueField(.eventSourceUserData, value: tag)
        return event.type == .null ? event : nil
    }
    func finish(_ reason: Code) -> Never {
        finished = true; ledger.fence()
        if reason != .terminal { record(3, reason) }
        if let tap = tap { CGEvent.tapEnable(tap: tap, enable: false); CFMachPortInvalidate(tap) }
        record(3, .terminal)
        _exit(0) // Never a cleanup up or released-input claim.
    }
    func start() -> Never {
        guard scope(), neutral(), ledger.beginProbe(now: now, budget: 0.25),
              let port = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
                options: .defaultTap, eventsOfInterest: CGEventMask.max,
                callback: { proxy, type, event, context in
                    guard let context = context else { return Unmanaged.passUnretained(event) }
                    return Unmanaged<MechanismOwner>.fromOpaque(context).takeUnretainedValue().receive(proxy, type, event)
                }, userInfo: Unmanaged.passUnretained(self).toOpaque()),
              let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0),
              let probe = wake(config.tag) else { finish(.blocked) }
        tap = port; source = src
        CFRunLoopAddSource(CFRunLoopGetMain(), src, .commonModes)
        CGEvent.tapEnable(tap: port, enable: true)
        guard CGEvent.tapIsEnabled(tap: port) else { finish(.blocked) }
        timer = Timer(timeInterval: 0.02, repeats: true) { [self] _ in
            if ledger.phase == .probing && now >= ledger.expires { finish(.timeout) }
            if !attempted && ledger.phase == .armed && now >= deadline { finish(.timeout) }
        }
        RunLoop.main.add(timer!, forMode: .common)
        record(3, .probeSent)
        probe.post(tap: .cgSessionEventTap)
        RunLoop.main.run()
        finish(.refused)
    }
    func arm() {
        if scenario == .null { finish(.terminal) }
        deadline = now + 0.75
        guard scope(), neutral(), ledger.arm(now: now, deadline: deadline), let event = wake(clickTag(config.tag)) else { finish(.refused) }
        record(3, .armed)
        event.post(tap: .cgSessionEventTap)
    }
    func pause() {
        record(3, .stoppedBoundary)
        experiment_stop_here() // Only supervisor may resume this owned child.
        record(3, .resumedBoundary)
        if let tap = tap { record(3, CGEvent.tapIsEnabled(tap: tap) ? .resumedTapEnabled : .resumedTapDisabled) }
        if experiment_bootstrap_live() != 1 || getppid() != config.parent || !fences.allSatisfy({ $0.clean() }) { record(3, .resumeLivenessLost) }
        if now >= deadline { record(3, .resumeDeadlineExpired) }
    }
    func receive(_ proxy: CGEventTapProxy, _ type: CGEventType, _ event: CGEvent) -> Unmanaged<CGEvent>? {
        let unchanged = Unmanaged.passUnretained(event)
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            ledger.fence(); record(3, .tapDisabled); return unchanged
        }
        guard type == .null else {
            ledger.fence(); record(3, .takeover); return unchanged // object identity, even tagged traffic
        }
        let tag = event.getIntegerValueField(.eventSourceUserData)
        if tag == config.tag && ledger.phase == .probing {
            guard ledger.probeArrived(now: now), let tap = tap, CGEvent.tapIsEnabled(tap: tap) else { finish(.refused) }
            record(3, .probeReceived)
            DispatchQueue.main.async { self.arm() }
            return unchanged
        }
        guard tag == clickTag(config.tag), ledger.phase == .armed else { return unchanged }
        record(3, .clickWake)
        guard ledger.consume(now: now, trustedScope: scope(), neutral: neutral()) else { finish(.refused) }
        let point = CGPoint(x: rect.midX, y: rect.midY)
        guard let (down, up) = ClickGuardianNative.preallocate(point: point, tag: clickTag(config.tag),
                make: ClickGuardianNative.Observations().mouseEvent) else { finish(.refused) }
        record(3, .beforeCheck)
        if scenario.before { pause() }
        // Sample before any final guard can short-circuit on deadline/scope.
        // These are separate conservative samples, not an atomic ownership claim.
        var sampledNeutral: Bool?
        if scenario == .held {
            let heldLeft = (NSEvent.pressedMouseButtons & 1) != 0 &&
                CGEventSource.buttonState(.hidSystemState, button: .left) &&
                CGEventSource.buttonState(.combinedSessionState, button: .left)
            let isNeutral = neutral()
            record(3, heldLeft ? .finalSampleHeldLeft : .finalSampleNotHeldLeft)
            record(3, isNeutral ? .finalSampleNeutral : .finalSampleNonNeutral)
            sampledNeutral = isNeutral
        }
        // Same rejection boundary as the candidate after pair allocation.
        guard scope(), (sampledNeutral ?? neutral()), let tap = tap, CGEvent.tapIsEnabled(tap: tap),
              !ledger.revoked, now < deadline else { finish(.refused) }
        record(3, .finalChecked)
        let time = DispatchTime.now().uptimeNanoseconds
        guard time < UInt64.max else { finish(.refused) }
        down.timestamp = time; up.timestamp = time + 1
        retainedUp = up
        attempted = true; ledger.fence() // one sequence only; no retries
        if scenario.after { pause() }
        // Exact candidate emission order. Hooks deliberately bracket the unsafe
        // boundaries; no later check can make an already stale proxy atomic.
        down.tapPostEvent(proxy)
        record(3, .downInserted)
        if scenario == .afterDown || scenario == .ownerDeath { pause() }
        record(3, .returningUp)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.finish(.terminal) }
        return Unmanaged.passRetained(up)
    }
}
