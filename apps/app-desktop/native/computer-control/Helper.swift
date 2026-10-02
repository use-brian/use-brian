import Foundation
import CoreFoundation
import Dispatch
import AppKit
import ApplicationServices
import Darwin
import CryptoKit
import ScreenCaptureKit
import Security

// A deliberately narrow, signed-parent-only macOS AX pilot. No shell, clipboard,
// AppleScript, network or permission prompts. Capture/input are safe-fixture-only.
// stdin/stdout are inherited private pipes. stdout is protocol-only.
typealias Object = [String: Any]
let proto = "native-computer-v1"
let cohort = "com.usebrian.NativeComputerFixture"
// Signature identifiers are authority only after kernel identity + Security validation.
struct ProcessIdentity: Equatable {
    let pid: pid_t
    let birth: UInt64
    let executable: String
    static func read(_ pid: pid_t) -> ProcessIdentity? {
        var path = [CChar](repeating: 0, count: 4096)
        var birth: UInt64 = 0
        let capacity = UInt32(path.count)
        guard brian_process_identity(pid, getuid(), &path, capacity, &birth) == 1,
              let canonical = canonicalPath(String(cString: path)) else { return nil }
        return ProcessIdentity(pid: pid, birth: birth, executable: canonical)
    }
}
func canonicalPath(_ path: String) -> String? {
    guard path.hasPrefix("/"), let resolved = realpath(path, nil) else { return nil }
    defer { free(resolved) }
    return String(cString: resolved)
}
// Electron v1 wire ABI: https://www.electronjs.org/docs/latest/tutorial/fuses
// Read every Mach-O architecture, not merely the first sentinel in a fat binary.
// No cached code/fuse verdict can authorize a later operation.
let electronBootstrapPolicy = "electron-fuses-v1:0,2,3=0;4,5=1"
func hardenedElectronWire(_ data: Data) -> Bool {
    guard data.count >= 32, data.count <= 1024 * 1024 * 1024 else { return false }
    func word(_ offset: Int, _ little: Bool = false, _ width: Int = 4) -> UInt64? {
        guard offset >= 0, offset <= data.count - width else { return nil }
        let bytes = data[offset..<(offset + width)]
        return (little ? Array(bytes.reversed()) : Array(bytes)).reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
    }
    var slices: [(Int, Int, UInt64)] = []
    let magic = word(0)
    if magic == 0xcafebabe || magic == 0xcafebabf {
        guard let count = word(4), count >= 1, count <= 2 else { return false }
        let stride = magic == 0xcafebabe ? 20 : 32
        var end = 8 + Int(count) * stride
        guard end <= data.count else { return false }
        for index in 0..<Int(count) {
            let base = 8 + index * stride
            guard let cpu = word(base), let offset = word(base + 8, false, stride == 20 ? 4 : 8),
                  let size = word(base + (stride == 20 ? 12 : 16), false, stride == 20 ? 4 : 8),
                  offset >= UInt64(end), offset <= UInt64(data.count), size >= 32,
                  size <= UInt64(data.count) - offset else { return false }
            slices.append((Int(offset), Int(size), cpu)); end = Int(offset + size)
        }
    } else {
        guard let cpu = word(4, true) else { return false }
        slices.append((0, data.count, cpu))
    }
    let sentinel = Data("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX".utf8)
    var cursor = 0; var totalWires = 0
    while cursor < data.count, let found = data.range(of: sentinel, in: cursor..<data.count) {
        totalWires += 1; cursor = found.lowerBound + 1
        if totalWires > slices.count { return false }
    }
    guard totalWires == slices.count else { return false }
    var firstWire: [UInt8]?
    var cpus: Set<UInt64> = []
    for (offset, size, cpu) in slices {
        guard [UInt64(0x01000007), UInt64(0x0100000c)].contains(cpu), cpus.insert(cpu).inserted,
              word(offset, true) == 0xfeedfacf, word(offset + 4, true) == cpu,
              word(offset + 12, true) == 6,
              let found = data.range(of: sentinel, in: offset..<(offset + size)), found.lowerBound >= offset + 32,
              data.range(of: sentinel, in: (found.lowerBound + 1)..<(offset + size)) == nil else { return false }
        let start = found.upperBound
        guard start + 2 <= offset + size, data[start] == 1, [8, 9].contains(Int(data[start + 1])),
              start + 2 + Int(data[start + 1]) <= offset + size else { return false }
        let wire = Array(data[(start + 2)..<(start + 2 + Int(data[start + 1]))])
        if let previous = firstWire, previous != wire { return false }
        firstWire = wire
        guard wire.allSatisfy({ $0 == 0x30 || $0 == 0x31 }),
              wire[0] == 0x30, wire[2] == 0x30, wire[3] == 0x30,
              wire[4] == 0x31, wire[5] == 0x31 else { return false }
    }
    return true
}
// Bounded, non-symlink regular-file read. Read errors, growth, truncation or
// metadata changes fail closed; this still does NOT attest a loaded dyld image.
func boundedFrameworkBytes(_ path: String) -> Data? {
    let fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    guard fd >= 0 else { return nil }
    defer { close(fd) }
    var before = stat(); var after = stat()
    guard fstat(fd, &before) == 0, (before.st_mode & S_IFMT) == S_IFREG,
          before.st_size >= 32, before.st_size <= 1024 * 1024 * 1024 else { return nil }
    let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
    guard let bytes = try? handle.read(upToCount: Int(before.st_size) + 1), bytes.count == Int(before.st_size),
          fstat(fd, &after) == 0, before.st_size == after.st_size,
          before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec, before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
          before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec, before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec else { return nil }
    return bytes
}
func hardenedParentBootstrap(_ identity: ProcessIdentity, _ info: [String: Any]) -> Bool {
    // Read only Security-validated signing metadata, never Bundle/NSWorkspace plist.
    guard let plist = info[kSecCodeInfoPList as String] as? [String: Any],
          plist["BrianElectronFusePolicy"] as? String == electronBootstrapPolicy,
          let integrity = plist["ElectronAsarIntegrity"] as? [String: Any],
          let asar = integrity["Resources/app.asar"] as? [String: Any],
          asar["algorithm"] as? String == "SHA256", let hash = asar["hash"] as? String,
          hash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
          let team = info[kSecCodeInfoTeamIdentifier as String] as? String,
          team.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil else { return false }
    let contents = URL(fileURLWithPath: identity.executable).deletingLastPathComponent().deletingLastPathComponent().path
    let frameworkBundle = contents + "/Frameworks/Electron Framework.framework"
    let framework = frameworkBundle + "/Versions/A/Electron Framework"
    let archive = contents + "/Resources/app.asar"
    guard canonicalPath(archive) == archive, canonicalPath(framework) == framework,
          canonicalPath(contents + "/Frameworks/Electron Framework.framework/Electron Framework") == framework else { return false }
    var requirement: SecRequirement?
    guard SecRequirementCreateWithString(("anchor apple generic and certificate leaf[subject.OU] = \"\(team)\"") as CFString, [], &requirement) == errSecSuccess,
          let requirement = requirement else { return false }
    func frameworkValid() -> Bool {
        var code: SecStaticCode?
        var signing: CFDictionary?
        // Validate the framework bundle itself, including its resource seal and
        // all architectures. Do not rely on the launcher's nested-code default.
        guard SecStaticCodeCreateWithPath(URL(fileURLWithPath: frameworkBundle) as CFURL, [], &code) == errSecSuccess,
              let code = code,
              SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures | kSecCSCheckNestedCode), requirement) == errSecSuccess,
              SecCodeCopySigningInformation(code, [], &signing) == errSecSuccess,
              let metadata = signing as? [String: Any],
              let executable = metadata[kSecCodeInfoMainExecutable as String] as? URL,
              canonicalPath(executable.path) == framework else { return false }
        return true
    }
    guard frameworkValid(), let bytes = boundedFrameworkBytes(framework),
          hardenedElectronWire(bytes), frameworkValid(), canonicalPath(framework) == framework,
          ProcessIdentity.read(identity.pid) == identity else { return false }
    return true
}
// Validate the RUNNING guest, not just an Info.plist or a file at a claimed URL.
// Also validate its static resource seal (notably the containing desktop app).
func signedProcess(_ identity: ProcessIdentity, _ requirementText: String, bootstrap: Bool = false) -> String? {
    var guest: SecCode?
    var requirement: SecRequirement?
    let attributes = [kSecGuestAttributePid as String: NSNumber(value: identity.pid)] as CFDictionary
    guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &guest) == errSecSuccess,
          let code = guest,
          SecRequirementCreateWithString(requirementText as CFString, [], &requirement) == errSecSuccess,
          let requirement = requirement,
          SecCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) == errSecSuccess else { return nil }
    var staticCode: SecStaticCode?
    var information: CFDictionary?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let disk = staticCode,
          SecStaticCodeCheckValidity(disk, SecCSFlags(rawValue: kSecCSStrictValidate | (bootstrap ? kSecCSCheckNestedCode : 0)), requirement) == errSecSuccess,
          SecCodeCopySigningInformation(disk, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
          let info = information as? [String: Any],
          let executable = info[kSecCodeInfoMainExecutable as String] as? URL,
          canonicalPath(executable.path) == identity.executable,
          ProcessIdentity.read(identity.pid) == identity else { return nil }
    if bootstrap && !hardenedParentBootstrap(identity, info) { return nil }
    // Recheck dynamic identity after potentially expensive framework/resource reads.
    guard SecCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) == errSecSuccess,
          ProcessIdentity.read(identity.pid) == identity else { return nil }
    // Apple platform binaries need not carry a third-party team identifier.
    return info[kSecCodeInfoTeamIdentifier as String] as? String ?? ""
}
final class ProcessTrust {
    let helper: ProcessIdentity
    let parent: ProcessIdentity
    let team: String
    let fixtureExecutable: String
    private var bootstrapData: BootstrapProcessBinding.DataResult?
    init?() {
        guard brian_private_pipes() == 1,
              let helper = ProcessIdentity.read(getpid()),
              let team = signedProcess(helper, "anchor apple generic"),
              team.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil,
              let parent = ProcessIdentity.read(getppid()) else { return nil }
        // Derive the tree from the kernel executable, never Bundle.main, argv,
        // environment, application title, bundleURL or bundleIdentifier metadata.
        let macOS = URL(fileURLWithPath: parent.executable).deletingLastPathComponent()
        let contents = macOS.deletingLastPathComponent()
        guard macOS.lastPathComponent == "MacOS", contents.lastPathComponent == "Contents",
              contents.deletingLastPathComponent().pathExtension == "app",
              parent.executable == contents.path + "/MacOS/Use Brian",
              helper.executable == contents.path + "/Resources/computer-control/brian-native-computer-helper" else { return nil }
        self.helper = helper; self.parent = parent; self.team = team
        fixtureExecutable = contents.path + "/Resources/computer-control/NativeComputerFixture.app/Contents/MacOS/NativeComputerFixture"
        guard signedParentValid(),
              let binding = try? BootstrapProcessBinding.collect(trust: self) else { return nil }
        bootstrapData = binding
        guard parentValid() else { return nil }
    }
    func teamRequirement(_ identifier: String? = nil) -> String {
        let base = "anchor apple generic and certificate leaf[subject.OU] = \"\(team)\""
        return identifier.map { base + " and identifier \"\($0)\"" } ?? base
    }
    func parentValid() -> Bool {
        guard let binding = bootstrapData,
              (try? BootstrapProcessBinding.revalidate(binding, trust: self)) != nil else { return false }
        return signedParentValid()
    }
    private func signedParentValid() -> Bool {
        return getppid() == parent.pid && brian_private_channel_alive() == 1 && brian_private_pipes() == 1 &&
            ProcessIdentity.read(getpid()) == helper && ProcessIdentity.read(parent.pid) == parent &&
            signedProcess(helper, teamRequirement()) == team &&
            signedProcess(parent, teamRequirement("ai.usebrian.desktop"), bootstrap: true) == team
    }
    func target(_ pid: pid_t) -> (ProcessIdentity, String)? {
        guard parentValid(), let identity = ProcessIdentity.read(pid), pid != getpid() else { return nil }
        if identity.executable == "/System/Applications/TextEdit.app/Contents/MacOS/TextEdit",
           signedProcess(identity, "anchor apple and identifier \"com.apple.TextEdit\"") != nil {
            return (identity, "com.apple.TextEdit")
        }
        if identity.executable == fixtureExecutable,
           signedProcess(identity, teamRequirement(cohort)) == team { return (identity, cohort) }
        return nil
    }
}
let canvasTitle = "Brian Safe Canvas"
let maxBytes = 4 * 1024 * 1024
// BEGIN FOUNDATION WIRE VALIDATION
// These pure functions are extracted verbatim by the Foundation-only boundary
// tests. Shared limits: packages/computer-control/src/protocol.ts. Do NOT use
// them for AX attributes, whose native CFBoolean/NSNumber semantics differ.
func now() -> Double { (Date().timeIntervalSince1970 * 1000).rounded(.down) }
func wireBool(_ value: Any?) -> Bool? {
    guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
    return number.boolValue
}
func wireNumber(_ value: Any?) -> Double? {
    guard let number = value as? NSNumber, CFGetTypeID(number) == CFNumberGetTypeID() else { return nil }
    let result = number.doubleValue
    return result.isFinite ? result : nil
}
func wireInteger(_ value: Any?, min: Double = 0, max: Double = Double.greatestFiniteMagnitude) -> Double? {
    guard let number = wireNumber(value), number.rounded(.towardZero) == number, number >= min, number <= max else { return nil }
    return number
}
func wireString(_ value: Any?, max: Int = 256, nonempty: Bool = true) -> String? {
    guard let string = value as? String, (!nonempty || !string.isEmpty), string.utf16.count <= max else { return nil }
    return string
}
func validWireIdentity(_ identity: Object) -> Bool {
    let keys = ["deploymentId", "userId", "workspaceId", "deviceId", "sessionId", "conversationId", "taskId"]
    return Set(identity.keys) == Set(keys) && keys.allSatisfy { wireString(identity[$0]) != nil }
}
func validWireTarget(_ target: Object) -> Bool {
    let identifiers = ["appId", "processInstanceId", "windowId", "windowInstanceId"]
    return Set(target.keys) == Set(identifiers + ["processId"]) && identifiers.allSatisfy { wireString(target[$0]) != nil } &&
        // pid_t is signed 32-bit on macOS. Never trap/narrow a large JSON number.
        wireInteger(target["processId"], min: 1, max: Double(Int32.max)) != nil
}
func validWireGrant(_ candidate: Object) -> Bool {
    guard Set(candidate.keys) == Set(["protocol", "identity", "grantId", "epoch", "expiresAt", "targets", "allowControl", "allowCapture", "requester", "goal"]),
          candidate["protocol"] as? String == proto, let identity = candidate["identity"] as? Object, validWireIdentity(identity),
          wireString(candidate["grantId"]) != nil, wireInteger(candidate["epoch"]) != nil, wireInteger(candidate["expiresAt"]) != nil,
          wireBool(candidate["allowControl"]) != nil, wireBool(candidate["allowCapture"]) != nil,
          wireString(candidate["requester"], max: 200) != nil, wireString(candidate["goal"], max: 2000) != nil,
          let targets = candidate["targets"] as? [Object], !targets.isEmpty, targets.count <= 8, targets.allSatisfy(validWireTarget) else { return false }
    return true
}
func validWireCommand(_ command: Object) -> Bool {
    guard Set(command.keys) == Set(["protocol", "identity", "grantId", "epoch", "commandId", "deadlineAt", "action"]),
          command["protocol"] as? String == proto, let identity = command["identity"] as? Object, validWireIdentity(identity),
          wireString(command["grantId"]) != nil, wireString(command["commandId"]) != nil,
          wireInteger(command["epoch"]) != nil, wireInteger(command["deadlineAt"]) != nil,
          let action = command["action"] as? Object, let kind = action["kind"] as? String,
          let target = action["target"] as? Object, validWireTarget(target) else { return false }
    let keys: [String: Set<String>] = [
        "observe": ["kind", "target"], "capture": ["kind", "target", "observationId"],
        "focus": ["kind", "target", "observationId"], "invoke": ["kind", "target", "observationId", "ref"],
        "setValue": ["kind", "target", "observationId", "ref", "text"],
        "select": ["kind", "target", "observationId", "ref"], "scroll": ["kind", "target", "observationId", "ref", "deltaY"],
        "click": ["kind", "target", "observationId", "frameId", "x", "y"], "key": ["kind", "target", "observationId", "key"]
    ]
    guard keys[kind] == Set(action.keys) else { return false }
    if kind != "observe" && wireString(action["observationId"]) == nil { return false }
    if ["invoke", "setValue", "select", "scroll"].contains(kind) && wireString(action["ref"]) == nil { return false }
    switch kind {
    case "setValue":
        guard let text = wireString(action["text"], max: 4096, nonempty: false), !text.contains("\u{0000}") else { return false }
    case "scroll":
        guard wireInteger(action["deltaY"], min: -600, max: 600) != nil else { return false }
    case "click":
        guard wireString(action["frameId"]) != nil, let x = wireNumber(action["x"]), let y = wireNumber(action["y"]), x >= 0, y >= 0 else { return false }
    case "key":
        guard let key = action["key"] as? String, ["Tab", "Shift+Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Escape", "Enter"].contains(key) else { return false }
    default: break
    }
    return true
}
func validWirePayload(_ method: String, _ payload: Object) -> Bool {
    switch method {
    case "capabilities", "listTargets": return payload.isEmpty
    case "start":
        return Set(payload.keys) == Set(["grant", "leaseId"]) && wireString(payload["leaseId"]) != nil &&
            (payload["grant"] as? Object).map(validWireGrant) == true
    case "beginApproval", "execute", "endApproval":
        let keys = method == "endApproval" ? ["command", "leaseId", "approved"] : ["command", "leaseId"]
        return Set(payload.keys) == Set(keys) && wireString(payload["leaseId"]) != nil &&
            (method != "endApproval" || wireBool(payload["approved"]) != nil) &&
            (payload["command"] as? Object).map(validWireCommand) == true
    default: return false
    }
}
func timingRequestID(_ value: Any?) -> String? {
    guard let identifier = wireString(value), identifier.utf8.allSatisfy({
        (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 95 || $0 == 45
    }) else { return nil }
    return identifier
}
func validWireRequest(_ request: Object) -> Bool {
    let keys = request.keys.contains("diagnostics") ? ["id", "method", "payload", "diagnostics"] : ["id", "method", "payload"]
    guard Set(request.keys) == Set(keys), wireString(request["id"]) != nil,
          let method = request["method"] as? String, let payload = request["payload"] as? Object else { return false }
    if request.keys.contains("diagnostics") {
        guard let requested = wireBool(request["diagnostics"]) else { return false }
        // Diagnostic correlation has the narrower ASCII alphabet from helper-timing.ts.
        // Ordinary request IDs retain their existing UTF-16 validation when default-off.
        if requested && timingRequestID(request["id"]) == nil { return false }
    }
    return validWirePayload(method, payload)
}
// PRIVATE envelope diagnostics only. Canonical DTO: helper-timing.ts.
// No payload/result data, wall-clock deadline or authority flag enters this DTO.
// A returned invocation is not delivery/mutation evidence; failed is not proof of
// non-dispatch. No response (hung/lost/killed) supplies no timing completion evidence.
enum SourceMethod: String {
    case capabilities, listTargets, start, beginApproval, endApproval, execute
}
enum SourcePhase: String {
    case request, observe_request, capture_request
    case api_set_value, api_invoke, api_select, api_scroll
    var isAPI: Bool {
        switch self {
        case .api_set_value, .api_invoke, .api_select, .api_scroll: return true
        default: return false
        }
    }
}
enum SourceStatus: String { case returned, failed }
struct SourceSpan {
    let phase: SourcePhase
    let startUs: UInt64
    let endUs: UInt64
    let status: SourceStatus
    var wire: Object? {
        guard startUs <= 9_007_199_254_740_991, endUs <= 9_007_199_254_740_991,
              endUs >= startUs, endUs - startUs <= 900_000_000 else { return nil }
        return ["phase": phase.rawValue, "startUs": startUs, "endUs": endUs,
                "durationUs": endUs - startUs, "status": status.rawValue]
    }
}
final class SourceClock {
    let instanceId = UUID().uuidString
    let clockId = UUID().uuidString
    private let originNs = DispatchTime.now().uptimeNanoseconds
    func tick() -> UInt64? {
        let uptimeNs = DispatchTime.now().uptimeNanoseconds
        guard uptimeNs >= originNs else { return nil }
        let us = (uptimeNs - originNs) / 1000
        return us <= 9_007_199_254_740_991 ? us : nil
    }
    func dto(requestId: String, method: SourceMethod, root: SourceSpan, api: SourceSpan?) -> Object? {
        guard timingRequestID(requestId) != nil, !root.phase.isAPI,
              method == .execute || root.phase == .request, let rootWire = root.wire else { return nil }
        var spans = [rootWire]
        if let api = api {
            guard method == .execute, root.phase == .request, api.phase.isAPI,
                  api.startUs >= root.startUs, api.endUs <= root.endUs, let apiWire = api.wire else { return nil }
            spans.append(apiWire)
        }
        return ["version": 1, "instanceId": instanceId, "clockId": clockId,
                "requestId": requestId, "method": method.rawValue, "spans": spans]
    }
}
final class SourceRequestTiming {
    let requestId: String
    let method: SourceMethod
    private let clock: SourceClock
    private let phase: SourcePhase
    private let startUs: UInt64
    private var pending: (SourcePhase, UInt64)?
    private var api: SourceSpan?
    private var invalid = false
    private var finished = false
    init?(request: Object, clock: SourceClock) {
        guard validWireRequest(request), wireBool(request["diagnostics"]) == true,
              let requestId = timingRequestID(request["id"]), let name = request["method"] as? String,
              let method = SourceMethod(rawValue: name), let startUs = clock.tick() else { return nil }
        self.requestId = requestId; self.method = method; self.clock = clock; self.startUs = startUs
        // Read only the fixed action discriminator; never retain payload/targets/refs.
        let actionKind = (((request["payload"] as? Object)?["command"] as? Object)?["action"] as? Object)?["kind"] as? String
        if method == .execute && actionKind == "observe" { phase = .observe_request }
        else if method == .execute && actionKind == "capture" { phase = .capture_request }
        else { phase = .request }
    }
    func beginAPI(_ phase: SourcePhase) {
        guard !invalid, !finished, method == .execute, self.phase == .request, phase.isAPI,
              pending == nil, api == nil, let start = clock.tick() else { invalid = true; return }
        pending = (phase, start)
    }
    func endAPI(returned: Bool) {
        guard !invalid, !finished, let (phase, start) = pending, let end = clock.tick() else { invalid = true; return }
        pending = nil
        let span = SourceSpan(phase: phase, startUs: start, endUs: end, status: returned ? .returned : .failed)
        guard span.wire != nil else { invalid = true; return }
        api = span
    }
    func finish() -> Object? {
        guard !finished else { return nil }
        finished = true
        guard !invalid, pending == nil, let end = clock.tick() else { return nil }
        // Handler returned a structured result, including refusals. Do not infer
        // native delivery/success from that result or expose its error/content.
        return clock.dto(requestId: requestId, method: method,
                         root: SourceSpan(phase: phase, startUs: startUs, endUs: end, status: .returned), api: api)
    }
}
func privateResponse(requestId: String, method: String, result: Any, timing: SourceRequestTiming?) -> Object {
    var response: Object = ["id": requestId, "ok": true, "result": result]
    // Negotiation is a PRIVATE response-envelope scalar, not public capabilities.
    // Advertised for capabilities even when timing collection was omitted/false.
    if method == "capabilities" { response["diagnosticsVersion"] = 1 }
    if let timing = timing, timing.requestId == requestId, timing.method.rawValue == method,
       let diagnostics = timing.finish() { response["diagnostics"] = diagnostics }
    return response
}
// Unconditional authority barrier, NOT an attestation or configurable pilot gate.
// The operational Broker remains unreachable until real loaded-framework binding
// and native acceptance are implemented. No permission probes or target reads.
let probeOnlyLimitation = "Native authority disabled: parent loaded-framework proof is unenforced."
func probeOnlyResponse(_ request: Object, clock: SourceClock) -> Object? {
    guard validWireRequest(request), let requestId = request["id"] as? String,
          let method = request["method"] as? String, let payload = request["payload"] as? Object else { return nil }
    let timing = SourceRequestTiming(request: request, clock: clock)
    let result: Any
    switch method {
    case "capabilities":
        result = ["protocol": proto, "platform": "darwin", "axRead": false,
                  "semanticActions": false, "windowCapture": false, "input": false,
                  "accessibilityPermission": "unknown", "capturePermission": "unknown",
                  "limitations": [probeOnlyLimitation]] as Object
    case "listTargets": result = [Object]()
    case "start", "beginApproval", "endApproval": result = false
    case "execute":
        guard let command = payload["command"] as? Object, let commandId = command["commandId"] as? String else { return nil }
        result = ["commandId": commandId, "outcome": "not_executed", "code": "denied"]
    default: return nil
    }
    // Only handler timing, including refusals. No API span can be produced here.
    return privateResponse(requestId: requestId, method: method, result: result, timing: timing)
}
// Closed role/subrole privacy policy, shared with the Foundation boundary tests.
// nil means unreadable/malformed, not an absent optional attribute. A genuine
// unsupported/no-value optional subrole is represented by an empty string only
// by the native attribute reader below. Unreviewed subroles remain redacted.
let publicAXRoles: Set<String> = ["AXWindow", "AXGroup", "AXButton", "AXCheckBox", "AXRadioButton", "AXTextField", "AXTextArea", "AXStaticText", "AXPopUpButton", "AXScrollArea", "AXList", "AXRow", "AXTable", "AXColumn", "AXMenu", "AXMenuItem", "AXToolbar", "AXScrollBar", "AXSplitter", "AXSplitGroup", "AXLayoutArea", "AXLayoutItem"]
func publicAXClassification(_ role: String?, _ subrole: String?) -> Bool {
    guard let role = role, let subrole = subrole, publicAXRoles.contains(role) else { return false }
    if subrole.isEmpty { return role != "AXWindow" }
    switch role {
    case "AXWindow": return subrole == "AXStandardWindow"
    case "AXButton": return ["AXCloseButton", "AXMinimizeButton", "AXZoomButton", "AXFullScreenButton"].contains(subrole)
    case "AXTextField": return subrole == "AXSearchField"
    case "AXRow": return ["AXTableRow", "AXOutlineRow"].contains(subrole)
    default: return false
    }
}
// END FOUNDATION WIRE VALIDATION
func monotonic() -> Double { ProcessInfo.processInfo.systemUptime * 1000 }
func id() -> String { UUID().uuidString }
func same(_ a: Object, _ b: Object) -> Bool { NSDictionary(dictionary: a).isEqual(to: b) }
func attr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var result: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &result) == .success ? result : nil
}
func elements(_ element: AXUIElement, _ name: String) -> [AXUIElement] { attr(element, name) as? [AXUIElement] ?? [] }
// Internal security comparisons always use the full AX string, never a prefix.
func string(_ element: AXUIElement, _ name: String) -> String { attr(element, name) as? String ?? "" }
func privacySubrole(_ element: AXUIElement) -> String? {
    var value: CFTypeRef?
    switch AXUIElementCopyAttributeValue(element, kAXSubroleAttribute as CFString, &value) {
    case .success: return value as? String
    case .attributeUnsupported, .noValue: return ""
    default: return nil // Timeout, invalid element, disabled API, or failed read.
    }
}
// Wire limits match JavaScript/Zod UTF-16 code units, not Swift graphemes.
// Stop on a scalar boundary: never emit an unpaired surrogate at the limit.
func boundedText(_ value: String, _ limit: Int) -> (text: String, truncated: Bool) {
    var text = ""; var units = 0
    for scalar in value.unicodeScalars {
        let width = scalar.value > 0xFFFF ? 2 : 1
        if units + width > limit { return (text, true) }
        text.unicodeScalars.append(scalar); units += width
    }
    return (text, false)
}
struct NodeRead {
    let value: Object
    let complete: Bool
}
func bool(_ element: AXUIElement, _ name: String) -> Bool { (attr(element, name) as? Bool) ?? false }
func bounds(_ element: AXUIElement) -> Object? {
    guard let p = attr(element, kAXPositionAttribute), let s = attr(element, kAXSizeAttribute), CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero; var size = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size), point.x.isFinite, point.y.isFinite, size.width > 0, size.height > 0, size.width <= 32768, size.height <= 32768 else { return nil }
    return ["x": point.x, "y": point.y, "width": size.width, "height": size.height]
}
func layout() -> String {
    let description = DispatchQueue.main.sync { NSScreen.screens.map { "\($0.frame):\($0.backingScaleFactor)" }.joined(separator: "|") }
    return SHA256.hash(data: Data(description.utf8)).map { String(format: "%02x", $0) }.joined()
}
func lastInputAge() -> Double {
    [CGEventType.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel, .leftMouseDragged, .mouseMoved].map {
        CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) * 1000
    }.min() ?? 0
}
struct Window {
    let target: Object
    let element: AXUIElement
    let application: AXUIElement
    let applicationWindows: [AXUIElement]
    let launch: Date
    let identity: ProcessIdentity
}
struct Ref {
    let element: AXUIElement
    let node: Object
    let children: [AXUIElement]
}
struct Snapshot {
    let observation: Object
    let refs: [String: Ref]
    let monotonic: Double
}
final class Broker {
    // Explicit dependency: top-level guard bindings are not class members.
    // The probe-only entry point still never constructs this operational class.
    private let trust: ProcessTrust
    var windows: [String: Window] = [:]
    var processes: [String: String] = [:]
    var grant: Object?
    var lease = ""
    var expiresMonotonic = 0.0
    var snapshots: [String: Snapshot] = [:]
    var frame: Object?
    var frameObservation = ""
    var lastCapture = -Double.infinity
    var journal: [String: Object] = [:]
    var seen: [String: Data] = [:]
    // Independent watchdog: parent death/deadline/permission loss never waits for AX.
    let guardLock = NSLock()
    var watchdogDeadline: Double = 0
    var watchdogActive = false
    var watchdogCapture = false
    var approvalCommand: Object?
    var approvedCommand: Object?
    var approvalOpen = false
    var inputTap: CFMachPort?
    // Local lifetime fencing only; no observer transport, content or telemetry.
    private var scopeObserver: AXObserver?
    func input(_ type: CGEventType, _ event: CGEvent) {
        guardLock.lock(); let active = watchdogActive; let approving = approvalOpen; guardLock.unlock()
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput { _exit(72) }
        guard active else { return }
        // No own-PID exemption: semantic actions/capture do not inject input.
        // Only the trusted parent's LOCAL approval interaction is excepted. Main must
        // keep all non-dialog takeover hooks live; renderer input is not consent.
        if approving && event.getIntegerValueField(.eventTargetUnixProcessID) == Int64(getppid()) { return }
        _exit(73)
    }
    var commandDeadline = Double.infinity
    init(trust: ProcessTrust) {
        self.trust = trust
        let types: [CGEventType] = [.keyDown, .keyUp, .flagsChanged, .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp, .scrollWheel, .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged]
        let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        inputTap = CGEvent.tapCreate(tap: .cgAnnotatedSessionEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: mask, callback: { _, type, event, info in
            guard let info = info else { return Unmanaged.passUnretained(event) }
            Unmanaged<Broker>.fromOpaque(info).takeUnretainedValue().input(type, event)
            return Unmanaged.passUnretained(event)
        }, userInfo: Unmanaged.passUnretained(self).toOpaque())
        if let tap = inputTap {
            CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0), .commonModes)
            CGEvent.tapEnable(tap: tap, enable: true)
        }
        DispatchQueue.global(qos: .userInteractive).async { [self] in
            while true {
                usleep(50_000)
                if brian_private_channel_alive() != 1 { _exit(70) }
                guardLock.lock(); let deadline = watchdogDeadline; let active = watchdogActive; let capture = watchdogCapture; guardLock.unlock()
                if brian_private_channel_alive() != 1 || getppid() != trust.parent.pid || (active && (monotonic() >= deadline || !AXIsProcessTrusted() || (capture && !CGPreflightScreenCaptureAccess()) || inputTap == nil || !CGEvent.tapIsEnabled(tap: inputTap!))) { _exit(70) }
            }
        }
        DistributedNotificationCenter.default().addObserver(forName: NSNotification.Name("com.apple.screenIsLocked"), object: nil, queue: nil) { _ in _exit(71) }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: nil) { _ in _exit(71) }
    }
    func capabilities() -> Object {
        let trusted = AXIsProcessTrusted()
        let ready = trusted && (inputTap.map { CGEvent.tapIsEnabled(tap: $0) } ?? false)
        return ["protocol": proto, "platform": "darwin", "axRead": ready, "semanticActions": ready, "windowCapture": ready && CGPreflightScreenCaptureAccess(), "input": false,
                "accessibilityPermission": trusted ? "granted" : "denied", "capturePermission": CGPreflightScreenCaptureAccess() ? "granted" : "denied",
                "limitations": ["macOS 14+ fixture and TextEdit document AX only; packaged acceptance pending.", "Coordinate input disabled: no surviving release owner. Capture: isolated safe fixture canvas only; TextEdit pixels denied. Keys/focus/drag unsupported. Fixture vertical AX scrollbar steps only.", "Input takeover revokes; only trusted parent approval interaction is excepted. Fresh foreground refs only."]]
    }
    func listTargets() -> [Object] {
        guard grant == nil, AXIsProcessTrusted() else { return [] }
        var next: [String: Window] = [:]
        for app in NSWorkspace.shared.runningApplications {
            guard let (identity, appId) = trust.target(app.processIdentifier),
                  let launch = app.launchDate, !app.isTerminated else { continue }
            let processKey = "\(app.processIdentifier):\(launch.timeIntervalSince1970)"
            let processInstance = processes[processKey] ?? id()
            processes[processKey] = processInstance
            let ax = AXUIElementCreateApplication(app.processIdentifier)
            AXUIElementSetMessagingTimeout(ax, 0.2)
            guard let applicationWindows = attr(ax, kAXWindowsAttribute) as? [AXUIElement],
                  applicationWindows.count <= 32 else { continue }
            for window in applicationWindows {
                guard bounds(window) != nil else { continue }
                if !supportedWindowScope(window) { continue }
                let previous = windows.values.first { ($0.target["processId"] as? Int) == Int(app.processIdentifier) && $0.launch == launch && CFEqual($0.element, window) }
                let target: Object = previous?.target ?? ["appId": appId, "processId": Int(app.processIdentifier), "processInstanceId": processInstance, "windowId": id(), "windowInstanceId": id()]
                next[target["windowInstanceId"] as! String] = Window(target: target, element: window, application: ax, applicationWindows: applicationWindows, launch: launch, identity: identity)
                if next.count >= 128 { break }
            }
        }
        windows = next
        // Stable discovery order for local inspectors; titles are not target identity.
        return next.values.sorted {
            let a = $0.target["processId"] as! Int, b = $1.target["processId"] as! Int
            return a == b ? string($0.element, kAXTitleAttribute) < string($1.element, kAXTitleAttribute) : a < b
        }.map { window in
            var discovered = window.target
            discovered["displayName"] = boundedText(string(window.element, kAXTitleAttribute), 256).text
            return discovered
        }
    }
    func liveWindow(_ target: Object) -> Window? {
        var intact = false
        // Scope loss is sticky: closing a modal later must never resurrect this
        // grant. Parent cleanup/reauthorization must use a new helper and epoch.
        defer { if !intact && grant != nil { _exit(71) } }
        guard validWireTarget(target), let key = target["windowInstanceId"] as? String, let window = windows[key], same(window.target, target), let pid = wireInteger(target["processId"], min: 1, max: Double(Int32.max)),
              let (identity, appId) = trust.target(pid_t(pid)), identity == window.identity, appId == target["appId"] as? String,
              let app = NSRunningApplication(processIdentifier: pid_t(pid)), !app.isTerminated, app.launchDate == window.launch,
              let currentWindows = attr(window.application, kAXWindowsAttribute) as? [AXUIElement],
              currentWindows.count == window.applicationWindows.count,
              currentWindows.contains(where: { CFEqual($0, window.element) }),
              window.applicationWindows.allSatisfy({ expected in currentWindows.filter({ CFEqual($0, expected) }).count == 1 }),
              !bool(window.element, kAXMinimizedAttribute), supportedWindowScope(window.element) else { return nil }
        // Another normal document may be focused before local consent restores
        // the selected one. A focused modal/dialog/unknown window is never such
        // permission: pause instead of raising the document through that modal.
        guard let focused = attr(window.application, kAXFocusedWindowAttribute),
              CFGetTypeID(focused) == AXUIElementGetTypeID(),
              supportedWindowScope(focused as! AXUIElement) else { return nil }
        intact = true
        return window
    }
    private func monitorScope(_ window: Window) -> Bool {
        guard scopeObserver == nil else { return false }
        var observer: AXObserver?
        let callback: AXObserverCallback = { _, _, _, context in
            guard let context = context else { return }
            let broker = Unmanaged<Broker>.fromOpaque(context).takeUnretainedValue()
            broker.guardLock.lock(); let active = broker.watchdogActive; broker.guardLock.unlock()
            // Never query AX on the callback: it must not wait on a blocked
            // provider. Even a short-lived new window/sheet invalidates scope.
            if active { _exit(71) }
        }
        guard AXObserverCreate(pid_t(window.target["processId"] as! Int), callback, &observer) == .success,
              let observer = observer else { return false }
        let context = Unmanaged.passUnretained(self).toOpaque()
        var subscriptions: [(AXUIElement, String)] = [(window.application, kAXWindowCreatedNotification)]
        for peer in window.applicationWindows {
            subscriptions.append((peer, kAXUIElementDestroyedNotification))
            subscriptions.append((peer, kAXSheetCreatedNotification))
        }
        for (element, notification) in subscriptions {
            guard AXObserverAddNotification(observer, element, notification as CFString, context) == .success else { return false }
        }
        scopeObserver = observer
        DispatchQueue.main.sync {
            CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
        }
        return true
    }
    // Foreground restoration is part of explicit local session/action consent,
    // never an independently model-callable focus escape hatch. Recheck identity.
    func restoreApprovedWindow(_ window: Window) -> Bool {
        guard let live = liveWindow(window.target), CFEqual(live.element, window.element),
              let app = NSRunningApplication(processIdentifier: pid_t(window.target["processId"] as! Int)) else { return false }
        let activated = DispatchQueue.main.sync { brian_private_channel_alive() == 1 && app.activate(options: []) }
        guard activated, liveWindow(window.target) != nil, brian_private_channel_alive() == 1, AXUIElementPerformAction(window.element, kAXRaiseAction as CFString) == .success else { return false }
        let end = monotonic() + 750
        repeat {
            if NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier,
               let focused = attr(window.application, kAXFocusedWindowAttribute), CFEqual(focused, window.element) {
                return liveWindow(window.target) != nil && brian_private_channel_alive() == 1
            }
            usleep(10_000)
        } while monotonic() < end
        return false
    }
    func start(_ payload: Object) -> Bool {
        guard validWirePayload("start", payload), grant == nil, let candidate = payload["grant"] as? Object,
              let leaseId = wireString(payload["leaseId"]),
              // Schema permits epoch zero; this pilot retains its active-grant >0 rule.
              let epoch = wireInteger(candidate["epoch"]), epoch > 0,
              let expiry = wireInteger(candidate["expiresAt"]), expiry > now(), expiry <= now() + 900_000,
              let capture = wireBool(candidate["allowCapture"]), (!capture || CGPreflightScreenCaptureAccess()),
              let targets = candidate["targets"] as? [Object], inputTap != nil, AXIsProcessTrusted(), targets.allSatisfy({ liveWindow($0) != nil }) else { return false }
        guard targets.count == 1, let window = liveWindow(targets[0]), monitorScope(window), restoreApprovedWindow(window) else { return false }
        guard brian_private_channel_alive() == 1 else { _exit(70) }
        grant = candidate; lease = leaseId; expiresMonotonic = monotonic() + expiry - now()
        guardLock.lock(); watchdogDeadline = expiresMonotonic; watchdogCapture = capture; watchdogActive = true; guardLock.unlock()
        return true
    }
    func authorized(_ command: Object, _ leaseId: String) -> Bool {
        guard validCommand(command), wireString(leaseId) != nil, trust.parentValid(), let grant = grant, leaseId == lease, command["protocol"] as? String == proto,
              let identity = command["identity"] as? Object, let owner = grant["identity"] as? Object, same(identity, owner),
              command["grantId"] as? String == grant["grantId"] as? String, wireInteger(command["epoch"]) == wireInteger(grant["epoch"]),
              let expiry = wireInteger(grant["expiresAt"]), now() < expiry, monotonic() < expiresMonotonic, monotonic() < commandDeadline,
              let deadline = wireInteger(command["deadlineAt"]), now() < deadline,
              let action = command["action"] as? Object, let target = action["target"] as? Object, let targets = grant["targets"] as? [Object], targets.contains(where: { same($0, target) }), liveWindow(target) != nil, AXIsProcessTrusted(), brian_private_channel_alive() == 1 else { return false }
        return true
    }
    func validCommand(_ command: Object) -> Bool { validWireCommand(command) }
    func actionNames(_ element: AXUIElement) -> [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
        return names as? [String] ?? []
    }
    func selectionAttribute(_ element: AXUIElement) -> Bool {
        var settable: DarwinBoolean = false
        return AXUIElementIsAttributeSettable(element, kAXSelectedAttribute as CFString, &settable) == .success && settable.boolValue
    }
    func node(_ element: AXUIElement, _ ref: String, _ parent: String?) -> NodeRead {
        let role = string(element, kAXRoleAttribute)
        let subrole = privacySubrole(element)
        // Unknown or unreadable classification never authorizes exporting text.
        let sensitive = !publicAXClassification(role, subrole)
        var actions: [String] = []
        let names = actionNames(element)
        if !sensitive && bool(element, kAXEnabledAttribute) {
            if names.contains(kAXPressAction) { actions.append("invoke") }
            var settable: DarwinBoolean = false
            if (role == kAXTextFieldRole || role == kAXTextAreaRole) && AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success && settable.boolValue { actions.append("setValue") }
            if selectionAttribute(element) || (role == kAXRadioButtonRole && names.contains(kAXPressAction)) { actions.append("select") }
            if role == kAXScrollBarRole, string(element, kAXOrientationAttribute) == kAXVerticalOrientationValue,
               names.contains(kAXIncrementAction) || names.contains(kAXDecrementAction) { actions.append("scroll") }
        }
        let exportedRole = boundedText(publicAXRoles.contains(role) ? role : "AXUnknown", 100)
        let title = sensitive ? "" : string(element, kAXTitleAttribute)
        let name = boundedText(sensitive ? "" : (title.isEmpty ? string(element, kAXDescriptionAttribute) : title), 4096)
        var complete = !sensitive && !exportedRole.truncated && !name.truncated
        var result: Object = ["ref": ref, "role": exportedRole.text, "name": name.text, "enabled": bool(element, kAXEnabledAttribute), "focused": bool(element, kAXFocusedAttribute), "selected": bool(element, kAXSelectedAttribute) || (!sensitive && role == kAXRadioButtonRole && bool(element, kAXValueAttribute)), "sensitive": sensitive, "actions": actions]
        if let parent = parent { result["parentRef"] = parent }
        if let rect = bounds(element) { result["bounds"] = rect }
        if !sensitive, let value = attr(element, kAXValueAttribute) as? String {
            let exported = boundedText(value, 4096)
            result["value"] = exported.text; complete = complete && !exported.truncated
        }
        if !sensitive, [kAXRadioButtonRole, kAXCheckBoxRole, kAXScrollBarRole].contains(role), let value = attr(element, kAXValueAttribute) as? NSNumber { result["value"] = value.stringValue }
        return NodeRead(value: result, complete: complete)
    }
    func supportedWindowScope(_ element: AXUIElement) -> Bool {
        // The supported scope is a normal document/fixture window, never a
        // dialog/sheet/security prompt attached after discovery or approval.
        return string(element, kAXRoleAttribute) == kAXWindowRole &&
            privacySubrole(element) == kAXStandardWindowSubrole && hasNoSheetChildren(element)
    }
    func hasNoSheetChildren(_ element: AXUIElement) -> Bool {
        // Sheets are AXChildren with AXSheet role, not a separate public attribute.
        // An unavailable/malformed child list or role is not proof of absence.
        guard let children = attr(element, kAXChildrenAttribute) as? [AXUIElement], children.count <= 500 else { return false }
        return children.allSatisfy { child in
            guard let role = attr(child, kAXRoleAttribute) as? String, !role.isEmpty else { return false }
            return role != kAXSheetRole
        }
    }
    func scopedChildren(_ element: AXUIElement) -> [AXUIElement] {
        // Canonical AX child membership includes sheet-role children. Actual
        // AppKit modal coverage remains a native acceptance requirement.
        return elements(element, kAXChildrenAttribute)
    }
    func observe(_ command: Object, _ window: Window) -> Object? {
        guard brian_private_channel_alive() == 1 else { _exit(70) }
        guard liveWindow(window.target) != nil, let rect = bounds(window.element),
              let identity = command["identity"] as? Object else { return nil }
        let started = monotonic(); let observationId = id()
        var nodes: [Object] = []; var refs: [String: Ref] = [:]
        var queue: [(AXUIElement, String?, Int)] = [(window.element, nil, 0)]
        var visited: [AXUIElement] = []; var complete = true; var bytes = 0
        while !queue.isEmpty {
            guard brian_private_channel_alive() == 1 else { _exit(70) }
            if nodes.count >= 500 || monotonic() - started > 300 || bytes > 400_000 { complete = false; break }
            let (element, parent, depth) = queue.removeFirst()
            if visited.contains(where: { CFEqual($0, element) }) { continue }
            visited.append(element)
            let key = id(); let read = node(element, key, parent); let value = read.value
            if !read.complete { complete = false }
            bytes += (try? JSONSerialization.data(withJSONObject: value).count) ?? 10000
            let children = scopedChildren(element)
            nodes.append(value); refs[key] = Ref(element: element, node: value, children: children)
            // Secure/unknown subtree never leaves the helper, even via a child's name.
            if value["sensitive"] as? Bool == true { complete = false; continue }
            if depth >= 16 { if !children.isEmpty { complete = false }; continue }
            if children.count > 500 { complete = false }
            for child in children.prefix(500) { queue.append((child, key, depth + 1)) }
            if queue.count > 1000 { complete = false; break }
        }
        if bytes > 400_000 || monotonic() - started > 300 { complete = false }
        let observation: Object = ["identity": identity, "epoch": command["epoch"]!, "id": observationId, "capturedAt": now(), "monotonicMs": monotonic(), "target": window.target,
                                   "foreground": NSWorkspace.shared.frontmostApplication?.processIdentifier == pid_t(window.target["processId"] as! Int), "bounds": rect, "displayLayoutVersion": layout(), "completeness": complete ? "complete" : "partial", "nodes": nodes]
        frame = nil; frameObservation = ""
        snapshots.removeAll() // One latest observation; no cross-window cached authority.
        guard brian_private_channel_alive() == 1 else { _exit(70) }
        // Recheck after traversal, before any local text can leave the helper.
        // Changed window/sheet scope is a refusal, not a partial approved result.
        guard liveWindow(window.target) != nil, let finalBounds = bounds(window.element), same(rect, finalBounds) else { return nil }
        snapshots[observationId] = Snapshot(observation: observation, refs: refs, monotonic: started)
        return observation
    }
    func fresh(_ action: Object, _ window: Window) -> Snapshot? {
        guard let observationId = action["observationId"] as? String, let snapshot = snapshots[observationId], snapshot.observation["completeness"] as? String == "complete", monotonic() - snapshot.monotonic < 5000,
              let target = snapshot.observation["target"] as? Object, same(target, window.target),
              snapshot.observation["displayLayoutVersion"] as? String == layout(), let previous = snapshot.observation["bounds"] as? Object, let rect = bounds(window.element), same(rect, previous),
              NSWorkspace.shared.frontmostApplication?.processIdentifier == pid_t(window.target["processId"] as! Int),
              let focused = attr(window.application, kAXFocusedWindowAttribute), CFEqual(focused, window.element),
              lastInputAge() >= monotonic() - snapshot.monotonic else { return nil }
        return snapshot
    }
    func sameChildren(_ ref: Ref) -> Bool {
        let current = scopedChildren(ref.element)
        return current.count == ref.children.count && zip(current, ref.children).allSatisfy { CFEqual($0.0, $0.1) }
    }
    func unchanged(_ snapshot: Snapshot, _ window: Window) -> Bool {
        guard snapshot.observation["completeness"] as? String == "complete" else { return false }
        // Whole observed state, including untouched fields and sheet/child membership.
        // A newly truncated value must fail even when its exported prefix is equal.
        return snapshot.refs.values.allSatisfy { ref in
            let current = node(ref.element, ref.node["ref"] as! String, ref.node["parentRef"] as? String)
            return current.complete && same(current.value, ref.node) &&
                reachable(ref.element, in: window.element) && sameChildren(ref)
        }
    }
    func beginApproval(_ payload: Object) -> Bool {
        guard validWirePayload("beginApproval", payload), approvalCommand == nil, let command = payload["command"] as? Object,
              let deadline = wireInteger(command["deadlineAt"]), validCommand(command), authorized(command, payload["leaseId"] as? String ?? ""),
              let action = command["action"] as? Object, let target = action["target"] as? Object,
              let window = liveWindow(target), let snapshot = fresh(action, window), unchanged(snapshot, window) else { return false }
        approvedCommand = nil; approvalCommand = command
        guardLock.lock(); approvalOpen = true
        watchdogDeadline = min(expiresMonotonic, monotonic() + min(30_000, deadline - now()))
        guardLock.unlock()
        return true
    }
    func endApproval(_ payload: Object) -> Bool {
        guardLock.lock(); approvalOpen = false; guardLock.unlock()
        defer { approvalCommand = nil }
        approvedCommand = nil
        guard validWirePayload("endApproval", payload), let approved = wireBool(payload["approved"]),
              let command = payload["command"] as? Object, let pending = approvalCommand, same(command, pending),
              authorized(command, payload["leaseId"] as? String ?? "") else { return false }
        if !approved {
            approvedCommand = nil
            guardLock.lock(); watchdogDeadline = expiresMonotonic; guardLock.unlock()
            return true
        }
        guard let action = command["action"] as? Object, let target = action["target"] as? Object,
              let window = liveWindow(target), let observationId = action["observationId"] as? String,
              let snapshot = snapshots[observationId], snapshot.observation["completeness"] as? String == "complete",
              snapshot.refs.values.allSatisfy({ node($0.element, $0.node["ref"] as! String, $0.node["parentRef"] as? String).complete }),
              restoreApprovedWindow(window), let previous = snapshot.observation["bounds"] as? Object,
              let b = bounds(window.element), same(previous, b), snapshot.observation["displayLayoutVersion"] as? String == layout(),
              NSWorkspace.shared.frontmostApplication?.processIdentifier == pid_t(target["processId"] as! Int),
              let focused = attr(window.application, kAXFocusedWindowAttribute), CFEqual(focused, window.element),
              unchanged(snapshot, window) else { return false }
        // After the locally approved focus restoration, never choose a replacement ref. The exact handles, values,
        // geometry, semantics and (for clicks) PNG must survive the dialog unchanged.
        if action["kind"] as? String == "click" {
            guard let f = frame, safeCanvas(window, snapshot), let (png, _, _) = pixels(window), png.base64EncodedString() == f["data"] as? String else { return false }
        }
        guard brian_private_channel_alive() == 1 else { _exit(70) }
        snapshots[observationId] = Snapshot(observation: snapshot.observation, refs: snapshot.refs, monotonic: monotonic())
        approvedCommand = command
        guardLock.lock(); watchdogDeadline = expiresMonotonic; guardLock.unlock()
        return true
    }
    func execute(_ payload: Object, timing: SourceRequestTiming? = nil) -> Object {
        let command = payload["command"] as? Object ?? [:]
        let commandId = wireString(command["commandId"]) ?? "invalid"
        func result(_ code: String, _ outcome: String = "not_executed", _ observation: Object? = nil) -> Object {
            var receipt: Object = ["commandId": commandId, "outcome": outcome, "code": code]
            if let observation = observation { receipt["observation"] = observation }; return receipt
        }
        guard validWirePayload("execute", payload), approvalCommand == nil, validCommand(command), let deadline = wireInteger(command["deadlineAt"]), authorized(command, payload["leaseId"] as? String ?? ""), let action = command["action"] as? Object, let kind = action["kind"] as? String, let target = action["target"] as? Object else { return result("denied") }
        // No surviving release owner across SIGKILL/_exit; approval or flags cannot enable input.
        if kind == "click" { return result("unsupported") }
        commandDeadline = monotonic() + deadline - now()
        guardLock.lock(); watchdogDeadline = min(expiresMonotonic, commandDeadline); guardLock.unlock()
        defer {
            commandDeadline = Double.infinity
            guardLock.lock(); watchdogDeadline = expiresMonotonic; guardLock.unlock()
        }
        let serialized = (try? JSONSerialization.data(withJSONObject: command, options: [.sortedKeys])) ?? Data()
        let fingerprint = Data(SHA256.hash(data: serialized))
        if let old = journal[commandId] { return seen[commandId] == fingerprint ? old : result("denied") }
        guard journal.count < 512 else { return result("denied") }
        seen[commandId] = fingerprint
        // Mark BEFORE dispatch. No repeat, even after a partially failed AX call.
        journal[commandId] = result("helper_error", "execution_unknown")
        func finish(_ receipt: Object) -> Object {
            var metadata = receipt; metadata.removeValue(forKey: "observation")
            journal[commandId] = metadata; return receipt
        }
        guard let window = liveWindow(target) else { return finish(result("wrong_target")) }
        if kind == "observe" {
            guard let observation = observe(command, window), authorized(command, payload["leaseId"] as? String ?? "") else { return finish(result("expired")) }
            return finish(result("ok", "executed", observation))
        }
        if kind != "capture" {
            guard let approved = approvedCommand, same(approved, command) else { return finish(result("approval_required")) }
            approvedCommand = nil
        }
        guard let completeSnapshot = fresh(action, window), unchanged(completeSnapshot, window) else { return finish(result("stale_observation")) }
        if kind == "capture" { return finish(capture(command, action, window)) }
        // Unsupported action classes never fall back to unguarded input.
        if kind == "key" || kind == "focus" { return finish(result("unsupported")) }
        guard wireBool(grant?["allowControl"]) == true else { return finish(result("denied")) }
        guard let snapshot = fresh(action, window), let key = action["ref"] as? String, let ref = snapshot.refs[key],
              let allowed = ref.node["actions"] as? [String], allowed.contains(kind), ref.node["sensitive"] as? Bool == false else { return finish(result("stale_observation")) }
        // TextEdit is document editing only, never menus, toolbar, dialogs or links.
        if target["appId"] as? String == "com.apple.TextEdit" && (kind != "setValue" || ref.node["role"] as? String != kAXTextAreaRole || !hasNoSheetChildren(window.element) || completeSnapshot.refs.values.contains(where: { $0.node["role"] as? String == kAXSheetRole })) { return finish(result("unsupported")) }
        // Re-read security/semantics/geometry, not merely a cached AX handle.
        let current = node(ref.element, key, ref.node["parentRef"] as? String)
        guard current.complete, same(current.value, ref.node), reachable(ref.element, in: window.element),
              unchanged(snapshot, window),
              fresh(action, window) != nil,
              authorized(command, payload["leaseId"] as? String ?? "") else { return finish(result("stale_observation")) }
        var error: AXError
        switch kind {
        case "invoke":
            guard brian_private_channel_alive() == 1 else { _exit(70) }
            timing?.beginAPI(.api_invoke)
            error = AXUIElementPerformAction(ref.element, kAXPressAction as CFString)
            timing?.endAPI(returned: error == .success)
        case "select":
            if selectionAttribute(ref.element) {
                guard brian_private_channel_alive() == 1 else { _exit(70) }
                timing?.beginAPI(.api_select)
                error = AXUIElementSetAttributeValue(ref.element, kAXSelectedAttribute as CFString, kCFBooleanTrue)
                timing?.endAPI(returned: error == .success)
            } else if current.value["role"] as? String == kAXRadioButtonRole, actionNames(ref.element).contains(kAXPressAction) {
                // Radio selection is idempotent, unlike a checkbox toggle.
                guard brian_private_channel_alive() == 1 else { _exit(70) }
                timing?.beginAPI(.api_select)
                error = AXUIElementPerformAction(ref.element, kAXPressAction as CFString)
                timing?.endAPI(returned: error == .success)
            } else { return finish(result("unsupported")) }
        case "scroll":
            // One native semantic increment/decrement, NOT a pixel-wheel emulation.
            guard let delta = wireInteger(action["deltaY"], min: -600, max: 600), delta != 0 else { return finish(result("denied")) }
            let operation = delta > 0 ? kAXIncrementAction : kAXDecrementAction
            guard actionNames(ref.element).contains(operation) else { return finish(result("unsupported")) }
            guard brian_private_channel_alive() == 1 else { _exit(70) }
            timing?.beginAPI(.api_scroll)
            error = AXUIElementPerformAction(ref.element, operation as CFString)
            timing?.endAPI(returned: error == .success)
        case "setValue":
            guard let text = action["text"] as? String, text.utf16.count <= 4096, !text.contains("\u{0000}") else { return finish(result("denied")) }
            guard brian_private_channel_alive() == 1 else { _exit(70) }
            timing?.beginAPI(.api_set_value)
            error = AXUIElementSetAttributeValue(ref.element, kAXValueAttribute as CFString, text as CFString)
            timing?.endAPI(returned: error == .success)
        default: return finish(result("unsupported"))
        }
        snapshots.removeAll()
        // AX timeout/error may be after delivery; never report "not executed" or retry.
        guard error == .success else { return finish(result("helper_error", "execution_unknown")) }
        let post = authorized(command, payload["leaseId"] as? String ?? "") ? observe(command, window) : nil
        return finish(result("ok", "executed", post))
    }
    func rect(_ value: Object) -> CGRect {
        CGRect(x: value["x"] as? Double ?? 0, y: value["y"] as? Double ?? 0,
               width: value["width"] as? Double ?? 0, height: value["height"] as? Double ?? 0)
    }
    // Only the isolated, borderless, immutable-content fixture canvas is a pixel-safe
    // cohort. AX completeness alone never proves arbitrary application pixels safe.
    func safeCanvas(_ window: Window, _ snapshot: Snapshot) -> Bool {
        guard liveWindow(window.target) != nil, window.target["appId"] as? String == cohort,
              string(window.element, kAXTitleAttribute) == canvasTitle,
              string(window.element, kAXIdentifierAttribute) == "brian-safe-canvas-v1",
              hasNoSheetChildren(window.element),
              snapshot.observation["completeness"] as? String == "complete",
              snapshot.refs.values.allSatisfy({ $0.node["sensitive"] as? Bool == false && $0.node["role"] as? String != kAXSheetRole && ($0.node["actions"] as? [String] ?? []).isEmpty }) else { return false }
        return unchanged(snapshot, window)
    }
    // CG window order verifies no overlaid window; SCK capture itself excludes other
    // windows. Refuse ambiguity, spanning/rotated displays, sheets and offscreen areas.
    func visibleWindowID(_ window: Window) -> CGWindowID? {
        guard let b = bounds(window.element) else { return nil }; let r = rect(b)
        var displays = [CGDirectDisplayID](repeating: 0, count: 32); var count: UInt32 = 0
        guard CGGetActiveDisplayList(32, &displays, &count) == .success,
              displays.prefix(Int(count)).filter({ CGDisplayBounds($0).contains(r) && CGDisplayRotation($0) == 0 }).count == 1,
              let entries = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [Object] else { return nil }
        for entry in entries {
            guard let dictionary = entry[kCGWindowBounds as String] as? Object,
                  let area = CGRect(dictionaryRepresentation: dictionary as CFDictionary) else { return nil }
            if entry[kCGWindowOwnerPID as String] as? Int == window.target["processId"] as? Int,
               area == r, entry[kCGWindowName as String] as? String == canvasTitle,
               let number = entry[kCGWindowNumber as String] as? UInt32 { return number }
            if area.intersects(r), (entry[kCGWindowAlpha as String] as? Double ?? 1) > 0 { return nil }
        }
        return nil
    }
    func pixels(_ window: Window) -> (Data, Int, Int)? {
        guard brian_private_channel_alive() == 1 else { _exit(70) }
        guard liveWindow(window.target) != nil, CGPreflightScreenCaptureAccess(), let number = visibleWindowID(window) else { return nil }
        let done = DispatchSemaphore(value: 0)
        var output: (Data, Int, Int)?
        SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { content, error in
            guard error == nil, let selected = content?.windows.first(where: { $0.windowID == number }),
                  selected.owningApplication?.processID == pid_t(window.target["processId"] as! Int) else { done.signal(); return }
            let filter = SCContentFilter(desktopIndependentWindow: selected)
            let configuration = SCStreamConfiguration()
            // 1 pixel per input point, bounded; no mixed-DPI scaling assumption.
            configuration.width = Int(selected.frame.width.rounded())
            configuration.height = Int(selected.frame.height.rounded())
            guard self.liveWindow(window.target) != nil, configuration.width > 0, configuration.height > 0, configuration.width <= 1024, configuration.height <= 1024 else { done.signal(); return }
            configuration.showsCursor = false
            configuration.ignoreShadowsSingleWindow = true
            guard brian_private_channel_alive() == 1 else { done.signal(); return }
            SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) { image, error in
                if error == nil, let image = image,
                   let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]), png.count <= 2_000_000 {
                    output = (png, image.width, image.height)
                }
                done.signal()
            }
        }
        // Watchdog/parent kills this process on deadline even if SCK hangs.
        done.wait()
        guard liveWindow(window.target) != nil, visibleWindowID(window) == number else { return nil }
        guard brian_private_channel_alive() == 1 else { _exit(70) }
        return output
    }
    func capture(_ command: Object, _ action: Object, _ window: Window) -> Object {
        func denied(_ code: String) -> Object { ["commandId": command["commandId"]!, "outcome": "not_executed", "code": code] }
        guard wireBool(grant?["allowCapture"]) == true, CGPreflightScreenCaptureAccess() else { return denied("denied") }
        guard monotonic() - lastCapture >= 1000, let snapshot = fresh(action, window), safeCanvas(window, snapshot) else { return denied("stale_observation") }
        lastCapture = monotonic()
        guard let (png, width, height) = pixels(window), fresh(action, window) != nil, safeCanvas(window, snapshot), authorized(command, lease) else { return denied("stale_observation") }
        let value: Object = ["id": id(), "mimeType": "image/png", "data": png.base64EncodedString(), "width": width, "height": height,
                             "bounds": snapshot.observation["bounds"]!, "displayLayoutVersion": snapshot.observation["displayLayoutVersion"]!]
        frame = value; frameObservation = action["observationId"] as! String
        var observation = snapshot.observation; observation["frame"] = value
        return ["commandId": command["commandId"]!, "outcome": "executed", "code": "ok", "observation": observation]
    }
    func reachable(_ target: AXUIElement, in window: AXUIElement) -> Bool {
        var current = target
        for _ in 0..<18 {
            if CFEqual(current, window) { return true }
            guard let parent = attr(current, kAXParentAttribute), CFGetTypeID(parent) == AXUIElementGetTypeID() else { return false }
            current = parent as! AXUIElement
        }
        return false
    }
}

