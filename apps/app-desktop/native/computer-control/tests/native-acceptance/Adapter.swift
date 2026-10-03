import Foundation
import AppKit
import CoreGraphics
import CoreFoundation

// Retired emitter. Only a harmless null probe remains; no event-pair dispatch.
final class MechanismOwner {
    let config: ExperimentConfig
    let rect: CGRect
    let fences: [ProcessEpochFence]
    var ledger = ClickGuardianNativeLedger()
    var tap: CFMachPort?
    var source: CFRunLoopSource?
    var timer: Timer?
    var finished = false
    var now: Double { ProcessInfo.processInfo.systemUptime }
    init?(_ c: ExperimentConfig) {
        guard c.scenario == Scenario.null.index else { return nil }
        guard experiment_bootstrap_live() == 1 else { return nil }
        config = c
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
        }
        RunLoop.main.add(timer!, forMode: .common)
        record(3, .probeSent)
        probe.post(tap: .cgSessionEventTap)
        RunLoop.main.run()
        finish(.refused)
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
            DispatchQueue.main.async { self.finish(.terminal) }
            return unchanged
        }
        return unchanged
    }
}
