import Foundation

// Compiled into Helper, but never an input emitter. Uses Helper's
// Object/proto and wire validators; no alternate public protocol or planner.
// A successful binding is arithmetic/policy evidence ONLY, not parent admission,
// AX safety, physical ownership, delivery, or permission to call CGEvent.post.
enum ClickIntent {
    // Internal, non-Codable inputs. The owner must populate these from its CURRENT
    // native cache only after liveWindow/fresh/unchanged/safeCanvas and permissions,
    // focus, layout, takeover, parent/channel and lease checks. Never decode this
    // container (or its timestamps/deadlines) from a request. Recheck immediately
    // before dispatch on the owner's serialized lane. This type cannot prove that
    // those native checks happened; that obligation remains with the future owner.
    struct Snapshot {
        let frame: Object
        let observation: Object // captured observation, including its exact frame
        let target: Object
        let currentBounds: Object
        let currentLayout: String
        let frameObservationID: String
        let frameMonotonicMs: Double
        // Original observation-start time, NOT the post-approval input checkpoint.
        // A local dialog may advance takeover accounting, never screenshot age.
        let observationMonotonicMs: Double
        let grantDeadlineMonotonicMs: Double
        let commandDeadlineMonotonicMs: Double
    }

    struct Clock {
        let wallMs: Double
        let monotonicMs: Double
    }

    struct Binding: Equatable {
        let commandID: String
        let grantID: String
        let epoch: Double
        let observationID: String
        let frameID: String
        let imageX: Double
        let imageY: Double
        let globalX: Double
        let globalY: Double
        // Only implicit LEFT SINGLE is supported by the existing click schema.
        // No button/count/key/modifier fields or native delivery claims.
    }

    private static func equal(_ a: Object, _ b: Object) -> Bool {
        // Bridge BOTH sides. Corelibs Foundation's isEqual(to: [AnyHashable: Any])
        // can reject identical Swift-literal numeric fields (e.g. Int epoch 1),
        // unlike JSON-decoded NSNumber fields. Both sources occur in native caches.
        NSDictionary(dictionary: a).isEqual(NSDictionary(dictionary: b))
    }

    private static func rectangle(_ value: Object) -> (Double, Double, Double, Double)? {
        guard Set(value.keys) == Set(["x", "y", "width", "height"]),
              let x = wireNumber(value["x"]), let y = wireNumber(value["y"]),
              let w = wireNumber(value["width"]), let h = wireNumber(value["height"]),
              w > 0, h > 0, (x + w).isFinite, (y + h).isFinite,
              x + w > x, y + h > y else { return nil }
        return (x, y, w, h)
    }

