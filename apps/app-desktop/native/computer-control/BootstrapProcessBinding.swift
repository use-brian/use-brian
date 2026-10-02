import Foundation
import CoreFoundation
import CryptoKit

// Packaged-bootstrap binding, currently required only for probe-only admission.
// No operational authority until native package enforcement acceptance. No caller-selected PID/path, IPC data,
// environment override, C bridge injection, logging, signing or control dispatch.
// Public API pins (reviewed, not invented): Security
// ef677c3d667a44e1737c1b0245e9ed04d11c51c1/OSX/libsecurity_codesigning/lib/
// SecCode.h: Unique is CFData, Flags/DigestAlgorithm are CFNumber, PList and
// EntitlementsDict are CFDictionary. Missing entitlements dictionary may mean
// UNKNOWN FORMAT, not absence: an accompanying blob without dictionary refuses.
// SecStaticCode.h/.cpp: UniversalFileOffset is consumed as signed C int (%d).
// CSCommon.h: kSecCSNoNetworkAccess; StaticCode.cpp: validationCannotUseNetwork.
// Swift imports that CF_OPTIONS member as SecCSFlags.noNetworkAccess, NOT a
// global C-spelled constant: https://developer.apple.com/documentation/security/seccsflags/nonetworkaccess
// There is NO public kSecCodeInfoArchitecture result in this pinned interface.
// Architecture below comes ONLY from independently kernel-hash-authenticated
// captured header/pages. Untrusted load-command offsets are bounded locators,
// not architecture evidence; CPU fields are not inspected until hashing succeeds.
// The existing full parsers subsequently enforce their stricter entire profiles.
//
// One fixed non-resetting monotonic budget, no retry. Checks cannot interrupt a
// blocked Security/kernel/filesystem call or bounded parser/hash computation;
// over-budget completion is discarded.
// Descriptor/stat checks detect changes; NEVER claimed atomic or loaded-image
// attestation. Signature/Info.plist/resource path races and revocation freshness
// (network forbidden) remain limitations, even after all repeated checks pass.
enum BootstrapProcessBinding {
    enum Failure: Error, Equatable {
        case unavailable
        var code: String { "ERR_BOOTSTRAP_PROCESS_BINDING_UNAVAILABLE" }
    }
    struct DataResult {
        let kind = "bootstrap-process-binding-data"
        let electronVersion = "43.2.0"
        let matchedLibraryHashCount: Int
        // Counts captured, approved framework slices, not attested loaded images.
        let matchedFrameworkArchitectureCount: Int
        let productionAuthority = false
        let controlAdmission = false
        let loadedImageAuthentication = false
        let nativeEnforcement = false
        let frameworkEmbeddedDigestBinding = false
        let frameworkFuseBinding = false
        let completeInventoryProvenance = false
        let nativeSignedAcceptance = false
        let cmsAuthentication = false
        let atomicSnapshot = false
        fileprivate let ownProcess: Sample
        fileprivate let parentProcess: Sample
        fileprivate init(count: Int, frameworkArchitectures: Int, own: Sample, parent: Sample) {
            matchedLibraryHashCount = count
            matchedFrameworkArchitectureCount = frameworkArchitectures
            ownProcess = own
            parentProcess = parent
        }
    }
    // Pure value policies also compiled verbatim by the Linux test harness.
    struct Sample: Equatable {
        let pid: Int32
        let user: UInt32
        let uniqueID: UInt64
        let parentUniqueID: UInt64
        let execID: UInt32
        let status: UInt32
        let offset: Int64
        let uuid: [UInt8]
        let hash: [UInt8]
        var expectation: MachOLibraryConstraint.KernelExpectation {
            // Accessed only after validatePair; no signed-to-unsigned truncation.
            .init(mainCDHash: hash, activeSliceOffset: UInt64(offset))
        }
    }
    struct Budget {
        static let nanoseconds: UInt64 = 5_000_000_000
        let start: UInt64
        func check(_ now: UInt64) throws {
            guard now >= start, now - start < Self.nanoseconds else { throw Failure.unavailable }
        }
    }
    static func validatePair(_ own: Sample, _ parent: Sample, ownPID: Int32, parentPID: Int32, user: UInt32) throws {
        guard user > 0, ownPID > 1, parentPID > 1, ownPID != parentPID,
              own.pid == ownPID, parent.pid == parentPID, own.parentUniqueID == parent.uniqueID,
              own.uniqueID != parent.uniqueID else { throw Failure.unavailable }
        for sample in [own, parent] {
            guard sample.user == user, sample.uniqueID != 0, sample.parentUniqueID != 0, sample.execID != 0,
                  sample.offset >= 0, sample.offset <= Int64(Int32.max), sample.uuid.count == 16,
                  sample.hash.count == 20, sample.hash.contains(where: { $0 != 0 }),
                  sample.status & 0x20010001 == 0x20010001,
                  sample.status & 0x11020026 == 0 else { throw Failure.unavailable }
        }
    }
    static func unchanged(_ before: Sample, _ after: Sample) throws {
        guard before == after else { throw Failure.unavailable }
    }
    // Strict CF types: do not accept a Boolean or floating number as an integer.
    static func integer(_ value: Any?) throws -> UInt32 {
        guard let n = value as? NSNumber, CFGetTypeID(n) == CFNumberGetTypeID(),
              ["c", "C", "s", "S", "i", "I", "l", "L", "q", "Q"].contains(String(cString: n.objCType)),
              n.int64Value >= 0, n.int64Value <= Int64(UInt32.max),
              n.stringValue == String(n.int64Value) else { throw Failure.unavailable }
        return UInt32(n.int64Value)
    }
    enum SignerRole: Equatable { case helper, parent, framework }
    // Apple Security ef677c3d667a44e1737c1b0245e9ed04d11c51c1,
    // OSX/sec/Security/SecPolicy.c, SecPolicyCreateAppleExternalDeveloperOptionalExpiry:
    // CFSTR("1.2.840.113635.100.6.2.6") = Developer ID intermediate marker;
    // CFSTR("1.2.840.113635.100.6.1.13") = Developer ID Application leaf marker.
    // That broad Apple policy also lists OTHER profiles. We intentionally require
    // BOTH of these specific markers, with no OR, profile fallback, supplied OID,
    // requirement fragment or arbitrary identifier. Not certificate acceptance
    // evidence until evaluated by real Security APIs on the actual signed code.
    static func requirementText(team: String, role: SignerRole) throws -> String {
        guard team.utf8.count == 10,
              team.utf8.allSatisfy({ (65...90).contains($0) || (48...57).contains($0) }) else { throw Failure.unavailable }
        let base = "anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists" +
            " and certificate leaf[field.1.2.840.113635.100.6.1.13] exists" +
            " and certificate leaf[subject.OU] = \"\(team)\""
        switch role {
        case .helper, .framework: return base
        case .parent: return base + " and identifier \"ai.usebrian.desktop\""
        }
    }
    // Provisional CF policy before capture: a nil/nil result is NOT evidence of
    // absence. capturedEntitlements must close that case after full verification.
    static func entitlements(_ value: Any?, rawBlobPresent: Bool, helper: Bool) throws {
        if value == nil { guard !rawBlobPresent else { throw Failure.unavailable }; return }
        guard let dictionary = value as? [String: Any], dictionary.count <= 128 else { throw Failure.unavailable }
        let common = ["get-task-allow", "com.apple.security.get-task-allow",
            "com.apple.security.cs.allow-dyld-environment-variables",
            "com.apple.security.cs.disable-executable-page-protection"]
        let electronExceptions = ["com.apple.security.cs.disable-library-validation", "com.apple.security.cs.allow-jit",
            "com.apple.security.cs.allow-unsigned-executable-memory"]
        let forbidden = common + (helper ? electronExceptions : [])
        // The standalone helper needs no positive entitlement. Unknown helper
        // keys require an explicit profile review, not a growing denylist of
        // known ways to weaken executable-page or library protections.
        if helper && !Set(dictionary.keys).isSubset(of: Set(forbidden)) { throw Failure.unavailable }
        // Unknown types refuse even if their coercion would be false. Electron's
        // JIT/unsigned-memory/LV exceptions are deliberately not helper exceptions.
        for key in forbidden where dictionary[key] != nil {
            guard let n = dictionary[key] as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID(),
                  !n.boolValue else { throw Failure.unavailable }
        }
    }
    // This is a locator hint until the SAME capture/sample passes the full
    // BootstrapApproval.bind or MachOLibraryConstraint.extract verifier. The
    // SuperBlob index is not itself CD-hashed; special-slot verification is
    // mandatory before interpreting presence OR absence. No trust flag/setter.
    struct ImageHeader {
        let context: MachOLibraryConstraint.MainImageContext
        let xmlEntitlementsPresent: Bool
        let derEntitlementsPresent: Bool
        fileprivate init(context: MachOLibraryConstraint.MainImageContext, slots: Set<Int>) {
            self.context = context
            xmlEntitlementsPresent = slots.contains(5)
            derEntitlementsPresent = slots.contains(7)
        }
    }
    // Call only AFTER full page/container/special-slot validation of the same
    // immutable capture. CF missing XML/dictionary alone never proves absence:
    // DER slot 7 may be present without a supported CF dictionary representation.
    static func capturedEntitlements(_ value: Any?, raw: Any?, image: ImageHeader, helper: Bool) throws {
        let present = image.xmlEntitlementsPresent || image.derEntitlementsPresent
        if present {
            guard value != nil else { throw Failure.unavailable }
        } else {
            guard value == nil, raw == nil else { throw Failure.unavailable }
        }
        if let raw = raw {
            guard let bytes = raw as? Data, !bytes.isEmpty, bytes.count <= 16 * 1024 * 1024 else { throw Failure.unavailable }
        }
        try entitlements(value, rawBlobPresent: raw != nil, helper: helper)
    }
    // No coercion/default-to-empty across final Security revalidation. Only
    // bounded, Security-produced property-list dictionaries are compared here.
    static func sameEntitlements(_ before: Any?, rawBefore: Any?, _ after: Any?, rawAfter: Any?) throws {
        guard (before == nil) == (after == nil), (rawBefore == nil) == (rawAfter == nil) else { throw Failure.unavailable }
        if let before = before {
            guard let a = before as? [String: Any], let b = after as? [String: Any],
                  a.count <= 128, b.count <= 128, NSDictionary(dictionary: a).isEqual(to: b) else { throw Failure.unavailable }
        }
        if let rawBefore = rawBefore {
            guard let a = rawBefore as? Data, let b = rawAfter as? Data,
                  !a.isEmpty, a.count <= 16 * 1024 * 1024, a == b else { throw Failure.unavailable }
        }
    }
    // Exact Electron v43.2.0 integrity_digest.mm / mac-asar-integrity.mjs:
    // ASCII key + "SHA256" + LOWERCASE HEX TEXT, sorted, no separators.
    // Foundation's ICU regex can match $ before a final line terminator.
    // Require a whole-key match to preserve the JS parser's strict end boundary.
    static func asarDigest(_ value: Any?) throws -> [UInt8] {
        guard let dictionary = value as? [String: Any], !dictionary.isEmpty, dictionary.count <= 128 else { throw Failure.unavailable }
        var entries = [(String, String)]()
        for key in dictionary.keys {
            guard key.utf8.count <= 1024, key.utf8.allSatisfy({ $0 < 128 }),
                  key.range(of: "^Resources/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\\.asar$", options: .regularExpression) == key.startIndex..<key.endIndex,
                  let item = dictionary[key] as? [String: Any], Set(item.keys) == Set(["algorithm", "hash"]),
                  item["algorithm"] as? String == "SHA256", let hash = item["hash"] as? String,
                  hash.utf8.count == 64, hash.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { throw Failure.unavailable }
            entries.append((key, hash))
        }
        var digest = SHA256()
        for (key, hash) in entries.sorted(by: { $0.0 < $1.0 }) {
            digest.update(data: Data(key.utf8)); digest.update(data: Data("SHA256".utf8)); digest.update(data: Data(hash.utf8))
        }
        return Array(digest.finalize())
    }

