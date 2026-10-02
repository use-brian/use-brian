import Foundation

// DATA-ONLY comparator for the single observed user-arm64-macos26-v1 envelope.
// Counterpart of scripts/mac-library-constraint-policy.mjs, NOT its unsupported
// production verifier. No helper admission/build integration or native effects.
//
// Native format evidence: mac-library-constraint.arm64-macos26.v1.json (183 bytes),
// macOS 26.6.2/25G83, SDK 26.5, ad-hoc, never executed. Synthetic extensions are
// not further native evidence. The later cdhash-only load differential does NOT
// establish enforcement of the three-fact Developer ID/team/inventory policy.
//
// Source grounding (same pins as JS):
// apple-oss-distributions/xnu @ ac9718fb1af618d5ce8678d0dc6e8a58f252216f,
// EXTERNAL_HEADERS/{CoreEntitlements/CoreEntitlementsPriv.h,Serialization.h,
// Entitlements.h,der_vm.h;corecrypto/ccder.h,ccasn1.h}: tag bits and ordered tuples,
// NOT a complete LWCR wire specification. 0x70 is the application envelope tag;
// 0xb0's dictionary usage is observed, not independently generalized.
// apple-oss-distributions/Security @ 97c3a4296c1ea06b0fe1877a7e616aa84450b5b2,
// OSX/libsecurity_codesigning/lib/LWCRHelper.mm delegates parsing to sec_LWCR/TLE.
// xnu @ 1031c584a5e37aff177559b9f69dbd3c8c3fd30a, osfmk/kern/cs_blobs.h:
// generic magic 0xfade8181, library slot 11, Developer ID category 6.
// https://developer.apple.com/documentation/security/defining-launch-environment-and-library-constraints
// grounds implicit AND, team strings and binary cdhash/$in membership.
//
// ccat=0, comp=1, reqs and vers=1 (and outer INTEGER 1) are EXACT OBSERVED
// spelling/order/types/values, not generally grounded metadata semantics. No
// category/compatibility/version interpretation or generalized DER evaluation.
//
// Callers MUST independently establish trusted provenance of expectedTeam and
// the COMPLETE expectedCDHashes inventory; never derive them from this blob.
// This API cannot establish that provenance or authenticate any signing slot,
// CodeDirectory, kernel/slice/generation, CMS, team, loaded image or enforcement.
enum LibraryConstraintPolicy {
    static let observedProfile = "user-arm64-macos26-v1-envelope-only"
    enum Limits {
        static let bytes = 4096
        static let hashes = 64
        static let nodes = 128
        static let depth = 9
    }

    enum Failure: Error, Equatable {
        case rejected
        var code: String { "ERR_MAC_LIBRARY_CONSTRAINT_POLICY_COMPARISON" }
        var message: String {
            "Library constraint policy comparison rejected: unsupported profile, malformed input, or inventory mismatch"
        }
    }

    // Value-only, immutable evidence, constructed only after complete comparison.
    // No input references, team or hashes are exposed. There is no authority mode.
    struct Match: Equatable {
        let kind = "observed-policy-comparison"
        let profile = LibraryConstraintPolicy.observedProfile
        let policyMatchesSuppliedInventory = true
        let matchedHashCount: Int
        let productionAuthority = false
        let slotAuthentication = false
        let kernelAuthentication = false
        let cmsAuthentication = false
        let loadedImageAuthentication = false
        let nativeEnforcement = false

        fileprivate init(matchedHashCount: Int) {
            self.matchedHashCount = matchedHashCount
        }
    }

    // Typed Swift values only: no Any/NSData/Data(bytesNoCopy:), custom collection,
    // caller callbacks or borrowed memory API. Explicit bounded element copies
    // below create parser-owned immutable arrays; Array(input) is not relied upon
    // to detach copy-on-write storage. As with any Swift API, unsafe memory writes
    // or concurrent data races in the caller are outside the language's contract.
    static func compare(rawGenericBlob: [UInt8], expectedTeam: String,
                        expectedCDHashes: [[UInt8]]) throws -> Match {
        guard expectedCDHashes.count >= 1, expectedCDHashes.count <= Limits.hashes else {
            throw Failure.rejected
        }
        var team = [UInt8]()
        team.reserveCapacity(10)
        for byte in expectedTeam.utf8.prefix(11) {
            guard team.count < 10, (65...90).contains(byte) || (48...57).contains(byte) else {
                throw Failure.rejected
            }
            team.append(byte)
        }
        guard team.count == 10 else { throw Failure.rejected }
        var inventory = Set<[UInt8]>()
        for hash in expectedCDHashes {
            let owned = try ownedCopy(hash, minimum: 20, maximum: 20)
            guard inventory.insert(owned).inserted else { throw Failure.rejected }
        }
        let bytes = try ownedCopy(rawGenericBlob, minimum: 8, maximum: Limits.bytes)
        var parser = Parser(bytes: bytes)
        return try parser.compare(team: team, inventory: inventory)
    }

    private static func ownedCopy(_ input: [UInt8], minimum: Int, maximum: Int) throws -> [UInt8] {
        guard input.count >= minimum, input.count <= maximum else { throw Failure.rejected }
        var copy = [UInt8]()
        copy.reserveCapacity(input.count)
        for byte in input { copy.append(byte) }
        return copy
    }

