// TEST ONLY: pure production policy code on Linux, not Security/Darwin mocks.
import Foundation
import CoreFoundation

func mustReject(_ body: () throws -> Void) {
    do { try body(); fatalError("Expected unavailable") }
    catch let e as BootstrapProcessBinding.Failure { precondition(e == .unavailable) }
    catch { fatalError("Unexpected policy failure") }
}
func makeSample(pid: Int32 = 41, user: UInt32 = 501, unique: UInt64 = 81, parent: UInt64 = 82,
                exec: UInt32 = 7, status: UInt32 = 0x20010001, offset: Int64 = 0,
                uuid: [UInt8] = [UInt8](repeating: 3, count: 16), hash: [UInt8] = [UInt8](repeating: 4, count: 20)) -> BootstrapProcessBinding.Sample {
    .init(pid: pid, user: user, uniqueID: unique, parentUniqueID: parent, execID: exec, status: status, offset: offset, uuid: uuid, hash: hash)
}
// Requirement text is pure policy, NOT proof that any certificate is accepted.
let expectedDeveloperID = "anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists" +
    " and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"ABCD012345\""
for role: BootstrapProcessBinding.SignerRole in [.helper, .parent, .framework] {
    let requirement = try BootstrapProcessBinding.requirementText(team: "ABCD012345", role: role)
    let suffix = role == .parent ? " and identifier \"ai.usebrian.desktop\"" : ""
    precondition(requirement == expectedDeveloperID + suffix)
    precondition(!requirement.contains(" or "))
    for team in ["", "ABCD01234", "ABCD0123456", "abcd012345", "ABCD01234\n", "ABCD01234\0",
                 "ＡBCD012345", "ABCD01234é", "ABCD01234\"", "\" or true", "ABCD012345\n"] {
        mustReject { _ = try BootstrapProcessBinding.requirementText(team: team, role: role) }
    }
}
let own = makeSample(), parent = makeSample(pid: 42, unique: 82, parent: 83)
try BootstrapProcessBinding.validatePair(own, parent, ownPID: 41, parentPID: 42, user: 501)
try BootstrapProcessBinding.unchanged(own, own)
let mutations = [makeSample(pid: 43), makeSample(user: 502), makeSample(unique: 84), makeSample(parent: 85),
    makeSample(exec: 8), makeSample(status: 0x20010101), makeSample(offset: 4096),
    makeSample(uuid: [UInt8](repeating: 9, count: 16)), makeSample(hash: [UInt8](repeating: 8, count: 20))]
for sample in mutations { mustReject { try BootstrapProcessBinding.unchanged(own, sample) } }
for sample in [makeSample(pid: 0), makeSample(user: 0), makeSample(unique: 0), makeSample(parent: 0), makeSample(exec: 0),
    makeSample(offset: -1), makeSample(offset: Int64(Int32.max) + 1), makeSample(uuid: []), makeSample(hash: []),
    makeSample(hash: [UInt8](repeating: 0, count: 20)), makeSample(status: 0)] {
    mustReject { try BootstrapProcessBinding.validatePair(sample, parent, ownPID: 41, parentPID: 42, user: 501) }
}
for mask: UInt32 in [2,4,0x20,0x1000000,0x10000000,0x20000] {
    mustReject { try BootstrapProcessBinding.validatePair(makeSample(status: own.status | mask), parent, ownPID: 41, parentPID: 42, user: 501) }
}
let budget = BootstrapProcessBinding.Budget(start: 100)
try budget.check(100); try budget.check(100 + BootstrapProcessBinding.Budget.nanoseconds - 1)
mustReject { try budget.check(99) }
mustReject { try budget.check(100 + BootstrapProcessBinding.Budget.nanoseconds) }
mustReject { try BootstrapProcessBinding.Budget(start: UInt64.max).check(0) }
// A late phase cannot reset/restart the same budget and become admissible.
for _ in 0..<3 { mustReject { try budget.check(100 + BootstrapProcessBinding.Budget.nanoseconds + 1) } }
for n: UInt32 in [0,2,0x10000,UInt32.max] { let actual = try BootstrapProcessBinding.integer(NSNumber(value: n)); precondition(actual == n) }
for n: Any in [true, false, 2.0, -1, "2", NSNull(), NSNumber(value: UInt64.max)] {
    mustReject { _ = try BootstrapProcessBinding.integer(n) }
}
let forbidden = ["get-task-allow", "com.apple.security.get-task-allow", "com.apple.security.cs.disable-library-validation",
    "com.apple.security.cs.allow-jit", "com.apple.security.cs.allow-unsigned-executable-memory", "com.apple.security.cs.allow-dyld-environment-variables",
    "com.apple.security.cs.disable-executable-page-protection"]
try BootstrapProcessBinding.entitlements(nil, rawBlobPresent: false, helper: true)
mustReject { try BootstrapProcessBinding.entitlements(nil, rawBlobPresent: true, helper: true) }
for key in forbidden {
    try BootstrapProcessBinding.entitlements([key: false], rawBlobPresent: true, helper: true)
    for value: Any in [true, 1, 0, "false", NSNull()] {
        mustReject { try BootstrapProcessBinding.entitlements([key: value], rawBlobPresent: true, helper: true) }
    }
}
try BootstrapProcessBinding.entitlements(["com.apple.security.cs.allow-jit": true,
    "com.apple.security.cs.allow-unsigned-executable-memory": true, "com.apple.security.cs.disable-library-validation": true], rawBlobPresent: true, helper: false)
mustReject { try BootstrapProcessBinding.entitlements(["get-task-allow": true], rawBlobPresent: true, helper: false) }