    // Independent architecture bootstrap. Authenticate ALL code pages and the
    // exact primary CD against the supplied selected kernel hash BEFORE reading
    // CPU/subtype. No fat-table/host-based architecture guess or trial/retry.
    // This is only a first-stage proof, never a substitute for the full existing
    // Mach-O/library/anchor parser (which checks every slice and all special slots).
    static func authenticatedArchitecture(_ b: [UInt8], sample: Sample) throws -> MachOLibraryConstraint.MainImageContext {
        try authenticatedImageHeader(b, sample: sample).context
    }
    static func authenticatedImageHeader(_ b: [UInt8], sample: Sample) throws -> ImageHeader {
        guard MemoryLayout<Int>.size == 8, b.count >= 32, b.count <= 512 * 1024 * 1024, sample.offset >= 0,
              sample.offset <= Int64(Int32.max), sample.offset <= Int64(b.count - 32), sample.hash.count == 20 else { throw Failure.unavailable }
        func range(_ offset: Int, _ size: Int, _ limit: Int) throws {
            guard offset >= 0, size >= 0, offset <= limit, size <= limit - offset else { throw Failure.unavailable }
        }
        func word(_ at: Int, _ little: Bool = false) throws -> Int {
            try range(at, 4, b.count)
            var n: UInt32 = 0
            for i in 0..<4 { n = (n << 8) | UInt32(b[at + (little ? 3 - i : i)]) }
            return Int(n)
        }
        let base = Int(sample.offset), commandCount = try word(base + 16, true), commands = try word(base + 20, true)
        guard commandCount > 0, commandCount <= 4096, commandCount * 8 <= commands else { throw Failure.unavailable }
        try range(base + 32, commands, b.count)
        let commandEnd = base + 32 + commands
        var at = base + 32, signature: (Int, Int)?
        for _ in 0..<commandCount {
            try range(at, 8, commandEnd)
            let kind = try word(at, true), size = try word(at + 4, true)
            guard size >= 8, size % 8 == 0 else { throw Failure.unavailable }
            try range(at, size, commandEnd)
            if kind == 0x1d {
                guard signature == nil, size == 16 else { throw Failure.unavailable }
                let offset = try word(at + 8, true), length = try word(at + 12, true)
                try range(base + offset, length, b.count)
                guard offset >= commandEnd - base, length >= 20, length <= 16 * 1024 * 1024 else { throw Failure.unavailable }
                signature = (base + offset, length)
            }
            at += size
        }
        guard at == commandEnd, let (sig, sigSize) = signature,
              try word(sig) == 0xfade0cc0 else { throw Failure.unavailable }
        let sbSize = try word(sig + 4), count = try word(sig + 8)
        guard count > 0, count <= 9, sbSize <= sigSize, sbSize >= 12 + count * 8 else { throw Failure.unavailable }
        var cd: Int?, cdSize = 0
        var seen = Set<Int>()
        for i in 0..<count {
            let slot = try word(sig + 12 + i * 8), offset = try word(sig + 16 + i * 8)
            guard [0,2,5,7,8,9,10,11,0x10000].contains(slot), seen.insert(slot).inserted,
                  offset >= 12 + count * 8 else { throw Failure.unavailable }
            try range(offset, 8, sbSize)
            let length = try word(sig + offset + 4)
            guard length >= 8 else { throw Failure.unavailable }
            try range(offset, length, sbSize)
            if slot == 0 { cd = sig + offset; cdSize = length }
        }
        guard let cd = cd, cdSize >= 88, try word(cd) == 0xfade0c02,
              Array(SHA256.hash(data: Data(b[cd..<(cd + cdSize)])).prefix(20)) == sample.hash else { throw Failure.unavailable }
        let version = try word(cd + 8), headerSizes = [0x20400:88, 0x20500:96, 0x20600:108]
        guard let header = headerSizes[version], cdSize >= header, b[cd + 36] == 32, b[cd + 37] == 2, b[cd + 38] == 0,
              [12,14].contains(b[cd + 39]), b[(cd + 40)..<(cd + 48)].allSatisfy({ $0 == 0 }),
              b[(cd + 52)..<(cd + 64)].allSatisfy({ $0 == 0 }) else { throw Failure.unavailable }
        if version >= 0x20500 && !b[(cd + 92)..<(cd + 96)].allSatisfy({ $0 == 0 }) { throw Failure.unavailable }
        if version >= 0x20600 && !b[(cd + 96)..<(cd + 108)].allSatisfy({ $0 == 0 }) { throw Failure.unavailable }
        let special = try word(cd + 24)
        let limit = try word(cd + 32), hashes = try word(cd + 16), pages = try word(cd + 28), pageSize = 1 << Int(b[cd + 39])
        guard limit == sig - base, limit >= commandEnd - base, special <= 11, hashes - special * 32 >= header,
              pages == (limit + pageSize - 1) / pageSize, hashes + pages * 32 == cdSize else { throw Failure.unavailable }
        try range(hashes, pages * 32, cdSize)
        // Same narrow CodeDirectory structural profile as the main Mach-O
        // module, including flags, exec segment and string/hash-table layout.
        // Container/section geometry and special-blob authentication still
        // belong to the mandatory full parser, not this architecture proof.
        func wide(_ at: Int) throws -> UInt64 {
            try range(at, 8, cd + cdSize)
            var n: UInt64 = 0
            for i in 0..<8 { n = (n << 8) | UInt64(b[at + i]) }
            return n
        }
        let execBase = try wide(cd + 64), execSize = try wide(cd + 72)
        guard UInt32(try word(cd + 12)) & ~UInt32(0x00033f02) == 0,
              try wide(cd + 80) & ~UInt64(0x3f1) == 0,
              execBase <= UInt64(limit), execSize <= UInt64(limit) - execBase else { throw Failure.unavailable }
        let hashStart = hashes - special * 32
        var parts = [(start: 0, end: header), (start: hashStart, end: cdSize)]
        for field in [20,48] {
            let offset = try word(cd + field)
            if offset == 0 && field == 48 { continue }
            guard offset >= header, offset < hashStart else { throw Failure.unavailable }
            var end = offset
            while end < hashStart && b[cd + end] != 0 { end += 1 }
            guard end > offset, end < hashStart else { throw Failure.unavailable }
            parts.append((start: offset, end: end + 1))
        }
        parts.sort { $0.start < $1.start }
        for i in 1..<parts.count {
            guard parts[i].start >= parts[i-1].end,
                  b[(cd + parts[i-1].end)..<(cd + parts[i].start)].allSatisfy({ $0 == 0 }) else { throw Failure.unavailable }
        }
        for slot in [4,6] where slot <= special {
            guard b[(cd + hashes - slot * 32)..<(cd + hashes - (slot - 1) * 32)].allSatisfy({ $0 == 0 }) else { throw Failure.unavailable }
        }
        for page in 0..<pages {
            let lo = base + page * pageSize, hi = min(lo + pageSize, base + limit)
            let expected = Array(b[(cd + hashes + page * 32)..<(cd + hashes + (page + 1) * 32)])
            guard Array(SHA256.hash(data: Data(b[lo..<hi]))) == expected else { throw Failure.unavailable }
        }
        guard try word(base, true) == 0xfeedfacf else { throw Failure.unavailable }
        let cpu = try word(base + 4, true), subtype = try word(base + 8, true)
        if cpu == 0x0100000c && subtype == 0 { return ImageHeader(context: .init(architecture: .arm64), slots: seen) }
        if cpu == 0x01000007 && subtype == 3 { return ImageHeader(context: .init(architecture: .x86_64), slots: seen) }
        throw Failure.unavailable
    }
}

