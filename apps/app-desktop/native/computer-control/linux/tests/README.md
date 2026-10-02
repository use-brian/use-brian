# Disposable Linux GTK tests

These are development integration tests, **not production logind, physical-input,
lease, Electron-dialog or packaged-desktop acceptance**. No root access, host
session changes or production helper/fixture modifications are required.

From `apps/app-desktop/native/computer-control/linux`:

```sh
python3 -m unittest discover -s tests -q
nix-shell --extra-experimental-features 'nix-command flakes' --impure shell.nix
```

Inside that Nix shell, run the self-contained GTK evaluation runner:

```sh
../../../../../scripts/native-computer-fixtures/check-gtk.sh
```

Individual native scripts also create fresh displays and session buses themselves.
Explicit disposable-session invocations are supported (the inner test session
still deliberately replaces the outer bus rather than trusting inherited state):

```sh
dbus-run-session --config-file="$DBUS_TEST_CONFIG" -- python3 tests/native_xvfb.py
dbus-run-session --config-file="$DBUS_TEST_CONFIG" -- python3 tests/native_focus.py
```

Outside Nix, install the dependencies listed by `../shell.nix` and use the default
D-Bus session configuration instead:

```sh
dbus-run-session -- python3 tests/native_xvfb.py
dbus-run-session -- python3 tests/native_focus.py
```

If `DBUS_TEST_CONFIG` is set, the shared runner passes it to `dbus-run-session`;
otherwise it uses the default. No existing session bus or display is a fallback.
The internal `_desktop_worker.py` is not a standalone entry point: it requires
an inherited supervisor ticket pipe before opening X11.

## Isolation and cleanup

All three entry points use `isolated_desktop.py`. Xvfb selects a free display with
`-displayfd` through a private inherited pipe, not a guessed display or a socket
scan. A 10-second deadline, complete numeric response, live owned server PID, and
successful private-cookie X11 setup handshake are required before starting the
D-Bus/WM/test worker. A wrong-cookie connection must be rejected. No `-ac`, TCP X11,
shared authority file, fixed display, or existing-display fallback is used.

Each test has a mode-0700 temporary directory, mode-0600 authority files and fresh
HOME/XDG directories. Inherited X11, Wayland, session/AT-SPI/starter-bus and focus
credentials are removed; packaging dependency paths are preserved. The system bus
is deliberately unavailable: these tests cannot establish production logind gates.

The supervisor monitors its exact Xvfb Popen and bounds the worker to 180 seconds.
WM readiness is checked before any test/fixture. Server death revokes the owned
worker group, even if a native call is blocked. Cleanup signals only recorded
processes and the group created by this runner; its leader PID stays unreaped
until group signaling finishes, preventing PID/PGID reuse. Normal exits and
SIGINT/SIGTERM clean up; this is not a SIGKILL/power-loss cleanup guarantee.

## Reproduce simultaneous startup

Inside the Nix shell:

```sh
python3 tests/check_parallel_desktops.py
```

This starts **all three** GTK harnesses together, requires all supervisors to be
live at readiness, asserts distinct displays/server PIDs, checks all exit statuses,
and checks that their Xvfb processes disappear. It additionally kills one owned
server while its worker is blocked and verifies that another owned server survives.
Logs are disposable; the summary contains only harness/display/PID metadata, not
Unicode/AX values or authority cookies. Unit tests cover failed spawn, early exit,
empty/truncated/invalid/oversized displayfd, timeout, environment/authority isolation,
authentication failure, late server death, and owned-group cleanup ordering.


## Existing nonfixture gedit cohort

Inside the pinned development shell, run `python3 tests/native_gedit.py` from the
Linux directory. It uses the shared owned desktop/session and an unsaved document,
never user files. See `../README.md` for the gedit 50.0 executable pin, measured AX
budget, Unicode/capture/stale-target results and simulated-authority limitations.


### Guarded gedit latency audit

Run `python3 tests/benchmark_gedit.py --sessions 5` inside the pinned Nix shell.
Cold/warm start/observe/begin/end/execute timings include a real 3500ms deadline;
logind/consent/lease authority remains simulated. Any failed session or deadline
violation makes the benchmark fail, even if most requests pass. Latest recorded
result: 2/5 sessions failed on warm execute, maximum 4269.942ms; latency acceptance
is NOT achieved. See `gedit_latency_results.json` and `../README.md` for counts,
p50/p95, limitations and graph/freshness regression details.
