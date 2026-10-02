// Linux-only deterministic tests. All syscall substitutions live in THIS test
// translation unit. Never compile these shims into the helper or native probe.
#define proc_pidinfo test_pidinfo
#define proc_pidpath test_pidpath
#define csops_audittoken test_csops
#define clock_gettime test_clock
#define getuid test_uid
#define geteuid test_euid
#define getgid test_gid
#define getegid test_egid
#define getpid test_pid
#define getpeereid test_peereid
#include "ProcessIdentity.c"
#include <assert.h>
#include <stdio.h>

static int info_calls, cs_calls, clock_calls, uid_calls, euid_calls, gid_calls, egid_calls;
static int short_at, error_at, over_at, mutate_at, mutation, cs_error_at, cs_partial_op, cs_change_at, exec_at;
static int clock_fail_at, clock_jump_at, clock_back_at, credential_call, credential_kind;
static uint32_t flags;
static int64_t offset;
static int zero_hash;
static int32_t version, parent_version;
static unsigned int assertions;

static void reset(void) {
    info_calls = cs_calls = clock_calls = uid_calls = euid_calls = gid_calls = egid_calls = 0;
    short_at = error_at = over_at = mutate_at = mutation = cs_error_at = cs_partial_op = cs_change_at = exec_at = 0;
    clock_fail_at = clock_jump_at = clock_back_at = credential_call = credential_kind = 0;
    flags = 0x20010001U; offset = 4096; zero_hash = 0; version = 47; parent_version = 91;
}

int test_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int size) {
    assert(pid == 200 || pid == 400); assert(arg == 0); ++info_calls;
    if (info_calls == error_at) return 0;
    if (flavor == 17) {
        assert(size == 56);
        // Independent wire offsets from xnu-12377.121.6 proc_info_private.h;
        // do NOT serialize the production struct (that hid the older ABI bug).
        unsigned char wire[56] = {0}, uuid[16];
        uint64_t unique = 123456, parent = 333, reserved2 = 0, reserved3 = 0;
        int32_t exec_version = version, original_parent = parent_version;
        memset(uuid, 7, sizeof(uuid));
        if (info_calls == mutate_at) {
            switch (mutation) {
                case 1: unique++; break;
                case 2: exec_version++; break;
                case 3: uuid[15]++; break;
                case 4: unique = 0; break;
                case 5: exec_version = 0; break;
                case 6: original_parent ^= 1; break;
                case 7: reserved2 = 1; break;
                case 8: reserved3 = 1; break;
                case 9: parent++; break;
            }
        }
        memcpy(wire, uuid, 16);
        memcpy(wire + 16, &unique, 8);
        memcpy(wire + 24, &parent, 8);
        memcpy(wire + 32, &exec_version, 4);
        memcpy(wire + 36, &original_parent, 4);
        memcpy(wire + 40, &reserved2, 8);
        memcpy(wire + 48, &reserved3, 8);
        memcpy(buffer, wire, sizeof(wire));
    } else {
        assert(flavor == PROC_PIDTBSDINFO); assert(size == sizeof(struct proc_bsdinfo));
        struct proc_bsdinfo info = {0};
        info.pbi_pid = (uint32_t)pid;
        info.pbi_uid = info.pbi_ruid = info.pbi_svuid = 501;
        info.pbi_gid = info.pbi_rgid = info.pbi_svgid = 20;
        info.pbi_start_tvsec = 100; // Intentionally unchanged for exec/PID tests.
        if (info_calls == mutate_at) {
            switch (mutation) {
                case 1: info.pbi_uid = 0; break;
                case 2: info.pbi_ruid = 502; break;
                case 3: info.pbi_svuid = 0; break;
                case 4: info.pbi_gid = 21; break;
                case 5: info.pbi_rgid = 21; break;
                case 6: info.pbi_svgid = 21; break;
                case 7: info.pbi_pid++; break;
                case 8: info.pbi_gid = info.pbi_rgid = info.pbi_svgid = 21; break;
            }
        }
        memcpy(buffer, &info, sizeof(info));
    }
    return size + (info_calls == over_at) - (info_calls == short_at);
}

