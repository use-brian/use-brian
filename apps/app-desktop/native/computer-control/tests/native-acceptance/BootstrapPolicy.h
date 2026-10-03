#ifndef EXPERIMENT_BOOTSTRAP_POLICY_H
#define EXPERIMENT_BOOTSTRAP_POLICY_H
#include "Experiment.h"
#include <string.h>
// Kernel-derived observations in the native implementation; synthetic data ONLY
// in the separate portable regression executable. No runtime observation override.
typedef struct {
    int32_t pid, ppid;
    uint32_t uid, ruid, svuid;
    uint64_t device, inode, mapped_device, mapped_inode, birth_seconds, birth_microseconds;
    char path[4096];
} ExperimentIdentity;
static inline int experiment_same_executable(const ExperimentIdentity *self, const ExperimentIdentity *peer) {
    return self->pid > 1 && peer->pid > 1 && self->uid > 0 && self->uid == self->ruid && self->uid == self->svuid &&
        peer->uid == self->uid && peer->ruid == self->uid && peer->svuid == self->uid &&
        self->inode != 0 && self->inode == peer->inode && self->device == peer->device &&
        self->mapped_inode == self->inode && self->mapped_device == self->device &&
        peer->mapped_inode == peer->inode && peer->mapped_device == peer->device &&
        self->path[0] == '/' && memchr(self->path, 0, sizeof(self->path)) &&
        memchr(peer->path, 0, sizeof(peer->path)) && strcmp(self->path, peer->path) == 0;
}
static inline int experiment_closed_topology(uint32_t expected, uint32_t issuer_role,
        int32_t socket_peer, uint32_t socket_uid, int32_t window_owner,
        const ExperimentIdentity *self, const ExperimentIdentity *issuer,
        const ExperimentIdentity *supervisor, const ExperimentIdentity *worker,
        const ExperimentConfig *c) {
    if (expected < 1 || expected > 3 || c->role != expected || c->magic != 0x42584d31 ||
        c->scenario > 11 || !c->window || c->tag <= 0 || c->tag > INT64_MAX / 2 ||
        socket_peer != self->ppid || socket_peer != issuer->pid || socket_uid != self->uid ||
        c->supervisor != supervisor->pid || window_owner != supervisor->pid ||
        self->pid == issuer->pid || self->pid == supervisor->pid ||
        !experiment_same_executable(self, issuer) || !experiment_same_executable(self, supervisor) ||
        !experiment_same_executable(self, worker) || worker->ppid != supervisor->pid || c->worker != worker->pid)
        return 0;
    if (expected == 3)
        return issuer_role == 1 && issuer->ppid == supervisor->pid && c->parent == issuer->pid &&
            issuer->pid != supervisor->pid && worker->pid != issuer->pid && worker->pid != self->pid;
    if (issuer_role != 0 || issuer->pid != supervisor->pid) return 0;
    if (expected == 2) return worker->pid == self->pid && c->parent == 0;
    return c->parent == self->pid && worker->pid != self->pid;
}
#endif
