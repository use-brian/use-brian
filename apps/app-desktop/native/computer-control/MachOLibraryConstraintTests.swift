// TEST ONLY: concatenated in temporary main.swift with production sources.
// Synthetic Mach-O/CD/kernel-expectation vectors are NEVER native signing proof.
import Foundation

struct MachOTestVector: Decodable {
    let name: String
    let bytes: String
    let cdHash: String
    let offset: String
    let architecture: String
    let compareObservedPolicy: Bool
}
func machoTestBytes(_ base64: String) -> [UInt8] {
    guard let data = Data(base64Encoded: base64) else { fatalError("Invalid test encoding") }
    return Array(data)
}
func machoTestRun(_ v: MachOTestVector) throws -> MachOLibraryConstraint.Extraction {
    guard let offset = UInt64(v.offset), let arch = MachOLibraryConstraint.Architecture(rawValue: v.architecture) else {
        fatalError("Invalid typed test context")
    }
    return try MachOLibraryConstraint.extract(capturedMain: machoTestBytes(v.bytes),
        kernel: .init(mainCDHash: machoTestBytes(v.cdHash), activeSliceOffset: offset),
        context: .init(architecture: arch))
}
func machoTestDTO(_ result: MachOLibraryConstraint.Extraction) -> [String: Any] {
    // Internal test transport ONLY. Production has no serializable DTO and its
    // rawBlob must remain private. Test data is either synthetic or public fixture.
    return ["rawBlob": Data(result.rawBlob).base64EncodedString(),
            "slice": ["offset": result.capturedSlice.offset, "size": result.capturedSlice.size,
                      "architecture": result.capturedSlice.architecture.rawValue],
            "version": result.codeDirectoryVersion, "policyStatus": result.policyStatus,
            "productionAuthority": result.productionAuthority, "cmsAuthentication": result.cmsAuthentication,
            "nativeEnforcement": result.nativeEnforcement, "loadedImageAuthentication": result.loadedImageAuthentication]
}
// Known SHA256 vectors independently specified, not derived from the JS fixture
// builder. Uses the same REAL SHA256 implementation imported by production.
precondition(Array(SHA256.hash(data: Data())) == [0xe3,0xb0,0xc4,0x42,0x98,0xfc,0x1c,0x14,0x9a,0xfb,0xf4,0xc8,0x99,0x6f,0xb9,0x24,0x27,0xae,0x41,0xe4,0x64,0x9b,0x93,0x4c,0xa4,0x95,0x99,0x1b,0x78,0x52,0xb8,0x55])
precondition(Array(SHA256.hash(data: Data("abc".utf8))) == [0xba,0x78,0x16,0xbf,0x8f,0x01,0xcf,0xea,0x41,0x41,0x40,0xde,0x5d,0xae,0x22,0x23,0xb0,0x03,0x61,0xa3,0x96,0x17,0x7a,0x9c,0xb4,0x10,0xff,0x61,0xf2,0x00,0x15,0xad])
precondition(CommandLine.arguments.count == 2)
let machoVectors = try JSONDecoder().decode([MachOTestVector].self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
precondition(!machoVectors.isEmpty)
let first = try machoTestRun(machoVectors[0])
var changed = first.rawBlob
changed[0] ^= 1
precondition(first.rawBlob[0] == 0xfa && changed != first.rawBlob)
var input = machoTestBytes(machoVectors[0].bytes), hash = machoTestBytes(machoVectors[0].cdHash)
let snapshot = try MachOLibraryConstraint.extract(capturedMain: input,
    kernel: .init(mainCDHash: hash, activeSliceOffset: 0), context: .init(architecture: .arm64))
input[0] = 0; hash[0] = 0
precondition(snapshot.rawBlob == first.rawBlob && snapshot.capturedSlice == first.capturedSlice)
var verdicts = [[String: Any]]()
for vector in machoVectors {
    do {
        let result = try machoTestRun(vector)
        if vector.compareObservedPolicy {
            // The native DER is inside a SYNTHETIC Mach-O whose expected CDHash
            // is also synthetic. This composition proves data plumbing only.
            let policy = try LibraryConstraintPolicy.compare(rawGenericBlob: result.rawBlob,
                expectedTeam: "ZZZZZZZZZZ", expectedCDHashes: [[UInt8](repeating: 0x11, count: 20), [UInt8](repeating: 0x22, count: 20)])
            precondition(policy.matchedHashCount == 2 && !policy.productionAuthority && !policy.nativeEnforcement)
        }
        verdicts.append(["match": machoTestDTO(result)])
    } catch let error as MachOLibraryConstraint.Failure {
        precondition(error == .rejected)
        verdicts.append(["error": error.code])
    } catch { fatalError("Unexpected extraction/policy error") }
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: verdicts, options: [.sortedKeys]))
FileHandle.standardOutput.write(Data([10]))
