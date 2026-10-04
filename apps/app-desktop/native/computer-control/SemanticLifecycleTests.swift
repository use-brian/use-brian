// Test-only native dependencies for verbatim Broker methods extracted by the runner.
// No replacement approval/execute implementation, helper launch or runtime bypass.
typealias CFString = String
var testWall = 1000.0
var testMono = 100.0
var channelAlive = true
func monotonic() -> Double { testMono }
func brian_private_channel_alive() -> Int { channelAlive ? 1 : 0 }
func CGPreflightScreenCaptureAccess() -> Bool { true }
enum CGEvent { static func tapIsEnabled(tap: Int) -> Bool { true } }
final class EpochFence { func clean() -> Bool { true } }
struct Window { let target: Object; let element = 1; let application = 2; let epochFence = EpochFence() }
struct Ref { let element = 3; let node: Object }
struct Snapshot { let observation: Object; let refs: [String: Ref]; let monotonic: Double; var inputMonotonic: Double? = nil }
struct NodeRead { let complete = true; let value: Object }
let kAXFocusedWindowAttribute = "focusedWindow", kAXTextAreaRole = "AXTextArea", kAXSheetRole = "AXSheet"
let kAXRadioButtonRole = "AXRadioButton", kAXPressAction = "AXPress", kAXSelectedAttribute = "AXSelected"
let kAXIncrementAction = "AXIncrement", kAXDecrementAction = "AXDecrement", kAXValueAttribute = "AXValue"
final class NSWorkspace {
    static let shared = NSWorkspace()
    struct Application { let processIdentifier: Int32 = 42 }
    let frontmostApplication: Application? = Application()
}
func CFEqual(_ a: Any, _ b: Any) -> Bool { (a as? Int) == (b as? Int) }
func attr(_ element: Int, _ name: String) -> Int? { 1 }
// Fake native object equality uses canonical complete JSON; corelibs Foundation
// dictionary equality for bridged Bool/array AX-node fixtures differs from Darwin.
func same(_ a: Object, _ b: Object) -> Bool {
    (try! JSONSerialization.data(withJSONObject: a, options: [.sortedKeys])) ==
        (try! JSONSerialization.data(withJSONObject: b, options: [.sortedKeys]))
}
enum AXError { case success, cannotComplete }
var axResult = AXError.success
var axEffects = 0
var axOperations: [String] = []
func AXUIElementPerformAction(_ element: Int, _ action: String) -> AXError { axEffects += 1; axOperations.append("action:" + action); return axResult }
func AXUIElementSetAttributeValue(_ element: Int, _ attribute: String, _ value: Any?) -> AXError { axEffects += 1; axOperations.append("set:" + attribute); return axResult }
func json(_ value: Object) -> Object { try! JSONSerialization.jsonObject(with: JSONSerialization.data(withJSONObject: value)) as! Object }
let testIdentity: Object = json(["deploymentId": "d", "userId": "u", "workspaceId": "w", "deviceId": "device", "sessionId": "s", "conversationId": "c", "taskId": "t"])
let testTarget: Object = json(["appId": "com.usebrian.NativeComputerFixture", "processId": 42, "processInstanceId": "p", "windowId": "w", "windowInstanceId": "wi"])
let testBounds: Object = json(["x": 0, "y": 0, "width": 100, "height": 100])
func makeCommand(_ id: String, _ kind: String = "invoke", deadline: Double = 100_000, deltaY: Int = 1) -> Object {
    var action: Object = ["kind": kind, "target": testTarget]
    if kind != "observe" { action["observationId"] = "o" }
    if semanticKind(kind) { action["ref"] = "r" }
    if kind == "scroll" { action["deltaY"] = deltaY }
    return json(["protocol": proto, "identity": testIdentity, "grantId": "g", "epoch": 1,
            "commandId": id, "deadlineAt": deadline, "action": action])
}
func payload(_ command: Object, approved: Bool? = nil) -> Object {
    var p: Object = ["command": command, "leaseId": "lease"]
    if let approved = approved { p["approved"] = approved }
    return json(p)
}
final class LifecycleBroker {
    var semanticSafety = SemanticSafety()
    var messagingReady = true, clickSpent = false, readbackOnly = false
    var grant: Object? = ["protocol": proto, "identity": testIdentity, "grantId": "g", "epoch": 1,
        "expiresAt": 200_000, "targets": [testTarget], "allowControl": true, "allowCapture": true,
        "requester": "Local user", "goal": "Synthetic test"]
    let lease = "lease"
    var approvalCommand: Object?, approvedCommand: Object?
    var commandDeadline = Double.infinity, expiresMonotonic = 199_100.0
    let guardLock = NSLock()
    var watchdogActive = true, approvalOpen = false
    var watchdogDeadline = 199_100.0
    var inputTap: Int? = 1
    var localCommandDeadline: Double?
    var localDeadlines: [String: Double] = [:]
    var snapshots: [String: Snapshot] = [:]
    var journal: [String: Object] = [:], seen: [String: Data] = [:]
    var onFresh: (() -> Void)?
    var freshAvailable = true, captureAllowed = true
    var authorityCalls = 0, observations = 0, captures = 0
    var captureDeadline: Double?, captureHadPendingApproval: Bool?
    let nodeValue: Object
    var selectionWritable = true
    var nativeActions = [kAXPressAction, kAXIncrementAction, kAXDecrementAction]
    var selectionQueries = 0, actionQueries = 0
    var onSelectionQuery: (() -> Void)?, onActionQuery: (() -> Void)?
    init(kind: String = "invoke", role: String = "AXButton") {
        nodeValue = json(["ref": "r", "role": role, "sensitive": false, "actions": [kind]])
        seedSnapshot()
    }
    func seedSnapshot() {
        snapshots["o"] = Snapshot(observation: ["completeness": "complete", "bounds": testBounds,
            "displayLayoutVersion": "layout"], refs: ["r": Ref(node: nodeValue)], monotonic: testMono)
    }
    // The fake fingerprint is canonical complete bytes (no hash dependency on
    // Linux). The production matcher still compares the entire Data value.
    func fingerprint(_ command: Object) -> Data { try! JSONSerialization.data(withJSONObject: command, options: [.sortedKeys]) }
    func validCommand(_ command: Object) -> Bool { validWireCommand(command) }
    func authorized(_ command: Object, _ leaseId: String) -> Bool {
        authorityCalls += 1
        return leaseId == lease && testMono < commandDeadline && testMono < expiresMonotonic &&
            testWall < (wireInteger(command["deadlineAt"]) ?? 0) && channelAlive
    }
    func liveWindow(_ target: Object) -> Window? { Window(target: target) }
    func fresh(_ action: Object, _ window: Window) -> Snapshot? {
        onFresh?()
        return freshAvailable ? snapshots["o"] : nil
    }
    func permittedSemantic(_ action: Object, _ snapshot: Snapshot) -> Bool { true }
    func unchanged(_ snapshot: Snapshot, _ window: Window) -> Bool { true }
    func node(_ element: Int, _ ref: String, _ parent: String?) -> NodeRead { NodeRead(value: nodeValue) }
    func reachable(_ element: Int, in window: Int) -> Bool { true }
    func hasNoSheetChildren(_ window: Int) -> Bool { true }
    func bounds(_ element: Int) -> Object? { testBounds }
    func layout() -> String { "layout" }
    func restoreApprovedWindow(_ window: Window, deadline: Double, wallDeadline: Double, wallExpiry: Double) -> Bool {
        effectAllowed(window, deadline: deadline, wallDeadline: wallDeadline, wallExpiry: wallExpiry)
    }
    func selectionAttribute(_ element: Int) -> Bool {
        selectionQueries += 1; onSelectionQuery?(); return selectionWritable
    }
    func actionNames(_ element: Int) -> [String] {
        actionQueries += 1; onActionQuery?(); return nativeActions
    }
    func clickOwnerReady() -> Bool { true }
    func clickSnapshot(_ command: Object, _ lease: String) -> Int? { nil }
    func prepareClick(_ command: Object, leaseId: String) -> Int? { nil }
    func safeCanvas(_ window: Window, _ snapshot: Snapshot) -> Bool { captureAllowed }
    func observe(_ command: Object, _ window: Window) -> Object? {
        observations += 1; seedSnapshot(); return snapshots["o"]!.observation
    }
    func capture(_ command: Object, _ action: Object, _ window: Window) -> Object {
        captures += 1; captureDeadline = commandDeadline; captureHadPendingApproval = approvedCommand != nil
        return ["commandId": command["commandId"]!, "outcome": "executed", "code": "ok"]
    }
    // PRODUCTION BROKER METHODS
}
// Unreachable click dependency required to typecheck the verbatim local approval
// methods. A retired click is rejected before this dependency can ever be called.
enum ClickIntent {
    struct Clock { let wallMs: Double; let monotonicMs: Double }
    static func validate(command: Object, approved: Object, grant: Object, snapshot: Int, clock: Clock) -> Int? {
        preconditionFailure("retired click reached a test dependency")
    }
}
var lifecycleChecks = 0
func verify(_ condition: @autoclosure () -> Bool, _ message: String = "") {
    lifecycleChecks += 1; precondition(condition(), "lifecycle check \(lifecycleChecks): \(message)")
}
func resetClocks() { testWall = 1000; testMono = 100; channelAlive = true; axResult = .success; axEffects = 0; axOperations = [] }
// 1. Validation remains bounded while blocking, but conclusive stale refusal
// releases only the active timer. An independent command can run afterward.
resetClocks()
do {
    let b = LifecycleBroker(), refused = makeCommand("refused", deadline: 1100)
    b.freshAvailable = false
    b.onFresh = {
        verify(b.commandDeadline == 200 && b.watchdogDeadline == 200)
        testMono = 150
    }
    verify(!b.beginApproval(payload(refused)))
    verify(b.commandDeadline.isInfinite && b.watchdogDeadline == b.expiresMonotonic)
    verify(b.semanticSafety.deadline(id: "refused", fingerprint: b.fingerprint(refused)) == 200)
    testMono = 300; testWall = 1200
    b.onFresh = nil; b.freshAvailable = true
    let next = makeCommand("independent")
    verify(b.beginApproval(payload(next)))

    verify(b.endApproval(payload(next, approved: true)))
    let nextResult = b.execute(payload(next))
    verify(nextResult["outcome"] as? String == "executed", "receipt: \(nextResult)")
    verify(axEffects == 1)
    testWall = 1000 // rollback cannot renew the refused command's retained clock
    verify(!b.beginApproval(payload(refused)))
    verify(b.commandDeadline.isInfinite && b.watchdogDeadline == b.expiresMonotonic)
}
// 2. Fully approved semantic command survives an unrelated request, with its
// original timer and approval intact, then dispatches once.
resetClocks()
do {
    let b = LifecycleBroker(), command = makeCommand("approved")
    verify(b.beginApproval(payload(command)))
    verify(b.endApproval(payload(command, approved: true)))
    let deadline = b.commandDeadline
    verify(b.execute(payload(makeCommand("unrelated", "observe")))["code"] as? String == "denied")
    verify(b.approvedCommand != nil && b.commandDeadline == deadline && b.watchdogDeadline == deadline)
    verify(b.observations == 0 && axEffects == 0)
    verify(b.execute(payload(command))["outcome"] as? String == "executed")
    verify(axEffects == 1 && b.approvedCommand == nil)
    verify(b.commandDeadline.isInfinite && b.watchdogDeadline == b.expiresMonotonic)
}
// 3. Actual begin/end local capture approval, capture attempt, then observation.
// Scope still runs through production captureAuthority before the fake OS call.
resetClocks()
do {
    let b = LifecycleBroker(), command = makeCommand("capture", "capture")
    verify(b.beginApproval(payload(command)))
    verify(b.endApproval(payload(command, approved: true)))
    let deadline = b.commandDeadline
    verify(b.execute(payload(command))["outcome"] as? String == "executed")
    verify(b.captures == 1 && b.captureDeadline == deadline && b.captureHadPendingApproval == false)
    verify(b.approvedCommand == nil && b.localCommandDeadline == nil)
    verify(b.execute(payload(makeCommand("readback", "observe")))["outcome"] as? String == "executed")
    verify(b.observations == 1 && axEffects == 0)
}
// 4. AX uncertainty is terminal. Exact metadata replay after both clocks expire
// performs no authority calls, clock renewal, native reads or second effect.
resetClocks()
do {
    let b = LifecycleBroker(), command = makeCommand("unknown")
    verify(b.beginApproval(payload(command)))
    verify(b.endApproval(payload(command, approved: true)))
    axResult = .cannotComplete
    let receipt = b.execute(payload(command))
    verify(receipt["outcome"] as? String == "execution_unknown")
    verify(b.semanticSafety.uncertain && axEffects == 1)
    let authorityCalls = b.authorityCalls, timer = b.watchdogDeadline
    testWall = 300_000; testMono = 300_000
    verify(same(receipt, b.execute(payload(command))))
    verify(b.authorityCalls == authorityCalls && b.watchdogDeadline == timer && b.commandDeadline.isInfinite)
    verify(b.execute(payload(makeCommand("new-read", "observe")))["code"] as? String == "denied")
    verify(!b.beginApproval(payload(makeCommand("new-effect"))))
    verify(b.observations == 0 && axEffects == 1)
    var changed = command; changed["deadlineAt"] = 400_000
    verify(b.execute(payload(changed))["code"] as? String == "denied")
    var wrongLease = payload(command); wrongLease["leaseId"] = "other"
    verify(b.execute(wrongLease)["code"] as? String == "denied")
}
// 5. Hooks run only in execute's switch-time queries, after approval and the
// general authority check. Native node reads advertise the configured supported
// branch without themselves calling these hooks. This is not an AX simulator.
let branchCases: [(name: String, kind: String, role: String, writable: Bool, delta: Int, operation: String)] = [
    ("selected-attribute", "select", "AXRow", true, 1, "set:" + kAXSelectedAttribute),
    ("radio-fallback", "select", kAXRadioButtonRole, false, 1, "action:" + kAXPressAction),
    ("scroll-positive", "scroll", "AXScrollBar", true, 1, "action:" + kAXIncrementAction),
    ("scroll-negative", "scroll", "AXScrollBar", true, -1, "action:" + kAXDecrementAction),
]
var branchSequences = 0
for branch in branchCases {
    for change in ["success", "monotonic", "wall", "channel"] {
        resetClocks()
        let b = LifecycleBroker(kind: branch.kind, role: branch.role)
        b.selectionWritable = branch.writable
        b.nativeActions = branch.kind == "select" ? [kAXPressAction] :
            [branch.delta > 0 ? kAXIncrementAction : kAXDecrementAction]
        let command = makeCommand(branch.name + "-" + change, branch.kind, deltaY: branch.delta)
        verify(b.beginApproval(payload(command)), branch.name)
        verify(b.endApproval(payload(command, approved: true)), branch.name)
        let retained = b.commandDeadline
        let authorityBefore = b.authorityCalls
        verify(b.selectionQueries == 0 && b.actionQueries == 0)
        var hooks = 0
        let delayedRead: () -> Void = {
            hooks += 1
            // The exact approval has already been consumed by actual execute.
            verify(b.approvedCommand == nil && b.commandDeadline == retained)
            verify(b.watchdogDeadline == retained && b.authorityCalls > authorityBefore)
            switch change {
            case "monotonic":
                testMono = retained + 1
                testWall = 100 // Wall rollback leaves wall deadline/channel valid.
                verify(testWall < wireInteger(command["deadlineAt"])! && channelAlive)
            case "wall": testWall = wireInteger(command["deadlineAt"])! + 1
            case "channel": channelAlive = false
            default: break
            }
        }
        if branch.kind == "select" && branch.writable { b.onSelectionQuery = delayedRead }
        else { b.onActionQuery = delayedRead }
        let receipt = b.execute(payload(command))
        verify(hooks == 1, branch.name + ": switch query was not reached exactly once")
        verify(b.selectionQueries == (branch.kind == "select" ? 1 : 0))
        verify(b.actionQueries == (branch.kind == "select" && branch.writable ? 0 : 1))
        if change == "success" {
            verify(receipt["outcome"] as? String == "executed")
            verify(axEffects == 1 && axOperations == [branch.operation])
        } else {
            verify(receipt["outcome"] as? String == "not_executed" && receipt["code"] as? String == "expired", branch.name + "-" + change + ": expected pre-mutation refusal")
            verify(axEffects == 0 && axOperations.isEmpty, branch.name + "-" + change + ": late mutation")
        }
        verify(b.semanticSafety.deadline(id: command["commandId"] as! String, fingerprint: b.fingerprint(command)) == retained)
        let queries = b.selectionQueries + b.actionQueries
        let effects = axEffects
        let replay = b.execute(payload(command))
        if channelAlive {
            verify(replay["outcome"] as? String == receipt["outcome"] as? String)
            verify(replay["code"] as? String == receipt["code"] as? String)
            verify(replay["observation"] == nil) // Cached metadata, not a fresh read.
        } else {
            verify(replay["outcome"] as? String == "not_executed")
            verify(replay["code"] as? String == "denied")
        }
        verify(axEffects == effects && b.selectionQueries + b.actionQueries == queries && hooks == 1)
        branchSequences += 1
    }
}
// 6. Fully approved but not dispatched: expiry survives wall rollback, including
// another begin attempt, without changing the pending timer or the binding.
resetClocks()
do {
    let b = LifecycleBroker(), command = makeCommand("pending-expiry")
    verify(b.beginApproval(payload(command)))
    verify(b.endApproval(payload(command, approved: true)))
    let retained = b.commandDeadline
    testMono = retained + 1; testWall = 0
    verify(b.execute(payload(command))["outcome"] as? String == "not_executed")
    verify(axEffects == 0 && b.observations == 0)
    verify(b.approvedCommand != nil && b.commandDeadline == retained && b.watchdogDeadline == retained)
    verify(b.semanticSafety.deadline(id: "pending-expiry", fingerprint: b.fingerprint(command)) == retained)
    verify(!b.beginApproval(payload(command)))
    verify(b.commandDeadline == retained && b.watchdogDeadline == retained && axEffects == 0)
}
// 7. Explicit denial releases the active timer, but retrying the same ID before
// and after its original deadline cannot buy a fresh 30 seconds.
resetClocks()
do {
    let b = LifecycleBroker(), command = makeCommand("denied-retry")
    verify(b.beginApproval(payload(command)))
    let retained = b.commandDeadline
    verify(b.endApproval(payload(command, approved: false)))
    verify(b.approvedCommand == nil && b.approvalCommand == nil && b.commandDeadline.isInfinite)
    verify(b.watchdogDeadline == b.expiresMonotonic)
    testMono = retained - 1; testWall = 0
    verify(b.beginApproval(payload(command)))
    verify(b.commandDeadline == retained && b.watchdogDeadline == retained)
    verify(b.endApproval(payload(command, approved: false)))
    testMono = retained + 1
    verify(!b.beginApproval(payload(command)))
    verify(b.semanticSafety.deadline(id: "denied-retry", fingerprint: b.fingerprint(command)) == retained)
    verify(b.commandDeadline.isInfinite && b.watchdogDeadline == b.expiresMonotonic)
    verify(b.execute(payload(command))["outcome"] as? String == "not_executed")
    verify(axEffects == 0 && b.observations == 0)
}
print("PASS \(lifecycleChecks) extracted Broker lifecycle checks (4 original sequences, \(branchSequences) select/scroll branch sequences, 2 approval-clock sequences); fake native dependencies, no native/atomicity evidence")