#ifndef BRIAN_TEST_MISSING_CSOPS
int test_csops(pid_t pid, unsigned int operation, void *buffer, size_t size, audit_token_t *token) {
    ++cs_calls;
    assert(pid == 200); assert(token->val[5] == 200 && token->val[7] == (uint32_t)version);
    for (int i = 0; i < 8; ++i) if (i != 5 && i != 7) assert(token->val[i] == 0);
    assert(operation == 0 || operation == 5 || operation == 6);
    if (cs_calls == cs_error_at || cs_calls == exec_at) return -1; // generation selector mismatch => ESRCH
    uint32_t status = flags;
    off_t slice = offset;
    uint8_t hash[20]; memset(hash, zero_hash ? 0 : 0x42, sizeof(hash));
    const void *source;
    switch (operation) {
        case 0: assert(size == 4); if (cs_calls == cs_change_at) status ^= 0x10000000U; source = &status; break;
        case 6: assert(size == 8); if (cs_calls == cs_change_at) slice++; source = &slice; break;
        default: assert(size == 20); if (cs_calls == cs_change_at) hash[19]++; source = hash; break;
    }
    // Fault injection deliberately violates the real syscall's fixed-copyout
    // contract, to prove stale/partial buffers cannot become evidence.
    memcpy(buffer, source, cs_partial_op == (int)operation + 1 ? size / 2 : size);
    return 0;
}
#endif

int test_clock(clockid_t clock, struct timespec *out) {
    assert(clock == CLOCK_MONOTONIC); ++clock_calls;
    if (clock_calls == clock_fail_at) return -1;
    out->tv_sec = clock_calls == clock_back_at ? 99 : 100;
    out->tv_nsec = clock_calls == clock_jump_at ? 250000001 : 0;
    return 0;
}
uid_t test_uid(void) { return ++uid_calls == credential_call && credential_kind == 1 ? 0 : 501; }
uid_t test_euid(void) { return ++euid_calls == credential_call && credential_kind == 2 ? 0 : 501; }
gid_t test_gid(void) { return ++gid_calls == credential_call && credential_kind == 3 ? 21 : 20; }
gid_t test_egid(void) { return ++egid_calls == credential_call && credential_kind == 4 ? 21 : 20; }
pid_t test_pid(void) { return 400; }
int test_pidpath(int pid, void *out, uint32_t size) { (void)pid; (void)out; (void)size; assert(0); return 0; }
int test_peereid(int fd, uid_t *uid, gid_t *gid) { (void)fd; (void)uid; (void)gid; assert(0); return -1; }

static void expect(brian_kernel_snapshot_result expected) {
    brian_kernel_signing_data data, zero = {0}; memset(&data, 0xff, sizeof(data));
    brian_kernel_snapshot_result result = brian_kernel_signing_snapshot(200, 501, &data);
    if (result != expected) { fprintf(stderr, "test mismatch: expected %d got %d\n", expected, result); assert(0); }
    ++assertions;
    assert(info_calls <= 6 && cs_calls <= 6 && clock_calls <= 26);
    if (expected == BRIAN_KERNEL_UNVERIFIED_DATA || expected == BRIAN_KERNEL_UNTRUSTED_DATA) {
        assert(data.pid == 200 && data.user == 501 && data.unique_id == 123456 && data.parent_unique_id == 333);
        assert(data.exec_idversion == (uint32_t)version && data.slice_offset == offset && data.signing_status == flags);
        for (int i = 0; i < 20; ++i) assert(data.main_cdhash[i] == 0x42);
        assert(info_calls == 6 && cs_calls == 6);
    } else assert(memcmp(&data, &zero, sizeof(data)) == 0);
}

