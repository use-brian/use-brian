import Foundation
import CryptoKit

// INTERNAL DATA prerequisite, not a production verifier or loaded-image proof.
// Counterpart of scripts/mac-library-constraints.mjs. Source pins:
// XNU 1031c584a5e37aff177559b9f69dbd3c8c3fd30a:
// EXTERNAL_HEADERS/mach-o/loader.h (commands), osfmk/kern/cs_blobs.h (CD layout,
// SHA256=2, cdhash=20, slot 11, magic 0xfade8181), bsd/kern/ubc_subr.c
// (special slot hashes include the WHOLE generic blob, not only its payload).
// Security ef677c3d667a44e1737c1b0245e9ed04d11c51c1:
// OSX/libsecurity_codesigning/lib/{codedirectory.h,codedirectory.cpp,signer.cpp}.
//
// Deliberately narrow: LE64 arm64/ALL or x86_64/ALL, thin or BE fat32/fat64,
// <=2 unique architectures; primary SHA256 CD v20400/v20500/v20600 only;
// 4K/16K pages; no scatter/codeLimit64/pre-encryption/linkage/alternates.
// All slices must be structurally/self-hash consistent, but ONLY the selected CD
// is compared to supplied kernel data. The unsigned fat table/padding is not
// authenticated as a whole. In the LIBRARY path, non-signature commands/section tables are FRAMED,
// not a full dyld/VM/section/linkedit semantics parser. The separate OWN HELPER
// path adds strict segment/section geometry and marker/record checks, but does
// not query live VM protections or authenticate arbitrary other mapped pages.
//
// Narrower than the generic JS extractor: MH_EXECUTE main images only; extracted
// slot 11 <=4096 bytes (the separate observed policy comparator's input bound).
// Other recognized blobs are opaque. External Info.plist/resources slots 1/3,
// CMS/signer/team, DER semantics, constraints/fuses/ASAR/inventory/enforcement and
// loaded code are NOT verified by the main/helper APIs. The separate framework
// API accepts MH_DYLIB only, checks EVERY primary CD against caller-supplied
// approved inventory and exposes strict ASAR geometry after full hash validation.
// It establishes artifact membership, never complete inventory or CMS provenance.
// No I/O, capture, kernel query, race/lease/deadline
// mechanism, architecture fallback or path-derived "kernel hash" exists here.
// Later admission still needs independent static signature/signer verification,
// helper-owned approved inventory, fresh generation/channel checks and the full
// bootstrap/native acceptance chain. Do not wire this result directly to authority.
enum MachOLibraryConstraint {
    enum Limits {
        static let artifactBytes = 512 * 1024 * 1024
        static let signatureBytes = 16 * 1024 * 1024
        static let constraintBytes = 4096
        static let commands = 4096
    }
    enum Failure: Error, Equatable {
        case rejected
        var code: String { "ERR_MACHO_LIBRARY_CONSTRAINT_EXTRACTION" }
    }
    enum Architecture: String, Equatable {
        case arm64
        case x86_64
        fileprivate var cpu: UInt32 { self == .arm64 ? 0x0100000c : 0x01000007 }
        fileprivate var subtype: UInt32 { self == .arm64 ? 0 : 3 }
    }
    // Caller-supplied DATA, not an attestation object. MUST come from a fresh,
    // validated same-exec-generation kernel main-signing snapshot. This parser
    // cannot establish that provenance/freshness. Never manufacture it from disk.
    struct KernelExpectation {
        let mainCDHash: [UInt8]
        let activeSliceOffset: UInt64
    }
    // MUST be independently established for that same running main image (e.g.
    // authenticated static-signature context bound to the kernel main CDHash).
    // NOT guessed from host architecture or the untrusted fat table. Kernel
    // snapshots do not supply captured file size, slice size or CPU subtype.
    struct MainImageContext {
        let architecture: Architecture
    }
    struct CapturedSlice: Equatable {
        let offset: Int
        let size: Int // Derived from this captured buffer/container, NOT the kernel.
        let architecture: Architecture
    }
    // Private/internal data: do NOT serialize/log this object or rawBlob. The
    // detached immutable bytes are solely for a later policy comparison. No
    // Codable/debug DTO or positive authentication/authority flags are provided.
    struct Extraction {
        let rawBlob: [UInt8]
        let capturedSlice: CapturedSlice
        let codeDirectoryVersion: UInt32
        let policyStatus = "unsupported"
        let productionAuthority = false
        let cmsAuthentication = false
        let nativeEnforcement = false
        let loadedImageAuthentication = false
        fileprivate init(rawBlob: [UInt8], capturedSlice: CapturedSlice, codeDirectoryVersion: UInt32) {
            self.rawBlob = rawBlob
            self.capturedSlice = capturedSlice
            self.codeDirectoryVersion = codeDirectoryVersion
        }
    }