#if os(macOS)
import Darwin
import Security
import Dispatch

extension BootstrapProcessBinding {
    // Not an authority cache/token. Callers must not use DataResult for control.
    // Unsupported API result types and any uncertain state return unavailable.
    static func collect(trust: ProcessTrust) throws -> DataResult {
        do { return try Collection(trust: trust).run() }
        catch { throw Failure.unavailable }
    }
    // Fence later probe requests to the exact exec generations, kernel hashes
    // and signing state authenticated by collection. PID/birth/path alone do not
    // detect exec of a different same-team parent. No disk-derived hash fallback.
    static func revalidate(_ data: DataResult, trust: ProcessTrust) throws {
        let collection = Collection(trust: trust)
        try collection.relationship()
        let own = try collection.sample(true), parent = try collection.sample(false)
        try validatePair(own, parent, ownPID: getpid(), parentPID: getppid(), user: getuid())
        try unchanged(data.ownProcess, own)
        try unchanged(data.parentProcess, parent)
        try collection.relationship()
    }
    private final class Collection {
        let trust: ProcessTrust
        let budget = Budget(start: DispatchTime.now().uptimeNanoseconds)
        init(trust: ProcessTrust) { self.trust = trust }
        func tick() throws { try budget.check(DispatchTime.now().uptimeNanoseconds) }
        func relationship() throws {
            try tick()
            guard getuid() > 0, getuid() == geteuid(), getpid() == trust.helper.pid, getppid() == trust.parent.pid,
                  brian_private_pipes() == 1, brian_private_channel_alive() == 1,
                  ProcessIdentity.read(getpid()) == trust.helper, ProcessIdentity.read(getppid()) == trust.parent,
                  trust.team.utf8.count == 10, trust.team.utf8.allSatisfy({ (65...90).contains($0) || (48...57).contains($0) }) else { throw Failure.unavailable }
            try tick()
        }
        func sample(_ own: Bool) throws -> Sample {
            try tick()
            var raw = brian_kernel_signing_data()
            // No parameter for an arbitrary PID; only current self/current parent.
            guard brian_kernel_signing_snapshot(own ? getpid() : getppid(), getuid(), &raw) == BRIAN_KERNEL_UNVERIFIED_DATA else { throw Failure.unavailable }
            let uuid = withUnsafeBytes(of: raw.executable_uuid) { Array($0) }
            let hash = withUnsafeBytes(of: raw.main_cdhash) { Array($0) }
            let value = Sample(pid: raw.pid, user: raw.user, uniqueID: raw.unique_id, parentUniqueID: raw.parent_unique_id,
                execID: raw.exec_idversion, status: raw.signing_status, offset: raw.slice_offset, uuid: uuid, hash: hash)
            try tick(); return value
        }
        struct Stamp: Equatable {
            let dev: Int64, ino: UInt64, size: Int64, mode: UInt32, uid: UInt32, gid: UInt32, links: UInt64
            let modifiedSeconds: Int64, modifiedNanos: Int64, changedSeconds: Int64, changedNanos: Int64
            let birthSeconds: Int64, birthNanos: Int64, flags: UInt32, generation: UInt32
            init(_ s: stat) {
                dev = Int64(s.st_dev); ino = UInt64(s.st_ino); size = Int64(s.st_size); mode = UInt32(s.st_mode)
                uid = s.st_uid; gid = s.st_gid; links = UInt64(s.st_nlink)
                modifiedSeconds = Int64(s.st_mtimespec.tv_sec); modifiedNanos = Int64(s.st_mtimespec.tv_nsec)
                changedSeconds = Int64(s.st_ctimespec.tv_sec); changedNanos = Int64(s.st_ctimespec.tv_nsec)
                birthSeconds = Int64(s.st_birthtimespec.tv_sec); birthNanos = Int64(s.st_birthtimespec.tv_nsec)
                flags = s.st_flags; generation = s.st_gen
            }
        }
        struct Capture { let path: String; let bytes: [UInt8]; let stamp: Stamp }
        func statPath(_ path: String) throws -> Stamp {
            try tick(); var s = stat()
            guard canonicalPath(path) == path, lstat(path, &s) == 0, (s.st_mode & S_IFMT) == S_IFREG else { throw Failure.unavailable }
            try tick(); return Stamp(s)
        }
        func capture(_ path: String, maximum: Int) throws -> Capture {
            let initial = try statPath(path)
            guard initial.size >= 32, initial.size <= Int64(maximum) else { throw Failure.unavailable }
            let fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
            guard fd >= 0 else { throw Failure.unavailable }
            defer { close(fd) }
            try tick()
            var s = stat()
            guard fstat(fd, &s) == 0, Stamp(s) == initial else { throw Failure.unavailable }
            var bytes = [UInt8](repeating: 0, count: Int(initial.size)), offset = 0
            while offset < bytes.count {
                try tick()
                let amount = min(64 * 1024, bytes.count - offset)
                let n = bytes.withUnsafeMutableBytes { raw -> Int in
                    guard let address = raw.baseAddress else { return -1 }
                    return Darwin.read(fd, address.advanced(by: offset), amount)
                }
                // EINTR/errors refuse; positive short reads advance, never retry
                // a failed read or rewind/restart a capture/signature transaction.
                guard n > 0, n <= amount else { throw Failure.unavailable }
                offset += n
            }
            try tick()
            var extra: UInt8 = 0
            guard Darwin.read(fd, &extra, 1) == 0, fstat(fd, &s) == 0, Stamp(s) == initial,
                  try statPath(path) == initial else { throw Failure.unavailable }
            try tick(); return Capture(path: path, bytes: bytes, stamp: initial)
        }
        func requirement(_ role: SignerRole) throws -> SecRequirement {
            let text = try BootstrapProcessBinding.requirementText(team: trust.team, role: role)
            var r: SecRequirement?
            guard SecRequirementCreateWithString(text as CFString, [], &r) == errSecSuccess,
                  let r = r else { throw Failure.unavailable }
            return r
        }
        var offlineStrict: SecCSFlags { SecCSFlags(rawValue: kSecCSStrictValidate).union(.noNetworkAccess) }
        func metadata(_ code: SecStaticCode) throws -> [String: Any] {
            try tick()
            var info: CFDictionary?
            guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
                  let info = info as? [String: Any] else { throw Failure.unavailable }
            try tick(); return info
        }
        struct SigningMetadata {
            let associated: [String: Any]
            let selected: [String: Any]
        }
        func capturedMetadata(_ metadata: SigningMetadata, image: ImageHeader, own: Bool) throws {
            for info in [metadata.associated, metadata.selected] {
                try BootstrapProcessBinding.capturedEntitlements(info[kSecCodeInfoEntitlementsDict as String],
                    raw: info[kSecCodeInfoEntitlements as String], image: image, helper: own)
            }
            try consistentMetadata(metadata.associated, metadata.selected)
        }
        func consistentMetadata(_ before: [String: Any], _ after: [String: Any]) throws {
            try BootstrapProcessBinding.sameEntitlements(before[kSecCodeInfoEntitlementsDict as String],
                rawBefore: before[kSecCodeInfoEntitlements as String], after[kSecCodeInfoEntitlementsDict as String],
                rawAfter: after[kSecCodeInfoEntitlements as String])
        }
        func signature(_ own: Bool, _ snapshot: Sample) throws -> SigningMetadata {
            try relationship()
            let identity = own ? trust.helper : trust.parent, r = try requirement(own ? .helper : .parent)
            var guest: SecCode?
            let attributes = [kSecGuestAttributePid as String: NSNumber(value: own ? getpid() : getppid())] as CFDictionary
            guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &guest) == errSecSuccess, let guest = guest else { throw Failure.unavailable }
            try tick()
            guard SecCodeCheckValidity(guest, offlineStrict, r) == errSecSuccess else { throw Failure.unavailable }
            try tick()
            // Bind BOTH guest's associated static code and explicitly selected
            // disk slice to the exact kernel hash, never a union of alternatives.
            var associated: SecStaticCode?
            guard SecCodeCopyStaticCode(guest, [], &associated) == errSecSuccess, let associated = associated else { throw Failure.unavailable }
            try tick()
            let flags = offlineStrict.union(SecCSFlags(rawValue: own ? 0 : kSecCSCheckNestedCode))
            guard SecStaticCodeCheckValidity(associated, flags, r) == errSecSuccess else { throw Failure.unavailable }
            try tick()
            let associatedInfo = try metadata(associated)
            try checkMetadata(associatedInfo, identity: identity, snapshot: snapshot, own: own)
            guard snapshot.offset >= 0, snapshot.offset <= Int64(Int32.max) else { throw Failure.unavailable }
            var selected: SecStaticCode?
            let selection = [kSecCodeAttributeUniversalFileOffset as String: NSNumber(value: Int32(snapshot.offset))] as CFDictionary
            guard SecStaticCodeCreateWithPathAndAttributes(URL(fileURLWithPath: identity.executable) as CFURL, [], selection, &selected) == errSecSuccess,
                  let selected = selected else { throw Failure.unavailable }
            try tick()
            guard SecStaticCodeCheckValidity(selected, flags, r) == errSecSuccess else { throw Failure.unavailable }
            try tick()
            let info = try metadata(selected)
            try checkMetadata(info, identity: identity, snapshot: snapshot, own: own)
            guard SecCodeCheckValidity(guest, offlineStrict, r) == errSecSuccess,
                  ProcessIdentity.read(identity.pid) == identity else { throw Failure.unavailable }
            try tick(); return SigningMetadata(associated: associatedInfo, selected: info)
        }
        func checkMetadata(_ info: [String: Any], identity: ProcessIdentity, snapshot: Sample, own: Bool) throws {
            guard let executable = info[kSecCodeInfoMainExecutable as String] as? URL,
                  executable.isFileURL, canonicalPath(executable.path) == identity.executable,
                  let hash = info[kSecCodeInfoUnique as String] as? Data, hash.count == 20, Array(hash) == snapshot.hash,
                  info[kSecCodeInfoTeamIdentifier as String] as? String == trust.team else { throw Failure.unavailable }
            let flags = try BootstrapProcessBinding.integer(info[kSecCodeInfoFlags as String])
            guard flags & 0x10000 != 0, flags & 0x20006 == 0,
                  try BootstrapProcessBinding.integer(info[kSecCodeInfoDigestAlgorithm as String]) == 2 else { throw Failure.unavailable }
            try BootstrapProcessBinding.entitlements(info[kSecCodeInfoEntitlementsDict as String],
                rawBlobPresent: info[kSecCodeInfoEntitlements as String] != nil, helper: own)
        }
        // Reproduce the existing hardenedParentBootstrap CF policy OFFLINE.
        // Do NOT call legacy parentValid/signedProcess: their Security calls do
        // not explicitly prohibit network access. Existing fuse parser is pure.
        func framework(_ parentInfo: [String: Any], approval: BootstrapApproval.ApprovalData) throws -> (Capture, [UInt8], Int) {
            guard let plist = parentInfo[kSecCodeInfoPList as String] as? [String: Any],
                  plist["BrianElectronFusePolicy"] as? String == electronBootstrapPolicy,
                  let integrity = plist["ElectronAsarIntegrity"] as? [String: Any], integrity["Resources/app.asar"] != nil else { throw Failure.unavailable }
            let digest = try BootstrapProcessBinding.asarDigest(integrity)
            let contents = URL(fileURLWithPath: trust.parent.executable).deletingLastPathComponent().deletingLastPathComponent().path
            let bundle = contents + "/Frameworks/Electron Framework.framework"
            let path = bundle + "/Versions/A/Electron Framework", archive = contents + "/Resources/app.asar"
            guard canonicalPath(archive) == archive, canonicalPath(path) == path,
                  canonicalPath(bundle + "/Electron Framework") == path else { throw Failure.unavailable }
            func validate() throws {
                try tick(); var code: SecStaticCode?
                let r = try requirement(.framework)
                guard SecStaticCodeCreateWithPath(URL(fileURLWithPath: bundle) as CFURL, [], &code) == errSecSuccess, let code = code else { throw Failure.unavailable }
                try tick()
                guard SecStaticCodeCheckValidity(code, offlineStrict.union(SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSCheckNestedCode)), r) == errSecSuccess else { throw Failure.unavailable }
                try tick()
                let info = try metadata(code)
                guard let url = info[kSecCodeInfoMainExecutable as String] as? URL, url.isFileURL, canonicalPath(url.path) == path,
                      let plist = info[kSecCodeInfoPList as String] as? [String: Any],
                      plist["CFBundleVersion"] as? String == BootstrapApproval.electronVersion else { throw Failure.unavailable }
                try tick()
            }
            try validate(); let bytes = try capture(path, maximum: 512 * 1024 * 1024)
            guard hardenedElectronWire(Data(bytes.bytes)) else { throw Failure.unavailable }
            try tick(); try validate()
            // Never invent a kernel hash for a library. The expected set comes
            // from the independently bound own-helper mapped approval. Check all
            // captured slices, signed ASAR digest and fuse bytes against it.
            let artifact = try ElectronFrameworkBinding.bind(capturedFramework: bytes.bytes, approval: approval)
            try tick()
            return (bytes, digest, artifact.architectureCount)
        }
        func run() throws -> DataResult {
            try relationship()
            let ownBefore = try sample(true), parentBefore = try sample(false)
            try BootstrapProcessBinding.validatePair(ownBefore, parentBefore, ownPID: getpid(), parentPID: getppid(), user: getuid())
            let ownInfo = try signature(true, ownBefore)
            let own = try capture(trust.helper.executable, maximum: 128 * 1024 * 1024)
            let ownImage = try BootstrapProcessBinding.authenticatedImageHeader(own.bytes, sample: ownBefore)
            try tick(); try relationship()
            // Only after own kernel, dynamic+selected static signature, forbidden
            // entitlement checks and authenticated captured header/code pages.
            guard let mapped = BootstrapApproval.copyOwnMappedRecord() else { throw Failure.unavailable }
            let approval = try BootstrapApproval.bind(capturedHelper: own.bytes, kernel: ownBefore.expectation,
                context: ownImage.context, mappedRecord: mapped)
            try capturedMetadata(ownInfo, image: ownImage, own: true)
            try tick()
            let parentInfo = try signature(false, parentBefore)
            let parent = try capture(trust.parent.executable, maximum: 512 * 1024 * 1024)
            let parentImage = try BootstrapProcessBinding.authenticatedImageHeader(parent.bytes, sample: parentBefore)
            try tick()
            let policy = try MachOLibraryConstraint.extract(capturedMain: parent.bytes, kernel: parentBefore.expectation, context: parentImage.context)
            try capturedMetadata(parentInfo, image: parentImage, own: false)
            let compared = try LibraryConstraintPolicy.compare(rawGenericBlob: policy.rawBlob,
                expectedTeam: trust.team, expectedCDHashes: approval.libraryCDHashes)
            guard compared.policyMatchesSuppliedInventory else { throw Failure.unavailable }
            try tick()
            let (frame, digest, frameworkArchitectures) = try framework(parentInfo.selected, approval: approval)
            guard approval.electronVersion == BootstrapApproval.electronVersion, digest == approval.asarDigest else { throw Failure.unavailable }
            let finalOwnInfo = try signature(true, ownBefore)
            let finalParentInfo = try signature(false, parentBefore)
            try capturedMetadata(finalOwnInfo, image: ownImage, own: true)
            try capturedMetadata(finalParentInfo, image: parentImage, own: false)
            try consistentMetadata(ownInfo.associated, finalOwnInfo.associated)
            try consistentMetadata(ownInfo.selected, finalOwnInfo.selected)
            try consistentMetadata(parentInfo.associated, finalParentInfo.associated)
            try consistentMetadata(parentInfo.selected, finalParentInfo.selected)
            // Repeat sealed plist/framework policy, not merely the main file stat.
            let (finalFrame, finalDigest, finalFrameworkArchitectures) = try framework(finalParentInfo.selected, approval: approval)
            guard finalDigest == digest, finalFrameworkArchitectures == frameworkArchitectures,
                  finalFrame.stamp == frame.stamp, finalFrame.bytes == frame.bytes,
                  try statPath(own.path) == own.stamp, try statPath(parent.path) == parent.stamp,
                  try statPath(frame.path) == frame.stamp,
                  BootstrapApproval.copyOwnMappedRecord() == mapped else { throw Failure.unavailable }
            try relationship()
            let ownAfter = try sample(true), parentAfter = try sample(false)
            try BootstrapProcessBinding.validatePair(ownAfter, parentAfter, ownPID: getpid(), parentPID: getppid(), user: getuid())
            try BootstrapProcessBinding.unchanged(ownBefore, ownAfter); try BootstrapProcessBinding.unchanged(parentBefore, parentAfter)
            try relationship(); try tick()
            // The captured framework artifact now matches the approved hashes,
            // ASAR digest and fuses. This is NOT loaded-image attestation: the
            // complete independently approved inventory, enforced launch chain
            // and native signed matrix remain required. No control claim.
            return DataResult(count: compared.matchedHashCount, frameworkArchitectures: frameworkArchitectures,
                own: ownBefore, parent: parentBefore)
        }
    }
}
#endif
