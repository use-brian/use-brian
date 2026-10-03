import Foundation
import CoreFoundation
import Dispatch
import Darwin
import AppKit
import ApplicationServices
import CryptoKit

struct ClickPreparedScope {
    let binding: ClickIntent.Binding
    let descriptor: ClickScopeDescriptor
}

// Native data only, produced from Broker's current validated cache. This is NOT
// a public JSON authority type. Only the authenticated worker fd3 handoff may
// carry it, and main binds its entire command to the original local approval.
struct ClickScopeDescriptor {
    let wire: Object
    let command: Object
    let process: Object
    let worker: Object
    let bounds: Object
    let windowNumber: CGWindowID
    let width: Int
    let height: Int
    let pngDigest: String
    let fingerprint: String
    let displayLayout: String
    let frameTime: Double
    let observationTime: Double
    let grantDeadline: Double
    let commandDeadline: Double
    var pid: pid_t { pid_t(process["pid"] as! Int) }
    var observationID: String { (command["action"] as! Object)["observationId"] as! String }

    static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    // Public PID/birth/path evidence, NOT a numeric exec generation. A local
    // ProcessEpochFence is subscribed before pinning this evidence and polled
    // at final barriers. It is never serialized or supplied by main/worker JSON.
    static func publicProcessIdentity(_ identity: ProcessIdentity) -> Object? {
        guard ProcessIdentity.read(identity.pid) == identity else { return nil }
        return ["pid": Int(identity.pid), "birth": String(identity.birth), "executable": identity.executable]
    }
    static func validPublicProcessIdentity(_ value: Object) -> Bool {
        guard Set(value.keys) == Set(["pid", "birth", "executable"]),
              wireInteger(value["pid"], min: 2, max: Double(Int32.max)) != nil,
              let path = wireString(value["executable"], max: 4096), path.hasPrefix("/"),
              let birth = wireString(value["birth"], max: 20), let n = UInt64(birth), n > 0 else { return false }
        return String(n) == birth
    }
    static func fingerprint(_ snapshot: Snapshot) -> String? {
        guard snapshot.observation["completeness"] as? String == "complete",
              snapshot.observation["foreground"] as? Bool == true,
              let nodes = snapshot.observation["nodes"] as? [Object], !nodes.isEmpty, nodes.count <= 500 else { return nil }
        var indices: [String: Int] = [:]
        for (index, node) in nodes.enumerated() {
            guard let ref = node["ref"] as? String, indices[ref] == nil else { return nil }
            indices[ref] = index
        }
        var canonical: [Object] = []
        for (index, node) in nodes.enumerated() {
            guard node["sensitive"] as? Bool == false, node["role"] as? String != "AXSheet",
                  (node["actions"] as? [String])?.isEmpty == true else { return nil }
            var value = node; value.removeValue(forKey: "ref"); value.removeValue(forKey: "parentRef")
            if let parent = node["parentRef"] as? String {
                guard let parentIndex = indices[parent], parentIndex < index else { return nil }
                value["parentIndex"] = parentIndex
            } else if index != 0 { return nil }
            canonical.append(value)
        }
        guard let b = snapshot.observation["bounds"] as? Object,
              let display = snapshot.observation["displayLayoutVersion"] as? String,
              let bytes = try? JSONSerialization.data(withJSONObject: ["nodes": canonical, "bounds": b, "display": display], options: [.sortedKeys]) else { return nil }
        return digest(bytes)
    }
    static func make(command: Object, snapshot: ClickIntent.Snapshot, native: Snapshot,
                     window: Window, number: CGWindowID, png: Data, worker: ProcessIdentity) -> ClickScopeDescriptor? {
        guard window.epochFence.clean(), let process = publicProcessIdentity(window.identity), let producer = publicProcessIdentity(worker),
              let fp = fingerprint(native), window.epochFence.clean() else { return nil }
        return ClickScopeDescriptor(wire: ["version": 1, "command": command, "process": process, "worker": producer,
            "windowNumber": number, "bounds": snapshot.currentBounds,
            "width": snapshot.frame["width"]!, "height": snapshot.frame["height"]!,
            "pngDigest": digest(png), "fingerprint": fp, "displayLayout": snapshot.currentLayout,
            "frameTime": snapshot.frameMonotonicMs, "observationTime": snapshot.observationMonotonicMs,
            "grantDeadline": snapshot.grantDeadlineMonotonicMs, "commandDeadline": snapshot.commandDeadlineMonotonicMs,
            "privacy": "publicCompleteSafeCanvas"])
    }
    init?(wire: Object) {
        guard Set(wire.keys) == Set(["version", "command", "process", "worker", "windowNumber", "bounds", "width", "height",
            "pngDigest", "fingerprint", "displayLayout", "frameTime", "observationTime", "grantDeadline", "commandDeadline", "privacy"]),
              wireInteger(wire["version"]) == 1, wire["privacy"] as? String == "publicCompleteSafeCanvas",
              let command = wire["command"] as? Object, validWireCommand(command),
              let action = command["action"] as? Object, action["kind"] as? String == "click",
              let target = action["target"] as? Object, target["appId"] as? String == cohort,
              let process = wire["process"] as? Object, Self.validPublicProcessIdentity(process),
              wireInteger(process["pid"]) == wireInteger(target["processId"]),
              let worker = wire["worker"] as? Object, Self.validPublicProcessIdentity(worker),
              let number = wireInteger(wire["windowNumber"], min: 1, max: Double(UInt32.max)),
              let bounds = wire["bounds"] as? Object, Set(bounds.keys) == Set(["x", "y", "width", "height"]),
              wireNumber(bounds["x"]) != nil, wireNumber(bounds["y"]) != nil,
              let w = wireNumber(bounds["width"]), w > 0, w <= 1024,
              let h = wireNumber(bounds["height"]), h > 0, h <= 1024,
              let width = wireInteger(wire["width"], min: 1, max: 1024),
              let height = wireInteger(wire["height"], min: 1, max: 1024),
              let png = wire["pngDigest"] as? String, let fp = wire["fingerprint"] as? String,
              let display = wire["displayLayout"] as? String,
              [png, fp, display].allSatisfy({ $0.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil }),
              let frame = wireNumber(wire["frameTime"]), let observed = wireNumber(wire["observationTime"]),
              observed >= 0, frame >= observed,
              let grant = wireNumber(wire["grantDeadline"]), let deadline = wireNumber(wire["commandDeadline"]),
              grant > 0, deadline > 0 else { return nil }
        self.wire = wire; self.command = command; self.process = process; self.worker = worker
        self.bounds = bounds; windowNumber = CGWindowID(number); self.width = Int(width); self.height = Int(height)
        pngDigest = png; fingerprint = fp; displayLayout = display; frameTime = frame; observationTime = observed
        grantDeadline = grant; commandDeadline = deadline
    }
    func matches(_ command: Object) -> Bool { NSDictionary(dictionary: self.command).isEqual(to: command) }
    func matchesProcess(_ identity: ProcessIdentity) -> Bool {
        guard let current = Self.publicProcessIdentity(identity) else { return false }
        return NSDictionary(dictionary: process).isEqual(to: current)
    }
    func fresh() -> Bool {
        let t = monotonic()
        return t >= frameTime && t >= observationTime && t - frameTime < 5000 && t - observationTime < 5000 &&
            t < grantDeadline && t < commandDeadline
    }
    func binding(command: Object) -> ClickIntent.Binding? {
        guard matches(command), fresh(), let action = command["action"] as? Object,
              let x = wireInteger(action["x"]), let y = wireInteger(action["y"]), x < Double(width), y < Double(height),
              let bx = wireNumber(bounds["x"]), let by = wireNumber(bounds["y"]),
              let bw = wireNumber(bounds["width"]), let bh = wireNumber(bounds["height"]) else { return nil }
        let gx = bx + x * (bw / Double(width)), gy = by + y * (bh / Double(height))
        guard gx.isFinite, gy.isFinite, gx >= bx, gx < bx + bw, gy >= by, gy < by + bh else { return nil }
        return .init(commandID: command["commandId"] as! String, grantID: command["grantId"] as! String,
            epoch: wireInteger(command["epoch"])!, observationID: observationID, frameID: action["frameId"] as! String,
            imageX: x, imageY: y, globalX: gx, globalY: gy)
    }
}