    static func extract(capturedMain: [UInt8], kernel: KernelExpectation,
                        context: MainImageContext) throws -> Extraction {
        guard MemoryLayout<Int>.size == 8, capturedMain.count >= 32,
              capturedMain.count <= Limits.artifactBytes, kernel.mainCDHash.count == 20,
              kernel.mainCDHash.contains(where: { $0 != 0 }),
              kernel.activeSliceOffset < UInt64(capturedMain.count) else { throw Failure.rejected }
        // Explicit element copies, not borrowed Foundation/NSData storage or
        // Data(bytesNoCopy:). Typed Swift values require normal race-free Swift
        // semantics; this API is not a sandbox for unsafe caller memory writes.
        let bytes = copy(capturedMain), expectedHash = copy(kernel.mainCDHash)
        return try Parser(bytes: bytes).extract(expectedHash: expectedHash,
            offset: Int(kernel.activeSliceOffset), architecture: context.architecture)
    }
    // Separate own-helper entry point, no optional library-verification bypass.
    // Generic CD/page validation is shared internally. Helper anchors do NOT
    // require slot 11. No callbacks, algorithm injection or runtime override.
    static func bindOwnBootstrapAnchor(capturedHelper: [UInt8], kernel: KernelExpectation,
                                       context: MainImageContext, mappedRecord: [UInt8]) throws {
        guard MemoryLayout<Int>.size == 8, capturedHelper.count >= 32,
              capturedHelper.count <= 128 * 1024 * 1024, kernel.mainCDHash.count == 20,
              kernel.mainCDHash.contains(where: { $0 != 0 }),
              kernel.activeSliceOffset < UInt64(capturedHelper.count),
              mappedRecord.count == BootstrapApproval.recordSize else { throw Failure.rejected }
        let bytes = copy(capturedHelper), expectedHash = copy(kernel.mainCDHash), mapped = copy(mappedRecord)
        _ = try BootstrapApproval.decode(record: mapped)
        try Parser(bytes: bytes).bindAnchor(expectedHash: expectedHash,
            offset: Int(kernel.activeSliceOffset), architecture: context.architecture, mapped: mapped)
    }
    // Framework ARTIFACT data, never kernel/loaded-library evidence. The caller
    // must independently authenticate a complete helper-anchored inventory; this
    // function establishes membership only, NOT inventory provenance/completeness.
    struct FrameworkSlice {
        let capturedSlice: CapturedSlice
        let primaryCDHash: [UInt8]
        let signedByteCount: Int
        let asarOffset: Int // slice-relative; mapping inspected only after hashes
        let commandEnd: Int
        let readableMappings: [Range<Int>]
        fileprivate init(slice: CapturedSlice, hash: [UInt8], signed: Int, asar: Int,
                         commandEnd: Int, mappings: [Range<Int>]) {
            capturedSlice = slice; primaryCDHash = hash; signedByteCount = signed
            asarOffset = asar; self.commandEnd = commandEnd; readableMappings = mappings
        }
    }
    struct FrameworkArtifact {
        let bytes: [UInt8]
        let slices: [FrameworkSlice]
        let productionAuthority = false
        let cmsAuthentication = false
        let nativeEnforcement = false
        let loadedImageAuthentication = false
        let inventoryProvenance = false
        let inventoryCompleteness = false
        fileprivate init(bytes: [UInt8], slices: [FrameworkSlice]) {
            self.bytes = bytes; self.slices = slices
        }
    }
    static func verifyFrameworkArtifact(capturedFramework: [UInt8], approvedCDHashes: [[UInt8]]) throws -> FrameworkArtifact {
        guard MemoryLayout<Int>.size == 8, capturedFramework.count >= 32,
              capturedFramework.count <= Limits.artifactBytes,
              !approvedCDHashes.isEmpty, approvedCDHashes.count <= 64 else { throw Failure.rejected }
        var inventory = Set<[UInt8]>()
        for hash in approvedCDHashes {
            guard hash.count == 20, hash.contains(where: { $0 != 0 }),
                  inventory.insert(copy(hash)).inserted else { throw Failure.rejected }
        }
        let bytes = copy(capturedFramework)
        return try Parser(bytes: bytes).framework(inventory: inventory)
    }
    private static func copy(_ source: [UInt8]) -> [UInt8] {
        var result = [UInt8]()
        result.reserveCapacity(source.count)
        for byte in source { result.append(byte) }
        return result
    }
    private struct Region {
        let offset: Int
        let size: Int
        var end: Int { offset + size } // Only constructed after bounded arithmetic.
    }
    private struct Parser {
        let bytes: [UInt8]
        var whole: Region { Region(offset: 0, size: bytes.count) }
        private func part(_ parent: Region, _ offset: Int, _ size: Int) throws -> Region {
            guard offset >= 0, size >= 0, offset <= parent.size, size <= parent.size - offset else { throw Failure.rejected }
            return Region(offset: parent.offset + offset, size: size)
        }
        private func u32(_ view: Region, _ at: Int, little: Bool = false) throws -> UInt32 {
            let p = try part(view, at, 4)
            var n: UInt32 = 0
            for i in 0..<4 { n = (n << 8) | UInt32(bytes[p.offset + (little ? 3 - i : i)]) }
            return n
        }
        private func u64(_ view: Region, _ at: Int, little: Bool = false) throws -> UInt64 {
            let p = try part(view, at, 8)
            var n: UInt64 = 0
            for i in 0..<8 { n = (n << 8) | UInt64(bytes[p.offset + (little ? 7 - i : i)]) }
            return n
        }
        private func bounded(_ n: UInt64, by maximum: Int) throws -> Int {
            guard n <= UInt64(maximum) else { throw Failure.rejected }
            return Int(n)
        }
        private func detached(_ view: Region) -> [UInt8] {
            var result = [UInt8]()
            result.reserveCapacity(view.size)
            for i in view.offset..<view.end { result.append(bytes[i]) }
            return result
        }
        private func zero(_ view: Region) throws {
            for i in view.offset..<view.end { if bytes[i] != 0 { throw Failure.rejected } }
        }
        private func digest(_ view: Region) -> [UInt8] {
            Array(SHA256.hash(data: Data(bytes[view.offset..<view.end])))
        }
        private func equal(_ view: Region, _ value: [UInt8]) -> Bool {
            guard view.size == value.count else { return false }
            for i in value.indices { if bytes[view.offset + i] != value[i] { return false } }
            return true
        }
        private func disjoint(_ regions: [Region]) throws {
            let sorted = regions.filter { $0.size != 0 }.sorted { $0.offset < $1.offset }
            for i in sorted.indices where i > 0 {
                guard sorted[i].offset >= sorted[i - 1].end else { throw Failure.rejected }
            }
        }
        private func gaps(_ parent: Region, _ regions: [Region], includeTail: Bool) throws {
            try disjoint(regions)
            let sorted = regions.sorted { $0.offset < $1.offset }
            var last = 0
            for region in sorted {
                try zero(part(parent, last, region.offset - last))
                last = region.end
            }
            if includeTail { try zero(part(parent, last, parent.size - last)) }
        }
        private func arch(_ cpu: UInt32, _ subtype: UInt32) throws -> Architecture {
            if cpu == 0x0100000c && subtype == 0 { return .arm64 }
            if cpu == 0x01000007 && subtype == 3 { return .x86_64 }
            throw Failure.rejected
        }
        private func slices() throws -> [CapturedSlice] {
            let magic = try u32(whole, 0)
            if magic != 0xcafebabe && magic != 0xcafebabf {
                return [CapturedSlice(offset: 0, size: bytes.count,
                    architecture: try arch(u32(whole, 4, little: true), u32(whole, 8, little: true)))]
            }
            let count = Int(try u32(whole, 4)), stride = magic == 0xcafebabe ? 20 : 32
            guard count >= 1 && count <= 2 else { throw Failure.rejected }
            let tableEnd = 8 + count * stride
            _ = try part(whole, 0, tableEnd)
            var result = [CapturedSlice](), cpus = Set<UInt32>()
            for i in 0..<count {
                let at = 8 + i * stride, cpu = try u32(whole, at)
                let architecture = try arch(cpu, u32(whole, at + 4))
                guard cpus.insert(cpu).inserted else { throw Failure.rejected }
                let offset = stride == 20 ? Int(try u32(whole, at + 8)) : try bounded(u64(whole, at + 8), by: bytes.count)
                let size = stride == 20 ? Int(try u32(whole, at + 12)) : try bounded(u64(whole, at + 16), by: bytes.count)
                let alignment = try u32(whole, at + (stride == 20 ? 16 : 24))
                _ = try part(whole, offset, size)
                guard size >= 32, offset >= tableEnd, alignment <= 30,
                      offset % (1 << Int(alignment)) == 0 else { throw Failure.rejected }
                if stride == 32 { try zero(part(whole, at + 28, 4)) }
                result.append(CapturedSlice(offset: offset, size: size, architecture: architecture))
            }
            try disjoint(result.map { Region(offset: $0.offset, size: $0.size) })
            return result
        }