    // Pure and repeatable, NOT a reservation. Approved must be the owner's exact
    // locally approved command, not a second caller-supplied JSON object. Native
    // deadlines must be anchored when the grant/command are admitted, never reset
    // here or after approval. Ages are milliseconds with an exclusive 5s limit.
    static func validate(command: Object, approved: Object, grant: Object,
                         snapshot s: Snapshot, clock: Clock) -> Binding? {
        guard validWireCommand(command), validWireCommand(approved),
              equal(command, approved), captureAuthority(grant),
              let action = command["action"] as? Object, action["kind"] as? String == "click",
              let identity = command["identity"] as? Object,
              let owner = grant["identity"] as? Object, equal(identity, owner),
              command["grantId"] as? String == grant["grantId"] as? String,
              let epoch = wireInteger(command["epoch"]), epoch == wireInteger(grant["epoch"]),
              let target = action["target"] as? Object, validWireTarget(s.target), equal(target, s.target),
              let targets = grant["targets"] as? [Object], targets.contains(where: { equal($0, target) }),
              let expiry = wireInteger(grant["expiresAt"]), let deadline = wireInteger(command["deadlineAt"]),
              clock.wallMs.isFinite, clock.wallMs >= 0, clock.monotonicMs.isFinite, clock.monotonicMs >= 0,
              clock.wallMs < expiry, clock.wallMs < deadline,
              s.grantDeadlineMonotonicMs.isFinite, s.commandDeadlineMonotonicMs.isFinite,
              clock.monotonicMs < s.grantDeadlineMonotonicMs,
              clock.monotonicMs < s.commandDeadlineMonotonicMs else { return nil }
        for timestamp in [s.frameMonotonicMs, s.observationMonotonicMs] {
            guard timestamp.isFinite, timestamp >= 0, timestamp <= clock.monotonicMs,
                  clock.monotonicMs - timestamp < 5_000 else { return nil }
        }
        let observation = s.observation
        let frame = s.frame
        guard s.observationMonotonicMs <= s.frameMonotonicMs,
              let observationID = wireString(observation["id"]),
              observationID == s.frameObservationID, observationID == action["observationId"] as? String,
              let observationIdentity = observation["identity"] as? Object, equal(observationIdentity, identity),
              wireInteger(observation["epoch"]) == epoch,
              let observationTarget = observation["target"] as? Object, equal(observationTarget, target),
              observation["completeness"] as? String == "complete",
              wireBool(observation["foreground"]) == true,
              let capturedAt = wireInteger(observation["capturedAt"]), capturedAt <= clock.wallMs,
              clock.wallMs - capturedAt < 5_000,
              let nodes = observation["nodes"] as? [Object], !nodes.isEmpty,
              nodes.allSatisfy({ node in
                  wireBool(node["sensitive"]) == false &&
                  wireString(node["role"]) != nil && node["role"] as? String != "AXSheet" &&
                  (node["actions"] as? [String])?.isEmpty == true
              }),
              let embeddedFrame = observation["frame"] as? Object, equal(embeddedFrame, frame),
              Set(frame.keys) == Set(["id", "mimeType", "data", "width", "height", "bounds", "displayLayoutVersion"]),
              let frameID = wireString(frame["id"]), frameID == action["frameId"] as? String,
              frame["mimeType"] as? String == "image/png", let data = frame["data"] as? String, !data.isEmpty,
              let width = wireInteger(frame["width"], min: 1, max: 9_007_199_254_740_991),
              let height = wireInteger(frame["height"], min: 1, max: 9_007_199_254_740_991),
              let bounds = frame["bounds"] as? Object, let rect = rectangle(bounds),
              let observedBounds = observation["bounds"] as? Object,
              equal(bounds, observedBounds), equal(bounds, s.currentBounds),
              !s.currentLayout.isEmpty, frame["displayLayoutVersion"] as? String == s.currentLayout,
              observation["displayLayoutVersion"] as? String == s.currentLayout,
              let x = wireInteger(action["x"]), let y = wireInteger(action["y"]),
              x < width, y < height else { return nil }
        let scaleX = rect.2 / width, scaleY = rect.3 / height
        guard scaleX.isFinite, scaleY.isFinite, scaleX > 0, scaleY > 0 else { return nil }
        // Exact frame.bounds transform, without centering, rounding or clamping.
        let globalX = rect.0 + x * scaleX, globalY = rect.1 + y * scaleY
        guard globalX.isFinite, globalY.isFinite,
              globalX >= rect.0, globalX < rect.0 + rect.2,
              globalY >= rect.1, globalY < rect.1 + rect.3 else { return nil }
        return Binding(commandID: command["commandId"] as! String,
                       grantID: grant["grantId"] as! String, epoch: epoch,
                       observationID: observationID, frameID: frameID,
                       imageX: x, imageY: y, globalX: globalX, globalY: globalY)
    }

    // One owner-retained ledger for the entire admitted session, on a serialized
    // lane. Burn before handing anything to a guardian; no retry on uncertain or
    // failed dispatch. Recreating this ledger is NOT recovery permission. It is
    // not a durable/native lease fence and must not replace ClickGuardian.
    final class Reservations {
        private var commands = Set<String>()
        private var frames = Set<String>()

        func reserve(command: Object, approved: Object, grant: Object,
                     snapshot: Snapshot, clock: Clock) -> Binding? {
            guard let binding = ClickIntent.validate(command: command, approved: approved,
                                                      grant: grant, snapshot: snapshot, clock: clock),
                  !commands.contains(binding.commandID), !frames.contains(binding.frameID) else { return nil }
            commands.insert(binding.commandID)
            frames.insert(binding.frameID)
            return binding
        }
    }
}
