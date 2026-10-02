// TEST ONLY. Concatenated after the verbatim production source into temp main.swift.
// Foundation JSON/file/stdio and test assertions belong here, never in the comparator.
import Foundation

struct PolicyVectorInput: Decodable {
    let raw: String
    let teamIdentifier: String
    let cdHashes: [String]
}

func policyTestBytes(_ base64: String) -> [UInt8] {
    guard let data = Data(base64Encoded: base64) else { fatalError("Invalid test vector encoding") }
    return Array(data)
}

func policyTestDTO(_ match: LibraryConstraintPolicy.Match) -> [String: Any] {
    return ["kind": match.kind, "profile": match.profile,
            "policyMatchesSuppliedInventory": match.policyMatchesSuppliedInventory,
            "matchedHashCount": match.matchedHashCount,
            "productionAuthority": match.productionAuthority, "slotAuthentication": match.slotAuthentication,
            "kernelAuthentication": match.kernelAuthentication, "cmsAuthentication": match.cmsAuthentication,
            "loadedImageAuthentication": match.loadedImageAuthentication, "nativeEnforcement": match.nativeEnforcement]
}

// Value semantics/privacy checks in real Swift (not a JavaScript simulation).
func policyTestValueSemantics(_ input: PolicyVectorInput) throws {
    var raw = policyTestBytes(input.raw)
    var hashes = input.cdHashes.map(policyTestBytes)
    var team = input.teamIdentifier
    let preservedRaw = raw, preservedHashes = hashes
    let match = try LibraryConstraintPolicy.compare(rawGenericBlob: raw, expectedTeam: team, expectedCDHashes: hashes)
    precondition(raw == preservedRaw && hashes == preservedHashes, "Input changed")
    let fields = Set(Mirror(reflecting: match).children.compactMap { $0.label })
    precondition(fields == Set(policyTestDTO(match).keys), "Unexpected private field in result")
    precondition(match.matchedHashCount == 2 && match.policyMatchesSuppliedInventory)
    precondition(!match.productionAuthority && !match.slotAuthentication && !match.kernelAuthentication &&
                 !match.cmsAuthentication && !match.loadedImageAuthentication && !match.nativeEnforcement)
    raw[0] = 0
    hashes[0][0] = 0
    hashes.removeAll()
    team = "A1B2C3D4E5"
    precondition(preservedRaw[0] == 0xfa && preservedHashes[0][0] == 0x11)
    precondition(match.matchedHashCount == 2 && match.profile == "user-arm64-macos26-v1-envelope-only")
    let repeated = try LibraryConstraintPolicy.compare(rawGenericBlob: preservedRaw, expectedTeam: input.teamIdentifier,
                                                       expectedCDHashes: preservedHashes)
    precondition(repeated == match)
    // Failed comparison returns only the fixed failure case, no team/hash context.
    do {
        _ = try LibraryConstraintPolicy.compare(rawGenericBlob: raw, expectedTeam: team, expectedCDHashes: hashes)
        fatalError("Modified input unexpectedly matched")
    } catch let error as LibraryConstraintPolicy.Failure {
        precondition(error == .rejected && error.code == "ERR_MAC_LIBRARY_CONSTRAINT_POLICY_COMPARISON")
    }
}

precondition(CommandLine.arguments.count == 2, "Expected test vector file")
let policyVectorData = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
let policyVectors = try JSONDecoder().decode([PolicyVectorInput].self, from: policyVectorData)
precondition(!policyVectors.isEmpty)
try policyTestValueSemantics(policyVectors[0]) // first vector is exact 183-byte user fixture
var policyVerdicts = [[String: Any]]()
for vector in policyVectors {
    do {
        let match = try LibraryConstraintPolicy.compare(rawGenericBlob: policyTestBytes(vector.raw),
            expectedTeam: vector.teamIdentifier, expectedCDHashes: vector.cdHashes.map(policyTestBytes))
        policyVerdicts.append(["match": policyTestDTO(match)])
    } catch let error as LibraryConstraintPolicy.Failure {
        precondition(error == .rejected)
        policyVerdicts.append(["error": ["code": error.code, "message": error.message]])
    } catch {
        fatalError("Unexpected error type in policy comparator")
    }
}
let policyOutput = try JSONSerialization.data(withJSONObject: policyVerdicts, options: [.sortedKeys])
FileHandle.standardOutput.write(policyOutput)
FileHandle.standardOutput.write(Data([10]))