int main(void) {
#ifdef BRIAN_TEST_MISSING_CSOPS
    reset(); expect(BRIAN_KERNEL_UNAVAILABLE); assert(info_calls == 0 && cs_calls == 0);
#else
    reset(); expect(BRIAN_KERNEL_UNVERIFIED_DATA);
    reset(); version = (int32_t)0x80000001U; expect(BRIAN_KERNEL_UNVERIFIED_DATA);
    reset(); parent_version = 0; expect(BRIAN_KERNEL_UNVERIFIED_DATA); // older zero-reserved ABI
    reset(); parent_version = INT32_MIN; expect(BRIAN_KERNEL_UNVERIFIED_DATA);
    reset(); parent_version = INT32_MAX; expect(BRIAN_KERNEL_UNVERIFIED_DATA);
    reset(); flags |= 0x2; expect(BRIAN_KERNEL_UNTRUSTED_DATA); // new field cannot bless ad-hoc code
    reset(); offset = 0; expect(BRIAN_KERNEL_UNVERIFIED_DATA);
    reset(); offset = INT64_MAX; expect(BRIAN_KERNEL_UNVERIFIED_DATA); // offset data, not proof of file bounds
    for (int i = 1; i <= 6; ++i) {
        reset(); short_at = i; expect(BRIAN_KERNEL_SHORT_READ);
        reset(); over_at = i; expect(BRIAN_KERNEL_SHORT_READ);
        reset(); error_at = i; expect(BRIAN_KERNEL_UNAVAILABLE);
        reset(); cs_error_at = i; expect(BRIAN_KERNEL_UNAVAILABLE);
        reset(); exec_at = i; expect(BRIAN_KERNEL_UNAVAILABLE);
    }
    for (int i = 1; i <= 9; ++i) {
        reset(); mutate_at = 6; mutation = i; expect(BRIAN_KERNEL_CHANGED);
        if (i >= 4 && i <= 8) {
            reset(); mutate_at = 1; mutation = i;
            expect(i <= 5 ? BRIAN_KERNEL_INVALID_IDENTITY :
                   i == 6 ? BRIAN_KERNEL_CHANGED : BRIAN_KERNEL_UNSUPPORTED_DATA);
        }
    }
    for (int call = 2; call <= 5; ++call) for (int field = 1; field <= 8; ++field) {
        reset(); mutate_at = call; mutation = field; expect(BRIAN_KERNEL_CREDENTIALS);
    }
    for (int call = 1; call <= 2; ++call) for (int field = 1; field <= 4; ++field) {
        reset(); credential_call = call; credential_kind = field; expect(BRIAN_KERNEL_CREDENTIALS);
    }
    for (int op = 0; op <= 6; ++op) if (op == 0 || op == 5 || op == 6) {
        reset(); cs_partial_op = op + 1; expect(BRIAN_KERNEL_CHANGED);
    }
    for (int call = 4; call <= 6; ++call) { reset(); cs_change_at = call; expect(BRIAN_KERNEL_CHANGED); }
    reset(); zero_hash = 1; expect(BRIAN_KERNEL_MISSING_HASH);
    reset(); offset = -1; expect(BRIAN_KERNEL_INVALID_SLICE);
    uint32_t unsafe[] = {0x2, 0x4, 0x20, 0x01000000, 0x10000000, 0x20000};
    for (size_t i = 0; i < sizeof(unsafe) / sizeof(unsafe[0]); ++i) { reset(); flags |= unsafe[i]; expect(BRIAN_KERNEL_UNTRUSTED_DATA); }
    uint32_t required[] = {1, 0x10000, 0x20000000};
    for (size_t i = 0; i < sizeof(required) / sizeof(required[0]); ++i) { reset(); flags &= ~required[i]; expect(BRIAN_KERNEL_UNTRUSTED_DATA); }
    reset(); flags = 0; expect(BRIAN_KERNEL_UNTRUSTED_DATA);
    reset(); clock_fail_at = 1; expect(BRIAN_KERNEL_UNAVAILABLE);
    for (int call = 2; call <= 26; ++call) {
        reset(); clock_fail_at = call; expect(BRIAN_KERNEL_DEADLINE);
        reset(); clock_jump_at = call; expect(BRIAN_KERNEL_DEADLINE);
        reset(); clock_back_at = call; expect(BRIAN_KERNEL_DEADLINE);
    }
    brian_kernel_signing_data data;
    reset(); assert(brian_kernel_signing_snapshot(0, 501, &data) == BRIAN_KERNEL_INVALID_ARGUMENT);
    assert(brian_kernel_signing_snapshot(1, 501, &data) == BRIAN_KERNEL_INVALID_ARGUMENT);
    assert(brian_kernel_signing_snapshot(-1, 501, &data) == BRIAN_KERNEL_INVALID_ARGUMENT);
    assert(brian_kernel_signing_snapshot(200, 0, &data) == BRIAN_KERNEL_INVALID_ARGUMENT);
    assert(brian_kernel_signing_snapshot(200, 501, NULL) == BRIAN_KERNEL_INVALID_ARGUMENT);
    assert(brian_kernel_signing_snapshot(200, 502, &data) == BRIAN_KERNEL_CREDENTIALS);
#endif
    printf("PASS %u deterministic kernel snapshot cases (test shims, NOT macOS execution)\n", assertions);
    return 0;
}