        private static let fixedCommands: [UInt32: Int] = [2:24, 0xb:80, 0x1b:24, 0x24:16,
            0x26:16, 0x29:16, 0x2a:16, 0x80000028:24, 0x22:48, 0x80000022:48, 0x80000033:16, 0x80000034:16]
        private static let stringCommands: [UInt32: Int] = [0xc:24, 0xd:24, 0x80000018:24,
            0x8000001f:24, 0x80000023:24, 0xe:12, 0x8000001c:12]
        private func signature(_ view: Region, _ slice: CapturedSlice, fileType: UInt32 = 2) throws -> Region {
            guard try u32(view, 0, little: true) == 0xfeedfacf,
                  try u32(view, 4, little: true) == slice.architecture.cpu,
                  try u32(view, 8, little: true) == slice.architecture.subtype,
                  try u32(view, 12, little: true) == fileType else { throw Failure.rejected }
            try zero(part(view, 28, 4))
            let count = Int(try u32(view, 16, little: true)), commandBytes = Int(try u32(view, 20, little: true))
            let commands = try part(view, 0, 32 + commandBytes)
            guard count > 0, count <= Limits.commands, count * 8 <= commandBytes else { throw Failure.rejected }
            var at = 32, signature: Region?, linkedit: Region?
            var segments = [Region](), names = Set<[UInt8]>()
            for _ in 0..<count {
                let cmd = try u32(commands, at, little: true), size = Int(try u32(commands, at + 4, little: true))
                guard size >= 8, size % 8 == 0 else { throw Failure.rejected }
                let command = try part(commands, at, size)
                if cmd == 0x1d {
                    guard signature == nil, size == 16 else { throw Failure.rejected }
                    let offset = Int(try u32(command, 8, little: true)), length = Int(try u32(command, 12, little: true))
                    _ = try part(view, offset, length)
                    signature = Region(offset: offset, size: length)
                } else if cmd == 0x19 {
                    guard size >= 72, size == 72 + Int(try u32(command, 64, little: true)) * 80 else { throw Failure.rejected }
                    let rawName = detached(try part(command, 8, 16)), firstZero = rawName.firstIndex(of: 0) ?? 16
                    guard rawName[firstZero..<16].allSatisfy({ $0 == 0 }), names.insert(Array(rawName.prefix(firstZero))).inserted else { throw Failure.rejected }
                    let offset = try bounded(u64(command, 40, little: true), by: view.size)
                    let length = try bounded(u64(command, 48, little: true), by: view.size)
                    _ = try part(view, offset, length)
                    let segment = Region(offset: offset, size: length)
                    segments.append(segment)
                    if rawName == Array("__LINKEDIT".utf8) + [UInt8](repeating: 0, count: 6) { linkedit = segment }
                } else if let required = Self.fixedCommands[cmd] {
                    guard size == required else { throw Failure.rejected }
                } else if let minimum = Self.stringCommands[cmd] {
                    guard size >= minimum else { throw Failure.rejected }
                    let offset = Int(try u32(command, 8, little: true))
                    guard offset >= minimum, offset < size else { throw Failure.rejected }
                    let string = try part(command, offset, size - offset)
                    guard bytes[string.offset..<string.end].contains(0) else { throw Failure.rejected }
                } else if cmd == 0x32 {
                    guard size >= 24, size == 24 + Int(try u32(command, 20, little: true)) * 8 else { throw Failure.rejected }
                } else { throw Failure.rejected }
                at += size
            }
            try disjoint(segments)
            guard at == commands.size, let signature = signature, let linkedit = linkedit,
                  signature.offset >= commands.size, signature.size >= 12, signature.size <= Limits.signatureBytes,
                  signature.end == view.size, signature.offset >= linkedit.offset, signature.end <= linkedit.end else { throw Failure.rejected }
            return signature
        }

