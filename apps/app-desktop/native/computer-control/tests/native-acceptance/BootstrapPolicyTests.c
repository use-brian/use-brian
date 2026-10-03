// Portable arithmetic-only regression seam. No native bootstrap override and
// no process creation, windows, sockets, permissions or event APIs are linked.
#include "BootstrapPolicy.h"
#include <assert.h>
#include <stdio.h>

static ExperimentIdentity identity(int pid, int ppid) {
    ExperimentIdentity i = {.pid=pid, .ppid=ppid, .uid=501, .ruid=501, .svuid=501,
        .device=7, .inode=100, .mapped_device=7, .mapped_inode=100, .birth_seconds=123, .birth_microseconds=456};
    strcpy(i.path, "/owned/NativeMechanismExperiment"); return i;
}
int main(void) {
    unsigned cases = 0;
    for (unsigned role = 1; role <= 3; role++) {
        for (unsigned mutation = 0; mutation < 31; mutation++) {
            ExperimentIdentity supervisor = identity(100, 50), parent = identity(101, 100);
            ExperimentIdentity worker = identity(102, 100), owner = identity(103, 101);
            ExperimentIdentity self = role == 1 ? parent : role == 2 ? worker : owner;
            ExperimentIdentity issuer = role == 3 ? parent : supervisor;
            uint32_t issuer_role = role == 3 ? 1 : 0, socket_uid = 501;
            int socket_peer = issuer.pid, window_pid = supervisor.pid;
            ExperimentConfig c = {.magic=0x42584d31, .role=role, .scenario=11, .window=4,
                .supervisor=100, .parent=role == 1 ? 101 : role == 3 ? 101 : 0, .worker=102, .tag=123};
            switch (mutation) {
            case 0: break; // three legal, closed process shapes
            case 1: strcpy(issuer.path, "/foreign/launcher"); break;
            case 2: issuer.inode++; break; // copied binary, not the same file
            case 3: issuer.device++; break;
            case 4: issuer.uid++; break;
            case 5: issuer.ruid++; break;
            case 6: issuer.svuid++; break;
            case 7: socket_peer = 50; break; // fabricated descriptor from another process
            case 8: socket_uid++; break;
            case 9: self.ppid = 50; break; // role3's supplied parent cannot choose actual ppid
            case 10: c.supervisor = 999; break; // arbitrary unrelated GUI/window PID
            case 11: window_pid = 999; break;
            case 12: strcpy(supervisor.path, "/foreign/gui"); break;
            case 13: supervisor.inode++; break;
            case 14: supervisor.uid++; break;
            case 15: worker.ppid = 999; break; // must be root's actual direct child
            case 16: strcpy(worker.path, "/foreign/worker"); break;
            case 17: worker.ruid++; break;
            case 18: c.role = role == 3 ? 1 : 3; break; // swapped CLI/grant roles
            case 19: issuer_role = role == 3 ? 0 : 1; break;
            case 20: c.parent = 999; break;
            case 21: c.worker = 999; break;
            case 22: c.window = 0; break;
            case 23: c.tag = 0; break;
            case 24: c.scenario = 12; break;
            case 25: c.magic = 0; break;
            case 26: self.svuid++; break;
            case 27: memset(issuer.path, 'x', sizeof(issuer.path)); break;
            case 28: self.uid = self.ruid = self.svuid = 0; break;
            case 29: issuer.mapped_inode++; break; // path replacement is not mapped file identity
            case 30: self.mapped_device++; break;
            }
            int ok = experiment_closed_topology(role, issuer_role, socket_peer, socket_uid, window_pid,
                &self, &issuer, &supervisor, &worker, &c);
            assert(ok == (mutation == 0)); cases++;
        }
    }
    // The old exploit: foreign parent claims a different same-executable GUI
    // ancestor/window. Its actual identity/parentage must reject before config.
    ExperimentIdentity root = identity(100, 50), parent = identity(101, 999), worker = identity(102, 100), owner = identity(103, 101);
    ExperimentConfig c = {.magic=0x42584d31, .role=3, .scenario=1, .window=4, .supervisor=100, .parent=101, .worker=102, .tag=123};
    assert(!experiment_closed_topology(3, 1, 101, 501, 100, &owner, &parent, &root, &worker, &c)); cases++;
    parent = identity(101, 100); worker = parent; c.worker = parent.pid;
    assert(!experiment_closed_topology(3, 1, 101, 501, 100, &owner, &parent, &root, &worker, &c)); cases++;
    printf("PASS %u synthetic bootstrap topology/identity refusals and admissions; no native authority or input\n", cases);
    return 0;
}
