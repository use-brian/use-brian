#ifndef BRIAN_PROCESS_IDENTITY_H
#define BRIAN_PROCESS_IDENTITY_H
#include <stdint.h>
#include <stddef.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <poll.h>
// Data-only own-image approval copy; empty compiled records refuse use.
#include "BootstrapApprovalAnchor.h"
// Kernel process credentials, executable path and birth time; no app metadata.
int brian_process_identity(pid_t pid, uid_t user, char *path, uint32_t capacity,
                           uint64_t *birth);
// Kernel signing DATA ONLY. No result grants production authority, authenticates
// a peer, or proves a loaded framework. Private ABI compatibility: see
// KERNEL-SIGNING-PROBE.md. Failure clears the entire output; no partial evidence.
typedef enum {
    BRIAN_KERNEL_UNVERIFIED_DATA = 1,
    BRIAN_KERNEL_UNTRUSTED_DATA = 2,
    BRIAN_KERNEL_INVALID_ARGUMENT = 10,
    BRIAN_KERNEL_UNAVAILABLE = 11,
    BRIAN_KERNEL_SHORT_READ = 12,
    BRIAN_KERNEL_CHANGED = 13,
    BRIAN_KERNEL_CREDENTIALS = 14,
    BRIAN_KERNEL_UNSUPPORTED_DATA = 15, // nonzero remaining reserved ABI fields
    BRIAN_KERNEL_DEADLINE = 16,
    BRIAN_KERNEL_INVALID_IDENTITY = 17, // zero unique ID or exec generation
    BRIAN_KERNEL_INVALID_SLICE = 18, // negative active-slice offset
    BRIAN_KERNEL_MISSING_HASH = 19 // all-zero kernel cdhash
} brian_kernel_snapshot_result;
typedef struct {
    int32_t pid;
    uint32_t user;
    uint64_t unique_id;
    uint64_t parent_unique_id;
    uint32_t exec_idversion;
    uint32_t signing_status;
    int64_t slice_offset;
    uint8_t executable_uuid[16];
    uint8_t main_cdhash[20];
} brian_kernel_signing_data;
// Same ordinary non-root user only. Fixed reads, no retries, 250ms monotonic
// budget checked around calls (cannot interrupt a blocked kernel syscall).
// UNTRUSTED_DATA must never qualify for production. UNVERIFIED_DATA is still
// unauthenticated; this API has no production-acceptance result.
brian_kernel_snapshot_result brian_kernel_signing_snapshot(
    pid_t pid, uid_t user, brian_kernel_signing_data *output);

int brian_private_pipes(void);
// Liveness only, not endpoint authentication. No reads/writes: HUP/ERR remains
// observable even with unread command bytes. Shared inline primitive permits
// real POSIX pipe/socketpair tests without stubbing macOS process credentials.
static inline int brian_pipe_endpoints_alive(int input, int output) {
    if (input < 0 || output < 0) return 0;
    struct pollfd ends[2] = {{input, POLLIN, 0}, {output, POLLOUT, 0}};
    for (int i = 0; i < 2; i++) {
        struct stat s;
        if (fstat(ends[i].fd, &s) != 0 || (!S_ISFIFO(s.st_mode) && !S_ISSOCK(s.st_mode))) return 0;
    }
    if (poll(ends, 2, 0) < 0) return 0;
    return !(ends[0].revents & (POLLHUP | POLLERR | POLLNVAL)) &&
           !(ends[1].revents & (POLLHUP | POLLERR | POLLNVAL));
}
int brian_private_channel_alive(void);
#endif
