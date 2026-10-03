import Foundation

// Source-only portable tests. Compile with ClickIntent.swift and the existing
// Foundation-only Helper wire-function extraction used by WireBoundaryTests;
// do not link the live Helper entry point. No duplicate wire schemas here.
// These tests exercise policy, not native safeCanvas/AX or delivery evidence.
@main
struct ClickIntentTests {
    struct Fixture {
        var identity: Object = Dictionary(uniqueKeysWithValues:
            ["deploymentId", "userId", "workspaceId", "deviceId", "sessionId", "conversationId", "taskId"].map { ($0, "test" as Any) })
        var target: Object = ["appId": "fixture", "processId": 42, "processInstanceId": "process",
                              "windowId": "window", "windowInstanceId": "instance"]
        var bounds: Object = ["x": -300, "y": 25, "width": 200, "height": 100]
        var frame: Object
        var observation: Object
        var command: Object
        var approved: Object
        var grant: Object
        var frameTime = 900.0
        var observationTime = 800.0
        var grantDeadline = 10_000.0
        var commandDeadline = 9_000.0
        var wall = 1_000.0
        var mono = 1_000.0
        var layout = "layout"
        var frameObservationID = "observation"

        init() {
            frame = ["id": "frame", "mimeType": "image/png", "data": "native-cached-png",
                     "width": 400, "height": 400, "bounds": bounds, "displayLayoutVersion": "layout"]
            observation = ["id": "observation", "identity": identity, "epoch": 1, "target": target,
                           "capturedAt": 800, "monotonicMs": 800, "foreground": true,
                           "bounds": bounds, "displayLayoutVersion": "layout", "completeness": "complete",
                           "nodes": [["role": "AXWindow", "sensitive": false, "actions": [String]()]], "frame": frame]
            command = ["protocol": proto, "identity": identity, "grantId": "grant", "epoch": 1,
                       "commandId": "command", "deadlineAt": 9_000,
                       "action": ["kind": "click", "target": target, "observationId": "observation",
                                  "frameId": "frame", "x": 100, "y": 200] as Object]
            approved = command
            grant = ["protocol": proto, "identity": identity, "grantId": "grant", "epoch": 1,
                     "expiresAt": 10_000, "targets": [target], "allowControl": true,
                     "allowCapture": true, "requester": "test", "goal": "test"]
        }
        var snapshot: ClickIntent.Snapshot {
            .init(frame: frame, observation: observation, target: target, currentBounds: bounds,
                  currentLayout: layout, frameObservationID: frameObservationID,
                  frameMonotonicMs: frameTime, observationMonotonicMs: observationTime,
                  grantDeadlineMonotonicMs: grantDeadline, commandDeadlineMonotonicMs: commandDeadline)
        }
        var clock: ClickIntent.Clock { .init(wallMs: wall, monotonicMs: mono) }
        mutating func action(_ key: String, _ value: Any) {
            var action = command["action"] as! Object
            action[key] = value
            command["action"] = action
            approved = command
        }
        mutating func frameField(_ key: String, _ value: Any) {
            frame[key] = value
            observation["frame"] = frame
        }
        func validate() -> ClickIntent.Binding? {
            ClickIntent.validate(command: command, approved: approved, grant: grant, snapshot: snapshot, clock: clock)
        }
        func reserve(_ ledger: ClickIntent.Reservations) -> ClickIntent.Binding? {
            ledger.reserve(command: command, approved: approved, grant: grant, snapshot: snapshot, clock: clock)
        }
    }

    static func reject(_ mutate: (inout Fixture) -> Void) {
        var fixture = Fixture()
        mutate(&fixture)
        precondition(fixture.validate() == nil)
    }