        private static let slotMagic: [UInt32: UInt32] = [0:0xfade0c02, 2:0xfade0c01, 5:0xfade7171,
            7:0xfade7172, 8:0xfade8181, 9:0xfade8181, 10:0xfade8181, 11:0xfade8181, 0x10000:0xfade0b01]
        private func components(_ sb: Region) throws -> [UInt32: Region] {
            guard try u32(sb, 0) == 0xfade0cc0 else { throw Failure.rejected }
            let length = Int(try u32(sb, 4)), count = Int(try u32(sb, 8))
            let boundedSB = try part(sb, 0, length), tableEnd = 12 + count * 8
            guard count > 0, count <= Self.slotMagic.count, tableEnd <= length else { throw Failure.rejected }
            var result = [UInt32: Region](), ranges = [Region(offset: 0, size: tableEnd)]
            for i in 0..<count {
                let type = try u32(boundedSB, 12 + i * 8), offset = Int(try u32(boundedSB, 16 + i * 8))
                guard let magic = Self.slotMagic[type], result[type] == nil else { throw Failure.rejected }
                let header = try part(boundedSB, offset, 8), size = Int(try u32(header, 4))
                guard offset >= tableEnd, size >= 8, try u32(header, 0) == magic else { throw Failure.rejected }
                result[type] = try part(boundedSB, offset, size)
                ranges.append(Region(offset: offset, size: size))
            }
            try gaps(boundedSB, ranges, includeTail: true) // Unused allocation is outside the SuperBlob.
            guard result[0] != nil else { throw Failure.rejected }
            return result
        }

