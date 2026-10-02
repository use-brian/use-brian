import Foundation

// Internal own-image source ONLY: no parent payload, path, environment or setter.
// This is not admission. The copied mapped record must still be bound by
// BootstrapApproval.bind to independently authenticated own-helper kernel/static
// signature evidence, with signing flags/entitlements and generation checked.
// Keeping this bridge separate allows pure parser tests without a mocked reader.
extension BootstrapApproval {
    static func copyOwnMappedRecord() -> [UInt8]? {
        var bytes = [UInt8](repeating: 0, count: Int(BRIAN_BOOTSTRAP_APPROVAL_SIZE))
        var written = 0
        let result = bytes.withUnsafeMutableBufferPointer { buffer in
            brian_bootstrap_approval_copy(buffer.baseAddress, buffer.count, &written)
        }
        guard result == BRIAN_BOOTSTRAP_ANCHOR_UNAUTHENTICATED_DATA,
              written == bytes.count, (try? decode(record: bytes)) != nil else { return nil }
        return bytes
    }
}