func readExactly(_ length: Int) -> Data? {
    var data = Data()
    while data.count < length {
        let chunk = FileHandle.standardInput.readData(ofLength: length - data.count)
        if chunk.isEmpty { return nil }; data.append(chunk)
    }
    return data
}
guard let trust = ProcessTrust() else { _exit(77) }
// Probe-only entry point: no operational backend or event-tap initialization.
let sourceClock = SourceClock()
DispatchQueue.global(qos: .userInitiated).async {
while let header = readExactly(4) {
    let length = header.reduce(0) { ($0 << 8) | Int($1) }
    guard length > 0, length <= maxBytes, let data = readExactly(length), let request = (try? JSONSerialization.jsonObject(with: data)) as? Object,
          validWireRequest(request) else { exit(64) }
    guard trust.parentValid() else { _exit(77) }
    guard brian_private_channel_alive() == 1 else { _exit(70) }
    guard let response = probeOnlyResponse(request, clock: sourceClock) else { exit(64) }
    guard brian_private_channel_alive() == 1 else { _exit(70) }
    guard let output = try? JSONSerialization.data(withJSONObject: response), output.count <= maxBytes else { exit(65) }
    var size = UInt32(output.count).bigEndian
    FileHandle.standardOutput.write(Data(bytes: &size, count: 4))
    FileHandle.standardOutput.write(output)
}
exit(0)
}
RunLoop.main.run()