    static func approvalCheckpointDoesNotRefreshObservation() {
        var fixture = Fixture()
        let originalObservationTime = fixture.observationTime // 800ms
        // A later capture remains fresh while its underlying observation expires.
        fixture.frameTime = 5_600
        let approvedDialogInputCheckpoint = 5_799.0
        fixture.mono = approvedDialogInputCheckpoint
        // Hold wall time constant to ensure MONOTONIC observation age, rather
        // than wall age, rejects stale state even across a wall-clock rollback.
        precondition(fixture.validate() != nil, "original observation just under 5s")
        fixture.approved = fixture.command // exact approval after the local dialog
        fixture.mono = approvedDialogInputCheckpoint + 1
        precondition(fixture.snapshot.observationMonotonicMs == originalObservationTime)
        precondition(fixture.mono - fixture.frameTime < 5_000)
        precondition(fixture.validate() == nil, "approval must not refresh original observation age")
        precondition(fixture.reserve(ClickIntent.Reservations()) == nil)
        // There is intentionally no input-checkpoint argument to ClickIntent:
        // takeover accounting belongs to the native owner, not capture freshness.
    }

    static func main() {
        let baseline = Fixture()
        precondition(validWireCommand(baseline.command), "baseline command wire schema")
        precondition(validWireGrant(baseline.grant), "baseline grant wire schema")
        precondition(captureAuthority(baseline.grant), "baseline capture consent")
        precondition(NSDictionary(dictionary: baseline.command).isEqual(NSDictionary(dictionary: baseline.approved)), "baseline exact approval")
        precondition(NSDictionary(dictionary: baseline.frame).isEqual(NSDictionary(dictionary: baseline.observation["frame"] as! Object)), "baseline embedded frame")
        guard let binding = baseline.validate() else { fatalError("baseline click binding rejected") }
        precondition(binding.globalX == -250 && binding.globalY == 75)
        precondition(binding.imageX == 100 && binding.imageY == 200)
        precondition(baseline.validate() == binding) // pure validation is repeatable
        // Exercise real JSON-decoded commands against Swift-built native caches,
        // as well as all-literal inputs. Both must retain identical exact binding.
        var decoded = baseline
        decoded.command = try! JSONSerialization.jsonObject(with: JSONSerialization.data(withJSONObject: baseline.command)) as! Object
        decoded.approved = try! JSONSerialization.jsonObject(with: JSONSerialization.data(withJSONObject: baseline.approved)) as! Object
        decoded.grant = try! JSONSerialization.jsonObject(with: JSONSerialization.data(withJSONObject: baseline.grant)) as! Object
        precondition(decoded.validate() == binding, "decoded wire / native cache equality")
        decoded.approved = baseline.approved
        precondition(decoded.validate() == binding, "mixed literal / decoded approval equality")
        approvalCheckpointDoesNotRefreshObservation()
        var edge = Fixture()
        edge.action("x", 0); edge.action("y", 0)
        precondition(edge.validate()!.globalX == -300 && edge.validate()!.globalY == 25)
        edge.action("x", 399); edge.action("y", 399)
        precondition(edge.validate()!.globalX == -100.5 && edge.validate()!.globalY == 124.75)
        for axis in ["x", "y"] {
            for invalid in [-1, 400, 401, 0.5, Double.nan, Double.infinity, -Double.infinity, true, "1", NSNull()] as [Any] {
                reject { $0.action(axis, invalid) }
            }
        }
        for field in ["width", "height"] {
            for invalid in [0, -1, 0.5, Double.nan, Double.infinity, true, "400"] as [Any] {
                reject { $0.frameField(field, invalid) }
            }
        }
        reject { $0.action("button", "right") }
        reject { $0.action("clickCount", 2) }
        reject { $0.action("modifiers", ["Shift"]) }
        reject { $0.action("kind", "drag") }
        reject {
            $0.command["action"] = ["kind": "key", "target": $0.target, "observationId": "observation", "key": "Enter"]
            $0.approved = $0.command
        }
        reject { $0.action("frameId", "foreign") }
        reject { $0.action("observationId", "foreign") }
        reject { $0.frameObservationID = "foreign" }
        reject { $0.target["windowInstanceId"] = "reused-window" }
        reject {
            var target = $0.target; target["windowId"] = "other-window"
            $0.action("target", target)
        }
        reject { $0.observation["target"] = ["windowId": "foreign"] }
        reject { $0.observation["epoch"] = 2 }
        reject { $0.observation["identity"] = ["taskId": "foreign"] }
        reject { $0.command["epoch"] = 2; $0.approved = $0.command }
        reject { $0.command["grantId"] = "foreign"; $0.approved = $0.command }
        reject {
            var identity = $0.identity; identity["taskId"] = "foreign"
            $0.command["identity"] = identity; $0.approved = $0.command
        }
        reject { $0.approved["commandId"] = "other" }
        reject { $0.approved["deadlineAt"] = 8_000 }
        reject { $0.action("x", 101); $0.approved = baseline.approved }
        reject { $0.grant["allowCapture"] = false }
        reject { $0.grant["allowControl"] = false }
        reject { $0.grant["allowCapture"] = 1 }
        reject { $0.grant["targets"] = [Object]() }
        reject { $0.grant["expiresAt"] = 1_000 }
        reject { $0.command["deadlineAt"] = 1_000; $0.approved = $0.command }
        reject { $0.grantDeadline = 1_000 }
        reject { $0.commandDeadline = 1_000 }
        reject { $0.grantDeadline = .infinity }
        reject { $0.commandDeadline = .nan }
        reject { $0.mono = .nan }
        reject { $0.wall = .infinity }
        reject { $0.mono = 5_900 } // frame age exactly 5s
        reject { $0.mono = 5_800 } // observation age exactly 5s
        reject { $0.frameTime = 1_001 }
        reject { $0.observationTime = 901 } // observation newer than frame
        reject { $0.frameTime = .nan }
        reject { $0.observationTime = -1 }
        reject { $0.observation["capturedAt"] = 1_001 }
        reject { $0.wall = 5_800 }
        reject { $0.observation["completeness"] = "partial" }
        reject { $0.observation["foreground"] = false }
        reject { $0.observation["nodes"] = [Object]() }
        for node in [
            ["role": "AXWindow", "sensitive": true, "actions": [String]()],
            ["role": "AXSheet", "sensitive": false, "actions": [String]()],
            ["role": "AXWindow", "sensitive": false, "actions": ["invoke"]],
            ["role": "AXWindow", "sensitive": false]
        ] as [Object] { reject { $0.observation["nodes"] = [node] } }
        reject { $0.layout = "changed" }
        reject { $0.bounds["x"] = -299 }
        reject { $0.frameField("bounds", ["x": 0, "y": 0, "width": 0, "height": 100]) }
        reject { $0.frame["id"] = "changed" } // embedded snapshot mismatch
        reject { $0.frameField("unexpected", true) }
        reject { $0.frameField("mimeType", "image/jpeg") }
        reject { $0.frameField("data", "") }
        for invalid in [Double.nan, Double.infinity, 0, -1] {
            reject {
                var bounds = $0.bounds; bounds["width"] = invalid
                $0.bounds = bounds; $0.observation["bounds"] = bounds
                $0.frameField("bounds", bounds)
            }
        }

        let ledger = ClickIntent.Reservations()
        precondition(baseline.reserve(ledger) != nil)
        precondition(baseline.reserve(ledger) == nil)
        var retry = baseline
        retry.command["commandId"] = "new-command"; retry.approved = retry.command
        precondition(retry.reserve(ledger) == nil) // same frame cannot be replayed
        retry = baseline
        retry.frameField("id", "new-frame"); retry.action("frameId", "new-frame")
        precondition(retry.reserve(ledger) == nil) // same command cannot be replayed
        retry.command["commandId"] = "new-command"; retry.approved = retry.command
        precondition(retry.reserve(ledger) != nil)
        precondition(retry.reserve(ledger) == nil)
        // A policy refusal performs no reservation; neither this nor success
        // asserts anything about native authority or OS delivery.
        let unused = ClickIntent.Reservations()
        var invalid = baseline; invalid.action("x", 400)
        precondition(invalid.reserve(unused) == nil)
        precondition(baseline.reserve(unused) != nil)
        print("PASS ClickIntent literal/decoded equality, exact binding, coordinates, stale capture age across approval, malformed inputs and replay policy; no native delivery evidence.")
    }
}
