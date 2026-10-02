#include "ProcessIdentity.h"
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <string.h>

int brian_process_identity(pid_t pid, uid_t user, char *path, uint32_t capacity,
                           uint64_t *birth) {
    struct proc_bsdinfo before = {0}, after = {0};
    char confirmed_path[PROC_PIDPATHINFO_MAXSIZE] = {0};
    if (pid <= 1 || user == 0 || getuid() != user || geteuid() != user || getgid() != getegid() ||
        proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &before, sizeof(before)) != (int)sizeof(before) ||
        before.pbi_uid != user || before.pbi_ruid != user || before.pbi_svuid != user ||
        before.pbi_gid != before.pbi_rgid || before.pbi_gid != before.pbi_svgid ||
        proc_pidpath(pid, path, capacity) <= 0 ||
        proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &after, sizeof(after)) != (int)sizeof(after) ||
        after.pbi_uid != user || after.pbi_ruid != user || after.pbi_svuid != user ||
        after.pbi_gid != after.pbi_rgid || after.pbi_gid != after.pbi_svgid ||
        before.pbi_start_tvsec != after.pbi_start_tvsec ||
        before.pbi_start_tvusec != after.pbi_start_tvusec ||
        proc_pidpath(pid, confirmed_path, sizeof(confirmed_path)) <= 0 ||
        strcmp(path, confirmed_path) != 0) return 0;
    *birth = after.pbi_start_tvsec * 1000000ULL + after.pbi_start_tvusec;
    return *birth != 0;
}

static int private_endpoint(int fd) {
    struct stat status;
    if (fstat(fd, &status) != 0) return 0;
    if (S_ISFIFO(status.st_mode)) return status.st_nlink == 0; // anonymous pipe only
    // Node/libuv implements inherited stdio pipes as anonymous Unix socketpairs
    // on macOS. Accept only connected, unnamed local streams, never a listener,
    // pathname socket or network connection.
    if (!S_ISSOCK(status.st_mode)) return 0;
    struct sockaddr_un local = {0}, peer = {0};
    socklen_t local_size = sizeof(local), peer_size = sizeof(peer);
    const char unnamed[sizeof(local.sun_path)] = {0};
    int type = 0;
    socklen_t type_size = sizeof(type);
    uid_t uid = 0;
    gid_t gid = 0;
    return getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &type_size) == 0 && type == SOCK_STREAM &&
           getsockname(fd, (struct sockaddr *)&local, &local_size) == 0 &&
           getpeername(fd, (struct sockaddr *)&peer, &peer_size) == 0 &&
           local.sun_family == AF_UNIX && peer.sun_family == AF_UNIX &&
           // XNU sun_noname uses sizeof(struct sockaddr), not a two-byte length.
           local_size >= offsetof(struct sockaddr_un, sun_path) && local_size <= sizeof(local) &&
           peer_size >= offsetof(struct sockaddr_un, sun_path) && peer_size <= sizeof(peer) &&
           memcmp(local.sun_path, unnamed, sizeof(unnamed)) == 0 &&
           memcmp(peer.sun_path, unnamed, sizeof(unnamed)) == 0 &&
           getpeereid(fd, &uid, &gid) == 0 && uid != 0 && uid == getuid();
}

int brian_private_pipes(void) {
    return private_endpoint(STDIN_FILENO) && private_endpoint(STDOUT_FILENO);
}

// Kept separate from the signed-parent/process checks: watchdogs must never
// wait for code validation or AX to observe private-channel revocation.
int brian_private_channel_alive(void) {
    return brian_pipe_endpoints_alive(STDIN_FILENO, STDOUT_FILENO);
}

// Private ABI pinned to Apple XNU xnu-10002.1.13 and xnu-12377.121.6
// (ac9718fb1af618d5ce8678d0dc6e8a58f252216f). Offset 36 was reserved/zero in
// the older layout; it now contains the original parent's exec generation.
// Do not substitute start time or csops() for generation-checked reads.
// Exact source URLs, ABI limits and non-authority contract are in the probe doc.
#include <mach/message.h>
#include <time.h>

