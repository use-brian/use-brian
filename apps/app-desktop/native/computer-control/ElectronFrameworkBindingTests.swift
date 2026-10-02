// TEST ONLY, separate compilation unit main.swift. Real SHA256 in production
// parser, synthetic approved inventories. No Security/native acceptance claims.
import Foundation

let input = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [[String: Any]]
var output = [[String: Any]]()
for vector in input {
    do {
        var bytes = Array(Data(base64Encoded: vector["bytes"] as! String)!)
        let inventory = (vector["inventory"] as! [String]).map { Array(Data(base64Encoded: $0)!) }
        let artifact = try MachOLibraryConstraint.verifyFrameworkArtifact(capturedFramework: bytes, approvedCDHashes: inventory)
        precondition(!artifact.productionAuthority && !artifact.cmsAuthentication && !artifact.nativeEnforcement && !artifact.loadedImageAuthentication)
        precondition(!artifact.inventoryProvenance && !artifact.inventoryCompleteness)
        let approval = try BootstrapApproval.decode(record: Array(Data(base64Encoded: vector["record"] as! String)!))
        let result = try ElectronFrameworkBinding.bind(capturedFramework: bytes, approval: approval)
        precondition(!result.productionAuthority && !result.controlAdmission && !result.cmsAuthentication && !result.staticSignerAuthentication)
        precondition(!result.nativeEnforcement && !result.loadedImageAuthentication && !result.inventoryProvenance && !result.inventoryCompleteness)
        precondition(!result.approvalProvenance && !result.nativeAcceptance && result.electronVersion == "43.2.0")
        precondition(result.architectureCount == artifact.slices.count)
        // Caller mutation cannot change the parser's retained owned data.
        let original = artifact.bytes[0]; bytes[0] ^= 1
        precondition(artifact.bytes[0] == original)
        output.append(["match": true, "count": result.architectureCount])
    } catch let error as ElectronFrameworkBinding.Failure {
        precondition(error.code == "ERR_ELECTRON_FRAMEWORK_BINDING")
        output.append(["match": false, "count": 0])
    } catch let error as MachOLibraryConstraint.Failure {
        precondition(error.code == "ERR_MACHO_LIBRARY_CONSTRAINT_EXTRACTION")
        output.append(["match": false, "count": 0])
    }
}
let encoded = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
FileHandle.standardOutput.write(encoded)
