#ifndef BRIAN_TEST_EXPERIMENT_H
#define BRIAN_TEST_EXPERIMENT_H
#include <stdint.h>
#include <stddef.h>
// Closed test roles use a kernel-peer/topology-bound socket grant; never a production protocol.
typedef struct { uint32_t magic, role, scenario, window; int32_t supervisor, parent, worker; int64_t tag; } ExperimentConfig;
typedef struct { uint32_t source, code, sequence, reserved; uint64_t ticks; } ExperimentRecord;
int experiment_start(uint32_t scenario, uint32_t window);
int experiment_launch_owner(void);
int experiment_child(uint32_t expected_role, ExperimentConfig *config);
int experiment_record(uint32_t source, uint32_t code);
int experiment_read(ExperimentRecord *record);
int experiment_signal(uint32_t role, int signal);
int experiment_poll(uint32_t role); // 0 alive, 1 exited (parent retained), -1 error
int experiment_owner_stopped(void);
void experiment_parent_run(void);
int experiment_cleanup(void);
int experiment_lost(void);
uint32_t experiment_count(uint32_t source);
int64_t experiment_tag(void);
void experiment_stop_here(void);
void *brian_epoch_fence_create(int32_t pid);
int32_t brian_epoch_fence_poll(void *fence);
void brian_epoch_fence_destroy(void *fence);

void experiment_install_cancel_handler(void);
int experiment_cancelled(void);

// Internal closed bootstrap. These are native calls, not wire authority flags.
int experiment_supervisor_init(void);
int experiment_gui_consent(uint32_t scenario, uint32_t window);
int experiment_root_config(ExperimentConfig *out, uint32_t scenario, uint32_t window);
const char *experiment_claim_launch(uint32_t role);
int experiment_bootstrap_pair(int pair[2]);
int experiment_issue(int fd, uint32_t role, int32_t recipient, ExperimentConfig config, int record_fd, int command_fd);
int experiment_accept(uint32_t expected_role, ExperimentConfig *out);
int experiment_bootstrap_live(void);
#endif