        private func directory(_ view: Region, _ signature: Region, _ blobs: [UInt32: Region]) throws -> (UInt32, [UInt8]) {
            guard let cd = blobs[0], cd.size >= 88 else { throw Failure.rejected }
            let version = try u32(cd, 8)
            let headers: [UInt32: Int] = [0x20400:88, 0x20500:96, 0x20600:108]
            guard let header = headers[version], cd.size >= header else { throw Failure.rejected }
            let profile = detached(try part(cd, 36, 4))
            guard profile[0] == 32, profile[1] == 2, profile[2] == 0, [12, 14].contains(profile[3]) else { throw Failure.rejected }
            try zero(part(cd, 40, 8)); try zero(part(cd, 52, 12))
            if version >= 0x20500 { try zero(part(cd, 92, 4)) }
            if version >= 0x20600 { try zero(part(cd, 96, 12)) }
            let hashes = Int(try u32(cd, 16)), special = Int(try u32(cd, 24)), pages = Int(try u32(cd, 28))
            let limit = Int(try u32(cd, 32)), pageSize = 1 << Int(profile[3])
            guard try u32(cd, 12) & ~UInt32(0x00033f02) == 0,
                  try u64(cd, 80) & ~UInt64(0x3f1) == 0 else { throw Failure.rejected }
            let execBase = try bounded(u64(cd, 64), by: limit), execSize = try bounded(u64(cd, 72), by: limit)
            guard execSize <= limit - execBase, special <= 11, limit == signature.offset,
                  pages == (limit + pageSize - 1) / pageSize else { throw Failure.rejected }
            let hashStart = hashes - special * 32
            _ = try part(cd, hashStart, (special + pages) * 32)
            guard hashStart >= header, hashes + pages * 32 == cd.size else { throw Failure.rejected }
            var ranges = [Region(offset: 0, size: header), Region(offset: hashStart, size: cd.size - hashStart)]
            for field in [20, 48] {
                let offset = Int(try u32(cd, field))
                if offset == 0 && field == 48 { continue }
                guard offset >= header, offset < hashStart else { throw Failure.rejected }
                var end = offset
                while end < hashStart && bytes[cd.offset + end] != 0 { end += 1 }
                guard end > offset, end < hashStart else { throw Failure.rejected }
                ranges.append(Region(offset: offset, size: end + 1 - offset))
            }
            try gaps(cd, ranges, includeTail: false)
            for slot in [2, 4, 5, 6, 7, 8, 9, 10, 11] {
                if slot > special {
                    guard blobs[UInt32(slot)] == nil else { throw Failure.rejected }
                    continue
                }
                let embedded = try part(cd, hashes - slot * 32, 32)
                if let blob = blobs[UInt32(slot)] {
                    guard equal(embedded, digest(blob)) else { throw Failure.rejected }
                } else { try zero(embedded) }
            }
            // Every code page, including Mach header/load commands and a short
            // last page. Signature starts exactly at codeLimit; no unsigned gap.
            for page in 0..<pages {
                let start = page * pageSize, length = min(pageSize, limit - start)
                let actual = digest(try part(view, start, length))
                guard equal(try part(cd, hashes + page * 32, 32), actual) else { throw Failure.rejected }
            }
            return (version, Array(digest(cd).prefix(20)))
        }

