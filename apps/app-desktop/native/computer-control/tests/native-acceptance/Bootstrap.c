// Narrow test-executable bootstrap. No signing service, public listener, JSON,
// environment authority or injected production observations.
#include "BootstrapPolicy.h"
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <sys/proc_info.h>
#include <libproc.h>
#include <mach/vm_prot.h>
#include <CoreGraphics/CoreGraphics.h>
#include <poll.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdlib.h>
#include <time.h>
#include <errno.h>

#define UNINITIALIZED UINT32_MAX
#define MAX_PINS 8
static struct Pin { ExperimentIdentity id; void *epoch; int image; struct stat file; } pins[MAX_PINS];
static unsigned pin_count;
static uint32_t current_role = UNINITIALIZED, claims;
static int initialized, consented;
static pid_t issued[4];
static ExperimentConfig admitted;

typedef struct {
    ExperimentConfig config;
    uint32_t issuer_role;
    int32_t recipient;
    uint64_t record_device, record_inode, command_device, command_inode, nonce;
} Grant;
typedef struct { uint64_t nonce; uint32_t phase, role; int32_t recipient; uint32_t reserved; } Reply;

static int same_birth(const struct proc_bsdinfo *a, const struct proc_bsdinfo *b) {
    return a->pbi_pid == b->pbi_pid && a->pbi_ppid == b->pbi_ppid &&
        a->pbi_uid == b->pbi_uid && a->pbi_ruid == b->pbi_ruid && a->pbi_svuid == b->pbi_svuid &&
        a->pbi_start_tvsec == b->pbi_start_tvsec && a->pbi_start_tvusec == b->pbi_start_tvusec;
}
static int same_file(const struct stat *a, const struct stat *b) {
    return a->st_dev == b->st_dev && a->st_ino == b->st_ino && a->st_mode == b->st_mode &&
        a->st_uid == b->st_uid && a->st_size == b->st_size &&
        a->st_mtimespec.tv_sec == b->st_mtimespec.tv_sec && a->st_mtimespec.tv_nsec == b->st_mtimespec.tv_nsec &&
        a->st_ctimespec.tv_sec == b->st_ctimespec.tv_sec && a->st_ctimespec.tv_nsec == b->st_ctimespec.tv_nsec;
}
// Bound the kernel-backed executable file mapping as well as the path's open
// vnode. In particular, replacing a path cannot make an old mapped inode match.
// Fixed scan bound; unknown/unsupported region data refuses, never a path-only
// fallback. This is file identity, not code-signature or loaded-byte attestation.
static int mapped_file(pid_t pid, ExperimentIdentity *out, const struct stat *file) {
    uint64_t address = 0;
    for (unsigned i = 0; i < 64; i++) {
        struct proc_regionwithpathinfo region = {0};
        if (proc_pidinfo(pid, PROC_PIDREGIONPATHINFO, address, &region, sizeof(region)) != (int)sizeof(region) ||
            region.prp_prinfo.pri_address < address || !region.prp_prinfo.pri_size ||
            region.prp_prinfo.pri_address > UINT64_MAX - region.prp_prinfo.pri_size) return 0;
        const char *path = region.prp_vip.vip_path;
        if (!memchr(path, 0, sizeof(region.prp_vip.vip_path))) return 0;
        if ((region.prp_prinfo.pri_protection & VM_PROT_EXECUTE) && strcmp(path, out->path) == 0) {
            out->mapped_device = region.prp_vip.vip_vi.vi_stat.vst_dev;
            out->mapped_inode = region.prp_vip.vip_vi.vi_stat.vst_ino;
            return out->mapped_device == (uint32_t)file->st_dev && out->mapped_inode == file->st_ino;
        }
        address = region.prp_prinfo.pri_address + region.prp_prinfo.pri_size;
    }
    return 0;
}
static int snapshot(pid_t pid, ExperimentIdentity *out, struct stat *file, int *image) {
    struct proc_bsdinfo before = {0}, after = {0};
    memset(out, 0, sizeof(*out));
    if (pid <= 1 || proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &before, sizeof(before)) != (int)sizeof(before) ||
        before.pbi_pid != (uint32_t)pid || before.pbi_uid != getuid() || before.pbi_ruid != getuid() ||
        before.pbi_svuid != getuid() || !before.pbi_start_tvsec || before.pbi_start_tvusec >= 1000000 || getuid() == 0 || geteuid() != getuid() ||
        proc_pidpath(pid, out->path, sizeof(out->path)) <= 0 || out->path[0] != '/' ||
        !memchr(out->path, 0, sizeof(out->path))) return 0;
    // Path is obtained from the kernel, never argv/config. Retain the opened
    // file identity, not just its name; replacement/metadata changes refuse.
    int fd = open(out->path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return 0;
    if (fstat(fd, file) || !S_ISREG(file->st_mode) || (file->st_mode & 0022) || !mapped_file(pid, out, file) ||
        proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &after, sizeof(after)) != (int)sizeof(after) || !same_birth(&before, &after)) {
        close(fd); return 0;
    }
    out->pid = pid; out->ppid = (int32_t)before.pbi_ppid;
    out->uid = before.pbi_uid; out->ruid = before.pbi_ruid; out->svuid = before.pbi_svuid;
    out->device = (uint32_t)file->st_dev; out->inode = file->st_ino;
    out->birth_seconds = before.pbi_start_tvsec; out->birth_microseconds = before.pbi_start_tvusec;
    *image = fd; return 1;
}
static struct Pin *hold(pid_t pid) {
    for (unsigned i = 0; i < pin_count; i++) if (pins[i].id.pid == pid)
        return brian_epoch_fence_poll(pins[i].epoch) == 1 ? &pins[i] : NULL;
    if (pin_count == MAX_PINS) return NULL;
    struct Pin *p = &pins[pin_count];
    // ORIGINAL subscription precedes every path/UID/birth/topology pin.
    p->epoch = brian_epoch_fence_create(pid);
    if (!p->epoch || !snapshot(pid, &p->id, &p->file, &p->image) || brian_epoch_fence_poll(p->epoch) != 1) return NULL;
    pin_count++; return p;
}
int experiment_bootstrap_live(void) {
    if (current_role == UNINITIALIZED || !pin_count) return 0;
    for (unsigned i = 0; i < pin_count; i++) if (brian_epoch_fence_poll(pins[i].epoch) != 1) return 0;
    return 1; // kept for the whole process; never replace/rearm bootstrap fences
}
static int pins_current(void) {
    for (unsigned i = 0; i < pin_count; i++) {
        ExperimentIdentity id; struct stat file, held; int fd = -1;
        if (brian_epoch_fence_poll(pins[i].epoch) != 1 ||
            !snapshot(pins[i].id.pid, &id, &file, &fd)) return 0;
        close(fd);
        if (memcmp(&id, &pins[i].id, sizeof(id)) || fstat(pins[i].image, &held) ||
            !same_file(&pins[i].file, &file) || !same_file(&pins[i].file, &held) ||
            brian_epoch_fence_poll(pins[i].epoch) != 1) return 0;
    }
    return pin_count > 0;
}
static int32_t window_owner(uint32_t number) {
    int32_t pid = 0;
    CFArrayRef rows = CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, number);
    if (!rows) return 0;
    if (CFArrayGetCount(rows) == 1) {
        CFTypeRef row = CFArrayGetValueAtIndex(rows, 0);
        if (row && CFGetTypeID(row) == CFDictionaryGetTypeID()) {
            CFTypeRef value = CFDictionaryGetValue((CFDictionaryRef)row, kCGWindowOwnerPID);
            CFTypeRef id = CFDictionaryGetValue((CFDictionaryRef)row, kCGWindowNumber);
            int64_t selected = 0;
            if (value && id && CFGetTypeID(value) == CFNumberGetTypeID() && CFGetTypeID(id) == CFNumberGetTypeID() &&
                CFNumberGetValue((CFNumberRef)id, kCFNumberSInt64Type, &selected) && selected == number)
                (void)CFNumberGetValue((CFNumberRef)value, kCFNumberSInt32Type, &pid);
        }
    }
    CFRelease(rows); return pid;
}
int experiment_supervisor_init(void) {
    if (initialized) return 0;
    initialized = 1;
    if (!hold(getpid())) return 0;
    current_role = 0; return 1;
}
int experiment_gui_consent(uint32_t scenario, uint32_t window) {
    // Called ONLY by the native GUI branch after its modal acknowledgement.
    if (current_role != 0 || consented || scenario != 0 || !window ||
        !pins_current() || window_owner(window) != getpid()) return 0;
    admitted = (ExperimentConfig){.magic=0x42584d31, .scenario=scenario, .window=window, .supervisor=getpid(),
        .tag=(int64_t)(((uint64_t)arc4random() << 32 | arc4random()) & (INT64_MAX / 2))};
    if (!admitted.tag) admitted.tag = 1;
    consented = 1; return 1;
}
int experiment_root_config(ExperimentConfig *out, uint32_t scenario, uint32_t window) {
    if (scenario != 0 || current_role != 0 || !consented || admitted.scenario != scenario || admitted.window != window || !pins_current()) return 0;
    *out = admitted; return 1;
}
const char *experiment_claim_launch(uint32_t role) {
    if (admitted.scenario != 0 || role < 1 || role > 3 || (claims & (1u << role)) || !pins_current()) return NULL;
    if (current_role == 0) {
        if (!consented || role == 3 || (role == 1 && !issued[2])) return NULL;
    } else if (current_role != 1 || role != 3) return NULL;
    claims |= 1u << role; // spend BEFORE spawn, including failure; no retry
    return pins[0].id.path;
}
static double seconds(void) {
    struct timespec t; if (clock_gettime(CLOCK_MONOTONIC, &t)) return -1;
    return (double)t.tv_sec + (double)t.tv_nsec / 1e9;
}
static int transfer(int fd, void *buffer, size_t count, int writing, double deadline) {
    size_t offset = 0;
    while (offset < count) {
        double now = seconds(); if (now < 0 || now >= deadline) return 0;
        struct pollfd p = {.fd=fd, .events=writing ? POLLOUT : POLLIN};
        int ready = poll(&p, 1, (int)((deadline - now) * 1000) + 1);
        if (ready != 1 || (p.revents & (POLLERR | POLLNVAL)) || !(p.revents & p.events)) return 0;
        ssize_t n = writing ? send(fd, (char *)buffer + offset, count - offset, 0) : recv(fd, (char *)buffer + offset, count - offset, 0);
        if (n <= 0) return 0;
        offset += (size_t)n;
    }
    return 1;
}
int experiment_bootstrap_pair(int pair[2]) {
    int raw[2]; if (socketpair(AF_UNIX, SOCK_STREAM, 0, raw)) return 0;
    pair[0] = pair[1] = -1;
    for (int i = 0; i < 2; i++) {
        pair[i] = fcntl(raw[i], F_DUPFD_CLOEXEC, 10); close(raw[i]);
        if (pair[i] < 0) { if (!i) close(raw[1]); else close(pair[0]); return 0; }
        int flags = fcntl(pair[i], F_GETFL), one = 1;
        if (flags < 0 || fcntl(pair[i], F_SETFL, flags | O_NONBLOCK) ||
            setsockopt(pair[i], SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one))) {
            if (!i) close(raw[1]); else close(pair[0]); close(pair[i]); return 0;
        }
    }
    return 1;
}
static int pipe_info(int fd, int access, struct stat *s) {
    int flags = fcntl(fd, F_GETFL);
    return !fstat(fd, s) && S_ISFIFO(s->st_mode) && flags >= 0 &&
        (flags & O_ACCMODE) == access && (flags & O_NONBLOCK);
}
int experiment_issue(int fd, uint32_t role, int32_t recipient, ExperimentConfig c, int record_fd, int command_fd) {
    if (c.scenario != 0 || role < 1 || role > 3 || !(claims & (1u << role)) || issued[role] ||
        c.scenario != admitted.scenario || c.window != admitted.window || c.tag != admitted.tag ||
        c.supervisor != admitted.supervisor) return 0;
    struct Pin *child = hold(recipient);
    if (!child || child->id.ppid != getpid() || !experiment_same_executable(&pins[0].id, &child->id)) return 0;
    if ((current_role == 0 && (!consented || role == 3)) || (current_role != 0 && (current_role != 1 || role != 3))) return 0;
    c.role = role; c.parent = role == 1 ? recipient : role == 3 ? getpid() : 0;
    c.worker = role == 2 ? recipient : current_role == 0 ? issued[2] : admitted.worker;
    struct stat record, command = {0};
    if (!pipe_info(record_fd, O_WRONLY, &record) || (role == 1 && !pipe_info(command_fd, O_RDONLY, &command))) return 0;
    Grant grant = {.config=c, .issuer_role=current_role, .recipient=recipient,
        .record_device=(uint64_t)record.st_dev, .record_inode=record.st_ino,
        .command_device=(uint64_t)command.st_dev, .command_inode=command.st_ino};
    arc4random_buf(&grant.nonce, sizeof(grant.nonce)); if (!grant.nonce) grant.nonce = 1;
    double start = seconds(); if (start < 0) return 0;
    double deadline = start + 2;
    Reply reply = {0};
    if (!pins_current() || !transfer(fd, &grant, sizeof(grant), 1, deadline) ||
        !transfer(fd, &reply, sizeof(reply), 0, deadline) || reply.phase != 0x41434b31 || reply.reserved ||
        reply.nonce != grant.nonce || reply.recipient != recipient || reply.role != role || !pins_current()) return 0;
    reply.phase = 0x434d5431;
    // The issuer's ORIGINAL ancestor/worker/child fences overlap the receiver's
    // subscriptions through this commit; no clean-new-subscription replacement.
    if (!transfer(fd, &reply, sizeof(reply), 1, deadline)) return 0;
    issued[role] = recipient; return 1;
}
int experiment_accept(uint32_t expected, ExperimentConfig *out) {
    if (initialized || expected < 1 || expected > 3) return 0;
    initialized = 1;
    struct Pin *self = hold(getpid());
    pid_t parent_pid = getppid();
    struct Pin *parent = hold(parent_pid);
    if (!self || !parent || self->id.ppid != parent_pid || !experiment_same_executable(&self->id, &parent->id)) return 0;
    // SOCK_STREAM credentials are kernel supplied. Caller-created pipes, foreign
    // launchers, UID changes and sockets created by another process refuse.
    pid_t peer = 0; uid_t uid; gid_t gid; int type = 0;
    socklen_t pid_size = sizeof(peer), type_size = sizeof(type);
    int flags = fcntl(3, F_GETFL);
    if (getpeereid(3, &uid, &gid) || getsockopt(3, SOL_LOCAL, LOCAL_PEERPID, &peer, &pid_size) ||
        pid_size != sizeof(peer) || peer != parent_pid || uid != getuid() ||
        getsockopt(3, SOL_SOCKET, SO_TYPE, &type, &type_size) || type != SOCK_STREAM ||
        flags < 0 || !(flags & O_NONBLOCK)) return 0;
    struct Pin *supervisor = expected == 3 ? hold(parent->id.ppid) : parent;
    if (!supervisor || !experiment_same_executable(&self->id, &supervisor->id)) return 0;
    double start = seconds(); if (start < 0) return 0;
    double deadline = start + 2;
    Grant grant = {0};
    if (!transfer(3, &grant, sizeof(grant), 0, deadline) || grant.config.scenario != 0 || grant.recipient != getpid() || !grant.nonce) return 0;
    struct Pin *worker = hold(grant.config.worker);
    if (!worker || !experiment_closed_topology(expected, grant.issuer_role, peer, uid,
        window_owner(grant.config.window), &self->id, &parent->id, &supervisor->id, &worker->id, &grant.config)) return 0;
    struct stat record, command;
    if (!pipe_info(4, O_WRONLY, &record) || (uint64_t)record.st_dev != grant.record_device || record.st_ino != grant.record_inode ||
        (expected == 1 && (!pipe_info(5, O_RDONLY, &command) || (uint64_t)command.st_dev != grant.command_device || command.st_ino != grant.command_inode))) return 0;
    Reply reply = {.nonce=grant.nonce, .phase=0x41434b31, .role=expected, .recipient=getpid()};
    if (!pins_current() || !transfer(3, &reply, sizeof(reply), 1, deadline) ||
        !transfer(3, &reply, sizeof(reply), 0, deadline) || reply.phase != 0x434d5431 || reply.reserved ||
        reply.nonce != grant.nonce || reply.role != expected || reply.recipient != getpid() || !pins_current()) return 0;
    admitted = grant.config;
    admitted.supervisor = supervisor->id.pid; // derive the target ancestor; never trust a supplied window PID
    admitted.parent = expected == 3 ? parent->id.pid : expected == 1 ? getpid() : 0;
    current_role = expected;
    close(3); // original epoch/file pins remain strongly held for the lifetime
    *out = admitted; return 1;
}
