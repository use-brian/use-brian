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
// AppleScript, network or permission prompts. Observation only; no capture/input.
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
// BEGIN FOUNDATION VISUAL PINS
// Copy only the signed helper's embedded anchor, never target-supplied pins.
// C validates the record; independently bound count and hash material here.
func visualFixtureExpectedCDHashes() -> [Data] {
    var bytes = [UInt8](repeating: 0, count: 40)
    let count = bytes.withUnsafeMutableBufferPointer {
        brian_visual_fixture_hashes_copy($0.baseAddress, $0.count)
    }
    guard count == 1 || count == 2 else { return [] }
    let hashes = (0..<Int(count)).map { Data(bytes[($0 * 20)..<(($0 + 1) * 20)]) }
    guard hashes.allSatisfy({ $0.contains(where: { $0 != 0 }) }), Set(hashes).count == hashes.count,
          bytes.dropFirst(Int(count) * 20).allSatisfy({ $0 == 0 }) else { return [] }
    return hashes
}
// END FOUNDATION VISUAL PINS
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
    func visualFixturePinReady() -> Bool {
        let pins = visualFixtureExpectedCDHashes()
        return !pins.isEmpty && pins.count <= 2 && pins.allSatisfy { $0.count == 20 }
    }
    func visualFixtureValid(_ identity: ProcessIdentity) -> Bool {
        guard visualFixturePinReady(), parentValid(), identity.executable == fixtureExecutable,
              ProcessIdentity.read(identity.pid) == identity else { return false }
        let hashes = visualFixtureExpectedCDHashes().map { pin in
            "cdhash H\"" + pin.map { String(format: "%02x", $0) }.joined() + "\""
        }.joined(separator: " or ")
        // The requirement is checked against the running guest AND static seal,
        // with process birth rechecked by signedProcess. Same-team substitutions
        // do not satisfy the exact reviewed renderer hash requirement.
        return signedProcess(identity, teamRequirement(cohort) + " and (" + hashes + ")") == team
    }
    func target(_ pid: pid_t, diagnostics: DiscoveryDiagnostics? = nil) -> (ProcessIdentity, String)? {
        // Kernel path is a refusal-only prefilter. Do not revalidate the entire
        // parent seal for every unrelated running app. Candidate admission still
        // requires fresh parent trust and both dynamic/static target signatures.
        guard let identity = ProcessIdentity.read(pid), pid != getpid(),
              identity.executable == "/System/Applications/TextEdit.app/Contents/MacOS/TextEdit" || identity.executable == fixtureExecutable else {
            diagnostics?.increment("unsupportedProcess"); return nil
        }
        guard parentValid() else { diagnostics?.increment("parentRejected"); return nil }
        if identity.executable == "/System/Applications/TextEdit.app/Contents/MacOS/TextEdit",
           signedProcess(identity, "anchor apple and identifier \"com.apple.TextEdit\"") != nil {
            return (identity, "com.apple.TextEdit")
        }
        if identity.executable == fixtureExecutable,
           signedProcess(identity, teamRequirement(cohort)) == team { return (identity, cohort) }
        diagnostics?.increment("signatureRejected")
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
    let keys = ["deploymentId", "userId", "workspaceId", "deviceId", "sessionId", "conversationId"] +
        (identity["profileId"] == nil ? ["taskId"] : ["profileId"])
    return Set(identity.keys) == Set(keys) && keys.allSatisfy { wireString(identity[$0]) != nil }
}
func validWireTarget(_ target: Object) -> Bool {
    let identifiers = ["appId", "processInstanceId", "windowId", "windowInstanceId"]
    return Set(target.keys) == Set(identifiers + ["processId"]) && identifiers.allSatisfy { wireString(target[$0]) != nil } &&
        // pid_t is signed 32-bit on macOS. Never trap/narrow a large JSON number.
        wireInteger(target["processId"], min: 1, max: Double(Int32.max)) != nil
}
func validWireGrant(_ candidate: Object) -> Bool {
    let profile = (candidate["identity"] as? Object)?["profileId"] != nil
    guard Set(candidate.keys) == Set(["protocol", "identity", "grantId", "epoch", "expiresAt", "targets", "allowControl", "allowCapture", "requester"] + (profile ? ["purpose"] : ["goal"])),
          candidate["protocol"] as? String == proto, let identity = candidate["identity"] as? Object, validWireIdentity(identity),
          wireString(candidate["grantId"]) != nil, wireInteger(candidate["epoch"]) != nil, wireInteger(candidate["expiresAt"]) != nil,
          wireBool(candidate["allowControl"]) != nil, wireBool(candidate["allowCapture"]) != nil,
          wireString(candidate["requester"], max: 200) != nil,
          (profile ? candidate["purpose"] as? String == "chat-tools" : wireString(candidate["goal"], max: 2000) != nil),
          let targets = candidate["targets"] as? [Object], !targets.isEmpty, targets.count <= 8, targets.allSatisfy(validWireTarget) else { return false }
    return true
}
// Only the goal restriction differs for chat profiles; renderer/privacy/approval
// checks remain mandatory at the capture and dispatch sites.
func publicShapesGrant(_ grant: Object?) -> Bool {
    guard let grant = grant, validWireGrant(grant), let identity = grant["identity"] as? Object else { return false }
    return identity["profileId"] != nil || grant["goal"] as? String == "Activate the outlined triangle; finish when Result is Triangle."
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
        "visualInvoke": ["kind", "target", "observationId", "frameId", "x", "y"],
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
    case "click", "visualInvoke":
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
        let visual = ((payload["command"] as? Object)?["action"] as? Object)?["kind"] as? String == "visualInvoke"
        let keys = method == "endApproval" ? ["command", "leaseId", "approved"] + (visual ? ["bindingId"] : []) : ["command", "leaseId"]
        if method == "endApproval" && visual && wireString(payload["bindingId"]) == nil { return false }
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
// Fresh-helper readiness is metadata-only. Only explicit local discovery creates
// the backend; authority still requires an exact grant and per-action approval.
let probeOnlyLimitation = "Select discovery to initialize AX and safe-fixture-canvas capture readiness; input disabled."
// A visual backend cannot return legacy true or an arbitrary dictionary.
struct VisualApproval {
    let bindingId: String
    let commandId: String
    let frameId: String
    let target: Object
    let observationId: String
    let ref: String
    var wire: Object {
        ["bindingId": bindingId, "commandId": commandId, "frameId": frameId,
         "action": ["kind": "invoke", "target": target, "observationId": observationId, "ref": ref]]
    }
}
protocol ObservationBackend: AnyObject {
    func capabilities() -> Object
    func listTargets() -> [Object]
    func discoveryDiagnostics() -> Object?
    func start(_ payload: Object) -> Bool
    func beginApproval(_ payload: Object) -> Bool
    func beginVisualApproval(_ payload: Object) -> VisualApproval?
    func endApproval(_ payload: Object) -> Bool
    func execute(_ payload: Object, timing: SourceRequestTiming?) -> Object
    func handoffClick(_ payload: Object, requestID: String) -> Object?
}
extension ObservationBackend {
    func discoveryDiagnostics() -> Object? { nil }
    func beginVisualApproval(_ payload: Object) -> VisualApproval? { nil }
    // Non-native/metadata backends have no private descriptor producer.
    func handoffClick(_ payload: Object, requestID: String) -> Object? { nil }
}
func observationGrant(_ payload: Object) -> Bool {
    guard validWirePayload("start", payload), let grant = payload["grant"] as? Object else { return false }
    return wireBool(grant["allowControl"]) == false && wireBool(grant["allowCapture"]) == false
}
// Capture requires both explicit permissions; a read-only grant cannot carry it.
func captureAuthority(_ grant: Object?) -> Bool {
    guard let grant = grant, validWireGrant(grant) else { return false }
    return wireBool(grant["allowControl"]) == true && wireBool(grant["allowCapture"]) == true
}
func supportedGrant(_ payload: Object) -> Bool {
    guard validWirePayload("start", payload), let grant = payload["grant"] as? Object else { return false }
    return wireBool(grant["allowCapture"]) == false || captureAuthority(grant)
}
func semanticKind(_ kind: String) -> Bool { ["invoke", "setValue", "select", "scroll"].contains(kind) }
func supportedExecution(_ command: Object) -> Bool {
    guard let action = command["action"] as? Object, let kind = action["kind"] as? String else { return false }
    return kind == "observe" || kind == "capture" || kind == "visualInvoke" || semanticKind(kind)
}
// Approval binds every command field (identity, target instances, epoch, ref,
// observation, deadline and text), never a label or a subset of the action.
func exactSemanticCommand(_ command: Object, _ approved: Object) -> Bool {
    guard validWireCommand(command), validWireCommand(approved),
          let action = command["action"] as? Object, let kind = action["kind"] as? String,
          (semanticKind(kind) || kind == "visualInvoke") else { return false }
    return NSDictionary(dictionary: command).isEqual(to: approved)
}
// Explicit local pixel approval is not semantic/ref approval. Whole-object
// equality binds every field, including frame, coordinates, deadline and identity.
func exactLocalCommand(_ command: Object, _ approved: Object) -> Bool {
    guard validWireCommand(command), validWireCommand(approved),
          let action = command["action"] as? Object,
          let kind = action["kind"] as? String, ["capture", "click"].contains(kind) else { return false }
    return NSDictionary(dictionary: command).isEqual(to: approved)
}
// Pure policy used by live AX reads and portable tests. Native attributes are
// queried only for public nodes under an explicitly control-authorized grant.
func semanticNodeActions(control: Bool, appId: String, role: String, subrole: String?,
                         enabled: Bool, names: [String], writableValue: Bool,
                         writableSelection: Bool, vertical: Bool) -> [String] {
    guard control, enabled, publicAXClassification(role, subrole) else { return [] }
    if appId == "com.apple.TextEdit" {
        return role == "AXTextArea" && writableValue ? ["setValue"] : []
    }
    guard appId == "com.usebrian.NativeComputerFixture" else { return [] }
    var actions: [String] = []
    // Window chrome is not a fixture form action.
    if ["AXButton", "AXCheckBox", "AXPopUpButton", "AXMenuItem"].contains(role),
       subrole == "", names.contains("AXPress") { actions.append("invoke") }
    if ["AXTextField", "AXTextArea"].contains(role), writableValue { actions.append("setValue") }
    if (["AXRow", "AXRadioButton"].contains(role) && writableSelection) ||
        (role == "AXRadioButton" && names.contains("AXPress")) { actions.append("select") }
    if role == "AXScrollBar", vertical, names.contains("AXIncrement") || names.contains("AXDecrement") { actions.append("scroll") }
    return actions
}
final class ObservationDispatcher {
    private var backend: ObservationBackend?
    private let makeBackend: () -> ObservationBackend
    init(makeBackend: @escaping () -> ObservationBackend) { self.makeBackend = makeBackend }
    func response(_ request: Object, clock: SourceClock) -> Object? {
        guard validWireRequest(request), let requestId = request["id"] as? String,
              let method = request["method"] as? String, let payload = request["payload"] as? Object else { return nil }
        let timing = SourceRequestTiming(request: request, clock: clock)
        let result: Any
        switch method {
        case "capabilities":
            result = backend?.capabilities() ?? ["protocol": proto, "platform": "darwin", "axRead": false,
                "semanticActions": false, "windowCapture": false, "input": false,
                "accessibilityPermission": "unknown", "capturePermission": "unknown",
                "limitations": [probeOnlyLimitation]] as Object
        case "listTargets":
            if backend == nil { backend = makeBackend() }
            result = backend!.listTargets()
        case "start": result = supportedGrant(payload) ? (backend?.start(payload) ?? false) : false
        case "beginApproval":
            if ((payload["command"] as? Object)?["action"] as? Object)?["kind"] as? String == "visualInvoke" {
                result = backend?.beginVisualApproval(payload)?.wire as Any? ?? false
            } else { result = backend?.beginApproval(payload) ?? false }
        case "endApproval": result = backend?.endApproval(payload) ?? false
        case "execute":
            guard let command = payload["command"] as? Object, let commandId = command["commandId"] as? String else { return nil }
            if let action = command["action"] as? Object, action["kind"] as? String == "click",
               let handoff = backend?.handoffClick(payload, requestID: requestId) {
                result = handoff
            } else if let backend = backend, supportedExecution(command) {
                result = backend.execute(payload, timing: timing)
            } else {
                result = ["commandId": commandId, "outcome": "not_executed", "code": "denied"]
            }
        default: return nil
        }
        var response = privateResponse(requestId: requestId, method: method, result: result, timing: timing)
        if method == "listTargets", let diagnostics = backend?.discoveryDiagnostics() {
            response["discoveryDiagnostics"] = diagnostics
        }
        return response
    }
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
// Unsupported children are not equivalent to an empty declared child list.
// Only reviewed public leaf roles, independently omitting AXChildren from a
// successful attribute-name enumeration, may use the absent-leaf case.
let publicAXLeafRoles: Set<String> = ["AXButton", "AXCheckBox", "AXRadioButton", "AXTextField", "AXTextArea", "AXStaticText"]
func publicLeafWithoutChildren(_ role: String?, _ subrole: String?, _ attributeNames: [String]?) -> Bool {
    guard let role = role, publicAXLeafRoles.contains(role), publicAXClassification(role, subrole),
          let names = attributeNames, !names.contains("AXChildren") else { return false }
    return true
}
enum ChildrenRead<Element> {
    case declared([Element]), absentLeaf, failed, malformed
    var elements: [Element]? {
        switch self {
        case .declared(let children): return children
        case .absentLeaf: return []
        case .failed, .malformed: return nil
        }
    }
}
func sameChildrenRead<Element>(_ previous: ChildrenRead<Element>, _ current: ChildrenRead<Element>,
                               equal: (Element, Element) -> Bool) -> Bool {
    switch (previous, current) {
    case (.absentLeaf, .absentLeaf): return true
    case (.declared(let before), .declared(let after)):
        return before.count == after.count && zip(before, after).allSatisfy { equal($0.0, $0.1) }
    default: return false // Even declared-empty -> absent-leaf is a scope change.
    }
}
// BEGIN FOUNDATION SEMANTIC SAFETY
// Serialized Broker-lane state. Tests extract this exact production policy.
// These are admission/revalidation fences, NOT an atomic AX dispatch primitive.
struct SemanticSafety {
    private struct Binding { let fingerprint: Data; let deadline: Double }
    private var bindings: [String: Binding] = [:]
    private(set) var uncertain = false
    mutating func admit(id: String, fingerprint: Data, wallDeadline: Double,
                        wall: Double, monotonic: Double) -> Double? {
        guard !uncertain else { return nil }
        if let old = bindings[id] {
            return old.fingerprint == fingerprint ? old.deadline : nil
        }
        guard bindings.count < 512 else { return nil }
        let deadline = monotonic + min(30_000, wallDeadline - wall)
        bindings[id] = Binding(fingerprint: fingerprint, deadline: deadline)
        return deadline // Retained even if later approval validation/consent fails.
    }
    func deadline(id: String, fingerprint: Data) -> Double? {
        guard let old = bindings[id], old.fingerprint == fingerprint else { return nil }
        return old.deadline
    }
    static func cachedReceiptMatches(fingerprint: Data, recorded: Data?, lease: String?, expectedLease: String,
                                     channelAlive: Bool) -> Bool {
        return channelAlive && !expectedLease.isEmpty && lease == expectedLease && recorded == fingerprint
    }
    mutating func markUncertain() { uncertain = true }
    func permitsEffect(monotonic: Double, wall: Double, commandDeadline: Double,
                       grantDeadline: Double, wallDeadline: Double, wallExpiry: Double,
                       channelAlive: Bool, monitorLive: Bool) -> Bool {
        return !uncertain && channelAlive && monitorLive &&
            monotonic < commandDeadline && monotonic < grantDeadline &&
            wall < wallDeadline && wall < wallExpiry
    }
}
// Passive pointer motion has no AX effect. Meaningful input remains a global
// revocation signal, with closed diagnostic categories and no event payload.
enum SemanticInputKind { case pointer, key, button, scroll, drag, modifier, unknown }
enum SemanticInputPolicy {
    static func exitCode(active: Bool, approving: Bool, parentTarget: Bool,
                         kind: SemanticInputKind) -> Int32? {
        guard active else { return nil }
        if kind == .pointer || (approving && parentTarget) { return nil }
        switch kind {
        case .pointer: return nil
        case .key: return 80
        case .button: return 81
        case .scroll: return 82
        case .drag: return 83
        case .modifier: return 84
        case .unknown: return 73
        }
    }
}
// END FOUNDATION SEMANTIC SAFETY
// END FOUNDATION WIRE VALIDATION
// BEGIN FOUNDATION VISUAL POLICY
// Closed visual policy; extracted verbatim on Foundation-only hosts.
enum VisualPolicy {
    static let title = "Brian Public Shapes v1"
    static let identifier = "brian-public-shapes-v1"
    static let goal = "Activate the outlined triangle; finish when Result is Triangle."
    enum AttributeRead { case value(Any), absent, failed }
    static func contentAttributes(_ node: Object, read: (String) -> AttributeRead) -> Bool {
        // Optional alternate content must be empty or agree with required
        // exported content. Missing required content still fails cohort().
        for name in ["AXTitle", "AXDescription", "AXHelp", "AXValue", "AXMinimized", "AXModal"] {
            switch read(name) {
            case .absent: continue
            case .failed: return false
            case .value(let value):
                if ["AXMinimized", "AXModal"].contains(name) {
                    guard value as? Bool == false else { return false }
                } else {
                    guard let text = value as? String else { return false }
                    let expected = name == "AXValue" ? (node["value"] as? String ?? "") :
                        (name == "AXHelp" ? "" : node["name"] as? String ?? "")
                    guard text.isEmpty || text == expected else { return false }
                }
            }
        }
        return true
    }
    static func point(x: Double, y: Double, width: Double, height: Double, bounds: Object) -> (Double, Double)? {
        guard let bx = wireNumber(bounds["x"]), let by = wireNumber(bounds["y"]),
              let bw = wireNumber(bounds["width"]), let bh = wireNumber(bounds["height"]),
              [x, y, width, height, bx, by, bw, bh].allSatisfy({ $0.isFinite }),
              width > 0, height > 0, width <= 1024, height <= 1024, bw > 0, bh > 0,
              x >= 0, y >= 0, x < width, y < height else { return nil }
        let px = bx + x * bw / width, py = by + y * bh / height
        return px.isFinite && py.isFinite ? (px, py) : nil
    }
    static func contains(_ b: Object, _ point: (Double, Double)) -> Bool {
        guard let x = wireNumber(b["x"]), let y = wireNumber(b["y"]),
              let w = wireNumber(b["width"]), let h = wireNumber(b["height"]), w > 0, h > 0 else { return false }
        return point.0 > x && point.1 > y && point.0 < x + w && point.1 < y + h
    }
    static func alive(capture: Double, observation: Double, current: Double) -> Bool {
        return [capture, observation, current].allSatisfy { $0.isFinite } &&
            current >= capture && current >= observation && current - capture < 5_000 && current - observation < 5_000
    }
    static func cohort(_ nodes: [Object], bounds: Object) -> Bool {
        guard nodes.count == 6, let x = wireNumber(bounds["x"]), let y = wireNumber(bounds["y"]),
              wireNumber(bounds["width"]) == 480, wireNumber(bounds["height"]) == 240 else { return false }
        let ids = [identifier, "public-shapes-content-v1", "slot-1", "slot-2", "slot-3", "public-shapes-result-v1"]
        let roles = ["AXWindow", "AXGroup", "AXButton", "AXButton", "AXButton", "AXStaticText"]
        let names = [title, "Public shapes", "Option 1", "Option 2", "Option 3", "Result"]
        let boxes: [[Double]] = [[0,0,480,240], [0,0,480,240], [30,60,120,100], [180,60,120,100], [330,60,120,100], [30,190,420,24]]
        for i in nodes.indices {
            let n = nodes[i]
            guard n["identifier"] as? String == ids[i], n["role"] as? String == roles[i],
                  n["subrole"] as? String == (i == 0 ? "AXStandardWindow" : ""), n["name"] as? String == names[i],
                  n["sensitive"] as? Bool == false, let b = n["bounds"] as? Object,
                  wireNumber(b["x"]) == x + boxes[i][0], wireNumber(b["y"]) == y + boxes[i][1],
                  wireNumber(b["width"]) == boxes[i][2], wireNumber(b["height"]) == boxes[i][3],
                  n["parent"] as? Int == (i == 0 ? -1 : (i == 1 ? 0 : 1)),
                  let actions = n["actions"] as? [String], actions == (i >= 2 && i <= 4 ? ["invoke"] : []) else { return false }
            if i >= 2 && i <= 4 && n["enabled"] as? Bool != true { return false }
            if i == 5 {
                guard ["None", "Triangle", "Circle", "Square"].contains(n["value"] as? String ?? "") else { return false }
            } else if !(n["value"] as? String ?? "").isEmpty { return false }
        }
        return true
    }
}
struct VisualAttempt {
    private(set) var captureCommand: Data?
    private(set) var command: Data?
    private(set) var terminal = false
    mutating func reserveCapture(_ fingerprint: Data) -> Bool {
        guard !terminal, captureCommand == nil else { return false }
        captureCommand = fingerprint; return true
    }
    mutating func bind(_ fingerprint: Data) -> Bool {
        guard !terminal, captureCommand != nil, command == nil else { return false }
        command = fingerprint; return true
    }
    mutating func terminate() { terminal = true }
}
// END FOUNDATION VISUAL POLICY

func monotonic() -> Double { ProcessInfo.processInfo.systemUptime * 1000 }
func id() -> String { UUID().uuidString }
func same(_ a: Object, _ b: Object) -> Bool { NSDictionary(dictionary: a).isEqual(to: b) }
// Closed counters only. No attribute values, identities, paths or titles.
final class DiscoveryDiagnostics {
    private var counts = Dictionary(uniqueKeysWithValues: ["processes", "fenceRejected", "unsupportedProcess", "parentRejected", "signatureRejected", "admitted", "windowListRejected", "boundsRejected", "scopeRejected", "fenceChanged", "targets", "axCannotComplete", "axApiDisabled", "axInvalidElement", "axOtherError"].map { ($0, 0) })
    func increment(_ key: String, by amount: Int = 1) {
        guard let value = counts[key] else { return }
        counts[key] = min(65535, value + max(0, amount))
    }
    func record(_ error: AXError) {
        guard error != .success else { return }
        switch error {
        case .cannotComplete: increment("axCannotComplete")
        case .apiDisabled: increment("axApiDisabled")
        case .invalidUIElement: increment("axInvalidElement")
        default: increment("axOtherError")
        }
    }
    var wire: Object { var result = counts as Object; result["version"] = 1; return result }
}
func attr(_ element: AXUIElement, _ name: String, diagnostics: DiscoveryDiagnostics? = nil) -> CFTypeRef? {
    var result: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, name as CFString, &result)
    diagnostics?.record(error)
    return error == .success ? result : nil
}
func elements(_ element: AXUIElement, _ name: String) -> [AXUIElement] { attr(element, name) as? [AXUIElement] ?? [] }
func readChildren(_ element: AXUIElement) -> ChildrenRead<AXUIElement> {
    var value: CFTypeRef?
    switch AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value) {
    case .success:
        guard let value = value, CFGetTypeID(value) == CFArrayGetTypeID(),
              let children = value as? [AnyObject],
              children.allSatisfy({ CFGetTypeID($0) == AXUIElementGetTypeID() }) else { return .malformed }
        return .declared(children.map { $0 as! AXUIElement })
    case .attributeUnsupported:
        var attributes: CFArray?
        guard AXUIElementCopyAttributeNames(element, &attributes) == .success else { return .failed }
        guard let names = attributes as? [String] else { return .malformed }
        guard publicLeafWithoutChildren(attr(element, kAXRoleAttribute) as? String,
                                        privacySubrole(element), names) else { return .failed }
        return .absentLeaf
    default: return .failed // Includes noValue, timeout, invalid element and disabled API.
    }
}
// Internal security comparisons always use the full AX string, never a prefix.
func string(_ element: AXUIElement, _ name: String) -> String { attr(element, name) as? String ?? "" }
func privacySubrole(_ element: AXUIElement, diagnostics: DiscoveryDiagnostics? = nil) -> String? {
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, kAXSubroleAttribute as CFString, &value)
    diagnostics?.record(error)
    switch error {
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
func bounds(_ element: AXUIElement, diagnostics: DiscoveryDiagnostics? = nil) -> Object? {
    guard let p = attr(element, kAXPositionAttribute, diagnostics: diagnostics), let s = attr(element, kAXSizeAttribute, diagnostics: diagnostics), CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero; var size = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size), point.x.isFinite, point.y.isFinite, size.width > 0, size.height > 0, size.width <= 32768, size.height <= 32768 else { return nil }
    return ["x": point.x, "y": point.y, "width": size.width, "height": size.height]
}
func layout() -> String {
    let description = DispatchQueue.main.sync { NSScreen.screens.map { "\($0.frame):\($0.backingScaleFactor)" }.sorted().joined(separator: "|") }
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
    let epochFence: ProcessEpochFence
}
struct Ref {
    let element: AXUIElement
    let node: Object
    let children: ChildrenRead<AXUIElement>
}
struct Snapshot {
    let observation: Object
    let refs: [String: Ref]
    let monotonic: Double
    var inputMonotonic: Double? = nil // Local dialog input checkpoint, never observation age.
}
private struct VisualBinding {
    let id: String
    let command: Object
    let lease: String
    let action: Object
    let frame: Object
    let captureMonotonic: Double
    let observationMonotonic: Double
    let element: AXUIElement
    let window: AXUIElement
    let identity: ProcessIdentity
    let point: (Double, Double)
    var approved = false
}
final class Broker: ObservationBackend {
    // Explicit dependency: top-level guard bindings are not class members.
    // Created only by explicit discovery after signed-parent admission.
    private let trust: ProcessTrust
    var windows: [String: Window] = [:]
    var processes: [String: String] = [:]
    var grant: Object?
    var lease = ""
    var expiresMonotonic = 0.0
    var snapshots: [String: Snapshot] = [:]
    var frame: Object?
    var frameObservation = ""
    private var frameMonotonic: Double?
    private var visualAttempt = VisualAttempt() // Helper lifetime, never reset by observe/start/Resume.
    private var visualBinding: VisualBinding?
    private var visualExecuting = false
    private var localCommandDeadline: Double?
    private var localDeadlines: [String: Double] = [:] // Session lifetime; never renew a command ID.
    // Private owner preparation is available; this is NOT platform/input acceptance.
    private func clickOwnerReady() -> Bool { guardianInvalidation == nil && brian_pipe_endpoints_alive(3, 3) == 1 }
    private let guardianInvalidation: (() -> Void)?
    private var reservedClicks = Set<String>()
    private var reservedFrames = Set<String>()
    private var clickTransferred = false // never reset; the old effect producer stays closed
    private var clickSpent = false // at most ONE attempted click in this consented grant
    private var readbackOnly = false
    private var readbackMonitorInstalled = false
    private var readbackDescriptor: ClickScopeDescriptor?
    var lastCapture = -Double.infinity
    var journal: [String: Object] = [:]
    var seen: [String: Data] = [:]
    // Independent watchdog: parent death/deadline/permission loss never waits for AX.
    let guardLock = NSLock()
    var watchdogDeadline: Double = 0
    var watchdogActive = false
    var approvalCommand: Object?
    var approvedCommand: Object?
    var approvalOpen = false
    var inputTap: CFMachPort?
    // Local lifetime fencing only; no observer transport, content or telemetry.
    private var scopeObserver: AXObserver?
    private var semanticSafety = SemanticSafety()
    private var messagingReady = false
    private func fingerprint(_ command: Object) -> Data {
        let bytes = (try? JSONSerialization.data(withJSONObject: command, options: [.sortedKeys])) ?? Data()
        return Data(SHA256.hash(data: bytes))
    }
    // Fast only: no AX reads, signatures or window traversal here. Existing
    // notification/takeover revocation still exits independently. Suspension
    // after this check and already queued target effects remain unresolved AX races.
    private func effectAllowed(_ window: Window, deadline: Double, wallDeadline: Double, wallExpiry: Double) -> Bool {
        guardLock.lock(); let active = watchdogActive; guardLock.unlock()
        let monitor = messagingReady && active && window.epochFence.clean() &&
            (inputTap.map { CGEvent.tapIsEnabled(tap: $0) } ?? false)
        guard visualEvidenceAlive() else { return false }
        return semanticSafety.permitsEffect(monotonic: monotonic(), wall: now(),
            commandDeadline: deadline, grantDeadline: expiresMonotonic,
            wallDeadline: wallDeadline, wallExpiry: wallExpiry,
            channelAlive: brian_private_channel_alive() == 1, monitorLive: monitor)
    }
    func input(_ type: CGEventType, _ event: CGEvent) {
        guardLock.lock(); let active = watchdogActive; let approving = approvalOpen; guardLock.unlock()
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput { _exit(72) }
        guard active else { return }
        // No own-PID exemption: semantic actions/capture do not inject input.
        // Only the trusted parent's LOCAL approval interaction is excepted. Main must
        // keep all non-dialog takeover hooks live; renderer input is not consent.
        let kind: SemanticInputKind
        switch type {
        case .mouseMoved: kind = .pointer
        case .keyDown, .keyUp: kind = .key
        case .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp: kind = .button
        case .scrollWheel: kind = .scroll
        case .leftMouseDragged, .rightMouseDragged, .otherMouseDragged: kind = .drag
        case .flagsChanged: kind = .modifier
        default: kind = .unknown
        }
        if let code = SemanticInputPolicy.exitCode(active: active, approving: approving,
            parentTarget: event.getIntegerValueField(.eventTargetUnixProcessID) == Int64(getppid()), kind: kind) {
            _exit(code)
        }
    }
    var commandDeadline = Double.infinity
    init(trust: ProcessTrust, guardianInvalidation: (() -> Void)? = nil) {
        self.trust = trust
        self.guardianInvalidation = guardianInvalidation
        // System-wide AX object's timeout sets the process default for descendant
        // handles too; an application-object override does not. This config call
        // neither reads AX content nor prompts. Failure leaves this backend inert.
        messagingReady = AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.2) == .success
        guard messagingReady else { return }
        // Guardian uses the same native readers, not the worker's exiting tap,
        // watchdog or notification callbacks. It owns revocable prepared scope.
        if guardianInvalidation != nil { return }
        let types: [CGEventType] = [.keyDown, .keyUp, .flagsChanged, .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp, .scrollWheel, .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged]
        let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        if AXIsProcessTrusted() {
            inputTap = CGEvent.tapCreate(tap: .cgAnnotatedSessionEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: mask, callback: { _, type, event, info in
                guard let info = info else { return Unmanaged.passUnretained(event) }
                Unmanaged<Broker>.fromOpaque(info).takeUnretainedValue().input(type, event)
                return Unmanaged.passUnretained(event)
            }, userInfo: Unmanaged.passUnretained(self).toOpaque())
            if let tap = inputTap {
                CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0), .commonModes)
                CGEvent.tapEnable(tap: tap, enable: true)
            }
        }
        DispatchQueue.global(qos: .userInteractive).async { [self] in
            while true {
                usleep(50_000)
                if brian_private_channel_alive() != 1 { _exit(70) }
                guardLock.lock(); let deadline = watchdogDeadline; let active = watchdogActive; guardLock.unlock()
                if brian_private_channel_alive() != 1 || getppid() != trust.parent.pid || (active && (monotonic() >= deadline || !AXIsProcessTrusted() || inputTap == nil || !CGEvent.tapIsEnabled(tap: inputTap!))) { _exit(70) }
            }
        }
        DistributedNotificationCenter.default().addObserver(forName: NSNotification.Name("com.apple.screenIsLocked"), object: nil, queue: nil) { _ in _exit(71) }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: nil) { _ in _exit(71) }
    }
    func capabilities() -> Object {
        guard messagingReady else {
            return ["protocol": proto, "platform": "darwin", "axRead": false, "semanticActions": false,
                    "windowCapture": false, "input": false, "accessibilityPermission": "unknown",
                    "capturePermission": "unknown", "limitations": ["AX messaging timeout configuration failed; backend unavailable."]]
        }
        let trusted = AXIsProcessTrusted()
        let ready = messagingReady && trusted && (inputTap.map { CGEvent.tapIsEnabled(tap: $0) } ?? false)
        // Broker exists only after explicit discovery. Never prompt for permission.
        let captureReady = CGPreflightScreenCaptureAccess()
        var result: Object = ["protocol": proto, "platform": "darwin", "axRead": ready, "semanticActions": ready && !clickSpent && !semanticSafety.uncertain, "windowCapture": ready && captureReady, "input": false,
                "accessibilityPermission": trusted ? "granted" : "denied", "capturePermission": captureReady ? "granted" : "denied",
                "limitations": ["Consented TextEdit/fixture AX actions. Capture requires control+capture consent and a public, unoccluded fixture canvas. Coordinate mechanism retired after a deadline counterexample; input/keys/focus disabled.", "AX permission and enabled takeover monitor required. Clicks, dragging, scrolling, keyboard/modifier input, lock/sleep and changed window scope revoke the session. Passive pointer movement alone does not."]]
        if ready && captureReady && !semanticSafety.uncertain && !clickSpent && trust.visualFixturePinReady() {
            result["visualInvokeVersion"] = 1
        }
        return result
    }
    private var lastDiscoveryDiagnostics: Object?
    func discoveryDiagnostics() -> Object? { lastDiscoveryDiagnostics }
    func listTargets() -> [Object] {
        let diagnostics = DiscoveryDiagnostics()
        defer { lastDiscoveryDiagnostics = diagnostics.wire }
        return discoverTargets(only: nil, diagnostics: diagnostics)
    }
    private func discoverTargets(only pid: pid_t?, standingFence: ProcessEpochFence? = nil, diagnostics: DiscoveryDiagnostics? = nil) -> [Object] {
        guard messagingReady, grant == nil, AXIsProcessTrusted() else { return [] }
        let applications: [NSRunningApplication]
        if let pid = pid {
            guard let app = NSRunningApplication(processIdentifier: pid) else { return [] }
            applications = [app]
        } else { applications = NSWorkspace.shared.runningApplications }
        diagnostics?.increment("processes", by: applications.count)
        var next: [String: Window] = [:]
        for app in applications {
            // Subscribe before ANY birth/signature/window pinning. Reuse a
            // prior admission fence, never replace a poisoned lifetime.
            let prior = windows.values.first { $0.identity.pid == app.processIdentifier }?.epochFence
            guard let epochFence = standingFence ?? prior ?? ProcessEpochFence(pid: app.processIdentifier),
                  epochFence.pid == app.processIdentifier, epochFence.clean() else { diagnostics?.increment("fenceRejected"); continue }
            guard let (identity, appId) = trust.target(app.processIdentifier, diagnostics: diagnostics),
                  let launch = app.launchDate, !app.isTerminated else { continue }
            diagnostics?.increment("admitted")
            let processKey = "\(app.processIdentifier):\(launch.timeIntervalSince1970)"
            let processInstance = processes[processKey] ?? id()
            processes[processKey] = processInstance
            let ax = AXUIElementCreateApplication(app.processIdentifier)
            guard let applicationWindows = attr(ax, kAXWindowsAttribute, diagnostics: diagnostics) as? [AXUIElement],
                  applicationWindows.count <= 32 else { diagnostics?.increment("windowListRejected"); continue }
            for window in applicationWindows {
                guard bounds(window, diagnostics: diagnostics) != nil else { diagnostics?.increment("boundsRejected"); continue }
                if !supportedWindowScope(window, diagnostics: diagnostics) { diagnostics?.increment("scopeRejected"); continue }
                if !epochFence.clean() { diagnostics?.increment("fenceChanged"); continue }
                let previous = windows.values.first { ($0.target["processId"] as? Int) == Int(app.processIdentifier) && $0.launch == launch && CFEqual($0.element, window) }
                let target: Object = previous?.target ?? ["appId": appId, "processId": Int(app.processIdentifier), "processInstanceId": processInstance, "windowId": id(), "windowInstanceId": id()]
                next[target["windowInstanceId"] as! String] = Window(target: target, element: window, application: ax, applicationWindows: applicationWindows, launch: launch, identity: identity, epochFence: epochFence)
                if next.count >= 128 { break }
            }
        }
        windows = next
        diagnostics?.increment("targets", by: next.count)
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
        defer { if !intact && grant != nil {
            if let invalidate = guardianInvalidation { invalidate() } else { _exit(71) }
        } }
        guard validWireTarget(target), let key = target["windowInstanceId"] as? String, let window = windows[key], same(window.target, target), window.epochFence.clean(), let pid = wireInteger(target["processId"], min: 1, max: Double(Int32.max)),
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
        guard window.epochFence.clean() else { return nil }
        intact = true
        return window
    }
    private func monitorScope(_ window: Window) -> Bool {
        guard scopeObserver == nil else { return false }
        var observer: AXObserver?
        let callback: AXObserverCallback = { _, _, _, _ in
            // Installed only during a consented Start. Invalidate from the first
            // subscription, including BEFORE grant/watchdog activation; otherwise
            // a transient sheet during startup could be forgotten. Never query AX
            // or wait for the worker/lock here: a provider may already be blocked.
            _exit(71)
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
    func restoreApprovedWindow(_ window: Window, deadline: Double, wallDeadline: Double, wallExpiry: Double) -> Bool {
        guard let live = liveWindow(window.target), CFEqual(live.element, window.element),
              let app = NSRunningApplication(processIdentifier: pid_t(window.target["processId"] as! Int)) else { return false }
        guard effectAllowed(window, deadline: deadline, wallDeadline: wallDeadline, wallExpiry: wallExpiry) else { return false }
        let activated = DispatchQueue.main.sync {
            effectAllowed(window, deadline: deadline, wallDeadline: wallDeadline, wallExpiry: wallExpiry) && app.activate(options: [])
        }
        guard activated, liveWindow(window.target) != nil,
              effectAllowed(window, deadline: deadline, wallDeadline: wallDeadline, wallExpiry: wallExpiry) else { return false }
        let raised = AXUIElementPerformAction(window.element, kAXRaiseAction as CFString)
        guard raised == .success else { semanticSafety.markUncertain(); return false }
        let end = monotonic() + 750
        repeat {
            if NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier,
               let focused = attr(window.application, kAXFocusedWindowAttribute), CFEqual(focused, window.element) {
                return liveWindow(window.target) != nil && effectAllowed(window, deadline: deadline, wallDeadline: wallDeadline, wallExpiry: wallExpiry)
            }
            usleep(10_000)
        } while monotonic() < end
        return false
    }
    func start(_ payload: Object) -> Bool {
        guard messagingReady, !semanticSafety.uncertain else { return false }
        guard supportedGrant(payload), grant == nil, let candidate = payload["grant"] as? Object,
              let leaseId = wireString(payload["leaseId"]),
              // Schema permits epoch zero; this pilot retains its active-grant >0 rule.
              let epoch = wireInteger(candidate["epoch"]), epoch > 0,
              let expiry = wireInteger(candidate["expiresAt"]), expiry > now(), expiry <= now() + 900_000,
              let targets = candidate["targets"] as? [Object], let tap = inputTap, CGEvent.tapIsEnabled(tap: tap), AXIsProcessTrusted(), targets.allSatisfy({ liveWindow($0) != nil }) else { return false }
        guard targets.count == 1, let window = liveWindow(targets[0]), monitorScope(window), liveWindow(window.target) != nil, AXIsProcessTrusted(), CGEvent.tapIsEnabled(tap: tap) else { return false }
        guard brian_private_channel_alive() == 1 else { _exit(70) }
        expiresMonotonic = monotonic() + expiry - now()
        guardLock.lock(); watchdogDeadline = expiresMonotonic; watchdogActive = true; guardLock.unlock()
        // Inspector Start never activates. Only explicit control consent restores.
        if wireBool(candidate["allowControl"]) == true {
            guard restoreApprovedWindow(window, deadline: expiresMonotonic, wallDeadline: expiry, wallExpiry: expiry) else { return false }
        }
        guard now() < expiry, liveWindow(window.target) != nil, trust.parentValid(),
              brian_private_channel_alive() == 1, AXIsProcessTrusted(), CGEvent.tapIsEnabled(tap: tap) else { return false }
        grant = candidate; lease = leaseId
        return true
    }
    func authorized(_ command: Object, _ leaseId: String) -> Bool {
        if clickSpent || clickTransferred {
            guard readbackOnly, readbackMonitorInstalled,
                  let action = command["action"] as? Object,
                  let kind = action["kind"] as? String, ["observe", "capture"].contains(kind),
                  let target = action["target"] as? Object, let window = liveWindow(target),
                  let descriptor = readbackDescriptor, descriptor.matchesProcess(window.identity),
                  let current = bounds(window.element), same(current, descriptor.bounds),
                  layout() == descriptor.displayLayout, uniqueCanvasWindow(window, descriptor.windowNumber),
                  let tap = inputTap, CGEvent.tapIsEnabled(tap: tap) else { return false }
        }
        return scopedAuthority(command, leaseId)
    }
    // Internal scope validation during a handoff is NOT reopening dispatch.
    private func scopedAuthority(_ command: Object, _ leaseId: String) -> Bool {
        guard messagingReady else { return false }
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
        let exportedRole = boundedText(publicAXRoles.contains(role) ? role : "AXUnknown", 100)
        let title = sensitive ? "" : string(element, kAXTitleAttribute)
        let name = boundedText(sensitive ? "" : (title.isEmpty ? string(element, kAXDescriptionAttribute) : title), 4096)
        var complete = !sensitive && !exportedRole.truncated && !name.truncated
        var result: Object = ["ref": ref, "role": exportedRole.text, "name": name.text, "enabled": bool(element, kAXEnabledAttribute), "focused": bool(element, kAXFocusedAttribute), "selected": bool(element, kAXSelectedAttribute) || (!sensitive && role == kAXRadioButtonRole && bool(element, kAXValueAttribute)), "sensitive": sensitive, "actions": [String]()]
        if !sensitive, wireBool(grant?["allowControl"]) == true {
            var writable: DarwinBoolean = false
            let writableValue = AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &writable) == .success && writable.boolValue
            let appId = (grant?["targets"] as? [Object])?.first?["appId"] as? String ?? ""
            result["actions"] = semanticNodeActions(control: true, appId: appId, role: role, subrole: subrole,
                enabled: bool(element, kAXEnabledAttribute), names: actionNames(element), writableValue: writableValue,
                writableSelection: selectionAttribute(element), vertical: string(element, kAXOrientationAttribute) == kAXVerticalOrientationValue)
        }
        if let parent = parent { result["parentRef"] = parent }
        if let rect = bounds(element) { result["bounds"] = rect }
        if !sensitive, let value = attr(element, kAXValueAttribute) as? String {
            let exported = boundedText(value, 4096)
            result["value"] = exported.text; complete = complete && !exported.truncated
        }
        if !sensitive, [kAXRadioButtonRole, kAXCheckBoxRole, kAXScrollBarRole].contains(role), let value = attr(element, kAXValueAttribute) as? NSNumber { result["value"] = value.stringValue }
        return NodeRead(value: result, complete: complete)
    }
    func supportedWindowScope(_ element: AXUIElement, diagnostics: DiscoveryDiagnostics? = nil) -> Bool {
        // The supported scope is a normal document/fixture window, never a
        // dialog/sheet/security prompt attached after discovery or approval.
        return attr(element, kAXRoleAttribute, diagnostics: diagnostics) as? String == kAXWindowRole &&
            privacySubrole(element, diagnostics: diagnostics) == kAXStandardWindowSubrole && hasNoSheetChildren(element, diagnostics: diagnostics)
    }
    func hasNoSheetChildren(_ element: AXUIElement, diagnostics: DiscoveryDiagnostics? = nil) -> Bool {
        // Sheets are AXChildren with AXSheet role, not a separate public attribute.
        // An unavailable/malformed child list or role is not proof of absence.
        guard let children = attr(element, kAXChildrenAttribute, diagnostics: diagnostics) as? [AXUIElement], children.count <= 500 else { return false }
        return children.allSatisfy { child in
            guard let role = attr(child, kAXRoleAttribute, diagnostics: diagnostics) as? String, !role.isEmpty else { return false }
            return role != kAXSheetRole
        }
    }
    func observe(_ command: Object, _ window: Window) -> Object? {
        guard brian_private_channel_alive() == 1 else { if let invalidate = guardianInvalidation { invalidate(); return nil }; _exit(70) }
        guard liveWindow(window.target) != nil, let rect = bounds(window.element),
              let identity = command["identity"] as? Object else { return nil }
        let started = monotonic(); let observationId = id()
        var nodes: [Object] = []; var refs: [String: Ref] = [:]
        var queue: [(AXUIElement, String?, Int)] = [(window.element, nil, 0)]
        var visited: [AXUIElement] = []; var complete = true; var bytes = 0
        while !queue.isEmpty {
            guard brian_private_channel_alive() == 1 else { if let invalidate = guardianInvalidation { invalidate(); return nil }; _exit(70) }
            if nodes.count >= 500 || monotonic() - started > 300 || bytes > 400_000 { complete = false; break }
            let (element, parent, depth) = queue.removeFirst()
            if visited.contains(where: { CFEqual($0, element) }) { continue }
            visited.append(element)
            let key = id(); let read = node(element, key, parent); let value = read.value
            if !read.complete { complete = false }
            bytes += (try? JSONSerialization.data(withJSONObject: value).count) ?? 10000
            let childRead = readChildren(element)
            if childRead.elements == nil { complete = false }
            let children = childRead.elements ?? []
            nodes.append(value); refs[key] = Ref(element: element, node: value, children: childRead)
            // Secure/unknown subtree never leaves the helper, even via a child's name.
            if value["sensitive"] as? Bool == true { complete = false; continue }
            if depth >= 16 { if !children.isEmpty { complete = false }; continue }
            if children.count > 500 { complete = false }
            for child in children.prefix(500) { queue.append((child, key, depth + 1)) }
            if queue.count > 1000 { complete = false; break }
        }
        if bytes > 400_000 || monotonic() - started > 300 { complete = false }
        var observation: Object = ["identity": identity, "epoch": command["epoch"]!, "id": observationId, "capturedAt": now(), "monotonicMs": monotonic(), "target": window.target,
                                   "foreground": NSWorkspace.shared.frontmostApplication?.processIdentifier == pid_t(window.target["processId"] as! Int), "bounds": rect, "displayLayoutVersion": layout(), "completeness": complete ? "complete" : "partial", "nodes": nodes]
        invalidateVisualEvidence()
        frame = nil; frameObservation = ""; frameMonotonic = nil
        snapshots.removeAll() // One latest observation; no cross-window cached authority.
        guard brian_private_channel_alive() == 1 else { if let invalidate = guardianInvalidation { invalidate(); return nil }; _exit(70) }
        // Recheck after traversal, before any local text can leave the helper.
        // Changed window/sheet scope is a refusal, not a partial approved result.
        guard liveWindow(window.target) != nil, let finalBounds = bounds(window.element), same(rect, finalBounds) else { return nil }
        let candidate = Snapshot(observation: observation, refs: refs, monotonic: started)
        if publicShapes(window, candidate) { observation["captureCohort"] = "public-shapes-v1" }
        snapshots[observationId] = Snapshot(observation: observation, refs: refs, monotonic: started)
        return observation
    }
    func fresh(_ action: Object, _ window: Window) -> Snapshot? {
        guard let observationId = action["observationId"] as? String, let snapshot = snapshots[observationId], snapshot.observation["completeness"] as? String == "complete", monotonic() - snapshot.monotonic < 5000,
              let target = snapshot.observation["target"] as? Object, same(target, window.target),
              snapshot.observation["displayLayoutVersion"] as? String == layout(), let previous = snapshot.observation["bounds"] as? Object, let rect = bounds(window.element), same(rect, previous),
              NSWorkspace.shared.frontmostApplication?.processIdentifier == pid_t(window.target["processId"] as! Int),
              let focused = attr(window.application, kAXFocusedWindowAttribute), CFEqual(focused, window.element),
              lastInputAge() >= monotonic() - (snapshot.inputMonotonic ?? snapshot.monotonic) else { return nil }
        return snapshot
    }
    func sameChildren(_ ref: Ref) -> Bool {
        let current = readChildren(ref.element)
        return sameChildrenRead(ref.children, current, equal: { CFEqual($0, $1) })
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
    // Approval must name a currently permitted ref, not just a well-formed command.
    func permittedSemantic(_ action: Object, _ snapshot: Snapshot) -> Bool {
        if let target = snapshot.observation["target"] as? Object, let window = liveWindow(target), visualReserved(window) {
            guard visualExecuting, let binding = visualBinding, same(action, binding.action) else { return false }
        }
        guard wireBool(grant?["allowControl"]) == true,
              let kind = action["kind"] as? String, semanticKind(kind),
              let key = action["ref"] as? String, let ref = snapshot.refs[key],
              ref.node["sensitive"] as? Bool == false,
              (ref.node["actions"] as? [String])?.contains(kind) == true else { return false }
        if kind == "scroll" {
            guard let delta = wireInteger(action["deltaY"], min: -600, max: 600), delta != 0,
                  actionNames(ref.element).contains(delta > 0 ? kAXIncrementAction : kAXDecrementAction) else { return false }
        }
        return true
    }
    // Native-only assembly. No request-supplied frame, clock or transform is used.
    private func clickSnapshot(_ command: Object, _ leaseId: String) -> ClickIntent.Snapshot? {
        guard authorized(command, leaseId), captureAuthority(grant),
              CGPreflightScreenCaptureAccess(), let tap = inputTap, CGEvent.tapIsEnabled(tap: tap),
              let action = command["action"] as? Object, action["kind"] as? String == "click",
              let target = action["target"] as? Object, let window = liveWindow(target),
              let snapshot = fresh(action, window), unchanged(snapshot, window), safeCanvas(window, snapshot),
              let frame = frame, let captured = frameMonotonic,
              let currentBounds = bounds(window.element), let deadline = localCommandDeadline else { return nil }
        return ClickIntent.Snapshot(frame: frame, observation: snapshot.observation, target: window.target,
            currentBounds: currentBounds, currentLayout: layout(), frameObservationID: frameObservation,
            frameMonotonicMs: captured, observationMonotonicMs: snapshot.monotonic,
            grantDeadlineMonotonicMs: expiresMonotonic, commandDeadlineMonotonicMs: deadline)
    }
    // Owner integration interface: call on the serialized Broker lane immediately
    // before reservation/handoff. Arithmetic evidence only; never permission to post.
    // Returns a private descriptor only; the surviving owner must independently reconstruct scope.
    func prepareClick(_ command: Object, leaseId: String) -> ClickPreparedScope? {
        guard ClickGuardianNativeAcceptedPlatforms.acceptsCurrentPlatform() else { return nil }
        guard clickOwnerReady(), let approved = approvedCommand,
              exactLocalCommand(command, approved), let grant = grant,
              let before = clickSnapshot(command, leaseId),
              ClickIntent.validate(command: command, approved: approved, grant: grant, snapshot: before,
                  clock: .init(wallMs: now(), monotonicMs: monotonic())) != nil else { return nil }
        commandDeadline = before.commandDeadlineMonotonicMs
        guardLock.lock(); watchdogDeadline = min(expiresMonotonic, commandDeadline); guardLock.unlock()
        guard let action = command["action"] as? Object, let target = action["target"] as? Object,
              let window = liveWindow(target), let snapshot = fresh(action, window),
              let (png, width, height) = pixels(command, action, window, snapshot),
              png.base64EncodedString() == before.frame["data"] as? String,
              wireInteger(before.frame["width"]) == Double(width),
              wireInteger(before.frame["height"]) == Double(height),
              let after = clickSnapshot(command, leaseId), same(before.frame, after.frame),
              before.frameMonotonicMs == after.frameMonotonicMs else { return nil }
        // SCK/AX can block: repeat identity, lease, focus, geometry, layout and clocks
        // AFTER the unchanged PNG comparison. Never replace/refresh the cached frame.
        guard let binding = ClickIntent.validate(command: command, approved: approved, grant: grant, snapshot: after,
            clock: .init(wallMs: now(), monotonicMs: monotonic())),
              let number = visibleWindowID(window), uniqueCanvasWindow(window, number),
              let descriptor = ClickScopeDescriptor.make(command: command, snapshot: after,
                  native: snapshot, window: window, number: number, png: png, worker: trust.helper),
              descriptor.fresh(), authorized(command, leaseId) else { return nil }
        return ClickPreparedScope(binding: binding, descriptor: descriptor)
    }
    func handoffClick(_ payload: Object, requestID: String) -> Object? {
        let command = payload["command"] as? Object ?? [:]
        let commandID = command["commandId"] as? String ?? "invalid"
        func receipt(_ outcome: String, _ code: String) -> Object {
            ["commandId": commandID, "outcome": outcome, "code": code]
        }
        // Refusal must not spend semantic availability, reserve a frame/command,
        // or transfer the existing takeover monitor. Prior uncertainty stays sticky.
        guard ClickGuardianNativeAcceptedPlatforms.acceptsCurrentPlatform() else {
            return clickSpent || clickTransferred
                ? receipt("execution_unknown", "helper_error") : receipt("not_executed", "unsupported")
        }
        defer { approvedCommand = nil }
        guard !clickSpent, validWirePayload("execute", payload), approvalCommand == nil,
              let prepared = prepareClick(command, leaseId: payload["leaseId"] as? String ?? ""),
              !reservedClicks.contains(prepared.binding.commandID),
              !reservedFrames.contains(prepared.binding.frameID) else { return receipt("not_executed", "denied") }
        clickSpent = true
        reservedClicks.insert(prepared.binding.commandID)
        reservedFrames.insert(prepared.binding.frameID)
        // Burn the exact native approval BEFORE handing off. Worker never emits.
        approvedCommand = nil
        guard let action = command["action"] as? Object, let target = action["target"] as? Object,
              let admittedWindow = liveWindow(target) else { return receipt("execution_unknown", "helper_error") }
        let originalFence = admittedWindow.epochFence
        guard let result = guardianWorkerHandoff(requestID: requestID, descriptor: prepared.descriptor, transfer: { [self] in
            guard scopedAuthority(command, lease), prepared.descriptor.fresh(),
                  let tap = inputTap, CGEvent.tapIsEnabled(tap: tap) else { return false }
            // Guardian has confirmed its active monitor; transfer takeover only
            // now, with no unmonitored gap. Worker scope callback stays _exit(71).
            clickTransferred = true // irreversible closure of the old effect producer
            guardLock.lock(); watchdogActive = false; guardLock.unlock()
            DispatchQueue.main.sync { CGEvent.tapEnable(tap: tap, enable: false) }
            // ownerPrepared means the independently subscribed guardian has
            // pinned its native scope. Confirm OUR ORIGINAL subscription after
            // that readiness, before the authenticated workerTransferred ack.
            return originalFence.clean()
        }, returnMonitoring: { [self] in
            return installReadbackMonitor(command, descriptor: prepared.descriptor) && originalFence.clean()
        }) else {
            return receipt("execution_unknown", "helper_error")
        }
        if result == "delivered", clickTransferred, readbackMonitorInstalled, originalFence.clean() {
            // Node sends this only AFTER a complete return transcript and owner
            // observed exit. Stream delivery is not app/task success. Core must
            // issue its own fresh completion observation, not reuse our probes.
            readbackDescriptor = prepared.descriptor
            readbackOnly = true
            commandDeadline = .infinity
            localCommandDeadline = nil
            snapshots.removeAll(); frame = nil; frameObservation = ""; frameMonotonic = nil
            guardLock.lock(); watchdogDeadline = expiresMonotonic; guardLock.unlock()
            return receipt("executed", "ok")
        }
        return result == "refused" && !clickTransferred ? receipt("not_executed", "unsupported") : receipt("execution_unknown", "helper_error")
    }
    private func installReadbackMonitor(_ command: Object, descriptor: ClickScopeDescriptor) -> Bool {
        guard clickSpent, clickTransferred, !readbackMonitorInstalled,
              ClickGuardianNativeAcceptedPlatforms.acceptsCurrentPlatform(),
              ClickGuardianNativeIdentitySupport.hasPublicEpochFenceSupport(), descriptor.matches(command),
              let action = command["action"] as? Object, let target = action["target"] as? Object,
              let window = liveWindow(target), descriptor.matchesProcess(window.identity),
              let tap = inputTap, let observer = scopeObserver else { return false }
        func currentPublicScope() -> Bool {
            guard scopedAuthority(command, lease), descriptor.matchesProcess(window.identity),
                  let b = bounds(window.element), same(b, descriptor.bounds), layout() == descriptor.displayLayout,
                  uniqueCanvasWindow(window, descriptor.windowNumber),
                  NSWorkspace.shared.frontmostApplication?.processIdentifier == window.identity.pid,
                  let focus = attr(window.application, kAXFocusedWindowAttribute), CFEqual(focus, window.element),
                  CGPreflightScreenCaptureAccess(), let observed = observe(command, window),
                  let id = observed["id"] as? String, let snapshot = snapshots[id],
                  safeCanvas(window, snapshot) else { return false }
            return window.epochFence.clean() // Fresh public completeness, NOT equality with pre-click pixels/content.
        }
        guard currentPublicScope() else { return false }
        // Preserve the existing unconditional worker _exit(71) callback and add
        // the owner's scope coverage before acknowledging return. No new callback
        // treats readback as permission to ignore a resize, focus change or sheet.
        let context = Unmanaged.passUnretained(self).toOpaque()
        var subscriptions: [(AXUIElement, String)] = [(window.application, kAXFocusedWindowChangedNotification),
            (window.application, kAXFocusedUIElementChangedNotification)]
        for peer in window.applicationWindows {
            for name in [kAXMovedNotification, kAXResizedNotification, kAXTitleChangedNotification, kAXLayoutChangedNotification] {
                subscriptions.append((peer, name))
            }
        }
        for (element, name) in subscriptions {
            guard AXObserverAddNotification(observer, element, name as CFString, context) == .success else { return false }
        }
        // Overlap monitors: arm takeover/watchdog BEFORE acknowledgement. A
        // physical event or scope change exits the worker; guardian stays alive.
        DispatchQueue.main.sync {
            guardLock.lock(); approvalOpen = false; watchdogActive = true
            watchdogDeadline = min(expiresMonotonic, commandDeadline); guardLock.unlock()
            CGEvent.tapEnable(tap: tap, enable: true)
        }
        guard CGEvent.tapIsEnabled(tap: tap), currentPublicScope(), brian_private_channel_alive() == 1 else { return false }
        readbackMonitorInstalled = true
        return true
    }
    private func visualReserved(_ window: Window) -> Bool {
        return string(window.element, kAXTitleAttribute) == VisualPolicy.title ||
            string(window.element, kAXIdentifierAttribute) == VisualPolicy.identifier
    }
    private func captureWindowTitle(_ window: Window) -> String {
        visualReserved(window) ? VisualPolicy.title : canvasTitle
    }
    private func captureWindowIdentifier(_ window: Window) -> String {
        visualReserved(window) ? VisualPolicy.identifier : "brian-safe-canvas-v1"
    }
    private func captureCohort(_ window: Window, _ snapshot: Snapshot) -> Bool {
        visualReserved(window) ? publicShapes(window, snapshot) : safeCanvas(window, snapshot)
    }
    // Pixel privacy comes from the exact pinned closed renderer, not an OS
    // metadata allowlist. Required roles/content/children/geometry are checked
    // by publicShapes/cohort/unchanged. Localized descriptions and optional OS
    // relations are not rendered content and must not authorize or deny it.
    private func publicShapeAttributes(_ element: AXUIElement, _ node: Object) -> Bool {
        VisualPolicy.contentAttributes(node) { name in
            var value: CFTypeRef?
            switch AXUIElementCopyAttributeValue(element, name as CFString, &value) {
            case .success:
                guard let value = value else { return .failed }
                return .value(value)
            case .noValue, .attributeUnsupported: return .absent
            default: return .failed
            }
        }
    }
    private func publicShapes(_ window: Window, _ snapshot: Snapshot) -> Bool {
        guard captureAuthority(grant), publicShapesGrant(grant),
              window.target["appId"] as? String == cohort, trust.visualFixtureValid(window.identity),
              liveWindow(window.target) != nil, string(window.element, kAXTitleAttribute) == VisualPolicy.title,
              string(window.element, kAXIdentifierAttribute) == VisualPolicy.identifier,
              snapshot.observation["completeness"] as? String == "complete", snapshot.refs.count == 6,
              let bounds = snapshot.observation["bounds"] as? Object,
              let exported = snapshot.observation["nodes"] as? [Object], exported.count == 6,
              window.applicationWindows.count == 1, hasNoSheetChildren(window.element) else { return false }
        var nodes: [Object] = []
        for n in exported {
            guard let key = n["ref"] as? String, let ref = snapshot.refs[key],
                  ref.node["sensitive"] as? Bool == false, publicShapeAttributes(ref.element, n),
                  let subrole = privacySubrole(ref.element), let children = ref.children.elements else { return false }
            let index = nodes.count
            let expectedChildren = index == 0 ? [1] : (index == 1 ? [2, 3, 4, 5] : [])
            guard children.count == expectedChildren.count else { return false }
            for (child, expected) in zip(children, expectedChildren) {
                guard let childKey = exported[expected]["ref"] as? String, let known = snapshot.refs[childKey],
                      CFEqual(child, known.element) else { return false }
            }
            var value = n
            value["identifier"] = string(ref.element, kAXIdentifierAttribute); value["subrole"] = subrole
            if let parent = n["parentRef"] as? String {
                guard let parentIndex = exported.firstIndex(where: { $0["ref"] as? String == parent }),
                      let parentRef = snapshot.refs[parent], let nativeParent = attr(ref.element, kAXParentAttribute),
                      CFEqual(nativeParent, parentRef.element) else { return false }
                value["parent"] = parentIndex
            } else { value["parent"] = -1 }
            let nativeActions = actionNames(ref.element)
            guard nativeActions == (index == 0 ? [kAXRaiseAction] : (index >= 2 && index <= 4 ? [kAXPressAction] : [])) else { return false }
            nodes.append(value)
        }
        return VisualPolicy.cohort(nodes, bounds: bounds) && unchanged(snapshot, window)
    }
    private func reserveVisualCapture(_ command: Object) -> Bool {
        visualAttempt.reserveCapture(fingerprint(command))
    }
    private func terminateVisual() { visualAttempt.terminate(); visualBinding = nil }
    private func invalidateVisualEvidence() {
        if visualAttempt.captureCommand != nil { terminateVisual() }
    }
    private func isVisualApproval(_ payload: Object) -> Bool {
        return visualBinding != nil || ((payload["command"] as? Object)?["action"] as? Object)?["kind"] as? String == "visualInvoke"
    }
    private func visualEvidenceAlive() -> Bool {
        guard let binding = visualBinding else { return !visualExecuting }
        return VisualPolicy.alive(capture: binding.captureMonotonic, observation: binding.observationMonotonic, current: monotonic())
    }
    private func visualValid(_ binding: VisualBinding, _ command: Object, _ window: Window) -> Bool {
        guard same(binding.command, command), binding.lease == lease, window.identity == binding.identity,
              CFEqual(window.element, binding.window), let action = command["action"] as? Object,
              let currentFrame = frame, same(currentFrame, binding.frame),
              currentFrame["id"] as? String == action["frameId"] as? String,
              frameObservation == action["observationId"] as? String,
              frameMonotonic == binding.captureMonotonic,
              let snapshot = fresh(action, window), snapshot.monotonic == binding.observationMonotonic,
              VisualPolicy.alive(capture: binding.captureMonotonic, observation: binding.observationMonotonic, current: monotonic()),
              captureAuthority(grant), CGPreflightScreenCaptureAccess(), publicShapes(window, snapshot),
              let number = visibleWindowID(window), uniqueCanvasWindow(window, number),
              let key = binding.action["ref"] as? String, let ref = snapshot.refs[key], CFEqual(ref.element, binding.element),
              ref.node["role"] as? String == "AXButton", ref.node["enabled"] as? Bool == true,
              let box = ref.node["bounds"] as? Object, VisualPolicy.contains(box, binding.point),
              actionNames(ref.element) == [kAXPressAction], reachable(ref.element, in: window.element),
              authorized(command, binding.lease) else { return false }
        // Native validation above may block; never return a renewed/stale binding.
        return VisualPolicy.alive(capture: binding.captureMonotonic, observation: binding.observationMonotonic, current: monotonic())
    }
    func beginVisualApproval(_ payload: Object) -> VisualApproval? {
        guard validWirePayload("beginApproval", payload), let command = payload["command"] as? Object,
              let action = command["action"] as? Object, action["kind"] as? String == "visualInvoke",
              approvalCommand == nil, approvedCommand == nil, visualBinding == nil,
              let deadline = wireInteger(command["deadlineAt"]), let commandID = wireString(command["commandId"]),
              let retained = semanticSafety.admit(id: commandID, fingerprint: fingerprint(command), wallDeadline: deadline,
                  wall: now(), monotonic: monotonic()), visualAttempt.bind(fingerprint(command)) else { return nil }
        commandDeadline = retained
        guardLock.lock(); watchdogDeadline = min(expiresMonotonic, retained); guardLock.unlock()
        var accepted = false
        defer {
            if !accepted {
                terminateVisual(); commandDeadline = .infinity
                guardLock.lock(); watchdogDeadline = expiresMonotonic; guardLock.unlock()
            }
        }
        guard messagingReady, !semanticSafety.uncertain, !clickSpent,
              authorized(command, payload["leaseId"] as? String ?? ""),
              let target = action["target"] as? Object, let window = liveWindow(target), let snapshot = fresh(action, window),
              publicShapes(window, snapshot), let frame = frame, let captureTime = frameMonotonic,
              frameObservation == action["observationId"] as? String, frame["id"] as? String == action["frameId"] as? String,
              let width = wireNumber(frame["width"]), let height = wireNumber(frame["height"]), let b = frame["bounds"] as? Object,
              let x = wireNumber(action["x"]), let y = wireNumber(action["y"]),
              let point = VisualPolicy.point(x: x, y: y, width: width, height: height, bounds: b),
              VisualPolicy.alive(capture: captureTime, observation: snapshot.monotonic, current: monotonic()),
              let number = visibleWindowID(window), uniqueCanvasWindow(window, number) else { return nil }
        let candidates = snapshot.refs.filter { _, ref in
            ref.node["role"] as? String == "AXButton" && ref.node["enabled"] as? Bool == true &&
                (ref.node["actions"] as? [String]) == ["invoke"] &&
                (ref.node["bounds"] as? Object).map { VisualPolicy.contains($0, point) } == true
        }
        guard candidates.count == 1, let (key, ref) = candidates.first else { return nil }
        guard let hitBounds = ref.node["bounds"] as? Object,
              VisualPolicy.contains(hitBounds, (Double(Float(point.0)), Double(Float(point.1)))) else { return nil }
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(window.application, Float(point.0), Float(point.1), &hit) == .success,
              let hit = hit, CFEqual(hit, ref.element),
              snapshot.refs.values.filter({ CFEqual($0.element, hit) }).count == 1 else { return nil }
        var pid: pid_t = 0
        guard AXUIElementGetPid(hit, &pid) == .success, pid == window.identity.pid else { return nil }
        let resolved: Object = ["kind": "invoke", "target": target, "observationId": action["observationId"]!, "ref": key]
        let binding = VisualBinding(id: id(), command: command, lease: lease, action: resolved, frame: frame,
            captureMonotonic: captureTime, observationMonotonic: snapshot.monotonic, element: hit,
            window: window.element, identity: window.identity, point: point)
        guard visualValid(binding, command, window), let expiry = wireInteger(grant?["expiresAt"]),
              effectAllowed(window, deadline: retained, wallDeadline: deadline, wallExpiry: expiry) else { return nil }
        visualBinding = binding; approvalCommand = command
        guardLock.lock(); approvalOpen = true; guardLock.unlock()
        accepted = true
        return VisualApproval(bindingId: binding.id, commandId: commandID, frameId: action["frameId"] as! String,
            target: target, observationId: action["observationId"] as! String, ref: key)
    }
    private func endVisualApproval(_ payload: Object) -> Bool {
        guardLock.lock(); approvalOpen = false; guardLock.unlock()
        var accepted = false
        defer {
            approvalCommand = nil
            if !accepted {
                approvedCommand = nil; terminateVisual(); commandDeadline = .infinity
                guardLock.lock(); watchdogDeadline = expiresMonotonic; guardLock.unlock()
            }
        }
        guard validWirePayload("endApproval", payload), let command = payload["command"] as? Object,
              let pending = approvalCommand, same(command, pending), var binding = visualBinding,
              binding.id == payload["bindingId"] as? String, same(command, binding.command),
              payload["leaseId"] as? String == binding.lease, let approved = wireBool(payload["approved"]),
              authorized(command, binding.lease) else { return false }
        if !approved { return true } // Denial spends the run; never renew evidence/deadline.
        guard let action = command["action"] as? Object, let target = action["target"] as? Object,
              let window = liveWindow(target), let observation = action["observationId"] as? String,
              var snapshot = snapshots[observation],
              VisualPolicy.alive(capture: binding.captureMonotonic, observation: binding.observationMonotonic, current: monotonic()),
              let retained = semanticSafety.deadline(id: command["commandId"] as! String, fingerprint: fingerprint(command)),
              let wallDeadline = wireInteger(command["deadlineAt"]), let expiry = wireInteger(grant?["expiresAt"]),
              restoreApprovedWindow(window, deadline: retained, wallDeadline: wallDeadline, wallExpiry: expiry) else { return false }
        snapshot.inputMonotonic = monotonic() // Dialog input only, NOT snapshot/capture age.
        snapshots[observation] = snapshot
        guard visualValid(binding, command, window),
              effectAllowed(window, deadline: retained, wallDeadline: wallDeadline, wallExpiry: expiry) else { return false }
        binding.approved = true; visualBinding = binding; approvedCommand = pending
        commandDeadline = retained; accepted = true
        return true
    }
    private func consumeVisual(_ command: Object, _ payload: Object, _ window: Window) -> Object? {
        let binding = visualBinding
        visualAttempt.terminate() // At most one attempted dispatch, including refusal.
        guard let binding = binding, binding.approved, payload["leaseId"] as? String == binding.lease,
              visualAttempt.command == fingerprint(command), visualValid(binding, command, window) else {
            visualBinding = nil; approvedCommand = nil; return nil
        }
        visualExecuting = true
        return binding.action
    }
    private func endVisualExecution() {
        if visualExecuting { visualBinding = nil; visualExecuting = false }
    }
    private func localApprovalKind(_ command: Object) -> Bool {
        guard let action = command["action"] as? Object, let kind = action["kind"] as? String else { return false }
        return kind == "capture" || kind == "click"
    }
    private func beginLocalApproval(_ payload: Object) -> Bool {
        if let command = payload["command"] as? Object,
           let action = command["action"] as? Object, action["kind"] as? String == "click" { return false }
        guard clickOwnerReady(), validWirePayload("beginApproval", payload), approvalCommand == nil,
              let command = payload["command"] as? Object, exactLocalCommand(command, command),
              let deadline = wireInteger(command["deadlineAt"]), let commandID = wireString(command["commandId"]),
              localDeadlines[commandID] != nil || localDeadlines.count < 512 else { return false }
        // Anchor once at admission, not at approval completion or preparation.
        let anchored = monotonic() + min(30_000, deadline - now())
        let retained = min(localDeadlines[commandID] ?? anchored, anchored)
        localDeadlines[commandID] = retained
        localCommandDeadline = retained
        commandDeadline = retained
        var accepted = false
        defer { if !accepted { localCommandDeadline = nil; commandDeadline = .infinity } }
        guard authorized(command, payload["leaseId"] as? String ?? ""), captureAuthority(grant),
              CGPreflightScreenCaptureAccess(), let tap = inputTap, CGEvent.tapIsEnabled(tap: tap),
              let action = command["action"] as? Object, let target = action["target"] as? Object,
              let window = liveWindow(target), let snapshot = fresh(action, window), captureCohort(window, snapshot) else { return false }
        if action["kind"] as? String == "click" {
            guard let grant = grant, let native = clickSnapshot(command, payload["leaseId"] as? String ?? ""),
                  ClickIntent.validate(command: command, approved: command, grant: grant, snapshot: native,
                    clock: .init(wallMs: now(), monotonicMs: monotonic())) != nil else { return false }
        }
        approvedCommand = nil; approvalCommand = command
        guardLock.lock(); approvalOpen = true; watchdogDeadline = min(expiresMonotonic, retained); guardLock.unlock()
        accepted = true
        return true
    }
    private func endLocalApproval(_ payload: Object) -> Bool {
        guardLock.lock(); approvalOpen = false; guardLock.unlock()
        var accepted = false
        defer {
            approvalCommand = nil
            if !accepted { approvedCommand = nil; localCommandDeadline = nil; commandDeadline = .infinity }
        }
        approvedCommand = nil
        guard clickOwnerReady(), validWirePayload("endApproval", payload),
              let approved = wireBool(payload["approved"]), let command = payload["command"] as? Object,
              let pending = approvalCommand, exactLocalCommand(command, pending),
              authorized(command, payload["leaseId"] as? String ?? "") else { return false }
        if !approved {
            guardLock.lock(); watchdogDeadline = expiresMonotonic; guardLock.unlock()
            return true
        }
        guard let action = command["action"] as? Object, let target = action["target"] as? Object,
              let observationID = action["observationId"] as? String, let snapshot = snapshots[observationID],
              monotonic() - snapshot.monotonic < 5_000,
              let window = liveWindow(target), captureCohort(window, snapshot),
              let deadline = localCommandDeadline, let wallDeadline = wireInteger(command["deadlineAt"]),
              let expiry = wireInteger(grant?["expiresAt"]),
              restoreApprovedWindow(window, deadline: deadline, wallDeadline: wallDeadline, wallExpiry: expiry) else { return false }
        // Permit only the completed trusted local dialog's input, without making
        // old observations or frames young. The independent takeover tap stays live.
        var restored = snapshot; restored.inputMonotonic = monotonic()
        snapshots[observationID] = restored
        guard fresh(action, window) != nil, captureCohort(window, restored),
              authorized(command, payload["leaseId"] as? String ?? ""), CGPreflightScreenCaptureAccess(),
              let tap = inputTap, CGEvent.tapIsEnabled(tap: tap) else { return false }
        approvedCommand = pending
        if action["kind"] as? String == "click" {
            guard prepareClick(command, leaseId: payload["leaseId"] as? String ?? "") != nil else { return false }
        }
        // Retain the original monotonic deadline through any later preparation.
        accepted = true
        return true
    }
    func beginApproval(_ payload: Object) -> Bool {
        guard messagingReady, !semanticSafety.uncertain, !clickSpent else { return false } // readback capture uses session consent, not effect approval
        if let command = payload["command"] as? Object, localApprovalKind(command) { return beginLocalApproval(payload) }
        guard validWirePayload("beginApproval", payload), let command = payload["command"] as? Object,
              let action = command["action"] as? Object, let kind = action["kind"] as? String, semanticKind(kind),
              let deadline = wireInteger(command["deadlineAt"]), let commandID = wireString(command["commandId"]),
              let retained = semanticSafety.admit(id: commandID, fingerprint: fingerprint(command),
                  wallDeadline: deadline, wall: now(), monotonic: monotonic()) else { return false }
        guard approvalCommand == nil, approvedCommand == nil else { return false }
        // Arm the original bound BEFORE validation can block in AX/Security.
        // A refused/repeated attempt retains its binding; it cannot buy more time.
        commandDeadline = retained
        guardLock.lock(); watchdogDeadline = min(expiresMonotonic, retained); guardLock.unlock()
        defer {
            // Validation performed no effects. A conclusive refusal releases the
            // active timer, not the immutable per-ID deadline retained above.
            if approvalCommand == nil && approvedCommand == nil {
                commandDeadline = .infinity
                guardLock.lock(); watchdogDeadline = expiresMonotonic; guardLock.unlock()
            }
        }
        guard authorized(command, payload["leaseId"] as? String ?? ""),
              let target = action["target"] as? Object, let window = liveWindow(target),
              let snapshot = fresh(action, window), permittedSemantic(action, snapshot), unchanged(snapshot, window),
              let expiry = wireInteger(grant?["expiresAt"]),
              effectAllowed(window, deadline: retained, wallDeadline: deadline, wallExpiry: expiry) else { return false }
        commandDeadline = retained
        approvedCommand = nil; approvalCommand = command
        guardLock.lock(); approvalOpen = true
        watchdogDeadline = min(expiresMonotonic, retained)
        guardLock.unlock()
        return true
    }
    func endApproval(_ payload: Object) -> Bool {
        if isVisualApproval(payload) { return endVisualApproval(payload) }
        if let pending = approvalCommand, localApprovalKind(pending) { return endLocalApproval(payload) }
        guardLock.lock(); approvalOpen = false; guardLock.unlock()
        defer { approvalCommand = nil }
        approvedCommand = nil
        guard validWirePayload("endApproval", payload), let approved = wireBool(payload["approved"]),
              let command = payload["command"] as? Object, let pending = approvalCommand, exactSemanticCommand(command, pending),
              authorized(command, payload["leaseId"] as? String ?? "") else { return false }
        if !approved {
            approvedCommand = nil
            commandDeadline = .infinity
            guardLock.lock(); watchdogDeadline = expiresMonotonic; guardLock.unlock()
            return true
        }
        guard let action = command["action"] as? Object, let target = action["target"] as? Object,
              let window = liveWindow(target), let observationId = action["observationId"] as? String,
              let snapshot = snapshots[observationId], snapshot.observation["completeness"] as? String == "complete", permittedSemantic(action, snapshot),
              snapshot.refs.values.allSatisfy({ node($0.element, $0.node["ref"] as! String, $0.node["parentRef"] as? String).complete }),
              let commandID = wireString(command["commandId"]),
              let retained = semanticSafety.deadline(id: commandID, fingerprint: fingerprint(command)),
              let wallDeadline = wireInteger(command["deadlineAt"]), let expiry = wireInteger(grant?["expiresAt"]),
              restoreApprovedWindow(window, deadline: retained, wallDeadline: wallDeadline, wallExpiry: expiry), let previous = snapshot.observation["bounds"] as? Object,
              let b = bounds(window.element), same(previous, b), snapshot.observation["displayLayoutVersion"] as? String == layout(),
              NSWorkspace.shared.frontmostApplication?.processIdentifier == pid_t(target["processId"] as! Int),
              let focused = attr(window.application, kAXFocusedWindowAttribute), CFEqual(focused, window.element),
              unchanged(snapshot, window) else { return false }
        // Exact handles/state must survive the local dialog. No capture fallback.
        guard authorized(command, payload["leaseId"] as? String ?? "") else { return false }
        guard effectAllowed(window, deadline: retained, wallDeadline: wallDeadline, wallExpiry: expiry) else { return false }
        snapshots[observationId] = Snapshot(observation: snapshot.observation, refs: snapshot.refs, monotonic: monotonic())
        approvedCommand = command
        commandDeadline = retained
        guardLock.lock(); watchdogDeadline = min(expiresMonotonic, retained); guardLock.unlock()
        return true
    }
    func execute(_ payload: Object, timing: SourceRequestTiming? = nil) -> Object {
        let command = payload["command"] as? Object ?? [:]
        let commandId = wireString(command["commandId"]) ?? "invalid"
        func result(_ code: String, _ outcome: String = "not_executed", _ observation: Object? = nil) -> Object {
            var receipt: Object = ["commandId": commandId, "outcome": outcome, "code": code]
            if let observation = observation { receipt["observation"] = observation }; return receipt
        }
        guard validWirePayload("execute", payload), var action = command["action"] as? Object, var kind = action["kind"] as? String else { return result("denied") }
        defer { endVisualExecution() }
        let digest = fingerprint(command)
        // Metadata-only exact replay needs no live AX/deadline authority. Bind the
        // entire command AND private lease; never return pixels or re-enter AX.
        if let old = journal[commandId] {
            guard SemanticSafety.cachedReceiptMatches(fingerprint: digest,
                recorded: seen[commandId], lease: wireString(payload["leaseId"]), expectedLease: lease,
                channelAlive: brian_private_channel_alive() == 1) else { return result("denied") }
            return old
        }
        guard !semanticSafety.uncertain else { return result("denied") }
        // An unrelated read/attempt must not disarm an approved command's watchdog.
        if let approved = approvedCommand, !same(command, approved) { return result("denied") }
        if clickSpent && (!readbackOnly || !["observe", "capture"].contains(kind)) { return result("denied") }
        // Clicks use the private dispatcher handoff, never this AX executor.
        // Hard effect-class barrier, independent of grant or approval state.
        guard supportedExecution(command) else { return result("denied") }
        guard kind == "observe" || wireBool(grant?["allowControl"]) == true else { return result("denied") }
        guard kind != "capture" || captureAuthority(grant) else { return result("denied") }
        guard approvalCommand == nil, validCommand(command), let deadline = wireInteger(command["deadlineAt"]), authorized(command, payload["leaseId"] as? String ?? ""), let target = action["target"] as? Object else { return result("denied") }
        // No coordinate emitter exists in this AX executor; clicks use the private handoff.
        if kind == "click" { return result("unsupported") }
        if semanticKind(kind) || kind == "visualInvoke" {
            guard let retained = semanticSafety.deadline(id: commandId, fingerprint: digest) else { return result("approval_required") }
            commandDeadline = retained
        } else if let approved = approvedCommand, exactLocalCommand(command, approved), let anchored = localCommandDeadline {
            commandDeadline = anchored
            // Capture still requires the existing session/canvas authority. Burn
            // matching local approval on this attempt, retaining its bound through
            // capture; otherwise the pending-command fence would block readback.
            if kind == "capture" { approvedCommand = nil; localCommandDeadline = nil }
        } else {
            commandDeadline = monotonic() + deadline - now()
        }
        guardLock.lock(); watchdogDeadline = min(expiresMonotonic, commandDeadline); guardLock.unlock()
        defer {
            // Early refusal (e.g. a full journal) must not disarm an approval
            // still awaiting dispatch. Only a consumed approval releases its timer.
            if (!semanticKind(kind) && kind != "visualInvoke") || approvedCommand == nil {
                commandDeadline = Double.infinity
                guardLock.lock(); watchdogDeadline = expiresMonotonic; guardLock.unlock()
            }
        }
        if let old = journal[commandId] { return seen[commandId] == digest ? old : result("denied") }
        guard journal.count < 512 else { return result("denied") }
        seen[commandId] = digest
        // Mark BEFORE dispatch. No repeat, even after a partially failed AX call.
        journal[commandId] = result("helper_error", "execution_unknown")
        func finish(_ receipt: Object) -> Object {
            var metadata = receipt; metadata.removeValue(forKey: "observation")
            journal[commandId] = metadata; return receipt
        }
        guard let window = liveWindow(target) else { return finish(result("wrong_target")) }
        if kind == "visualInvoke" {
            guard let resolved = consumeVisual(command, payload, window) else { return finish(result("denied")) }
            action = resolved; kind = "invoke"
        }
        if kind == "observe" {
            guard let observation = observe(command, window), authorized(command, payload["leaseId"] as? String ?? "") else { return finish(result("expired")) }
            if readbackOnly {
                var exported = observation
                // Remove effect affordances from the EXPORTED readback only.
                // Native refs/snapshot keep their original actions so safeCanvas
                // cannot misclassify an interactive subtree as a safe canvas.
                exported["nodes"] = (observation["nodes"] as? [Object] ?? []).map { node -> Object in
                    var value = node; value["actions"] = [String](); return value
                }
                return finish(result("ok", "executed", exported))
            }
            return finish(result("ok", "executed", observation))
        }
        // Capture is authorized by the exact session grant, never by an action
        // approval or desktop ceiling. capture() repeats authority and scope gates.
        if kind == "capture" { return finish(capture(command, action, window)) }
        guard let approved = approvedCommand, exactSemanticCommand(command, approved) else { return finish(result("approval_required")) }
        approvedCommand = nil
        guard let completeSnapshot = fresh(action, window), unchanged(completeSnapshot, window) else { return finish(result("stale_observation")) }
        guard permittedSemantic(action, completeSnapshot) else { return finish(result("denied")) }
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
        guard let expiry = wireInteger(grant?["expiresAt"]) else { return finish(result("denied")) }
        var error: AXError
        switch kind {
        case "invoke":
            guard effectAllowed(window, deadline: commandDeadline, wallDeadline: deadline, wallExpiry: expiry) else { return finish(result("expired")) }
            timing?.beginAPI(.api_invoke)
            error = AXUIElementPerformAction(ref.element, kAXPressAction as CFString)
            timing?.endAPI(returned: error == .success)
        case "select":
            if selectionAttribute(ref.element) {
                guard effectAllowed(window, deadline: commandDeadline, wallDeadline: deadline, wallExpiry: expiry) else { return finish(result("expired")) }
                timing?.beginAPI(.api_select)
                error = AXUIElementSetAttributeValue(ref.element, kAXSelectedAttribute as CFString, kCFBooleanTrue)
                timing?.endAPI(returned: error == .success)
            } else if current.value["role"] as? String == kAXRadioButtonRole, actionNames(ref.element).contains(kAXPressAction) {
                // Radio selection is idempotent, unlike a checkbox toggle.
                guard effectAllowed(window, deadline: commandDeadline, wallDeadline: deadline, wallExpiry: expiry) else { return finish(result("expired")) }
                timing?.beginAPI(.api_select)
                error = AXUIElementPerformAction(ref.element, kAXPressAction as CFString)
                timing?.endAPI(returned: error == .success)
            } else { return finish(result("unsupported")) }
        case "scroll":
            // One native semantic increment/decrement, NOT a pixel-wheel emulation.
            guard let delta = wireInteger(action["deltaY"], min: -600, max: 600), delta != 0 else { return finish(result("denied")) }
            let operation = delta > 0 ? kAXIncrementAction : kAXDecrementAction
            guard actionNames(ref.element).contains(operation) else { return finish(result("unsupported")) }
            guard effectAllowed(window, deadline: commandDeadline, wallDeadline: deadline, wallExpiry: expiry) else { return finish(result("expired")) }
            timing?.beginAPI(.api_scroll)
            error = AXUIElementPerformAction(ref.element, operation as CFString)
            timing?.endAPI(returned: error == .success)
        case "setValue":
            guard let text = action["text"] as? String, text.utf16.count <= 4096, !text.contains("\u{0000}") else { return finish(result("denied")) }
            guard effectAllowed(window, deadline: commandDeadline, wallDeadline: deadline, wallExpiry: expiry) else { return finish(result("expired")) }
            timing?.beginAPI(.api_set_value)
            error = AXUIElementSetAttributeValue(ref.element, kAXValueAttribute as CFString, text as CFString)
            timing?.endAPI(returned: error == .success)
        default: return finish(result("unsupported"))
        }
        snapshots.removeAll()
        // AX timeout/error may be after delivery; never report "not executed" or retry.
        guard error == .success else {
            semanticSafety.markUncertain() // No new ID/observation/approval can reopen effects.
            return finish(result("helper_error", "execution_unknown"))
        }
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
               area == r, entry[kCGWindowName as String] as? String == captureWindowTitle(window),
               let number = entry[kCGWindowNumber as String] as? UInt32 { return number }
            if area.intersects(r), (entry[kCGWindowAlpha as String] as? Double ?? 1) > 0 { return nil }
        }
        return nil
    }
    func uniqueCanvasWindow(_ window: Window, _ number: CGWindowID) -> Bool {
        guard let expected = bounds(window.element), let peers = attr(window.application, kAXWindowsAttribute) as? [AXUIElement],
              peers.count <= 32,
              peers.filter({ element in
                  string(element, kAXTitleAttribute) == captureWindowTitle(window) &&
                  string(element, kAXIdentifierAttribute) == captureWindowIdentifier(window) &&
                  bounds(element).map { same($0, expected) } == true
              }).count == 1,
              let entries = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [Object] else { return false }
        let matches = entries.filter { entry in
            guard entry[kCGWindowOwnerPID as String] as? Int == Int(window.identity.pid),
                  entry[kCGWindowName as String] as? String == captureWindowTitle(window),
                  let b = entry[kCGWindowBounds as String] as? Object,
                  let r = CGRect(dictionaryRepresentation: b as CFDictionary) else { return false }
            return r == rect(expected)
        }
        return matches.count == 1 && matches[0][kCGWindowNumber as String] as? UInt32 == number && visibleWindowID(window) == number
    }

    // Guardian-only reuse of observation/privacy/capture validators. Must run on
    // its AX preparation queue, never in either input tap callback.
    func reconstructClick(_ descriptor: ClickScopeDescriptor, command: Object, grant approvedGrant: Object,
                          leaseId: String, epochFence: ProcessEpochFence, invalidate: @escaping () -> Void) -> ClickGuardianPreparedScope? {
        guard guardianInvalidation != nil, descriptor.matches(command), descriptor.fresh(),
              captureAuthority(approvedGrant), AXIsProcessTrusted(), CGPreflightScreenCaptureAccess() else { return nil }
        guard epochFence.pid == descriptor.pid, epochFence.clean() else { return nil }
        _ = discoverTargets(only: descriptor.pid, standingFence: epochFence)
        let matches = windows.values.filter { window in
            window.identity.pid == descriptor.pid && descriptor.matchesProcess(window.identity) &&
                bounds(window.element).map { same($0, descriptor.bounds) } == true &&
                uniqueCanvasWindow(window, descriptor.windowNumber)
        }
        guard matches.count == 1, let discovered = matches.first,
              let action = command["action"] as? Object, let logicalTarget = action["target"] as? Object,
              let key = logicalTarget["windowInstanceId"] as? String else { return nil }
        // Logical IDs correlate approval only. Native AX handle, membership,
        // standing epoch fence and CG window number above established the scope.
        let window = Window(target: logicalTarget, element: discovered.element, application: discovered.application,
            applicationWindows: discovered.applicationWindows, launch: discovered.launch, identity: discovered.identity, epochFence: discovered.epochFence)
        windows = [key: window]; grant = approvedGrant; lease = leaseId
        expiresMonotonic = descriptor.grantDeadline
        commandDeadline = descriptor.commandDeadline
        guard let prepared = ClickGuardianPreparedScope(window: window, descriptor: descriptor,
                grantExpiresAt: wireInteger(approvedGrant["expiresAt"])!, invalidate: invalidate),
              prepared.subscribe(), let observed = observe(command, window),
              let observedID = observed["id"] as? String, let original = snapshots[observedID],
              safeCanvas(window, original), ClickScopeDescriptor.fingerprint(original) == descriptor.fingerprint else { return nil }
        var observation = original.observation
        observation["id"] = descriptor.observationID
        let snapshot = Snapshot(observation: observation, refs: original.refs, monotonic: original.monotonic)
        snapshots = [descriptor.observationID: snapshot]
        // Independently capture selected window twice, validating AX/privacy,
        // membership, occlusion, display and geometry before/after BOTH captures.
        for _ in 0..<2 {
            guard prepared.validForPreparation(), descriptor.fresh(), authorized(command, leaseId),
                  fresh(action, window) != nil, safeCanvas(window, snapshot),
                  uniqueCanvasWindow(window, descriptor.windowNumber),
                  ClickScopeDescriptor.fingerprint(snapshot) == descriptor.fingerprint,
                  let (png, width, height) = pixels(command, action, window, snapshot),
                  width == descriptor.width, height == descriptor.height,
                  ClickScopeDescriptor.digest(png) == descriptor.pngDigest,
                  descriptor.matchesProcess(window.identity), descriptor.fresh(),
                  unchanged(snapshot, window), layout() == descriptor.displayLayout,
                  uniqueCanvasWindow(window, descriptor.windowNumber) else { prepared.invalidate(); return nil }
        }
        guard prepared.validForPreparation(), let binding = descriptor.binding(command: command) else { return nil }
        prepared.seal(binding: binding)
        return prepared
    }

    func revalidateGuardianClick(_ prepared: ClickGuardianPreparedScope, command: Object) -> Bool {
        guard guardianInvalidation != nil, prepared.validForPreparation(),
              let action = command["action"] as? Object,
              let snapshot = snapshots[prepared.descriptor.observationID],
              prepared.descriptor.fresh(), authorized(command, lease),
              safeCanvas(prepared.window, snapshot), uniqueCanvasWindow(prepared.window, prepared.descriptor.windowNumber),
              let (png, width, height) = pixels(command, action, prepared.window, snapshot),
              width == prepared.descriptor.width, height == prepared.descriptor.height,
              ClickScopeDescriptor.digest(png) == prepared.descriptor.pngDigest,
              ClickScopeDescriptor.fingerprint(snapshot) == prepared.descriptor.fingerprint,
              prepared.descriptor.matchesProcess(prepared.window.identity), prepared.descriptor.fresh(),
              uniqueCanvasWindow(prepared.window, prepared.descriptor.windowNumber),
              prepared.validForPreparation(), let intent = prepared.intent(), prepared.validates(intent) else { return false }
        return true
    }

    private func pixels(_ command: Object, _ action: Object, _ window: Window, _ snapshot: Snapshot) -> (Data, Int, Int)? {
        guard brian_private_channel_alive() == 1 else { if let invalidate = guardianInvalidation { invalidate(); return nil }; _exit(70) }
        guard captureAuthority(grant), authorized(command, lease), fresh(action, window) != nil,
              captureCohort(window, snapshot), CGPreflightScreenCaptureAccess(),
              let expectedBounds = snapshot.observation["bounds"] as? Object,
              let number = visibleWindowID(window) else { return nil }
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
            guard selected.frame == self.rect(expectedBounds), self.captureStillValid(command, action, window, snapshot),
                  self.visibleWindowID(window) == number, self.uniqueCanvasWindow(window, number),
                  configuration.width > 0, configuration.height > 0, configuration.width <= 1024, configuration.height <= 1024 else { done.signal(); return }
            configuration.showsCursor = false
            configuration.ignoreShadowsSingleWindow = true
            guard brian_private_channel_alive() == 1 else { done.signal(); return }
            SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) { image, error in
                if error == nil, let image = image,
                   image.width == configuration.width, image.height == configuration.height,
                   let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]), png.count <= 2_000_000 {
                    output = (png, image.width, image.height)
                }
                done.signal()
            }
        }
        // Watchdog/parent kills this process on deadline even if SCK hangs.
        done.wait()
        guard captureStillValid(command, action, window, snapshot), visibleWindowID(window) == number, uniqueCanvasWindow(window, number) else { return nil }
        guard brian_private_channel_alive() == 1 else { if let invalidate = guardianInvalidation { invalidate(); return nil }; _exit(70) }
        return output
    }
    private func captureStillValid(_ command: Object, _ action: Object, _ window: Window, _ snapshot: Snapshot) -> Bool {
        return captureAuthority(grant) && authorized(command, lease) && fresh(action, window) != nil &&
            captureCohort(window, snapshot) && CGPreflightScreenCaptureAccess() && brian_private_channel_alive() == 1
    }
    private func capture(_ command: Object, _ action: Object, _ window: Window) -> Object {
        func denied(_ code: String) -> Object { ["commandId": command["commandId"]!, "outcome": "not_executed", "code": code] }
        let visual = visualReserved(window)
        let visualAdmitted = !visual || reserveVisualCapture(command)
        var captured = false
        defer { if visual && !captured { terminateVisual() } }
        visualBinding = nil
        frame = nil; frameObservation = ""; frameMonotonic = nil // Failed attempts never leave a reusable frame.
        guard visualAdmitted, captureAuthority(grant), authorized(command, lease), CGPreflightScreenCaptureAccess() else { return denied("denied") }
        guard monotonic() - lastCapture >= 1000, let snapshot = fresh(action, window), captureCohort(window, snapshot) else { return denied("stale_observation") }
        lastCapture = monotonic()
        let captureStarted = monotonic() // Conservative capture age, before asynchronous SCK.
        guard let (png, width, height) = pixels(command, action, window, snapshot),
              captureStillValid(command, action, window, snapshot), monotonic() - captureStarted < 5_000 else { return denied("stale_observation") }
        let value: Object = ["id": id(), "mimeType": "image/png", "data": png.base64EncodedString(), "width": width, "height": height,
                             "bounds": snapshot.observation["bounds"]!, "displayLayoutVersion": snapshot.observation["displayLayoutVersion"]!]
        frame = value; frameObservation = action["observationId"] as! String
        frameMonotonic = captureStarted
        captured = true
        var observation = snapshot.observation; observation["frame"] = value
        if visual { observation["captureCohort"] = "public-shapes-v1" }
        snapshots[frameObservation] = Snapshot(observation: observation, refs: snapshot.refs, monotonic: snapshot.monotonic, inputMonotonic: snapshot.inputMonotonic)
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
// Closed executable roles only; both pass the identical signed bootstrap and
// private standard-pipe admission. No argument/environment can enable input.
let helperArguments = Array(CommandLine.arguments.dropFirst())
guard helperArguments.isEmpty || helperArguments == ["--click-guardian"] else { _exit(64) }
guard let trust = ProcessTrust() else { _exit(77) }
if helperArguments == ["--click-guardian"] { ClickGuardianHost(trust: trust).run() }
// Capturing the factory does not initialize AX or the takeover monitor.
let dispatcher = ObservationDispatcher { Broker(trust: trust) }
let sourceClock = SourceClock()
DispatchQueue.global(qos: .userInitiated).async {
while let header = readExactly(4) {
    let length = header.reduce(0) { ($0 << 8) | Int($1) }
    guard length > 0, length <= maxBytes, let data = readExactly(length), let request = (try? JSONSerialization.jsonObject(with: data)) as? Object,
          validWireRequest(request) else { exit(64) }
    guard trust.parentValid() else { _exit(77) }
    guard brian_private_channel_alive() == 1 else { _exit(70) }
    guard let response = dispatcher.response(request, clock: sourceClock) else { exit(64) }
    guard brian_private_channel_alive() == 1 else { _exit(70) }
    guard let output = try? JSONSerialization.data(withJSONObject: response), output.count <= maxBytes else { exit(65) }
    var size = UInt32(output.count).bigEndian
    FileHandle.standardOutput.write(Data(bytes: &size, count: 4))
    FileHandle.standardOutput.write(output)
}
exit(0)
}
RunLoop.main.run()