    private struct View {
        var at: Int
        let end: Int
        let depth: Int
    }

    private struct Parser {
        let bytes: [UInt8] // Owned, immutable, at most 4096 bytes.
        private var nodes = 0
        init(bytes: [UInt8]) { self.bytes = bytes }

        private func word(_ at: Int) -> UInt32 {
            // Only called at 0/4 after the >=8 owned-copy guard.
            (UInt32(bytes[at]) << 24) | (UInt32(bytes[at + 1]) << 16) |
                (UInt32(bytes[at + 2]) << 8) | UInt32(bytes[at + 3])
        }

        private mutating func take(_ parent: inout View, tag: UInt8) throws -> View {
            guard nodes < Limits.nodes, parent.depth >= 0, parent.depth < Limits.depth,
                  parent.at >= 0, parent.at <= parent.end, parent.end <= bytes.count,
                  parent.end - parent.at >= 2 else { throw Failure.rejected }
            nodes += 1
            guard bytes[parent.at] == tag else { throw Failure.rejected }
            parent.at += 1
            var length = Int(bytes[parent.at])
            parent.at += 1
            if length & 0x80 != 0 {
                let count = length & 0x7f
                guard count >= 1, count <= 2, parent.end - parent.at >= count,
                      bytes[parent.at] != 0 else { throw Failure.rejected }
                length = 0
                for _ in 0..<count {
                    length = length * 256 + Int(bytes[parent.at]) // at most 65535
                    parent.at += 1
                }
                guard length >= 128, count != 2 || length >= 256 else { throw Failure.rejected }
            }
            guard length <= parent.end - parent.at else { throw Failure.rejected }
            let child = View(at: parent.at, end: parent.at + length, depth: parent.depth + 1)
            parent.at += length
            return child
        }

        private func end(_ view: View) throws {
            guard view.at == view.end else { throw Failure.rejected }
        }

        private func equal(_ view: View, _ expected: [UInt8]) -> Bool {
            guard view.end - view.at == expected.count else { return false }
            for index in expected.indices {
                if bytes[view.at + index] != expected[index] { return false }
            }
            return true
        }

        private mutating func integer(_ parent: inout View, _ expected: UInt8) throws {
            let view = try take(&parent, tag: 0x02)
            // Only exact, single-octet nonnegative 0/1/6: no BOOLEAN alias,
            // empty/negative INTEGER, redundant sign octet or alternate value.
            guard view.end - view.at == 1, bytes[view.at] == expected else { throw Failure.rejected }
        }

        private mutating func pair(_ parent: inout View, _ key: String) throws -> View {
            var view = try take(&parent, tag: 0x30)
            let name = try take(&view, tag: 0x0c)
            // Keys are internal fixed ASCII literals. No lossy UTF8 decoding,
            // replacement characters, normalization or Unicode equivalence.
            guard equal(name, Array(key.utf8)) else { throw Failure.rejected }
            return view
        }

        private mutating func integerPair(_ parent: inout View, _ key: String, _ value: UInt8) throws {
            var view = try pair(&parent, key)
            try integer(&view, value)
            try end(view)
        }

        mutating func compare(team: [UInt8], inventory: Set<[UInt8]>) throws -> Match {
            guard word(0) == 0xfade8181, word(4) == UInt32(bytes.count) else { throw Failure.rejected }
            var input = View(at: 8, end: bytes.count, depth: 0)
            var root = try take(&input, tag: 0x70)
            try end(input)
            try integer(&root, 1)
            var envelope = try take(&root, tag: 0xb0)
            try end(root)
            try integerPair(&envelope, "ccat", 0)
            try integerPair(&envelope, "comp", 1)
            var reqsPair = try pair(&envelope, "reqs")
            var reqs = try take(&reqsPair, tag: 0xb0)
            try end(reqsPair)
            var hashPair = try pair(&reqs, "cdhash")
            var hashDict = try take(&hashPair, tag: 0xb0)
            try end(hashPair)
            var inPair = try pair(&hashDict, "$in")
            var list = try take(&inPair, tag: 0x30)
            try end(inPair)
            try end(hashDict)
            var actual = Set<[UInt8]>()
            while list.at < list.end {
                guard actual.count < Limits.hashes else { throw Failure.rejected }
                let item = try take(&list, tag: 0x04)
                guard item.end - item.at == 20 else { throw Failure.rejected }
                var hash = [UInt8]()
                hash.reserveCapacity(20)
                for index in item.at..<item.end { hash.append(bytes[index]) }
                guard inventory.contains(hash), actual.insert(hash).inserted else { throw Failure.rejected }
            }
            guard !actual.isEmpty, actual.count == inventory.count else { throw Failure.rejected }
            var teamPair = try pair(&reqs, "team-identifier")
            let teamValue = try take(&teamPair, tag: 0x0c)
            guard equal(teamValue, team) else { throw Failure.rejected }
            try end(teamPair)
            try integerPair(&reqs, "validation-category", 6)
            try end(reqs)
            try integerPair(&envelope, "vers", 1)
            try end(envelope)
            return Match(matchedHashCount: actual.count)
        }
    }
}
