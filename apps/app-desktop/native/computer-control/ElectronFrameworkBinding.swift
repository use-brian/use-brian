import Foundation

// Internal, immutable ARTIFACT DATA ONLY. No I/O, Security calls, kernel inputs,
// host selection, Helper dependency, signing or admission. Caller must supply an
// independently authenticated own-helper approval, NOT merely decode disk/IPC
// bytes. BootstrapApproval.decode and this API cannot prove that provenance.
// Pins: electron/electron v43.2.0 shell/common/asar/integrity_digest.mm;
// electron v1 fuse wire ABI, same 8/9-state profile as hardenedElectronWire.
// SG_READ_ONLY describes artifact geometry; it does not prove live VM protection.
enum ElectronFrameworkBinding {
    enum Failure: Error, Equatable {
        case rejected
        var code: String { "ERR_ELECTRON_FRAMEWORK_BINDING" }
    }
    struct DataResult {
        let kind = "electron-framework-artifact-binding-data"
        let electronVersion = "43.2.0"
        let architectureCount: Int
        let productionAuthority = false
        let controlAdmission = false
        let cmsAuthentication = false
        let staticSignerAuthentication = false
        let nativeEnforcement = false
        let loadedImageAuthentication = false
        let inventoryProvenance = false
        let inventoryCompleteness = false
        let approvalProvenance = false
        let nativeAcceptance = false
        fileprivate init(count: Int) { architectureCount = count }
    }
    private static let asarMarker = Array("AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A".utf8)
    private static let fuseMarker = Array("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX".utf8)
    // Scan the ENTIRE capture, including unsigned fat padding and signature
    // allocations. Exactly one of each marker per slice; shadow copies refuse.
    private static func locations(_ marker: [UInt8], in bytes: [UInt8], maximum: Int) throws -> [Int] {
        guard bytes.count >= marker.count else { throw Failure.rejected }
        var result = [Int]()
        for at in 0...(bytes.count - marker.count) where bytes[at] == marker[0] {
            if bytes[at..<(at + marker.count)].elementsEqual(marker) {
                result.append(at)
                guard result.count <= maximum else { throw Failure.rejected }
            }
        }
        guard result.count == maximum else { throw Failure.rejected }
        return result
    }
    static func bind(capturedFramework: [UInt8], approval: BootstrapApproval.ApprovalData) throws -> DataResult {
        do {
            guard approval.electronVersion == "43.2.0", approval.asarDigest.count == 32,
                  approval.asarDigest.contains(where: { $0 != 0 }) else { throw Failure.rejected }
            let artifact = try MachOLibraryConstraint.verifyFrameworkArtifact(capturedFramework: capturedFramework,
                approvedCDHashes: approval.libraryCDHashes)
            let bytes = artifact.bytes
            var asarLocations = Set(try locations(asarMarker, in: bytes, maximum: artifact.slices.count))
            var fuseLocations = Set(try locations(fuseMarker, in: bytes, maximum: artifact.slices.count))
            var firstWire: [UInt8]?
            for slice in artifact.slices {
                let base = slice.capturedSlice.offset, end = base + slice.capturedSlice.size
                let asar = base + slice.asarOffset
                guard asarLocations.remove(asar) != nil, bytes[asar + 32] == 1, bytes[asar + 33] == 1,
                      bytes[(asar + 34)..<(asar + 66)].elementsEqual(approval.asarDigest) else { throw Failure.rejected }
                let candidates = fuseLocations.filter { $0 >= base && $0 < end }
                guard candidates.count == 1, let fuse = candidates.first,
                      fuse >= base + slice.commandEnd, fuse <= base + slice.signedByteCount - 34,
                      bytes[fuse + 32] == 1 else { throw Failure.rejected }
                let count = Int(bytes[fuse + 33]), relative = fuse - base
                guard [8, 9].contains(count), relative + 34 + count <= slice.signedByteCount,
                      slice.readableMappings.contains(where: { $0.lowerBound <= relative && $0.upperBound >= relative + 34 + count }),
                      relative + 34 + count <= slice.asarOffset || relative >= slice.asarOffset + 66 else { throw Failure.rejected }
                let wire = Array(bytes[(fuse + 34)..<(fuse + 34 + count)])
                guard wire.allSatisfy({ $0 == 0x30 || $0 == 0x31 }),
                      wire[0] == 0x30, wire[2] == 0x30, wire[3] == 0x30, wire[4] == 0x31, wire[5] == 0x31 else { throw Failure.rejected }
                if let previous = firstWire { guard previous == wire else { throw Failure.rejected } }
                firstWire = wire
                fuseLocations.remove(fuse)
            }
            guard asarLocations.isEmpty, fuseLocations.isEmpty else { throw Failure.rejected }
            return DataResult(count: artifact.slices.count)
        } catch { throw Failure.rejected }
    }
}