// AX may block on the preparation queue. Callback-time authority is a short,
// separately invalidatable reservation, never AX or signature work in the tap.
final class ClickGuardianPreparedScope {
    let window: Window
    let descriptor: ClickScopeDescriptor
    private let lock = NSLock()
    private var invalid = false
    private var sealed: ClickGuardianNative.NativeValidatedIntent?
    private let onInvalidation: () -> Void
    private let grantExpiresAt: Double
    private var observer: AXObserver?
    private var notifications: [NSObjectProtocol] = []
    init?(window: Window, descriptor: ClickScopeDescriptor, grantExpiresAt: Double, invalidate: @escaping () -> Void) {
        guard window.epochFence.clean(), descriptor.matchesProcess(window.identity), grantExpiresAt.isFinite,
              now() < grantExpiresAt, window.epochFence.clean() else { return nil }
        self.window = window; self.descriptor = descriptor; self.grantExpiresAt = grantExpiresAt; onInvalidation = invalidate
    }
    func invalidate() {
        lock.lock(); invalid = true; sealed = nil; lock.unlock()
        onInvalidation()
    }
    func validForPreparation() -> Bool { lock.lock(); defer { lock.unlock() }; return !invalid && window.epochFence.clean() }
    func seal(binding: ClickIntent.Binding) {
        lock.lock(); defer { lock.unlock() }
        guard !invalid, sealed == nil, window.epochFence.clean() else { return }
        // No renewal after preparation. Probe + dispatch must fit this budget.
        sealed = .init(command: UInt64.random(in: 1...UInt64.max), x: binding.globalX, y: binding.globalY,
            deadline: min(ProcessInfo.processInfo.systemUptime + 0.75,
                          min(descriptor.commandDeadline, descriptor.grantDeadline) / 1000,
                          (descriptor.observationTime + 5000) / 1000))
    }
    func intent() -> ClickGuardianNative.NativeValidatedIntent? {
        lock.lock(); defer { lock.unlock() }; return invalid || !window.epochFence.clean() ? nil : sealed
    }
    func validates(_ intent: ClickGuardianNative.NativeValidatedIntent) -> Bool {
        // Contention itself refuses; never block the input callback behind AX.
        guard lock.try() else { return false }; defer { lock.unlock() }
        guard !invalid, let sealed = sealed else { return false }
        return sealed.command == intent.command && sealed.x == intent.x && sealed.y == intent.y &&
            sealed.deadline == intent.deadline && ProcessInfo.processInfo.systemUptime < sealed.deadline &&
            now() < grantExpiresAt && now() < (wireInteger(descriptor.command["deadlineAt"]) ?? 0) && window.epochFence.clean()
    }
    func monitoringLive() -> Bool {
        guard lock.try() else { return false }; defer { lock.unlock() }
        // After the proven pair, the input deadline is never reused. This only
        // keeps a takeover monitor during the original bounded return budget.
        return !invalid && now() < grantExpiresAt && now() < (wireInteger(descriptor.command["deadlineAt"]) ?? 0) && window.epochFence.clean()
    }
    func subscribe() -> Bool {
        var observer: AXObserver?
        let callback: AXObserverCallback = { _, _, _, context in
            guard let context = context else { return }
            Unmanaged<ClickGuardianPreparedScope>.fromOpaque(context).takeUnretainedValue().invalidate()
        }
        guard AXObserverCreate(window.identity.pid, callback, &observer) == .success, let observer = observer else { return false }
        let context = Unmanaged.passUnretained(self).toOpaque()
        var subscriptions: [(AXUIElement, String)] = [(window.application, kAXWindowCreatedNotification),
            (window.application, kAXFocusedWindowChangedNotification),
            (window.application, kAXFocusedUIElementChangedNotification)]
        for peer in window.applicationWindows {
            for name in [kAXUIElementDestroyedNotification, kAXSheetCreatedNotification, kAXMovedNotification, kAXResizedNotification, kAXTitleChangedNotification, kAXLayoutChangedNotification] {
                subscriptions.append((peer, name))
            }
        }
        for (element, name) in subscriptions {
            guard AXObserverAddNotification(observer, element, name as CFString, context) == .success else { return false }
        }
        self.observer = observer
        DispatchQueue.main.sync {
            CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
            notifications.append(NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification,
                object: nil, queue: nil) { [weak self] _ in self?.invalidate() })
            notifications.append(NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.willSleepNotification,
                object: nil, queue: nil) { [weak self] _ in self?.invalidate() })
            notifications.append(DistributedNotificationCenter.default().addObserver(forName: NSNotification.Name("com.apple.screenIsLocked"),
                object: nil, queue: nil) { [weak self] _ in self?.invalidate() })
            notifications.append(NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
                object: nil, queue: nil) { [weak self] _ in self?.invalidate() })
        }
        return true
    }
    deinit {
        // Observers retain only weak references. AX refcon is removed while this
        // object remains alive; actual owner keeps scope through candidate cleanup.
        let retainedObserver = observer
        let retainedNotifications = notifications
        let remove = {
            if let observer = retainedObserver { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes) }
            for token in retainedNotifications {
                NSWorkspace.shared.notificationCenter.removeObserver(token)
                DistributedNotificationCenter.default().removeObserver(token)
                NotificationCenter.default.removeObserver(token)
            }
        }
        if Thread.isMainThread { remove() } else { DispatchQueue.main.sync(execute: remove) }
    }
}

