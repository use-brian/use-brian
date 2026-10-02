// TEST ONLY. JSON input is synthetic, never a C mapped getter/kernel snapshot.
import Foundation
struct BootstrapVector: Decodable {
    let name: String
    let mode: String
    let record: String
    let bytes: String?
    let cdHash: String?
    let offset: String?
    let architecture: String?
}
func bootstrapBytes(_ text: String) -> [UInt8] {
    guard let data = Data(base64Encoded: text) else { fatalError("Invalid test encoding") }
    return Array(data)
}
func bootstrapDTO(_ data: BootstrapApproval.ApprovalData) -> [String: Any] {
    // Test-only transport of public synthetic values, NEVER production logging.
    ["kind": data.kind, "electronVersion": data.electronVersion,
     "asarDigest": Data(data.asarDigest).base64EncodedString(),
     "libraryCDHashes": data.libraryCDHashes.map { Data($0).base64EncodedString() },
     "productionAuthority": data.productionAuthority, "cmsAuthentication": data.cmsAuthentication,
     "staticSignerAuthentication": data.staticSignerAuthentication,
     "kernelProvenanceAuthentication": data.kernelProvenanceAuthentication,
     "mappedRecordProvenanceAuthentication": data.mappedRecordProvenanceAuthentication,
     "nativeEnforcement": data.nativeEnforcement, "loadedImageAuthentication": data.loadedImageAuthentication]
}
precondition(CommandLine.arguments.count == 2)
let bootstrapVectors = try JSONDecoder().decode([BootstrapVector].self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
var recordInput = bootstrapBytes(bootstrapVectors[0].record)
let firstApproval = try BootstrapApproval.decode(record: recordInput)
var changedDigest = firstApproval.asarDigest, changedHashes = firstApproval.libraryCDHashes
changedDigest[0] ^= 1; changedHashes[0][0] ^= 1; recordInput[64] ^= 1
precondition(firstApproval.asarDigest != changedDigest && firstApproval.libraryCDHashes != changedHashes)
precondition(firstApproval.asarDigest == Array(bootstrapBytes(bootstrapVectors[0].record)[64..<96]))
var bootstrapResults = [[String: Any]]()
for v in bootstrapVectors {
    do {
        let result: BootstrapApproval.ApprovalData
        if v.mode == "decode" {
            result = try BootstrapApproval.decode(record: bootstrapBytes(v.record))
        } else {
            guard v.mode == "bind", let bytes = v.bytes, let hash = v.cdHash,
                  let offsetText = v.offset, let offset = UInt64(offsetText), let name = v.architecture,
                  let architecture = MachOLibraryConstraint.Architecture(rawValue: name) else { fatalError("Invalid typed test") }
            var captured = bootstrapBytes(bytes), mapped = bootstrapBytes(v.record), kernelHash = bootstrapBytes(hash)
            result = try BootstrapApproval.bind(capturedHelper: captured,
                kernel: .init(mainCDHash: kernelHash, activeSliceOffset: offset),
                context: .init(architecture: architecture), mappedRecord: mapped)
            let before = result.asarDigest
            captured[0] ^= 1; mapped[64] ^= 1; kernelHash[0] ^= 1
            precondition(result.asarDigest == before && before == Array(bootstrapBytes(v.record)[64..<96]))
        }
        bootstrapResults.append(["match": bootstrapDTO(result)])
    } catch let error as BootstrapApproval.Failure {
        precondition(error == .rejected)
        bootstrapResults.append(["error": error.code])
    } catch { fatalError("Unscoped extraction failure") }
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: bootstrapResults, options: [.sortedKeys]))
FileHandle.standardOutput.write(Data([10]))