        // Own-helper geometry profile mirrors mac-bootstrap-anchor.mjs. This is
        // stricter than library extraction's framing-only segment handling.
        // VM arithmetic is bounded to JS's exact-integer range for profile parity.
        private func anchorName(_ command: Region, _ at: Int) throws -> String {
            let raw = detached(try part(command, at, 16)), end = raw.firstIndex(of: 0) ?? 16
            guard end > 0, raw[end..<16].allSatisfy({ $0 == 0 }),
                  raw[0..<end].allSatisfy({ $0 >= 0x20 && $0 <= 0x7e }) else { throw Failure.rejected }
            return String(decoding: raw[0..<end], as: UTF8.self)
        }
        private func anchor(_ view: Region, _ sig: Region) throws -> Region {
            guard sig.size <= 8 * 1024 * 1024 else { throw Failure.rejected }
            return try geometry(view, sig, framework: false).target
        }
        // Shared strict geometry, separate fixed target policies. The framework
        // caller invokes this ONLY after all pages/special blobs and approved CD
        // membership succeed. Helper acceptance rules are unchanged.
        private func geometry(_ view: Region, _ sig: Region, framework: Bool) throws -> (target: Region, mappings: [Range<Int>], commandEnd: Int) {
            let vmLimit = 9_007_199_254_740_991
            let count = Int(try u32(view, 16, little: true)), end = 32 + Int(try u32(view, 20, little: true))
            let commands = try part(view, 0, end)
            var at = 32, found: Region?, headerMappings = 0
            var mappings = [Range<Int>]()
            var files = [Region](), vms = [Region](), sections = [Region](), vmSections = [Region]()
            var names = Set<String>(), sectionNames = Set<String>()
            // signature() already validated command count, framing, supported
            // command kinds, duplicate signature and the __LINKEDIT containment.
            guard sig.offset % 16 == 0 else { throw Failure.rejected }
            for _ in 0..<count {
                let cmd = try u32(commands, at, little: true), size = Int(try u32(commands, at + 4, little: true))
                let command = try part(commands, at, size)
                if cmd == 0x19 {
                    let name = try anchorName(command, 8), nsects = Int(try u32(command, 64, little: true))
                    guard names.insert(name).inserted, nsects <= 4096 else { throw Failure.rejected }
                    let vmaddr = try bounded(u64(command, 24, little: true), by: vmLimit)
                    let vmsize = try bounded(u64(command, 32, little: true), by: vmLimit - vmaddr)
                    let fileoff = try bounded(u64(command, 40, little: true), by: view.size)
                    let filesize = try bounded(u64(command, 48, little: true), by: view.size - fileoff)
                    let maxprot = try u32(command, 56, little: true), initprot = try u32(command, 60, little: true)
                    let segflags = try u32(command, 68, little: true)
                    guard filesize <= vmsize, maxprot & ~UInt32(7) == 0,
                          initprot & ~maxprot == 0, segflags & ~UInt32(0x1f) == 0 else { throw Failure.rejected }
                    if framework {
                        // No alternate high-VM/protected mapping interpretation.
                        guard segflags == 0 || segflags == 0x10 else { throw Failure.rejected }
                    }
                    files.append(Region(offset: fileoff, size: filesize)); vms.append(Region(offset: vmaddr, size: vmsize))
                    if initprot & 1 != 0 { mappings.append(fileoff..<(fileoff + filesize)) }
                    if filesize > 0 && fileoff < end {
                        guard name == "__TEXT", fileoff == 0, filesize >= end, initprot & 1 != 0 else { throw Failure.rejected }
                        headerMappings += 1
                    }
                    for j in 0..<nsects {
                        let section = try part(command, 72 + j * 80, 80)
                        let sectionName = try anchorName(section, 0), owner = try anchorName(section, 16)
                        // Match the JS profile's conservative duplicate key.
                        let key = owner + "/" + sectionName
                        guard sectionNames.insert(key).inserted, owner == name else { throw Failure.rejected }
                        let address = try bounded(u64(section, 32, little: true), by: vmaddr + vmsize)
                        let length = try bounded(u64(section, 40, little: true), by: vmaddr + vmsize - address)
                        let offset = Int(try u32(section, 48, little: true)), alignment = try u32(section, 52, little: true)
                        let flags = try u32(section, 64, little: true), type = flags & 0xff
                        guard address >= vmaddr, alignment <= 30, address % (1 << Int(alignment)) == 0,
                              type <= 0x16, flags & ~UInt32(0xfe0007ff) == 0 else { throw Failure.rejected }
                        vmSections.append(Region(offset: address, size: length))
                        let zeroFill = [UInt32(1), 0xc, 0x12].contains(type)
                        if !zeroFill {
                            guard offset >= fileoff, offset <= fileoff + filesize,
                                  length <= fileoff + filesize - offset,
                                  length == 0 || offset >= end,
                                  offset == fileoff + address - vmaddr,
                                  offset % (1 << Int(alignment)) == 0 else { throw Failure.rejected }
                            sections.append(Region(offset: offset, size: length))
                        }
                        if sectionName == (framework ? "__asar_integrity" : "__br_bootstrap") {
                            guard found == nil, name == "__DATA_CONST", !zeroFill else { throw Failure.rejected }
                            if framework {
                                // SG_READ_ONLY is dyld's data-const contract (not
                                // live VM proof). Without it require read-only max
                                // AND initial protections. No executable ASAR data.
                                guard flags == 0, length == 66, initprot & 1 != 0,
                                      maxprot & 4 == 0,
                                      (segflags == 0x10 || (segflags == 0 && maxprot & 2 == 0 && initprot & 2 == 0)) else { throw Failure.rejected }
                            } else {
                                guard flags == 0x10000000, length == BootstrapApproval.recordSize, alignment == 4,
                                      segflags == 0x10, initprot & 1 != 0, maxprot & 4 == 0 else { throw Failure.rejected }
                            }
                            try zero(part(section, 56, 8)); try zero(part(section, 68, 12))
                            // Entire record must be in signed pages, not signature
                            // allocation/padding. Header/commands are covered too.
                            guard offset <= sig.offset, length <= sig.offset - offset else { throw Failure.rejected }
                            found = try part(view, offset, length)
                        }
                    }
                }
                at += size
            }
            try disjoint(files); try disjoint(vms); try disjoint(sections); try disjoint(vmSections)
            try disjoint(sections + [sig])
            guard at == end, headerMappings == 1, let found = found else { throw Failure.rejected }
            return (found, mappings, end)
        }
        func framework(inventory: Set<[UInt8]>) throws -> FrameworkArtifact {
            let all = try slices()
            var result = [FrameworkSlice]()
            var verified = [(CapturedSlice, Region, [UInt8])]()
            for slice in all {
                let view = try part(whole, slice.offset, slice.size)
                let sig = try signature(view, slice, fileType: 6)
                let blobs = try components(part(view, sig.offset, sig.size))
                let (_, hash) = try directory(view, sig, blobs)
                guard inventory.contains(hash) else { throw Failure.rejected }
                verified.append((slice, sig, hash))
            }
            // No section mapping is consumed until EVERY slice is approved and
            // all its pages and embedded special-slot blobs have been checked.
            for (slice, sig, hash) in verified {
                let view = try part(whole, slice.offset, slice.size)
                let mapped = try geometry(view, sig, framework: true)
                result.append(FrameworkSlice(slice: slice, hash: hash, signed: sig.offset,
                    asar: mapped.target.offset - view.offset, commandEnd: mapped.commandEnd, mappings: mapped.mappings))
            }
            return FrameworkArtifact(bytes: bytes, slices: result)
        }
        func bindAnchor(expectedHash: [UInt8], offset: Int, architecture: Architecture, mapped: [UInt8]) throws {
            let all = try slices()
            guard let selected = all.first(where: { $0.offset == offset && $0.architecture == architecture }) else { throw Failure.rejected }
            var locations = Set<Int>()
            for slice in all {
                let view = try part(whole, slice.offset, slice.size), sig = try signature(view, slice)
                let region = try anchor(view, sig)
                // Every slice must carry the exact same canonical nonempty own
                // mapped record, just as the JS artifact profile requires.
                guard equal(region, mapped) else { throw Failure.rejected }
                locations.insert(region.offset)
                let blobs = try components(part(view, sig.offset, sig.size))
                let (_, hash) = try directory(view, sig, blobs)
                if slice == selected { guard hash == expectedHash else { throw Failure.rejected } }
            }
            // Marker cannot be shadowed in a different section, signature,
            // padding, fat header or unselected slice. Bounded full capture scan.
            for at in 0...(bytes.count - BootstrapApproval.markerLength) where bytes[at] == 0x42 {
                if BootstrapApproval.matchesMarker(bytes, at: at) {
                    guard locations.remove(at) != nil else { throw Failure.rejected }
                }
            }
            guard locations.isEmpty else { throw Failure.rejected }
        }

        func extract(expectedHash: [UInt8], offset: Int, architecture: Architecture) throws -> Extraction {
            let all = try slices()
            guard let selected = all.first(where: { $0.offset == offset && $0.architecture == architecture }) else { throw Failure.rejected }
            var result: Extraction?
            for slice in all {
                let view = try part(whole, slice.offset, slice.size), sig = try signature(view, slice)
                let blobs = try components(part(view, sig.offset, sig.size))
                guard let constraint = blobs[11], constraint.size > 8,
                      constraint.size <= Limits.constraintBytes, let cd = blobs[0] else { throw Failure.rejected }
                let special = try u32(cd, 24)
                guard special == 11 else { throw Failure.rejected }
                let (version, hash) = try directory(view, sig, blobs)
                if slice == selected {
                    guard hash == expectedHash, let blob = blobs[11] else { throw Failure.rejected }
                    result = Extraction(rawBlob: detached(blob), capturedSlice: slice, codeDirectoryVersion: version)
                }
            }
            guard let result = result else { throw Failure.rejected }
            return result
        }
    }
}
