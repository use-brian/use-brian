import AppKit
import CoreGraphics
import Foundation
import Darwin

// Role argv is fixed by the issuer AND must match its private, PID-bound grant.
let childRoles: [String: UInt32] = ["--owned-parent": 1, "--owned-worker": 2, "--owned-owner": 3]
if CommandLine.arguments.count == 2, let role = childRoles[CommandLine.arguments[1]] {
    var config = ExperimentConfig()
    guard experiment_child(role, &config) == 1 else { _exit(64) }
    signal(SIGPIPE, SIG_IGN)
    alarm(15) // independent finite lifetime while runnable; SIGSTOP caveat in README
    if config.role == 1 { experiment_parent_run(); _exit(74) }
    if config.role == 2 { while true { pause() } }
    // An orphaned stopped process group may receive SIGHUP + SIGCONT.
    // Survive HUP so the experiment records that actual kernel behavior.
    signal(SIGHUP, SIG_IGN)
    guard let owner = MechanismOwner(config) else { record(3, .blocked); record(3, .terminal); _exit(0) }
    owner.start()
}
guard CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--case",
      let scenario = Scenario(rawValue: CommandLine.arguments[2]) else { _exit(64) }
guard experiment_supervisor_init() == 1 else { _exit(64) }
signal(SIGPIPE, SIG_IGN)
experiment_install_cancel_handler()

