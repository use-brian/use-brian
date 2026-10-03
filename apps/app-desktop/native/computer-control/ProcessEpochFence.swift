import Foundation

#if os(macOS)
// Strongly retained from BEFORE target birth/signature/AX/CG pinning. A clean
// zero-timeout poll means no exec/exit observed since this subscription; NOT a
// numeric generation and NOT an atomic transaction with subsequent input.
// C uses a try-only atomic gate and sticky poisoning, never delayed callbacks.
final class ProcessEpochFence {
    let pid: Int32
    private let handle: UnsafeMutableRawPointer
    init?(pid: Int32) {
        guard let handle = brian_epoch_fence_create(pid) else { return nil }
        self.pid = pid; self.handle = handle
    }
    func clean() -> Bool {
        withExtendedLifetime(self) { brian_epoch_fence_poll(handle) == 1 }
    }
    deinit { brian_epoch_fence_destroy(handle) }
}
#endif
