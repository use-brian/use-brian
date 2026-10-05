// Production policy and visualValid are extracted verbatim. Only native dependencies are fake.
typealias CFString = String
let kAXTextAreaRole = "AXTextArea", kAXSheetRole = "AXSheet", kAXRadioButtonRole = "AXRadioButton"
let kAXSelectedAttribute = "AXSelected", kAXIncrementAction = "AXIncrement", kAXDecrementAction = "AXDecrement", kAXValueAttribute = "AXValue"
var delivered = 0
var onDelivery: (() -> Void)?
func brian_private_channel_alive() -> Int { 1 }
func AXUIElementPerformAction(_ element: Int, _ action: String) -> AXError {
    delivered += 1; onDelivery?(); return .success
}
func AXUIElementSetAttributeValue(_ element: Int, _ attr: String, _ value: Any?) -> AXError {
    preconditionFailure("visual invocation must never set a value")
}
struct NodeRead { var complete = true; var value: Object }
typealias AXUIElement = Int
typealias ProcessIdentity = Int
func CFEqual(_ a: Int, _ b: Int) -> Bool { a == b }
func same(_ a: Object, _ b: Object) -> Bool {
    (try! JSONSerialization.data(withJSONObject: a, options: [.sortedKeys])) ==
        (try! JSONSerialization.data(withJSONObject: b, options: [.sortedKeys]))
}
// C outputs are injected to exercise the real Swift defensive wrapper, not C parsing.
var pinCount: Int32 = 0
var pinBytes = [UInt8](repeating: 0, count: 40)
func brian_visual_fixture_hashes_copy(_ output: UnsafeMutablePointer<UInt8>?, _ capacity: Int) -> Int32 {
    precondition(capacity == 40)
    for i in 0..<40 { output![i] = pinBytes[i] }
    return pinCount
}
var clock = 100.0
func monotonic() -> Double { clock }
var permission = true
func CGPreflightScreenCaptureAccess() -> Bool { permission }
let kAXPressAction = "AXPress"
extension Int { var pid: Int32 { Int32(self) } }
struct Window { var identity = 42; var element = 1; var application = 2 }
enum AXError { case success, failure }
var hitElement = 3
func AXUIElementCopyElementAtPosition(_ app: Int, _ x: Float, _ y: Float, _ hit: inout Int?) -> AXError { hit = hitElement; return .success }
func AXUIElementGetPid(_ element: Int, _ pid: inout Int32) -> AXError { pid = 42; return .success }
func id() -> String { "binding" }
struct Ref { var element = 3; var node: Object }
struct Snapshot { var monotonic = 100.0; var refs: [String: Ref]; var inputMonotonic: Double? = nil }
let box: Object = ["x": -480, "y": 20, "width": 480, "height": 240]
var checks = 0
func check(_ value: Bool, _ label: String = "visual regression", line: Int = #line) {
    checks += 1; precondition(value, "\(label) (check \(checks), extracted line \(line))")
}
for count: Int32 in [-1, 0, 3, 100] {
    pinCount = count; check(visualFixtureExpectedCDHashes().isEmpty)
}
pinCount = 1; check(visualFixtureExpectedCDHashes().isEmpty)
pinBytes[0] = 1; check(visualFixtureExpectedCDHashes() == [Data(pinBytes.prefix(20))])
pinBytes[20] = 2; check(visualFixtureExpectedCDHashes().isEmpty)
pinCount = 2; check(visualFixtureExpectedCDHashes().count == 2)
pinBytes[20] = 1; check(visualFixtureExpectedCDHashes().isEmpty)
pinBytes[20] = 0; check(visualFixtureExpectedCDHashes().isEmpty)
let p = VisualPolicy.point(x: 240, y: 120, width: 480, height: 240, bounds: box)!
check(p.0 == -240 && p.1 == 140)
for v in [-1.0, 480, .nan, .infinity, -.infinity] {
    check(VisualPolicy.point(x: v, y: 1, width: 480, height: 240, bounds: box) == nil)
}
for v in [0.0, -1, 1025, .nan, .infinity] {
    check(VisualPolicy.point(x: 1, y: 1, width: v, height: 240, bounds: box) == nil)
}
for point in [(-480.0, 21.0), (0.0, 21.0), (-479.0, 20.0), (-479.0, 260.0), (Double.nan, 21.0)] {
    check(!VisualPolicy.contains(box, point))
}
check(VisualPolicy.contains(box, p))
for current in [100.0, 5099.999] { check(VisualPolicy.alive(capture: 100, observation: 100, current: current)) }
for current in [99.0, 5100, .nan, .infinity] { check(!VisualPolicy.alive(capture: 100, observation: 100, current: current)) }
check(!VisualPolicy.alive(capture: 100, observation: 99, current: 5099))
check(!VisualPolicy.alive(capture: .nan, observation: 100, current: 100))
let ids = ["brian-public-shapes-v1", "public-shapes-content-v1", "slot-1", "slot-2", "slot-3", "public-shapes-result-v1"]
let roles = ["AXWindow", "AXGroup", "AXButton", "AXButton", "AXButton", "AXStaticText"]
let names = ["Brian Public Shapes v1", "Public shapes", "Option 1", "Option 2", "Option 3", "Result"]
let boxes = [[0,0,480,240], [0,0,480,240], [30,60,120,100], [180,60,120,100], [330,60,120,100], [30,190,420,24]]
let nodes: [Object] = (0..<6).map { i -> Object in
    let bounds: Object = ["x": boxes[i][0] - 480, "y": boxes[i][1] + 20, "width": boxes[i][2], "height": boxes[i][3]]
    let parent: Int = i == 0 ? -1 : (i == 1 ? 0 : 1)
    let actions: [String] = (2...4).contains(i) ? ["invoke"] : []
    return ["identifier": ids[i], "role": roles[i], "subrole": i == 0 ? "AXStandardWindow" : "",
     "name": names[i], "sensitive": false, "enabled": true, "parent": parent,
     "actions": actions, "value": i == 5 ? "None" : "", "bounds": bounds]
}
check(VisualPolicy.cohort(nodes, bounds: box))
for i in nodes.indices {
    for field in ["identifier", "role", "subrole", "name", "sensitive", "parent", "actions", "bounds", "value"] {
        var changed = nodes; changed[i][field] = "forged"
        check(!VisualPolicy.cohort(changed, bounds: box), "cohort \(i)/\(field)")
    }
    var changed = nodes; changed.remove(at: i); check(!VisualPolicy.cohort(changed, bounds: box))
}
for i in 2...4 { var changed = nodes; changed[i]["enabled"] = false; check(!VisualPolicy.cohort(changed, bounds: box)) }
for stage in 0...2 {
    var attempt = VisualAttempt()
    check(!attempt.bind(Data([2])))
    if stage > 0 { check(attempt.reserveCapture(Data([1]))); check(!attempt.reserveCapture(Data([1]))) }
    if stage > 1 { check(attempt.bind(Data([2]))); check(!attempt.bind(Data([2]))); check(!attempt.bind(Data([3]))) }
    attempt.terminate(); check(!attempt.reserveCapture(Data([4]))); check(!attempt.bind(Data([4])))
}
let bindingIdentity: Object = ["deploymentId": "d", "userId": "u", "workspaceId": "w", "deviceId": "device", "sessionId": "s", "conversationId": "c", "taskId": "t"]
let bindingTarget: Object = ["appId": "com.usebrian.NativeComputerFixture", "processId": 42, "processInstanceId": "p", "windowId": "w", "windowInstanceId": "wi"]
let bindingGrant: Object = ["protocol": proto, "identity": bindingIdentity, "grantId": "g", "epoch": 1,
    "expiresAt": 200_000, "targets": [bindingTarget], "allowControl": true, "allowCapture": true,
    "requester": "Local user", "goal": "Activate the outlined triangle; finish when Result is Triangle."]