struct brian_proc_uniqidentifierinfo {
    uint8_t p_uuid[16];
    uint64_t p_uniqueid;
    uint64_t p_puniqueid;
    int32_t p_idversion;
    int32_t p_orig_ppidversion; // zero on the older ABI; DATA, not peer authority
    uint64_t p_reserve2;
    uint64_t p_reserve3;
};
_Static_assert(sizeof(struct brian_proc_uniqidentifierinfo) == 56, "private libproc ABI");
_Static_assert(offsetof(struct brian_proc_uniqidentifierinfo, p_uniqueid) == 16, "uniqueid ABI");
_Static_assert(offsetof(struct brian_proc_uniqidentifierinfo, p_idversion) == 32, "idversion ABI");
_Static_assert(offsetof(struct brian_proc_uniqidentifierinfo, p_orig_ppidversion) == 36, "original parent ABI");
_Static_assert(offsetof(struct brian_proc_uniqidentifierinfo, p_reserve2) == 40, "reserved ABI");
_Static_assert(offsetof(struct brian_proc_uniqidentifierinfo, p_reserve3) == 48, "reserved ABI");
_Static_assert(sizeof(audit_token_t) == 32 && sizeof(off_t) == 8 && sizeof(pid_t) == 4,
               "64-bit Darwin syscall ABI required");
_Static_assert(offsetof(audit_token_t, val[5]) == 20 && offsetof(audit_token_t, val[7]) == 28,
               "audit token selector ABI");

// sys/codesign.h is not shipped by every SDK. Signature copied from that XNU
// header. Weak import means an absent libSystem entry point fails closed rather
// than making the helper unloadable. Non-Apple attribute is for host shim tests;
// no alternative production implementation, symbol lookup or environment hook.
#if defined(__APPLE__)
extern int csops_audittoken(pid_t, unsigned int, void *, size_t, audit_token_t *)
    __attribute__((weak_import));
#else
extern int csops_audittoken(pid_t, unsigned int, void *, size_t, audit_token_t *)
    __attribute__((weak));
#endif

enum {
    BRIAN_PROC_PIDUNIQIDENTIFIERINFO = 17,
    BRIAN_CS_OPS_STATUS = 0,
    BRIAN_CS_OPS_CDHASH = 5,
    BRIAN_CS_OPS_PIDOFFSET = 6
};

static int kernel_monotonic_ns(uint64_t *value) {
    struct timespec time;
    if (clock_gettime(CLOCK_MONOTONIC, &time) != 0 || time.tv_sec < 0 ||
        time.tv_nsec < 0 || time.tv_nsec >= 1000000000L ||
        (uint64_t)time.tv_sec > (UINT64_MAX - (uint64_t)time.tv_nsec) / 1000000000ULL) return 0;
    *value = (uint64_t)time.tv_sec * 1000000000ULL + (uint64_t)time.tv_nsec;
    return 1;
}

static int kernel_within_budget(uint64_t start) {
    uint64_t now;
    return kernel_monotonic_ns(&now) && now >= start && now - start <= 250000000ULL;
}

static int kernel_credentials(const struct proc_bsdinfo *info, pid_t pid, uid_t user) {
    return info->pbi_pid == (uint32_t)pid && info->pbi_uid == user &&
        info->pbi_ruid == user && info->pbi_svuid == user &&
        info->pbi_gid == info->pbi_rgid && info->pbi_gid == info->pbi_svgid;
}

static brian_kernel_snapshot_result kernel_info(pid_t pid, int flavor, void *out,
                                                 int size, uint64_t start) {
    if (!kernel_within_budget(start)) return BRIAN_KERNEL_DEADLINE;
    int count = proc_pidinfo(pid, flavor, 0, out, size);
    if (!kernel_within_budget(start)) return BRIAN_KERNEL_DEADLINE;
    if (count <= 0) return BRIAN_KERNEL_UNAVAILABLE;
    if (count != size) return BRIAN_KERNEL_SHORT_READ;
    return BRIAN_KERNEL_UNVERIFIED_DATA;
}

