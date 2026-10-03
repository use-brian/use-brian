// Public lifetime epoch fence. No proc selectors, numeric generation or reset.
#include <sys/types.h>
#include <sys/event.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdlib.h>
#include <stdint.h>

struct brian_epoch_fence {
    int fd;
    atomic_bool poisoned;
    atomic_flag polling;
};

int32_t brian_epoch_fence_poll(void *opaque) {
    struct brian_epoch_fence *f = opaque;
    if (!f || atomic_load(&f->poisoned)) return 0;
    // Never wait behind another thread, including in an event-tap callback.
    if (atomic_flag_test_and_set(&f->polling)) {
        atomic_store(&f->poisoned, true);
        return 0;
    }
    struct kevent event;
    const struct timespec zero = {0, 0};
    int n = kevent(f->fd, NULL, 0, &event, 1, &zero);
    // ANY event (including coalesced exec, exit, EOF, EV_ERROR or unknown
    // data), syscall error/EINTR or unexpected count permanently poisons.
    if (n != 0) atomic_store(&f->poisoned, true);
    atomic_flag_clear(&f->polling);
    return atomic_load(&f->poisoned) ? 0 : 1;
}

void *brian_epoch_fence_create(int32_t pid) {
    if (pid <= 1) return NULL;
    struct brian_epoch_fence *f = calloc(1, sizeof(*f));
    if (!f) return NULL;
    *f = (struct brian_epoch_fence){ .fd = -1, .polling = ATOMIC_FLAG_INIT };
    atomic_init(&f->poisoned, false);
    if (!atomic_is_lock_free(&f->poisoned)) { free(f); return NULL; }
    f->fd = kqueue();
    if (f->fd < 0) { free(f); return NULL; }
    int flags = fcntl(f->fd, F_GETFD);
    if (flags < 0 || fcntl(f->fd, F_SETFD, flags | FD_CLOEXEC) < 0) goto fail;
    int confirmed_flags = fcntl(f->fd, F_GETFD);
    if (confirmed_flags < 0 || !(confirmed_flags & FD_CLOEXEC)) goto fail;
    struct kevent change, receipt;
    const struct timespec zero = {0, 0};
    EV_SET(&change, (uintptr_t)pid, EVFILT_PROC, EV_ADD | EV_ENABLE | EV_CLEAR | EV_RECEIPT,
           NOTE_EXEC | NOTE_EXIT, 0, NULL);
    // Receipt required: unsupported flags/permissions/dead process never fall
    // back to birth-only authority. No target identity is sampled before this.
    if (kevent(f->fd, &change, 1, &receipt, 1, &zero) != 1 ||
        receipt.ident != (uintptr_t)pid || receipt.filter != EVFILT_PROC ||
        receipt.fflags != (NOTE_EXEC | NOTE_EXIT) ||
        !(receipt.flags & EV_ERROR) || (receipt.flags & EV_EOF) || receipt.data != 0)
        goto fail;
    if (!brian_epoch_fence_poll(f)) goto fail;
    return f;
fail:
    close(f->fd); free(f); return NULL;
}

// Caller retains the object for every concurrent poll; destruction is not a
// cancellation mechanism. Never close/reopen a descriptor while polling it.
void brian_epoch_fence_destroy(void *opaque) {
    struct brian_epoch_fence *f = opaque;
    if (!f) return;
    atomic_store(&f->poisoned, true);
    close(f->fd); free(f);
}