// Independent sticky revocation latch. No AX/Security/generation sampling in
// the tap; public zero-timeout epoch polls are synchronous. Slow checks run off-lane and publish a short, expiring liveness lease.
final class ClickGuardianLiveness {
    private let lock = NSLock()
    private var revoked = false
    private var until = 0.0
    private var workerPID: pid_t = 0
    private var epochFences: [ProcessEpochFence] = []
    func pinEpochFences(worker: ProcessEpochFence, parent: ProcessEpochFence) {
        lock.lock(); epochFences = [worker, parent]; lock.unlock()
    }
    private let parentPID = getppid()
    func pinWorker(_ pid: pid_t) { lock.lock(); workerPID = pid; lock.unlock() }
    func revoke() { lock.lock(); revoked = true; lock.unlock() }
    func renew() { lock.lock(); if !revoked { until = ProcessInfo.processInfo.systemUptime + 0.1 }; lock.unlock() }
    func live() -> Bool {
        guard lock.try() else { return false }; defer { lock.unlock() }
        return !revoked && workerPID > 1 && getppid() == parentPID &&
            kill(workerPID, 0) == 0 && kill(parentPID, 0) == 0 &&
            ProcessInfo.processInfo.systemUptime < until && brian_private_channel_alive() == 1 && epochFences.count == 2 && epochFences.allSatisfy { $0.clean() }
    }
}