struct brian_signing_round {
    uint32_t status;
    off_t offset;
    uint8_t hash[20];
};

static brian_kernel_snapshot_result kernel_signing_round(pid_t pid, audit_token_t *selector,
    struct brian_signing_round *round, int reverse, uint64_t start) {
    // Two independent fixed reads, NOT a retry. Reverse order brackets the hash
    // and offset reads with status reads. Differently initialized buffers also
    // expose incomplete writes in shim tests; real csops has no byte-count return.
    for (int step = 0; step < 3; ++step) {
        unsigned int operation;
        void *buffer;
        size_t size;
        switch (reverse ? 2 - step : step) {
            case 0: operation = BRIAN_CS_OPS_STATUS; buffer = &round->status; size = sizeof(round->status); break;
            case 1: operation = BRIAN_CS_OPS_PIDOFFSET; buffer = &round->offset; size = sizeof(round->offset); break;
            default: operation = BRIAN_CS_OPS_CDHASH; buffer = round->hash; size = sizeof(round->hash); break;
        }
        if (!kernel_within_budget(start)) return BRIAN_KERNEL_DEADLINE;
        int result = csops_audittoken(pid, operation, buffer, size, selector);
        if (!kernel_within_budget(start)) return BRIAN_KERNEL_DEADLINE;
        if (result != 0) return BRIAN_KERNEL_UNAVAILABLE;
    }
    return BRIAN_KERNEL_UNVERIFIED_DATA;
}

brian_kernel_snapshot_result brian_kernel_signing_snapshot(
    pid_t pid, uid_t user, brian_kernel_signing_data *output) {
    if (output == NULL) return BRIAN_KERNEL_INVALID_ARGUMENT;
    memset(output, 0, sizeof(*output));
    if (pid <= 1 || user == 0) return BRIAN_KERNEL_INVALID_ARGUMENT;
    gid_t caller_group = getgid();
    if (getuid() != user || geteuid() != user || getegid() != caller_group) return BRIAN_KERNEL_CREDENTIALS;
    if (csops_audittoken == NULL) return BRIAN_KERNEL_UNAVAILABLE;
    uint64_t start;
    if (!kernel_monotonic_ns(&start)) return BRIAN_KERNEL_UNAVAILABLE;
    struct brian_proc_uniqidentifierinfo first, last;
    struct proc_bsdinfo before, after, caller_before, caller_after;
    struct brian_signing_round a, b;
    memset(&first, 0xa5, sizeof(first)); memset(&last, 0x5a, sizeof(last));
    memset(&before, 0xa5, sizeof(before)); memset(&after, 0x5a, sizeof(after));
    memset(&caller_before, 0xa5, sizeof(caller_before)); memset(&caller_after, 0x5a, sizeof(caller_after));
    memset(&a, 0xa5, sizeof(a)); memset(&b, 0x5a, sizeof(b));
    brian_kernel_snapshot_result result;
#define BRIAN_KERNEL_READ(PID, FLAVOR, VALUE) do { \
    result = kernel_info((PID), (FLAVOR), &(VALUE), (int)sizeof(VALUE), start); \
    if (result != BRIAN_KERNEL_UNVERIFIED_DATA) return result; \
} while (0)
    BRIAN_KERNEL_READ(pid, BRIAN_PROC_PIDUNIQIDENTIFIERINFO, first);
    BRIAN_KERNEL_READ(pid, PROC_PIDTBSDINFO, before);
    BRIAN_KERNEL_READ(getpid(), PROC_PIDTBSDINFO, caller_before);
    if (!kernel_credentials(&before, pid, user) || !kernel_credentials(&caller_before, getpid(), user) || caller_before.pbi_gid != caller_group)
        return BRIAN_KERNEL_CREDENTIALS;
    if (first.p_uniqueid == 0 || first.p_idversion == 0) return BRIAN_KERNEL_INVALID_IDENTITY;
    if (first.p_reserve2 || first.p_reserve3) return BRIAN_KERNEL_UNSUPPORTED_DATA;
    // p_orig_ppidversion is a signed 32-bit generation counter, not reserved
    // padding. Zero remains valid for the older ABI; all bits participate in
    // the full before/after comparison below. Never use it as peer authority.
    // This is a PID/generation SELECTOR assembled from libproc data, NOT a
    // received/authenticated peer audit token. XNU checks only val[5] and val[7]
    // against the referenced process before each read and applies MAC checks.
    audit_token_t selector = {{0}};
    selector.val[5] = (uint32_t)pid;
    selector.val[7] = (uint32_t)first.p_idversion;
    result = kernel_signing_round(pid, &selector, &a, 0, start);
    if (result != BRIAN_KERNEL_UNVERIFIED_DATA) return result;
    result = kernel_signing_round(pid, &selector, &b, 1, start);
    if (result != BRIAN_KERNEL_UNVERIFIED_DATA) return result;
    BRIAN_KERNEL_READ(getpid(), PROC_PIDTBSDINFO, caller_after);
    BRIAN_KERNEL_READ(pid, PROC_PIDTBSDINFO, after);
    BRIAN_KERNEL_READ(pid, BRIAN_PROC_PIDUNIQIDENTIFIERINFO, last);