check(captureAuthority(bindingGrant))
final class BindingHarness {
    fileprivate var visualBinding: VisualBinding?
    var visualExecuting = false
    func evidenceAlive() -> Bool { visualEvidenceAlive() }
    var onAuthority: (() -> Void)?
    var lease = "lease"
    var frame: Object? = ["id": "frame"]
    var frameObservation: String? = "obs"
    var frameMonotonic: Double? = 100
    var snapshot: Snapshot? = Snapshot(refs: ["ref": Ref(node: ["role": "AXButton", "enabled": true, "bounds": box])])
    var grant: Object? = bindingGrant
    var authority = true, cohort = true, visible = true, unique = true, reachableValue = true
    var actions = [kAXPressAction]
    func fresh(_ action: Object, _ window: Window) -> Snapshot? { snapshot }
    func publicShapes(_ window: Window, _ snapshot: Snapshot) -> Bool { cohort }
    func visibleWindowID(_ window: Window) -> Int? { visible ? 1 : nil }
    func uniqueCanvasWindow(_ window: Window, _ number: Int) -> Bool { unique }
    func actionNames(_ element: Int) -> [String] { actions }
    func reachable(_ element: Int, in window: Int) -> Bool { reachableValue }
    func authorized(_ command: Object, _ lease: String) -> Bool { onAuthority?(); return authority }
    var visualAttempt = VisualAttempt()
    var semanticSafety = SemanticSafety()
    var approvalCommand: Object?, approvedCommand: Object?
    var commandDeadline = Double.infinity, expiresMonotonic = 199100.0, watchdogDeadline = 199100.0
    var approvalOpen = false, messagingReady = true, clickSpent = false
    let guardLock = NSLock()
    var snapshots: [String: Snapshot] = [:]
    var onRestore: (() -> Void)?
    var channelAlive = true
    func fingerprint(_ value: Object) -> Data { try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
    func liveWindow(_ target: Object) -> Window? { Window() }
    func restoreApprovedWindow(_ window: Window, deadline: Double, wallDeadline: Double, wallExpiry: Double) -> Bool {
        onRestore?(); return channelAlive
    }
    func effectAllowed(_ window: Window, deadline: Double, wallDeadline: Double, wallExpiry: Double) -> Bool {
        channelAlive && visualEvidenceAlive() && clock < deadline
    }
    func end(_ payload: Object) -> Bool { endVisualApproval(payload) }
    func consume(_ command: Object, _ payload: Object) -> Object? { consumeVisual(command, payload, Window()) }
    func finish() { endVisualExecution() }
    func invalidate() { invalidateVisualEvidence() }
    var journal: [String: Object] = [:], seen: [String: Data] = [:]
    var readbackOnly = false
    var localCommandDeadline: Double?
    func validCommand(_ command: Object) -> Bool { validWireCommand(command) }
    func observe(_ command: Object, _ window: Window) -> Object? { ["nodes": []] }
    func capture(_ command: Object, _ action: Object, _ window: Window) -> Object { preconditionFailure("no visual recapture") }
    func unchanged(_ snapshot: Snapshot, _ window: Window) -> Bool { cohort }
    func permittedSemantic(_ action: Object, _ snapshot: Snapshot) -> Bool { cohort }
    func hasNoSheetChildren(_ element: Int) -> Bool { true }
    func node(_ element: Int, _ key: String, _ parent: String?) -> NodeRead { NodeRead(value: snapshot!.refs[key]!.node) }
    func selectionAttribute(_ element: Int) -> Bool { false }
    // PRODUCTION BINDING PREDICATE
    fileprivate func run(_ binding: VisualBinding, _ command: Object, _ window: Window) -> Bool { visualValid(binding, command, window) }
}
let command: Object = ["commandId": "command", "action": ["frameId": "frame", "observationId": "obs", "x": 240, "y": 120]]
private let binding = VisualBinding(id: "binding", command: command, lease: "lease", action: ["ref": "ref"], frame: ["id": "frame"], captureMonotonic: 100, observationMonotonic: 100, element: 3, window: 1, identity: 42, point: p)
check(BindingHarness().run(binding, command, Window()))
let mutations: [(BindingHarness) -> Void] = [
    { $0.lease = "other" }, { $0.frame = nil }, { $0.frame = ["id": "other"] },
    { $0.frameObservation = "other" }, { $0.frameMonotonic = 101 }, { $0.snapshot = nil },
    { $0.snapshot!.monotonic = 101 }, { $0.snapshot!.refs = [:] },
    { $0.snapshot!.refs["ref"]!.element = 4 }, { $0.snapshot!.refs["ref"]!.node["enabled"] = false },
    { $0.snapshot!.refs["ref"]!.node["role"] = "AXGroup" },
    { $0.snapshot!.refs["ref"]!.node["bounds"] = ["x": 0, "y": 0, "width": 1, "height": 1] },
    { $0.grant = nil }, { $0.authority = false }, { $0.cohort = false }, { $0.visible = false },
    { $0.unique = false }, { $0.reachableValue = false }, { $0.actions = [] }
]
for mutate in mutations { let h = BindingHarness(); mutate(h); check(!h.run(binding, command, Window())) }
for field in ["commandId", "action", "extra"] { var changed = command; changed[field] = "forged"; check(!BindingHarness().run(binding, changed, Window())) }
check(!BindingHarness().run(binding, command, Window(identity: 43)))
check(!BindingHarness().run(binding, command, Window(element: 2)))
clock = 5100; check(!BindingHarness().run(binding, command, Window()))
clock = 99; check(!BindingHarness().run(binding, command, Window()))
clock = 100
let delayed = BindingHarness(); delayed.onAuthority = { clock = 5100 }
check(!delayed.run(binding, command, Window()), "blocking authority cannot renew frame age")
clock = 100
let effect = BindingHarness(); effect.visualBinding = binding; effect.visualExecuting = true
check(effect.evidenceAlive())
clock = 5100; check(!effect.evidenceAlive())
effect.visualBinding = nil; check(!effect.evidenceAlive())
effect.visualExecuting = false; check(effect.evidenceAlive())
clock = 100; permission = false; check(!BindingHarness().run(binding, command, Window()))
print("PASS \(checks) extracted production visual pin/coordinate/freshness/cohort/attempt/binding checks; native dependencies fake")

// Metadata is not pixel authority: localized and optional OS relations are
// deliberately never read by the production content predicate.
for description in ["button", "ボタン", "Schaltfläche", "按钮"] {
    let metadata: Object = ["AXRoleDescription": description, "AXTitleUIElement": 7,
        "AXDefaultButton": 3, "AXCancelButton": 4, "AXChildrenInNavigationOrder": [3,4], "AXFutureOSMetadata": "opaque"]
    var reads: [String] = []
    check(VisualPolicy.contentAttributes(nodes[2]) { name in
        reads.append(name)
        return metadata[name].map { .value($0) } ?? .absent
    })
    check(Set(reads).isDisjoint(with: metadata.keys))
}
for field in ["AXTitle", "AXDescription", "AXHelp", "AXValue", "AXMinimized", "AXModal"] {
    check(!VisualPolicy.contentAttributes(nodes[2]) { $0 == field ? .value("secret") : .absent })
    check(!VisualPolicy.contentAttributes(nodes[2]) { $0 == field ? .failed : .absent })
}
var extra = nodes; extra.append(nodes[2]); check(!VisualPolicy.cohort(extra, bounds: box))

// Match the production JSON-decoded Foundation containers, not Swift-literal
// nested dictionaries whose equality bridging differs on corelibs Foundation.
func decodedWire(_ object: Object) -> Object {
    try! JSONSerialization.jsonObject(with: JSONSerialization.data(withJSONObject: object)) as! Object
}
let lifecycleCommand = decodedWire(["protocol": proto, "identity": bindingIdentity, "grantId": "g", "epoch": 1,
    "commandId": "visual", "deadlineAt": 100000,
    "action": ["kind": "visualInvoke", "target": bindingTarget, "observationId": "obs", "frameId": "frame", "x": 240, "y": 120]])
let beginPayload: Object = ["command": lifecycleCommand, "leaseId": "lease"]
func endPayload(_ approved: Bool) -> Object {
    ["command": lifecycleCommand, "leaseId": "lease", "bindingId": "binding", "approved": approved]
}
func prepared() -> BindingHarness {
    clock = 100; permission = true; hitElement = 3
    let h = BindingHarness()
    h.frame = ["id": "frame", "width": 480, "height": 240, "bounds": box]
    h.snapshot!.refs["ref"]!.node["actions"] = ["invoke"]
    h.snapshot!.refs["ref"]!.node["sensitive"] = false
    h.snapshots["obs"] = h.snapshot!
    check(h.visualAttempt.reserveCapture(Data([1])))
    return h
}
let denial = prepared()
check(denial.beginVisualApproval(beginPayload) != nil)
check(denial.end(endPayload(false)))
check(denial.visualAttempt.terminal && denial.visualBinding == nil && denial.approvedCommand == nil)
check(denial.consume(lifecycleCommand, beginPayload) == nil)
check(denial.beginVisualApproval(beginPayload) == nil)
for mutate: (BindingHarness) -> Void in [
    { $0.frame = ["id": "changed"] }, { $0.frameObservation = "changed" },
    { $0.snapshot!.monotonic = 101 }, { $0.invalidate() },
    { $0.onRestore = { clock = 5100 } }, { $0.onAuthority = { clock = 5100 } },
    { $0.channelAlive = false }, { _ in permission = false }
] {
    let h = prepared(); check(h.beginVisualApproval(beginPayload) != nil)
    mutate(h); check(!h.end(endPayload(true)))
    check(h.consume(lifecycleCommand, beginPayload) == nil)
    check(h.visualAttempt.terminal)
}
let approved = prepared()
check(approved.beginVisualApproval(beginPayload) != nil)
clock = 200
check(approved.end(endPayload(true)))
check(approved.snapshots["obs"]!.inputMonotonic == 200)
check(approved.frameMonotonic == 100 && approved.snapshot!.monotonic == 100)
check(approved.consume(lifecycleCommand, beginPayload)?["ref"] as? String == "ref")
check(approved.visualExecuting)
approved.finish()
check(approved.consume(lifecycleCommand, beginPayload) == nil)
check(approved.beginVisualApproval(beginPayload) == nil)
let blocked = prepared(); blocked.onAuthority = { clock = 5100 }
check(blocked.beginVisualApproval(beginPayload) == nil)
let wrongHit = prepared(); hitElement = 4
check(wrongHit.beginVisualApproval(beginPayload) == nil)
print("PASS \(checks) total production visual policy/begin/end/consume checks; OS dependencies fake, no native delivery claim")

let executor = prepared(); delivered = 0
check(executor.beginVisualApproval(beginPayload) != nil)
check(executor.end(endPayload(true)))
let receipt = executor.execute(beginPayload)
check(receipt["outcome"] as? String == "executed", "approved production execute: \(receipt)")
check(delivered == 1 && executor.visualBinding == nil && !executor.visualExecuting)
let replay = executor.execute(beginPayload)
check(replay["outcome"] as? String == "executed" && replay["observation"] == nil && delivered == 1)
var changedCommand = lifecycleCommand; changedCommand["deadlineAt"] = 99999
check(executor.execute(["command": changedCommand, "leaseId": "lease"])["code"] as? String == "denied")
check(delivered == 1)
for mutate: (BindingHarness) -> Void in [
    { $0.frameObservation = "changed" }, { $0.snapshot!.monotonic = 101 },
    { _ in clock = 5100 }, { $0.channelAlive = false }
] {
    let h = prepared(); check(h.beginVisualApproval(beginPayload) != nil); check(h.end(endPayload(true)))
    mutate(h)
    check(h.execute(beginPayload)["outcome"] as? String == "not_executed")
    check(delivered == 1)
}
// Stop after OS entry cannot retract delivery. The next attempt is fenced;
// this explicitly does not model AX dispatch as an atomic claim.
let stopped = prepared(); check(stopped.beginVisualApproval(beginPayload) != nil); check(stopped.end(endPayload(true)))
onDelivery = { stopped.channelAlive = false }
check(stopped.execute(beginPayload)["outcome"] as? String == "executed")
check(delivered == 2)
onDelivery = nil
print("PASS \(checks) total production visual checks including execute/replay/Stop-after-entry; no native OS acceptance")


// Execute the actual scope predicate, not a replacement identity comparator.
struct ScopeTrust { func parentValid() -> Bool { true } }
func AXIsProcessTrusted() -> Bool { true }
final class ScopeHarness {
    let trust = ScopeTrust()
    var messagingReady = true
    var grant: Object? = decodedWire(bindingGrant)
    let lease = "lease"
    let expiresMonotonic = 199100.0, commandDeadline = 199100.0
    func validCommand(_ command: Object) -> Bool { validWireCommand(command) }
    func liveWindow(_ target: Object) -> Window? { Window() }
    // PRODUCTION SCOPE PREDICATE
    func accepts(_ command: Object) -> Bool { scopedAuthority(command, lease) }
}
var profileIdentity = bindingIdentity
profileIdentity.removeValue(forKey: "taskId"); profileIdentity["profileId"] = "t"
var profileGrant = bindingGrant
profileGrant["identity"] = profileIdentity
profileGrant.removeValue(forKey: "goal"); profileGrant["purpose"] = "chat-tools"
check(validWireGrant(decodedWire(profileGrant)))
check(publicShapesGrant(decodedWire(profileGrant)))
check(publicShapesGrant(decodedWire(bindingGrant)))
var wrongGoal = bindingGrant; wrongGoal["goal"] = "different"
check(!publicShapesGrant(decodedWire(wrongGoal)))
var mixed = profileGrant; mixed["goal"] = "different"
check(!publicShapesGrant(decodedWire(mixed)))
var profileCommand = lifecycleCommand; profileCommand["identity"] = profileIdentity
profileCommand = decodedWire(profileCommand)
clock = 100
let scope = ScopeHarness()
check(scope.accepts(lifecycleCommand))
check(!scope.accepts(profileCommand))
scope.grant = decodedWire(profileGrant)
check(scope.accepts(profileCommand))
check(!scope.accepts(lifecycleCommand))
var otherProfile = profileIdentity; otherProfile["profileId"] = "other"
var otherCommand = profileCommand; otherCommand["identity"] = otherProfile
check(!scope.accepts(decodedWire(otherCommand)))
// Goal-free profiles reach the verbatim resolved approval / execute path.
let chatExecutor = prepared(); chatExecutor.grant = decodedWire(profileGrant)
let chatPayload: Object = ["command": profileCommand, "leaseId": "lease"]
check(chatExecutor.beginVisualApproval(chatPayload) != nil)
check(chatExecutor.end(["command": profileCommand, "leaseId": "lease", "bindingId": "binding", "approved": true]))
let beforeChat = delivered
check(chatExecutor.execute(chatPayload)["outcome"] as? String == "executed")
check(delivered == beforeChat + 1)
print("PASS \(checks) profile/scope production checks; Foundation only")

let noApproval = prepared(); noApproval.grant = decodedWire(profileGrant)
check(noApproval.execute(chatPayload)["outcome"] as? String == "not_executed")
var ordinaryCommand = profileCommand
ordinaryCommand["action"] = ["kind": "invoke", "target": bindingTarget, "observationId": "obs", "ref": "ref"]
let ordinary = prepared(); ordinary.grant = decodedWire(profileGrant)
check(ordinary.execute(["command": decodedWire(ordinaryCommand), "leaseId": "lease"])["outcome"] as? String == "not_executed")
for mutate: (BindingHarness) -> Void in [
    { $0.grant?["allowControl"] = false }, { $0.grant?["allowCapture"] = false },
    { $0.cohort = false }, { $0.channelAlive = false },
    { _ in permission = false }, { _ in clock = 5100 }
] {
    let h = prepared(); h.grant = decodedWire(profileGrant)
    mutate(h)
    check(h.beginVisualApproval(chatPayload) == nil)
}
let staleChat = prepared(); staleChat.grant = decodedWire(profileGrant)
check(staleChat.beginVisualApproval(chatPayload) != nil)
clock = 5100
check(!staleChat.end(["command": profileCommand, "leaseId": "lease", "bindingId": "binding", "approved": true]))
check(staleChat.execute(chatPayload)["outcome"] as? String == "not_executed")
check(delivered == beforeChat + 1)
print("PASS \(checks) profile checks including consent, cohort, age, Stop and no-approval refusals")