final class Canvas: NSView {
    var running = false
    var armed = false
    var cue = "Disposable isolated login ONLY. No external applications."
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.white.setFill(); bounds.fill()
        NSColor.systemBlue.setFill(); NSRect(x: 170, y: 125, width: 160, height: 100).fill()
        ("Fixed local target" as NSString).draw(at: NSPoint(x: 190, y: 165), withAttributes: [.foregroundColor: NSColor.white])
        (cue as NSString).draw(in: NSRect(x: 20, y: 15, width: 460, height: 90), withAttributes: [.foregroundColor: NSColor.black])
    }
    override func mouseDown(with event: NSEvent) {
        guard running else { return }
        let tagged = event.cgEvent?.getIntegerValueField(.eventSourceUserData) == clickTag(experiment_tag())
        record(2, tagged ? .fixtureDown : .fixturePhysicalDown)
        armed = tagged && NSRect(x: 170, y: 125, width: 160, height: 100).contains(convert(event.locationInWindow, from: nil))
    }
    override func mouseUp(with event: NSEvent) {
        guard running else { return }
        let tagged = event.cgEvent?.getIntegerValueField(.eventSourceUserData) == clickTag(experiment_tag())
        record(2, tagged ? .fixtureUp : .fixturePhysicalUp)
        if tagged && armed { record(2, .fixturePair) }
        armed = false
    }
}
final class FixtureWindow: NSWindow { override var canBecomeKey: Bool { true } }
final class Supervisor: NSObject, NSApplicationDelegate {
    let scenario: Scenario
    let canvas = Canvas(frame: NSRect(x: 0, y: 0, width: 500, height: 350))
    var window: NSWindow!
    var observer: CFMachPort?
    var observerSource: CFRunLoopSource?
    var started = false, ending = false, consented = false, injected = false, lost = false, scopeLost = false
    var records: [[String: Any]] = []
    var timer: Timer?
    var initialRect: CGRect?
    // Fixed codes only: no OS errors, paths, window contents or credentials.
    var preflightFailure: String?
    var startTime = 0.0
    var pausedAt: Double?
    var actionAt: Double?
    var ownerResumed = false
    var heldSampleReceived = false
    var observedDeaths = Set<UInt32>()
    init(_ scenario: Scenario) { self.scenario = scenario }
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = FixtureWindow(contentRect: NSRect(x: 100, y: 100, width: 500, height: 350), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = canvas; window.title = "Isolated native mechanism fixture"
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Hazardous local experiment: \(scenario.rawValue)"
        alert.informativeText = "Use a DISPOSABLE ISOLATED Mac login. Global input may escape this fixture after focus loss or suspension. At most one synthetic pair; delayed/unmatched events may remain. No cleanup up, retry or production acceptance. Close other apps. Keep hands off except the physical-case cue. Cancel if unsure. Physical-overlap: click the blue target during the pause. Physical-before-check: keep its left button held until the explicit SAMPLE RECORDED cue, then release manually. On cancellation/end release manually; that is not a passing held-input case."
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "Consent to this one case")
        let check = NSButton(checkboxWithTitle: "I am in a disposable isolated login and accept these risks", target: nil, action: nil)
        check.frame = NSRect(x: 0, y: 0, width: 480, height: 32); alert.accessoryView = check
        let consentTimer = Timer(timeInterval: 60, repeats: false) { _ in NSApp.abortModal() }
        RunLoop.main.add(consentTimer, forMode: .modalPanel)
        let response = alert.runModal()
        consentTimer.invalidate()
        guard response == .alertSecondButtonReturn, check.state == .on else { end(); return }
        consented = true
        canvas.cue = "Hands off. Starting one case in two seconds."; canvas.needsDisplay = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.begin() }
    }
    func installObserver() -> Bool {
        guard let port = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .tailAppendEventTap,
            options: .listenOnly, eventsOfInterest: CGEventMask.max, callback: { _, type, event, context in
                if let context = context {
                    Unmanaged<Supervisor>.fromOpaque(context).takeUnretainedValue().observe(type, event)
                }
                return Unmanaged.passUnretained(event)
            }, userInfo: Unmanaged.passUnretained(self).toOpaque()),
            let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0) else { return false }
        observer = port; observerSource = src
        CFRunLoopAddSource(CFRunLoopGetMain(), src, .commonModes)
        CGEvent.tapEnable(tap: port, enable: true)
        return CGEvent.tapIsEnabled(tap: port)
    }
    func refusePreflight(_ reason: String) {
        preflightFailure = reason
        end()
    }
    func begin() {
        guard consented else { end(); return }
        guard experiment_cancelled() == 0 else { refusePreflight("cancelled-before-start"); return }
        guard neutral() else { refusePreflight("input-not-neutral"); return }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid() else {
            refusePreflight("fixture-not-frontmost"); return
        }
        guard CGPreflightListenEventAccess() else { refusePreflight("listen-permission-unavailable"); return }
        guard CGPreflightPostEventAccess() else { refusePreflight("post-permission-unavailable"); return }
        guard installObserver() else { refusePreflight("observer-unavailable"); return }
        initialRect = windowRect(pid: getpid(), number: UInt32(window.windowNumber))
        guard initialRect != nil else { refusePreflight("fixture-window-unavailable"); return }
        guard experiment_gui_consent(scenario.index, UInt32(window.windowNumber)) == 1 else {
            refusePreflight("consent-bootstrap-unavailable"); return
        }
        let ok = experiment_start(scenario.index, UInt32(window.windowNumber)) == 1
        started = true; startTime = ProcessInfo.processInfo.systemUptime
        record(0, .consent); record(0, .observerReady)
        guard ok else { record(0, .blocked); end(); return }
        record(0, .launched)
        canvas.running = true
        guard experiment_launch_owner() == 1 else { record(0, .blocked); end(); return }
        timer = Timer(timeInterval: 0.01, repeats: true) { [self] _ in tick() }
        RunLoop.main.add(timer!, forMode: .common)
    }
    func observe(_ type: CGEventType, _ event: CGEvent) {
        guard started, !ending else { return }
        let tag = event.getIntegerValueField(.eventSourceUserData)
        let code: Code
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput { code = .observerDisabled }
        else if type == .null && tag == experiment_tag() { code = .observerProbe }
        else if type == .null && tag == clickTag(experiment_tag()) { code = .observerWake }
        else if type == .leftMouseDown { code = tag == clickTag(experiment_tag()) ? .observerDown : .observerPhysicalDown }
        else if type == .leftMouseUp { code = tag == clickTag(experiment_tag()) ? .observerUp : .observerPhysicalUp }
        else if type == .null { return }
        else { code = .observerOther }
        record(1, code)
    }
    func drain() {
        for _ in 0..<2049 {
            var r = ExperimentRecord()
            let result = experiment_read(&r)
            if result == 0 { return }
            guard result == 1, records.count < 2048 else { lost = true; return }
            records.append(["source": r.source, "code": r.code, "sequence": r.sequence, "ticks": String(r.ticks)])
            if !ending && scenario == .held && !heldSampleReceived && r.source == 3 &&
                (r.code == Code.finalSampleNeutral.rawValue || r.code == Code.finalSampleNonNeutral.rawValue) {
                heldSampleReceived = true
                record(0, .heldReleaseCue)
                canvas.cue = "SAMPLE RECORDED. Release the held left button manually now."
                canvas.needsDisplay = true
            }
            if r.source == 3 && r.code == Code.resumedBoundary.rawValue { ownerResumed = true }
            if r.source == 3 && r.code == Code.stoppedBoundary.rawValue && pausedAt == nil {
                pausedAt = ProcessInfo.processInfo.systemUptime
                canvas.cue = scenario == .held ? "NOW: press and HOLD left on blue until SAMPLE RECORDED." : scenario.physical ? "NOW: press and release blue during this 3-second pause." : "Owner suspended; independent observation continues."
                canvas.needsDisplay = true
            }
        }
        lost = true
    }
    func tick() {
        drain()
        if experiment_cancelled() != 0 { end(); return }
        let now = ProcessInfo.processInfo.systemUptime
        if !scopeLost && (NSWorkspace.shared.frontmostApplication?.processIdentifier != getpid() ||
            windowRect(pid: getpid(), number: UInt32(window.windowNumber)) != initialRect) {
            scopeLost = true; record(0, .scopeLost)
            _ = experiment_signal(3, SIGKILL)
        }
        if let paused = pausedAt, !scopeLost, !injected, now - paused >= 0.1, experiment_owner_stopped() == 1 {
            // Wait for SIGSTOP, not merely the preceding phase record.
            // SIGCONT after the fixed pause also handles stop/record delivery races.
            switch scenario {
            case .workerBefore, .workerAfter:
                if experiment_signal(2, SIGKILL) == 1 { record(4, .killedWorker) }
            case .parentBefore, .parentAfter:
                if experiment_signal(1, SIGKILL) == 1 { record(4, .killedParent) }
            case .ownerDeath:
                if experiment_signal(3, SIGKILL) == 1 { record(4, .killedOwner) }
            default: break
            }
            injected = true
        }
        for role in [UInt32(1), 2, 3] {
            if experiment_poll(role) == 1 && !observedDeaths.contains(role) {
                observedDeaths.insert(role)
                record(4, role == 1 ? .parentExited : role == 2 ? .workerReaped : .ownerExited)
            }
        }
        let deathCase = [Scenario.workerBefore, .workerAfter, .parentBefore, .parentAfter].contains(scenario)
        let victim: UInt32 = [Scenario.workerBefore, .workerAfter].contains(scenario) ? 2 : 1
        if let paused = pausedAt, !scopeLost, injected, actionAt == nil,
           (deathCase ? observedDeaths.contains(victim) : now - paused >= 3) {
            if scenario != .ownerDeath && !ownerResumed && experiment_signal(3, SIGCONT) == 1 { record(4, .resumed) }
            actionAt = now
            if scenario != .held {
                canvas.cue = "Hands off. Observing only."
            } else if !heldSampleReceived {
                canvas.cue = "Keep HOLDING left. Waiting for the final button sample."
            }
            canvas.needsDisplay = true
        }
        // Full bounded observation interval, including late events after owner exit.
        // Its end proves neither absence of future events nor queue drain.
        if now - startTime >= 8 || lost || experiment_lost() != 0 { end() }
    }
    func end() {
        guard !ending else { return }; ending = true
        timer?.invalidate(); canvas.running = false
        if started { record(0, .observationClosed) }
        if let observer = observer { CGEvent.tapEnable(tap: observer, enable: false); CFMachPortInvalidate(observer) }
        if started {
            let reaped = experiment_cleanup() == 1
            record(0, reaped ? .resourcesStopped : .resourcesUncertain)
            drain()
        }
        let report: [String: Any] = ["schema": "native-mechanism-experiment.v1", "case": scenario.rawValue,
            "productionAcceptance": false, "consented": consented, "started": started,
            "preflightFailure": preflightFailure.map { $0 as Any } ?? NSNull(),
            "lost": lost || experiment_lost() != 0, "records": records,
            "localCounts": ["0": experiment_count(0), "1": experiment_count(1), "2": experiment_count(2), "4": experiment_count(4)],
            "os": ProcessInfo.processInfo.operatingSystemVersionString,
            "architecture": architecture]
        if let bytes = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), bytes.count <= 262144 {
            FileHandle.standardOutput.write(bytes); FileHandle.standardOutput.write(Data([10]))
        }
        NSApp.terminate(nil)
    }
    var architecture: String {
        #if arch(arm64)
        return "arm64"
        #elseif arch(x86_64)
        return "x86_64"
        #else
        return "unsupported"
        #endif
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if !ending { end() }
        return .terminateNow
    }
}
let app = NSApplication.shared
let supervisor = Supervisor(scenario)
app.delegate = supervisor
app.setActivationPolicy(.regular)
let menu = NSMenu()
let applicationItem = NSMenuItem()
let applicationMenu = NSMenu()
applicationMenu.addItem(withTitle: "Stop experiment (no release claim)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
applicationItem.submenu = applicationMenu; menu.addItem(applicationItem); app.mainMenu = menu
app.run()