#undef BRIAN_KERNEL_READ
    if (getuid() != user || geteuid() != user || getgid() != caller_group || getegid() != caller_group ||
        !kernel_credentials(&after, pid, user) || !kernel_credentials(&caller_after, getpid(), user) || caller_after.pbi_gid != caller_group ||
        before.pbi_gid != after.pbi_gid || caller_before.pbi_gid != caller_after.pbi_gid)
        return BRIAN_KERNEL_CREDENTIALS;
    if (memcmp(&first, &last, sizeof(first)) != 0 || a.status != b.status || a.offset != b.offset ||
        memcmp(a.hash, b.hash, sizeof(a.hash)) != 0) return BRIAN_KERNEL_CHANGED;
    const uint8_t zero_hash[20] = {0};
    if (a.offset < 0) return BRIAN_KERNEL_INVALID_SLICE;
    if (memcmp(a.hash, zero_hash, sizeof(a.hash)) == 0) return BRIAN_KERNEL_MISSING_HASH;
    if (!kernel_within_budget(start)) return BRIAN_KERNEL_DEADLINE;
    brian_kernel_signing_data data = {0};
    data.pid = pid; data.user = user;
    data.unique_id = first.p_uniqueid; data.parent_unique_id = first.p_puniqueid;
    data.exec_idversion = (uint32_t)first.p_idversion;
    data.signing_status = a.status; data.slice_offset = a.offset;
    memcpy(data.executable_uuid, first.p_uuid, sizeof(data.executable_uuid));
    memcpy(data.main_cdhash, a.hash, sizeof(data.main_cdhash));
    *output = data;
    // Known unsafe status is explicitly classified as untrusted, but the other
    // class is STILL UNVERIFIED DATA, never production acceptance. No certificate,
    // team, requirement, library constraint, seal or loaded-image proof is here.
    const uint32_t required = 0x20000001U | 0x00010000U; // CS_SIGNED | CS_VALID | CS_RUNTIME
    const uint32_t unsafe = 0x00000002U | 0x00000004U | 0x00000020U | 0x01000000U | 0x10000000U | 0x00020000U;
    // CS_ADHOC | CS_GET_TASK_ALLOW | CS_INVALID_ALLOWED | CS_KILLED | CS_DEBUGGED | CS_LINKER_SIGNED
    return (a.status & required) != required || (a.status & unsafe) != 0 ?
        BRIAN_KERNEL_UNTRUSTED_DATA : BRIAN_KERNEL_UNVERIFIED_DATA;
}
