#include "Experiment.h"
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <sys/event.h>
#include <spawn.h>
#include <signal.h>
#include <unistd.h>
#include <fcntl.h>
#include <time.h>
#include <stdlib.h>
#include <errno.h>
#include <string.h>

static int records[2] = {-1, -1}, commands[2] = {-1, -1}, lost, owner_events = -1;
static int owner_stopped, owner_exited, is_parent;
static volatile sig_atomic_t cancelled;
static void cancel_handler(int sig) { (void)sig; cancelled = 1; }
void experiment_install_cancel_handler(void) { signal(SIGTERM, cancel_handler); signal(SIGINT, cancel_handler); }
int experiment_cancelled(void) { return cancelled != 0; }
static pid_t children[4];
static uint32_t sequences[6];
static ExperimentConfig config;
static void delay(void) { struct timespec t = {.tv_nsec=10000000}; nanosleep(&t, NULL); }
static int pipe_owned(int p[2]) {
    if (pipe(p)) return 0;
    for (int i = 0; i < 2; i++) {
        int fd = fcntl(p[i], F_DUPFD_CLOEXEC, 10);
        close(p[i]); p[i] = fd;
        if (fd < 0) { close(p[1-i]); return 0; }
    }
    return 1;
}
static int nonblock(int fd) {
    int flags = fcntl(fd, F_GETFL);
    return flags >= 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
}
static int launch(unsigned role) {
    if (config.scenario != 0) return 0;
    const char *exe = experiment_claim_launch(role);
    if (!exe) return 0;
    int p[2]; if (!experiment_bootstrap_pair(p)) return 0;
    ExperimentConfig c = config; c.role = role;
    c.parent = is_parent ? getpid() : children[1]; c.worker = children[2];
    posix_spawn_file_actions_t actions;
    posix_spawnattr_t attr;
    if (posix_spawn_file_actions_init(&actions)) { close(p[0]); close(p[1]); return 0; }
    if (posix_spawnattr_init(&attr)) { posix_spawn_file_actions_destroy(&actions); close(p[0]); close(p[1]); return 0; }
    int error = posix_spawnattr_setflags(&attr, POSIX_SPAWN_CLOEXEC_DEFAULT);
    error |= posix_spawn_file_actions_adddup2(&actions, p[0], 3);
    error |= posix_spawn_file_actions_adddup2(&actions, records[1], 4);
    if (role == 1) {
        error |= posix_spawn_file_actions_adddup2(&actions, commands[0], 5);
        // Parent leads an owned group; its owner inherits this group.
        error |= posix_spawnattr_setflags(&attr, POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETPGROUP);
        error |= posix_spawnattr_setpgroup(&attr, 0);
    }
    error |= posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0);
    error |= posix_spawn_file_actions_addopen(&actions, 1, "/dev/null", O_WRONLY, 0);
    error |= posix_spawn_file_actions_addopen(&actions, 2, "/dev/null", O_WRONLY, 0);
    char *roles[] = {NULL, "--owned-parent", "--owned-worker", "--owned-owner"};
    char *argv[] = {(char *)exe, roles[role], NULL};
    char *env[] = {"PATH=/usr/bin:/bin", NULL};
    if (!error) error = posix_spawn(&children[role], exe, &actions, &attr, argv, env);
    posix_spawnattr_destroy(&attr); posix_spawn_file_actions_destroy(&actions); close(p[0]);
    int ok = !error && experiment_issue(p[1], role, children[role], c, records[1], commands[0]);
    close(p[1]); return ok;
}
int experiment_start(uint32_t scenario, uint32_t window) {
    if (scenario != 0) return 0;
    if (!experiment_root_config(&config, scenario, window)) return 0;
    if (records[0] != -1 || scenario != 0 || !window || !pipe_owned(records) || !pipe_owned(commands)) return 0;
    if (!nonblock(records[0]) || !nonblock(records[1]) || !nonblock(commands[0]) || !nonblock(commands[1])) return 0;
    return launch(2) && launch(1);
}
int experiment_launch_owner(void) {
    return children[1] > 1 && children[2] > 1 && write(commands[1], "S", 1) == 1;
}
int experiment_child(uint32_t expected_role, ExperimentConfig *out) {
    if (!experiment_accept(expected_role, &config)) return 0;
    records[1] = 4;
    *out = config; return 1;
}
int64_t experiment_tag(void) { return config.tag; }
static int write_record(ExperimentRecord r) {
    // One nonblocking PIPE_BUF-sized write. No retry, allocation, JSON or lock.
    if (write(records[1], &r, sizeof(r)) != (ssize_t)sizeof(r)) { lost = 1; return 0; }
    return 1;
}
int experiment_record(uint32_t source, uint32_t code) {
    if (source > 5 || sequences[source] >= 2048) { lost = 1; return 0; }
    struct timespec t;
    if (clock_gettime(CLOCK_MONOTONIC, &t)) { lost = 1; return 0; }
    return write_record((ExperimentRecord){.source=source, .code=code, .sequence=++sequences[source],
        .ticks=(uint64_t)t.tv_sec * 1000000000 + (uint64_t)t.tv_nsec});
}
int experiment_lost(void) { return lost; }
uint32_t experiment_count(uint32_t source) { return source < 6 ? sequences[source] : UINT32_MAX; }
int experiment_read(ExperimentRecord *r) {
    for (;;) {
        ssize_t n = read(records[0], r, sizeof(*r));
        if (n == (ssize_t)sizeof(*r)) {
            // Private lifecycle registration, not an exported record or arbitrary PID API.
            if (r->source == 99 && r->code == 91 && !children[3]) {
                children[3] = (pid_t)r->ticks;
                owner_events = kqueue();
                struct kevent change;
                EV_SET(&change, (uintptr_t)children[3], EVFILT_PROC, EV_ADD | EV_CLEAR,
                    NOTE_EXIT, 0, NULL);
                if (owner_events < 0 || kevent(owner_events, &change, 1, NULL, 0, NULL)) lost = 1;
                continue;
            }
            if (r->source == 5 && r->code == 90) owner_stopped = 1;
            if (r->source == 5 && r->code == 83) owner_exited = 1;
            return 1;
        }
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return 0;
        lost = 1; return -1;
    }
}
static int parent_exited(void) {
    if (!children[1]) return 1;
    siginfo_t info; memset(&info, 0, sizeof(info));
    // Retain this direct child (even its zombie) until ALL group signals finish.
    // Its PID/PGID cannot be reused, including after the real parent's death.
    if (waitid(P_PID, (id_t)children[1], &info, WEXITED | WNOHANG | WNOWAIT)) return -1;
    return info.si_pid == children[1];
}
int experiment_poll(uint32_t role) {
    if (role < 1 || role > 3) return -1;
    if (role == 1) return parent_exited();
    if (role == 3) {
        if (owner_exited) return 1;
        if (owner_events >= 0) {
            struct kevent event; struct timespec zero = {0, 0};
            int n = kevent(owner_events, NULL, 0, &event, 1, &zero);
            if (n == 1 && !(event.flags & EV_ERROR) && (event.fflags & NOTE_EXIT)) { owner_exited = 1; return 1; }
            if (n < 0 || n == 1) return -1;
        }
        return 0;
    }
    if (!children[2]) return 1;
    int status; pid_t result = waitpid(children[2], &status, WNOHANG);
    if (!result) return 0;
    if (result == children[2]) { children[2] = 0; return 1; }
    return -1;
}
int experiment_owner_stopped(void) { return owner_stopped; }
int experiment_signal(uint32_t role, int sig) {
    if (role < 1 || role > 3 || (sig != SIGKILL && sig != SIGCONT)) return 0;
    if (role == 3) {
        int dead = parent_exited();
        if (dead < 0 || !children[1]) return 0;
        if (!dead) return write(commands[1], sig == SIGCONT ? "C" : "K", 1) == 1;
        // Only owned parent+owner group. Parent is unreaped, preventing PGID reuse.
        return kill(-children[1], sig) == 0;
    }
    if (experiment_poll(role) != 0) return 0;
    return kill(children[role], sig) == 0;
}
void experiment_stop_here(void) { raise(SIGSTOP); }
void experiment_parent_run(void) {
    is_parent = 1; children[2] = config.worker;
    if (!nonblock(5) || fcntl(5, F_SETFD, FD_CLOEXEC)) _exit(74);
    int launched = 0, stopped = 0, exited = 0;
    for (unsigned tick = 0; tick < 1400; tick++) {
        char command;
        ssize_t n = read(5, &command, 1);
        if (n == 0 || getppid() != config.supervisor) break;
        if (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK) break;
        if (n == 1) {
            if (command == 'S' && !launched) {
                launched = 1;
                if (!launch(3) || !write_record((ExperimentRecord){.source=99, .code=91, .ticks=(uint64_t)children[3]})) break;
            } else if (command == 'Q') { break;
            } else if ((command == 'C' || command == 'K') && children[3] && !exited) {
                // Direct, unreaped child; no PID reuse between check and signal.
                if (kill(children[3], command == 'C' ? SIGCONT : SIGKILL)) break;
            } else break;
        }
        if (children[3] && !exited) {
            siginfo_t info; memset(&info, 0, sizeof(info));
            if (waitid(P_PID, (id_t)children[3], &info, WEXITED | WSTOPPED | WNOHANG | WNOWAIT)) break;
            if (info.si_pid == children[3]) {
                if (info.si_code == CLD_STOPPED && !stopped) {
                    stopped = 1; if (!experiment_record(5, 90)) break;
                    // Consume ONLY stop status, never reap an exiting child here.
                    siginfo_t stop; memset(&stop, 0, sizeof(stop));
                    if (waitid(P_PID, (id_t)children[3], &stop, WSTOPPED | WNOHANG)) break;
                }
                if (info.si_code == CLD_EXITED || info.si_code == CLD_KILLED || info.si_code == CLD_DUMPED) {
                    exited = 1; if (!experiment_record(5, 83)) break;
                }
            }
        }
        delay();
    }
    if (children[3]) {
        if (!exited) kill(children[3], SIGKILL); // no resume before kill
        for (int i = 0; i < 100; i++) {
            if (waitpid(children[3], NULL, WNOHANG) == children[3]) _exit(0);
            delay();
        }
    }
    _exit(children[3] ? 74 : 0);
}
int experiment_cleanup(void) {
    // Give the responsive real parent a bounded chance to kill/reap its child.
    if (children[1] && parent_exited() == 0) {
        (void)write(commands[1], "Q", 1);
        for (unsigned n = 0; n < 100 && parent_exited() == 0; n++) delay();
    }
    // Parent remains unreaped until group signaling is permanently over.
    // Kill the group without resuming a suspended stale callback.
    if (children[1]) (void)kill(-children[1], SIGKILL);
    if (experiment_poll(2) == 0) (void)experiment_signal(2, SIGKILL);
    int done = 0;
    for (unsigned n = 0; n < 100; n++) {
        if (experiment_poll(3) == 1 && experiment_poll(2) == 1 && parent_exited() == 1) { done = 1; break; }
        delay();
    }
    if (children[1] && parent_exited() == 1) {
        if (waitpid(children[1], NULL, WNOHANG) == children[1]) children[1] = 0;
        else done = 0;
    }
    // Owner exit is observed, not necessarily reaped here after reparenting.
    return done;
}