final class ClickGuardianHost {
    private let trust: ProcessTrust
    private let liveness = ClickGuardianLiveness()
    private var candidate: ClickGuardianNative?
    private var prepared: ClickGuardianPreparedScope?
    private var broker: Broker?
    private var requestID: String?
    private var consumed = false
    private var dispatchAttempted = false
    private var transferOffered = false
    private var transferred = false
    private var returnOffered = false
    private var monitoringAcknowledged = false
    private var command: Object?
    private var targetFence: ProcessEpochFence?
    private var workerFence: ProcessEpochFence?
    private var preparationDeadline = ProcessInfo.processInfo.systemUptime + 3
    init(trust: ProcessTrust) { self.trust = trust }

    private func finish(reason: String) -> Never {
        let returnedCleanly = reason == "monitorReturned" && monitoringAcknowledged && liveness.live() && prepared?.monitoringLive() == true
        let terminalReason = reason == "monitorReturned" && !returnedCleanly ? "revoked" : reason
        liveness.revoke()
        var status = "refused", cleanup = "neverArmedNoEmission"
        if let candidate = candidate {
            if candidate.sequenceAttempted { status = "sequenceAttemptedUnproven" }
            if reason == "revoked" || reason == "scopeRejected" { candidate.revoke(.stop) }
            switch candidate.fencedCleanup() {
            case .neverArmedNoEmission: cleanup = "neverArmedNoEmission"
            case .inputStreamReleasedCandidate:
                cleanup = returnedCleanly ? "inputStreamReleasedCandidate" : "fencedLeaseRetained"
            case .fencedLeaseRetained: cleanup = "fencedLeaseRetained"
            }
        }
        if let id = requestID {
            _ = guardianWrite(["kind": "terminal", "id": id, "status": status, "cleanup": cleanup, "reason": terminalReason], to: .standardOutput)
        }
        _exit(0) // No synthetic cleanup event, replay, or application-success claim.
    }
    private func invalidate() {
        liveness.revoke() // synchronous, independent of owner's run-loop progress
        DispatchQueue.main.async { self.finish(reason: "revoked") }
    }
    private func admit(_ message: Object) {
        guard !consumed, Set(message.keys) == Set(["kind", "id", "workerPid", "grant", "command", "leaseId", "descriptor"]),
              message["kind"] as? String == "admit", let id = wireString(message["id"]) else { finish(reason: "revoked") }
        consumed = true; requestID = id
        guard let raw = message["descriptor"] as? Object, let descriptor = ClickScopeDescriptor(wire: raw),
              let pid = wireInteger(message["workerPid"], min: 2, max: Double(Int32.max)),
              wireInteger(descriptor.worker["pid"]) == pid,
              let command = message["command"] as? Object, descriptor.matches(command),
              let grant = message["grant"] as? Object, captureAuthority(grant),
              let lease = wireString(message["leaseId"]),
              let identity = command["identity"] as? Object, let owner = grant["identity"] as? Object,
              NSDictionary(dictionary: identity).isEqual(to: owner),
              wireInteger(command["epoch"]) == wireInteger(grant["epoch"]),
              command["grantId"] as? String == grant["grantId"] as? String,
              let action = command["action"] as? Object, let target = action["target"] as? Object,
              let targets = grant["targets"] as? [Object], targets.count == 1,
              targets.contains(where: { NSDictionary(dictionary: $0).isEqual(to: target) }),
              let deadline = wireInteger(command["deadlineAt"]), now() < deadline,
              let expiry = wireInteger(grant["expiresAt"]), now() < expiry,
              descriptor.fresh(), let parentFence = ProcessEpochFence(pid: trust.parent.pid), trust.parentValid(),
              let targetFence = ProcessEpochFence(pid: descriptor.pid),
              let workerFence = ProcessEpochFence(pid: pid_t(pid)),
              let worker = ProcessIdentity.read(pid_t(pid)),
              worker.pid != getpid(), worker.executable == trust.helper.executable,
              signedProcess(worker, trust.teamRequirement()) == trust.team,
              let publicIdentity = ClickScopeDescriptor.publicProcessIdentity(worker), NSDictionary(dictionary: publicIdentity).isEqual(to: descriptor.worker),
              let (nativeTarget, appID) = trust.target(descriptor.pid), appID == cohort,
              descriptor.matchesProcess(nativeTarget), targetFence.clean(), workerFence.clean(), parentFence.clean() else { finish(reason: "revoked") }
        self.command = command
        liveness.pinWorker(worker.pid)
        self.targetFence = targetFence; self.workerFence = workerFence
        liveness.pinEpochFences(worker: workerFence, parent: parentFence)
        // Target scope retains the independently installed standing fence. No
        // delayed DispatchSource process callback supplies epoch authority.
        preparationDeadline = min(preparationDeadline, descriptor.commandDeadline / 1000, descriptor.grantDeadline / 1000)
        // These potentially blocking checks never run in the event-tap callback.
        DispatchQueue.global(qos: .userInteractive).async { [self] in
            while true {
                guard now() < expiry, now() < deadline, trust.parentValid(), ProcessIdentity.read(worker.pid) == worker,
                      signedProcess(worker, trust.teamRequirement()) == trust.team,
                      let (currentTarget, currentApp) = trust.target(nativeTarget.pid), currentApp == cohort,
                      currentTarget == nativeTarget,
                      let current = ClickScopeDescriptor.publicProcessIdentity(worker), NSDictionary(dictionary: current).isEqual(to: descriptor.worker),
                      descriptor.matchesProcess(nativeTarget), AXIsProcessTrusted(), CGPreflightScreenCaptureAccess(),
                      CGPreflightListenEventAccess(), CGPreflightPostEventAccess(),
                      targetFence.clean(), workerFence.clean(), parentFence.clean() else { invalidate(); return }
                liveness.renew()
                usleep(20_000)
            }
        }
        let broker = Broker(trust: trust, guardianInvalidation: { [weak self] in self?.invalidate() })
        self.broker = broker
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            let prepared = broker.reconstructClick(descriptor, command: command, grant: grant, leaseId: lease, epochFence: targetFence,
                invalidate: { [weak self] in self?.invalidate() })
            DispatchQueue.main.async { [self] in
                guard let prepared = prepared, liveness.live(), prepared.validForPreparation() else { finish(reason: "scopeRejected") }
                self.prepared = prepared
                let candidate = ClickGuardianNative(validateCurrentScope: { [weak self, weak prepared] intent in
                    // No AX, signature checks, waits or queue hops in this closure.
                    self?.liveness.live() == true && prepared?.validates(intent) == true
                }, validateMonitoringScope: { [weak self, weak prepared] in
                    self?.liveness.live() == true && prepared?.monitoringLive() == true
                })
                self.candidate = candidate
                _ = candidate.startProbe()
            }
        }
    }
    private func acceptTransfer(_ message: Object) {
        guard transferOffered, !transferred, Set(message.keys) == Set(["kind", "id"]),
              message["kind"] as? String == "workerTransferred", message["id"] as? String == requestID,
              liveness.live(), let prepared = prepared, let candidate = candidate,
              candidate.status == .ready, let intent = prepared.intent(), prepared.validates(intent) else { finish(reason: "revoked") }
        transferred = true
        _ = candidate.execute(intent)
    }
    private func acceptMonitoring(_ message: Object) {
        guard returnOffered, !monitoringAcknowledged, Set(message.keys) == Set(["kind", "id"]),
              message["kind"] as? String == "workerMonitoring", message["id"] as? String == requestID,
              liveness.live(), let candidate = candidate,
              candidate.completeMonitorReturn() == .inputStreamReleasedCandidate else { finish(reason: "revoked") }
        monitoringAcknowledged = true
        // Only now may owner monitors close. Worker already revalidated privacy
        // and enabled its independent monitor. No effect authority is returned.
        finish(reason: "monitorReturned")
    }
    func run() -> Never {
        guard guardianWrite(["kind": "ready", "state": "unconstructed"], to: .standardOutput) else { finish(reason: "revoked") }
        DispatchQueue.global(qos: .userInteractive).async { [self] in
            guard let message = guardianRead(from: .standardInput) else { invalidate(); return }
            DispatchQueue.main.async { self.admit(message) }
            guard let transfer = guardianRead(from: .standardInput) else { invalidate(); return }
            DispatchQueue.main.async { self.acceptTransfer(transfer) }
            guard let monitoring = guardianRead(from: .standardInput) else { invalidate(); return }
            DispatchQueue.main.async { self.acceptMonitoring(monitoring) }
            _ = FileHandle.standardInput.readData(ofLength: 1)
            invalidate() // EOF OR any further message revokes; no second command.
        }
        let timer = Timer(timeInterval: 0.01, repeats: true) { [self] _ in
            guard brian_private_channel_alive() == 1, getppid() == trust.parent.pid else { finish(reason: "revoked") }
            guard ProcessInfo.processInfo.systemUptime < preparationDeadline else { finish(reason: "revoked") }
            guard let candidate = candidate else { return }
            guard liveness.live() else { finish(reason: "revoked") }
            switch candidate.status {
            case .ready:
                if dispatchAttempted { return }
                guard let prepared = prepared, let broker = broker, let command = command,
                      let intent = prepared.intent(), prepared.validates(intent) else { finish(reason: "scopeRejected") }
                dispatchAttempted = true
                // Final AX/pixel check after probe, before transfer/arm. Never
                // refresh the immutable scope deadline after this async work.
                DispatchQueue.global(qos: .userInitiated).async { [self] in
                    let valid = broker.revalidateGuardianClick(prepared, command: command)
                    DispatchQueue.main.async { [self] in
                        guard valid, liveness.live(), prepared.validates(intent), candidate.status == .ready,
                              let id = requestID else { finish(reason: "scopeRejected") }
                        transferOffered = true
                        guard guardianWrite(["kind": "prepared", "id": id], to: .standardOutput) else { finish(reason: "revoked") }
                    }
                }
            case .probeConfirmedProductionOff: finish(reason: "platformUnaccepted")
            case .refused, .fenced: finish(reason: "revoked")
            case .sequenceAttemptedUnproven:
                if candidate.tailObservationComplete && !returnOffered {
                    guard candidate.beginMonitorReturn(deadline: preparationDeadline), let id = requestID else { finish(reason: "revoked") }
                    returnOffered = true
                    guard guardianWrite(["kind": "returnMonitor", "id": id, "cleanup": "inputStreamReleasedCandidate"],
                        to: .standardOutput) else { finish(reason: "revoked") }
                }
            default: break
            }
        }
        RunLoop.main.add(timer, forMode: .common); RunLoop.main.run()
        finish(reason: "revoked")
    }
}
// Same four-byte big-endian framing and global size bound as the helper RPC.
// These messages are private/closed; none are part of validWireRequest/relay.
func guardianRead(from handle: FileHandle) -> Object? {
    func exact(_ count: Int) -> Data? {
        var data = Data()
        while data.count < count {
            let part = handle.readData(ofLength: count - data.count)
            if part.isEmpty { return nil }
            data.append(part)
        }
        return data
    }
    guard let header = exact(4) else { return nil }
    let size = header.reduce(0) { ($0 << 8) | Int($1) }
    guard size > 0, size <= maxBytes, let body = exact(size),
          let object = (try? JSONSerialization.jsonObject(with: body)) as? Object else { return nil }
    return object
}
@discardableResult
func guardianWrite(_ message: Object, to handle: FileHandle) -> Bool {
    guard let body = try? JSONSerialization.data(withJSONObject: message), !body.isEmpty, body.count <= maxBytes else { return false }
    var size = UInt32(body.count).bigEndian
    do {
        try handle.write(contentsOf: Data(bytes: &size, count: 4) + body)
        return true
    } catch { return false }
}

