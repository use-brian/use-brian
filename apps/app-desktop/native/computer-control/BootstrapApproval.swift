import Foundation

// Internal DATA ONLY. Project wire ABI: BootstrapApprovalAnchor.h, not a C
// struct layout or Apple ABI. No C imports, I/O, signing, or runtime overrides.
// No final main/helper CDHash here (that would create a signing cycle).
// Inventory completeness/finality and non-Apple classification are release
// pipeline obligations; byte ordering alone cannot establish them.
enum BootstrapApproval {
    static let recordSize = 1376
    static let electronVersion = "43.2.0"
    static let markerLength = 32
    // Do not emit another plaintext marker in the helper image: artifact-wide
    // uniqueness reserves it for C's anchor. Transform INPUT bytes across a
    // non-inlined boundary rather than decoding a constant marker array. Tests
    // scan both optimized and unoptimized Swift executables for duplicates;
    // actual Darwin linker/optimizer output still requires artifact acceptance.
    private static let encodedMarker: [UInt8] = [0xe7,0xf7,0xec,0xe4,0xeb,0xfa,0xe7,0xea,
        0xea,0xf1,0xf6,0xf1,0xf7,0xe4,0xf5,0xfa,0xe4,0xeb,0xe6,0xed,0xea,0xf7,0xfa,0xf3,
        0x94,0x29,0x04,0x76,0x5c,0x12,0xc5,0xe7]
    @inline(never) private static func encodeMarkerByte(_ byte: UInt8) -> UInt8 { byte ^ 0xa5 }
    static func matchesMarker(_ bytes: [UInt8], at offset: Int) -> Bool {
        guard offset >= 0, offset <= bytes.count, markerLength <= bytes.count - offset else { return false }
        for i in 0..<markerLength {
            if encodeMarkerByte(bytes[offset + i]) != encodedMarker[i] { return false }
        }
        return true
    }
    enum Failure: Error, Equatable {
        case rejected
        var code: String { "ERR_SWIFT_BOOTSTRAP_APPROVAL" }
    }
    struct ApprovalData {
        let kind = "bootstrap-approval-data"
        let electronVersion: String
        let asarDigest: [UInt8]
        let libraryCDHashes: [[UInt8]]
        let productionAuthority = false
        let cmsAuthentication = false
        let staticSignerAuthentication = false
        let kernelProvenanceAuthentication = false
        let mappedRecordProvenanceAuthentication = false
        let nativeEnforcement = false
        let loadedImageAuthentication = false
        fileprivate init(asarDigest: [UInt8], libraryCDHashes: [[UInt8]]) {
            self.electronVersion = BootstrapApproval.electronVersion
            self.asarDigest = asarDigest
            self.libraryCDHashes = libraryCDHashes
        }
    }
    // Decode canonical nonempty bytes only. Never sort, repair or fill inputs.
    // Ordinary race-free Swift value semantics required; no unsafe borrowed data.
    static func decode(record: [UInt8]) throws -> ApprovalData {
        guard record.count == recordSize else { throw Failure.rejected }
        var b = [UInt8](); b.reserveCapacity(recordSize)
        for byte in record { b.append(byte) }
        guard matchesMarker(b, at: 0), b[32] == 0, b[33] == 1,
              b[34] == 1, b[35] == 0,
              Array(b[36..<40]) == [0,0,5,96], b[46] == 20, b[47] == 32,
              Array(b[48..<56]) == Array(electronVersion.utf8) + [0,0],
              b[56..<64].allSatisfy({ $0 == 0 }), b[64..<96].contains(where: { $0 != 0 }) else { throw Failure.rejected }
        let count = Int(b[44]) * 256 + Int(b[45])
        guard count >= 1, count <= 64 else { throw Failure.rejected }
        let length = 96 + count * 20
        // Bounded used length fits UInt16; explicitly reject high reserved bytes.
        guard b[40] == 0, b[41] == 0, Int(b[42]) * 256 + Int(b[43]) == length,
              b[length..<recordSize].allSatisfy({ $0 == 0 }) else { throw Failure.rejected }
        var hashes = [[UInt8]]()
        for i in 0..<count {
            let hash = Array(b[(96 + i * 20)..<(116 + i * 20)])
            guard hash.contains(where: { $0 != 0 }) else { throw Failure.rejected }
            if let previous = hashes.last {
                guard previous.lexicographicallyPrecedes(hash) else { throw Failure.rejected }
            }
            hashes.append(hash)
        }
        return ApprovalData(asarDigest: Array(b[64..<96]), libraryCDHashes: hashes)
    }

    // Own-helper DATA binding, NOT admission. Caller MUST obtain mappedRecord
    // from C's volatile OWN mapped getter, never the parent pipe or a disk read.
    // The actual own-main kernel snapshot and architecture context must be fresh,
    // independently obtained and tied to the same exec generation. Supplying a
    // disk-derived CDHash would prove only self-consistency, not kernel binding.
    // This pure function cannot verify those input provenances. Independent own
    // signature/signer, flags/entitlements, generation and race checks remain
    // mandatory. Equality does NOT authenticate arbitrary other mapped pages,
    // CMS, enforcement or Electron's loaded images. No operational authority.
    static func bind(capturedHelper: [UInt8], kernel: MachOLibraryConstraint.KernelExpectation,
                     context: MachOLibraryConstraint.MainImageContext,
                     mappedRecord: [UInt8]) throws -> ApprovalData {
        do {
            let approval = try decode(record: mappedRecord)
            try MachOLibraryConstraint.bindOwnBootstrapAnchor(capturedHelper: capturedHelper,
                kernel: kernel, context: context, mappedRecord: mappedRecord)
            return approval
        } catch { throw Failure.rejected }
    }
}