// DYLD environment injection is forbidden for BOTH principals. A false CFBoolean
// is allowed; numeric 0/1, strings, nulls and a true CFBoolean are not substitutes.
for helper in [false, true] {
    let key = "com.apple.security.cs.allow-dyld-environment-variables"
    try BootstrapProcessBinding.entitlements([key: NSNumber(value: false)], rawBlobPresent: true, helper: helper)
    for value: Any in [NSNumber(value: true), NSNumber(value: Int32(0)), NSNumber(value: Int32(1)),
                      NSNumber(value: 0.0), "false", "true", NSNull(), [] as [String], ["unknown": false]] {
        mustReject { try BootstrapProcessBinding.entitlements([key: value], rawBlobPresent: true, helper: helper) }
    }
}
// Executable-page protection is not one of Electron's allowed exceptions.
for helper in [false, true] {
    let key = "com.apple.security.cs.disable-executable-page-protection"
    try BootstrapProcessBinding.entitlements([key: false], rawBlobPresent: true, helper: helper)
    for value: Any in [true, 0, 1, "false", NSNull()] {
        mustReject { try BootstrapProcessBinding.entitlements([key: value], rawBlobPresent: true, helper: helper) }
    }
}
// Unknown helper entitlements cannot acquire authority merely by being absent
// from a denylist, even when their value happens to be false.
for key in ["com.apple.security.cs.debugger", "com.apple.private.skip-library-validation", "unknown"] {
    for value: Any in [true, false, 0, "false", NSNull()] {
        mustReject { try BootstrapProcessBinding.entitlements([key: value], rawBlobPresent: true, helper: true) }
    }
}
// The three explicit Electron exceptions remain parent-only, never helper grants.
for key in ["com.apple.security.cs.allow-jit", "com.apple.security.cs.allow-unsigned-executable-memory",
            "com.apple.security.cs.disable-library-validation"] {
    try BootstrapProcessBinding.entitlements([key: true], rawBlobPresent: true, helper: false)
    mustReject { try BootstrapProcessBinding.entitlements([key: true], rawBlobPresent: true, helper: true) }
}

try BootstrapProcessBinding.sameEntitlements(nil, rawBefore: nil, nil, rawAfter: nil)
try BootstrapProcessBinding.sameEntitlements(["a": false], rawBefore: Data([1]), ["a": false], rawAfter: Data([1]))
for after: Any? in [nil, ["a": true], ["b": false], false] {
    mustReject { try BootstrapProcessBinding.sameEntitlements(["a": false], rawBefore: nil, after, rawAfter: nil) }
}
mustReject { try BootstrapProcessBinding.sameEntitlements(nil, rawBefore: nil, [:] as [String: Any], rawAfter: nil) }
mustReject { try BootstrapProcessBinding.sameEntitlements([:], rawBefore: Data([1]), [:], rawAfter: Data([2])) }
mustReject { try BootstrapProcessBinding.sameEntitlements([:], rawBefore: true, [:], rawAfter: true) }
mustReject { try BootstrapProcessBinding.sameEntitlements([:], rawBefore: Data([1]), [:], rawAfter: nil) }

let input = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [[String: Any]]
var results = [[String: Any]]()
for vector in input {
    do {
        if vector["kind"] as? String == "digest" {
            let digest = try BootstrapProcessBinding.asarDigest(vector["value"])
            results.append(["digest": Data(digest).base64EncodedString()])
        } else if vector["kind"] as? String == "entitlements" {
            let bytes = Array(Data(base64Encoded: vector["bytes"] as! String)!)
            let hash = Array(Data(base64Encoded: vector["hash"] as! String)!)
            let sample = makeSample(offset: Int64(vector["offset"] as! String)!, hash: hash)
            let image = try BootstrapProcessBinding.authenticatedImageHeader(bytes, sample: sample)
            let slots = vector["slots"] as! [Int]
            precondition(image.xmlEntitlementsPresent == slots.contains(5))
            precondition(image.derEntitlementsPresent == slots.contains(7))
            let helper = vector["helper"] as! Bool
            // NO entitlement-presence policy until full special-slot verification.
            do {
                if helper {
                    _ = try BootstrapApproval.bind(capturedHelper: bytes, kernel: sample.expectation, context: image.context,
                        mappedRecord: Array(Data(base64Encoded: vector["mapped"] as! String)!))
                } else {
                    _ = try MachOLibraryConstraint.extract(capturedMain: bytes, kernel: sample.expectation, context: image.context)
                }
            } catch { throw BootstrapProcessBinding.Failure.unavailable }
            let raw: Any? = vector["rawUnknown"] != nil ? true : (vector["raw"] as? String).flatMap { Data(base64Encoded: $0) }
            try BootstrapProcessBinding.capturedEntitlements(vector["dictionary"], raw: raw, image: image, helper: helper)
            results.append(["entitlements": true])
        } else {
            let bytes = Array(Data(base64Encoded: vector["bytes"] as! String)!)
            let hash = Array(Data(base64Encoded: vector["hash"] as! String)!)
            let sample = makeSample(offset: Int64(vector["offset"] as! String)!, hash: hash)
            let context = try BootstrapProcessBinding.authenticatedArchitecture(bytes, sample: sample)
            results.append(["architecture": context.architecture.rawValue])
        }
    } catch let e as BootstrapProcessBinding.Failure {
        precondition(e == .unavailable); results.append(["error": e.code])
    } catch { fatalError("Unexpected vector error") }
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: results, options: [.sortedKeys]))