// Dedicated inherited worker pipe only; never public stdout/renderer messages.
func guardianWorkerHandoff(requestID: String, descriptor: ClickScopeDescriptor, transfer: () -> Bool, returnMonitoring: () -> Bool) -> String? {
    guard brian_pipe_endpoints_alive(3, 3) == 1 else { return nil }
    let channel = FileHandle(fileDescriptor: 3, closeOnDealloc: false)
    guard guardianWrite(["kind": "handoff", "requestId": requestID, "descriptor": descriptor.wire], to: channel) else { return nil }
    var transferred = false
    var monitoring = false
    for _ in 0..<3 {
        guard let reply = guardianRead(from: channel), Set(reply.keys) == Set(["kind", "requestId"]),
              reply["requestId"] as? String == requestID, let kind = reply["kind"] as? String else { return nil }
        if kind == "ownerPrepared" {
            guard !transferred, transfer(), guardianWrite(["kind": "workerTransferred", "requestId": requestID], to: channel) else { return nil }
            transferred = true
        } else if kind == "returnMonitor" {
            guard transferred, !monitoring, returnMonitoring(),
                  guardianWrite(["kind": "workerMonitoring", "requestId": requestID], to: channel) else { return nil }
            monitoring = true
        } else if kind == "delivered" {
            guard transferred, monitoring else { return nil }
            return kind // main has observed normal owner exit and full transcript
        } else if ["refused", "sequenceAttemptedUnproven"].contains(kind) { return kind }
        else { return nil }
    }
    return nil
}
