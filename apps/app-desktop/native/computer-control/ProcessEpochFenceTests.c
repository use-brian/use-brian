// WRITTEN ONLY. Standalone deterministic C test translation unit on Darwin.
// Include the production source with syscall substitutions LOCAL TO THIS TU.
// No runtime injection, environment override, or acceptance bypass is linked.
#include <sys/types.h>
#include <sys/event.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdlib.h>
#include <stdint.h>
#include <stdarg.h>
#include <assert.h>
#include <errno.h>

static int events[64], reads[64], fd_flags[64], next_fd;
static int registration_error, missing_receipt, cloexec_failure, bad_receipt, queued_on_install;
static int fake_kqueue(void) { return ++next_fd; }
static int fake_close(int fd) { (void)fd; return 0; }
static int fake_fcntl(int fd, int command, ...) {
    if (cloexec_failure) return -1;
    if (command == F_GETFD) return fd_flags[fd];
    assert(command == F_SETFD);
    va_list args; va_start(args, command); fd_flags[fd] = va_arg(args, int); va_end(args);
    assert(fd_flags[fd] & FD_CLOEXEC);
    return 0;
}
static int fake_kevent(int fd, const struct kevent *change, int changes,
                       struct kevent *out, int count, const struct timespec *timeout) {
    assert(count == 1 && timeout && timeout->tv_sec == 0 && timeout->tv_nsec == 0);
    if (changes) {
        assert(changes == 1 && change->filter == EVFILT_PROC);
        assert((change->flags & (EV_RECEIPT | EV_ADD | EV_ENABLE)) == (EV_RECEIPT | EV_ADD | EV_ENABLE));
        assert(change->fflags == (NOTE_EXEC | NOTE_EXIT));
        assert(fd_flags[fd] & FD_CLOEXEC); // set BEFORE subscription
        *out = *change; out->flags = EV_ERROR; out->data = registration_error;
        if (bad_receipt == 1) out->ident++;
        if (bad_receipt == 2) out->flags = EV_EOF;
        if (bad_receipt == 3) out->filter = EVFILT_READ;
        if (bad_receipt == 4) out->fflags = NOTE_EXIT;
        events[fd] = queued_on_install;
        return missing_receipt ? 0 : 1;
    }
    reads[fd]++;
    int value = events[fd]; events[fd] = 0;
    if (value < 0) { errno = EINVAL; return -1; }
    if (!value) return 0;
    EV_SET(out, 123, EVFILT_PROC, value == 4 ? EV_EOF : 0,
           value == 1 ? NOTE_EXEC : value == 2 ? NOTE_EXIT : NOTE_EXEC | NOTE_EXIT, 0, NULL);
    return 1;
}
#define kqueue fake_kqueue
// Function-like macro leaves the public struct kevent tag untouched.
#define kevent(...) fake_kevent(__VA_ARGS__)
#define fcntl fake_fcntl
#define close fake_close
#include "ProcessEpochFence.c"
#undef kqueue
#undef kevent
#undef fcntl
#undef close

int main(void) {
    const int failures[] = { EINVAL, ESRCH, EPERM };
    for (unsigned i = 0; i < sizeof(failures) / sizeof(failures[0]); ++i) {
        registration_error = failures[i]; assert(!brian_epoch_fence_create(123));
    }
    registration_error = 0;
    for (bad_receipt = 1; bad_receipt <= 4; ++bad_receipt) assert(!brian_epoch_fence_create(123));
    bad_receipt = 0;
    queued_on_install = 1; assert(!brian_epoch_fence_create(123)); queued_on_install = 0;
    missing_receipt = 1; assert(!brian_epoch_fence_create(123)); missing_receipt = 0;
    cloexec_failure = 1; assert(!brian_epoch_fence_create(123)); cloexec_failure = 0;
    for (int event = -1; event <= 4; ++event) {
        if (!event) continue;
        struct brian_epoch_fence *f = brian_epoch_fence_create(123); assert(f);
        assert(brian_epoch_fence_poll(f)); events[f->fd] = event;
        if (event == 1) events[f->fd] |= 1; // multiple execs coalesce to NOTE_EXEC
        assert(!brian_epoch_fence_poll(f)); int consumed = reads[f->fd];
        // Draining/clearing a queued exec, multiple coalesced execs, exit/PID
        // reuse, EOF or syscall failure can NEVER resurrect this subscription.
        for (int i = 0; i < 3; ++i) assert(!brian_epoch_fence_poll(f));
        assert(reads[f->fd] == consumed); brian_epoch_fence_destroy(f);
    }
    struct brian_epoch_fence *worker = brian_epoch_fence_create(123); assert(worker);
    events[worker->fd] = 1; // exec before owner registration, not yet polled
    struct brian_epoch_fence *owner = brian_epoch_fence_create(123); assert(owner);
    assert(brian_epoch_fence_poll(owner)); // independently pinned owner readiness
    assert(!brian_epoch_fence_poll(worker)); // authenticated overlap MUST refuse
    brian_epoch_fence_destroy(worker); brian_epoch_fence_destroy(owner);
    worker = brian_epoch_fence_create(123); owner = brian_epoch_fence_create(123);
    assert(worker && owner && brian_epoch_fence_poll(owner) && brian_epoch_fence_poll(worker));
    events[owner->fd] = 3; // queued/coalesced event after readiness, before input
    assert(!brian_epoch_fence_poll(owner));
    // Simulate callback contention without waiting: permanently poison.
    atomic_flag_test_and_set(&worker->polling);
    assert(!brian_epoch_fence_poll(worker)); atomic_flag_clear(&worker->polling);
    assert(!brian_epoch_fence_poll(worker));
    brian_epoch_fence_destroy(worker); brian_epoch_fence_destroy(owner);
    return 0;
}
