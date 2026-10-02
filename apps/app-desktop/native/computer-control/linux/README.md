# Experimental Linux native helper

The parent now wires the fixed launcher, packaged resources, independent platform gate, visible app/perception indicator and Ctrl+Alt+Shift+Escape Stop. A consented read-only grant performs one local AX inspection and ends authority before returning its snapshot; it is not a model task. This is **not a release-ready Linux desktop-control claim**. Production logind, real parent/physical-input integration, packaged dependencies and acceptance remain open. The parent lease derives its fixed home from OS `userInfo().homedir`, never `HOME`/`USERPROFILE`. Linux independently authenticates the system-logind session owner and uses `User.RuntimePath`; unsafe/missing paths or an `XDG_RUNTIME_DIR` mismatch fail closed. Environment-selected directories cannot split device authority. Public Stop/disconnect responses redact prior identity/expiry; integration-level Stop erases the private grant. Stale controller callbacks are ignored, without releasing a live helper’s lease: helper death remains the release barrier. A completed inspector snapshot is retained only under its authenticated account/workspace/generation binding, not exposed as cross-account stopped status. Linux ordinary-credential checks reject root, mismatched real/effective/saved/filesystem UID/GID and nonzero effective/permitted/inheritable/ambient capabilities. Supplementary groups and capability bounding sets remain permitted. These checks supplement authenticated logind/lease paths; isolated fixture/focus tests do not establish production logind, hardware or packaged acceptance. The helper-client death barrier resolves only on actual process exit or a proven never-spawned process. A kill returning false, throwing or emitting errors revokes authority but does not release the lease; repeated errors remain handled safely. Stop is not proof of death, and uncertain termination cannot authorize a new owner. Stop now destroys both private command and observation streams **before** attempting kill. Channel closure independently revokes helper authority, including buffered commands: watchdogs and read/capture, focus-restoration and pre-effect guards detect closed endpoints. Closure is **not process-death proof**; the lease stays held until actual exit or proven never-spawned state. Real Linux pipe/socketpair tests exercise the portable checks; actual Windows/libuv pipe-state query acceptance remains open and unsupported/query-failure cases refuse authority. No guard can retract an OS operation already entered. The detailed historical and measured reports below are preserved; current cross-platform status is in `docs/native-computer-acceptance.md` at the repository root.

## Implemented scope

| appId | Cohort | Actions |
|---|---|---|
| `com.usebrian.NativeComputerFixture` | Exact adjacent `fixture.py` launched with an absolute path by Python 3; not a title-only allowlist | AT-SPI EditableText `setValue`, Action `invoke` (including local menus), Selection `select`, vertical scrollbar Value `scroll` |
| `org.gnome.gedit` | `gedit` executable in `/usr/bin` or `/nix/store`; GTK document multi-line editable text | `setValue` only; no toolbar/menu/search-field actions |

The gedit 50.0 cohort has actual unsaved-buffer backend coverage in dynamically owned, authenticated Xvfb/private-D-Bus sessions, not full production acceptance. The latency gate **fails**: warm execute exceeded 3500 ms in two of five benchmark sessions; a later cold observation at 1905 ms exceeded the unchanged 1800 ms tree budget, became partial and stopped. Unit/projection harness checks do not waive logind, consent/lease, hardware, native SDK/signing or provider gates. All three production helpers advertise `input=false` and independently refuse raw coordinate clicks; no environment flag, acceptance flag or local approval bypasses this. Scoped capture and supported AX/UIA/AT-SPI semantics remain. Generic core CV tests use fake providers, not enabled native vision. GNOME Text Editor (`org.gnome.TextEditor`), terminals, browsers and arbitrary GTK apps are not supported. These cohorts are not a sandbox against malicious same-user applications/plugins or other X11 clients.

Real AT-SPI2 traversal is capped at 500 nodes, 16 levels, 300 ms traversal budget and approximately 350 KB, with per-call AT-SPI timeouts and a separate request watchdog. Unknown/password/protected subtrees are redacted before serialization, including names and values. Every clipped name/value (including UTF-16 clipping of non-BMP text), skipped subtree and traversal truncation marks the entire observation `partial`. Partial observations are inspection-only: approval, focus restoration and effect dispatch require a complete tree. A complete node becoming truncated later also fails freshness, even if its transmitted prefix is unchanged. Refs/process/window instance IDs are random opaque IDs. Raw PID is present only as required by the shared target contract. Process birth uses `/proc` start time and boot ID; matching also checks live accessibility handles, PID and unique X11 client/frame geometry. Cached accessibility properties are explicitly refreshed.

On supported X11 sessions capabilities are `axRead=true`, `semanticActions=true`, `windowCapture=true`, **`input=false`**. Every semantic write requires exact local approval. `focus`, `click` and `key` are explicitly unsupported, never converted to shell commands or unconstrained input. There is no clipboard, subprocess action executor, arbitrary native-method dispatcher or network inference.

Capture is real direct-ctypes `XGetImage` → PNG, restricted to the fixture's borderless **Brian Safe Canvas**. It never captures the root desktop or gedit. It verifies the bounded, non-sensitive safe accessibility cohort, foreground, client bounds, viewability and all higher siblings along the X window ancestor chain, including override-redirect windows; stacking checks and image acquisition hold a short X server grab. Supported visuals are 24/32-bit RGB masks, <=1024×1024 pixels. Output is 1:1 client pixels with explicit origin/bounds; no logical-DPI guessing. RANDR configuration timestamps fence layout changes. There is no enabled coordinate/CV execution lane: safely distinguishing every injected event from takeover was not established. `xinput.py` contains raw XI2 inspection and an **unenabled, native-tested XTest candidate**, described below. Only the integration test calls that candidate; private-pipe `click` remains unsupported. The canvas reports `Canvas result: blue selected (N)` as a non-actionable AX label after a click so fresh state can verify an effect without creating a semantic shortcut.

**Wayland is explicitly unsupported**, including XWayland whenever `WAYLAND_DISPLAY` is present or `XDG_SESSION_TYPE` is not `x11`. Merely reaching AT-SPI on Wayland does not establish a reliable scoped lease/input/lock integration. No portal capture/input combination is implemented or advertised.

## Private pipe API

stdin/stdout only, serialized requests. Header: four-byte **big-endian** unsigned JSON length (1..4 MiB). Envelope: `{id, method, payload}`; response: `{id, ok:true, result}`. UTF-8, duplicate keys/nonfinite numbers/unknown schema fields rejected. stdout is protocol-only; no sensitive diagnostics are emitted.

| Method | Payload | Result |
|---|---|---|
| `capabilities` | `{}` | shared capability object |
| `listTargets` | `{}` | <=128 opaque targets, before start only |
| `start` | `{grant, leaseId}` | boolean |
| `beginApproval` | `{command, leaseId}` | boolean |
| `endApproval` | `{command, leaseId, approved}` | boolean |
| `execute` | `{command, leaseId}` | shared execution receipt |

Only one selected target and one grant per helper process. `start` is a trusted-parent **already locally approved grant**, not a request for model-derived consent. If the target is not foreground, it may restore only that exact selected window from the trusted parent's foreground window. Start-time restoration requires a complete, stable tree and geometry; an already-foreground target may still start inspection with a partial tree, but cannot execute effects from it.

Approval is bound to the entire command digest, target, refs, geometry, layout and **complete** tree contents. The narrowly scoped dialog exception binds the first input-bearing foreground X11 window owned by the pipe parent; another window (even the same PID) or a pointer outside that client's bounds revokes. Parent must show its own native local dialog and keep independent takeover/lock/Stop hooks active. This remains conservative polling/X11 attribution, not a hardened hostile-client security boundary.

On `endApproval(approved=true)`, helper closes the input exception **before** any focus restoration. It uses only an EWMH `_NET_ACTIVE_WINDOW` client message to the exact granted XID: no raw keyboard/pointer injection, shell, generic focus action or input-ignore interval. Identity, full tree, bounds and RANDR layout are checked before and after; before restoration only transient `focused` state bits may differ from the approved observation. After restoration, the exact original focus state and tree must return. An unrelated overlay is refused before requesting focus (only the current trusted parent window may cover the target); foreground and unobscured target are required afterward. Another application's foreground is never stolen. WM refusal or any mismatch fails closed.

**Parent integration:** disclose that local session/action consent includes returning focus to the selected window. Remove the five-second manual-return/Alt-Tab prompt/delay; physical Alt-Tab remains takeover and is never excepted. Call `endApproval` directly after local consent, with no renderer-controlled target substitution. Denied approval does not restore focus. Generic protocol `focus` is still unsupported; the lifecycle restoration is not a newly model-callable permission. The watchdog stays active through restoration, with no deadline/input relaxation. Observations normally expire at 5 seconds; a <=30-second approval may refresh freshness only after full unchanged-tree validation.


Helper checks identity/grant/epoch/lease/deadline on dispatch; grants last <=15 minutes. BOOTTIME fences suspend and wall-clock rollback. A per-user nonblocking `flock` in the private runtime directory from authenticated system logind `User.RuntimePath` excludes other helpers across Electron instances (do not unlink the lock file). The user object must belong to the validated local session UID; missing/unsafe runtime paths or a supplied `XDG_RUNTIME_DIR` mismatch fail closed. Environment-selected private directories cannot create independent authority. The trusted parent still needs its own device lease. A separate watchdog polls XI2 and logind, verifies parent process identity, terminates on expiry/blocked requests/session lock or loss, and rejects >1-second scheduling/suspend gaps. It includes synthetic raw input. No held input needs release because no input injection is supported. Exit 73 means takeover, 70 deadline/parent loss, 71 safety/session loss, 64 malformed request/internal failure; EOF ends authority. Xlib errors also terminate rather than continue uncertainly.

Journal: <=512 commands per grant, no eviction. An unknown receipt is recorded **before** native dispatch. Identical retries retrieve metadata, never rerun effects; changed payloads under the same ID are denied. Unknown native outcomes latch execution off. Fresh post-action observations are returned when possible; the planner still must verify progress. Across crashes there is no resumable grant or durable action replay; parent must treat a missing response as unknown and kill/reconsent, not blindly retry.

## Runtime dependencies and parent launch

See `dependencies.json` for the manifest. Python >=3.11, pyatspi, PyGObject, AT-SPI2/Gio/GLib typelibs, libX11/libXi/libXrandr, session D-Bus and **system logind** are required. GTK3/Atk/Cairo are fixture-only. Debian/Ubuntu example (administrator installation, never an action):

```sh
sudo apt install python3 python3-pyatspi python3-gi python3-cairo \
  gir1.2-atspi-2.0 gir1.2-gtk-3.0 at-spi2-core \
  libx11-6 libxi6 libxrandr2 dbus-user-session
```

Stage all seven runtime `.py` files together outside ASAR in an app-owned non-writable resource directory; ship `dependencies.json`. Its `runtimeFiles` list is explicit (do not omit the raw-event decoder dependency `xinput.py`):

```text
helper.py
contract.py
atspi_backend.py
safety.py
x11.py
xinput.py
fixture.py
``` No compilation is needed. Build verification:

```sh
/usr/bin/python3 -Es -m py_compile contract.py x11.py xinput.py safety.py atspi_backend.py helper.py fixture.py
/usr/bin/python3 -Es -m unittest discover -s tests -v
```

**Fixed interpreter launch:** parent spawns `/usr/bin/python3`, argv `['-Es', '/absolute/resources/native/computer-control/linux/helper.py']`, with private pipe stdio, no shell. `-E` ignores Python environment overrides; `-s` disables user site packages. Do not choose the interpreter, module path or arguments from a renderer/model or search PATH. The source shebang specifies the same interpreter; packaging may mark helper.py executable if choosing direct script spawn. For Nix packaging replace this with one **build-time-fixed absolute Python closure**, not a runtime `nix-shell` launcher. Bundle/audit GI typelibs and native libraries or declare distro packages; pin the release dependency closure and include licenses. Do not claim distro acceptance from the development Nix shell.

Pass only trusted local-session environment: `DISPLAY`, `XAUTHORITY` (if required), `DBUS_SESSION_BUS_ADDRESS`, `XDG_SESSION_TYPE`, `XDG_SESSION_ID`, `XDG_RUNTIME_DIR`, `WAYLAND_DISPLAY` (preserve it so refusal cannot be bypassed), and required locale/HOME/XDG data locations. For bundled/Nix libraries, `GI_TYPELIB_PATH`/`LD_LIBRARY_PATH`/`XDG_DATA_DIRS` must be packaging-selected fixed paths, not renderer values. Never pass Python import overrides, `LD_PRELOAD`, arbitrary user library overrides or model variables. Keep `PATH` minimal; production helper library loading uses fixed SONAMEs and never invokes library-discovery subprocesses.

Helper initialization and every session/target identity recheck require bounded kernel `/proc` credential snapshots: non-root matching real/effective/saved/filesystem UIDs and unchanged matching GIDs, with zero effective/permitted/ambient/inheritable capabilities. Missing or malformed state refuses AX authority. Supplementary groups and the capability bounding set are not elevation and remain permitted. These point-in-time checks do not make hostile same-user applications a sandbox.

Readiness requires logind's session to be active, unlocked, local, owned by this UID and matching `DISPLAY`; missing `LockedHint` or inability to query logind is unsupported. Needs an EWMH WM and enabled desktop accessibility. Plain Xvfb has no accepted logind session and therefore **cannot start the production helper**. Parent must retain the app indicator, independent emergency Stop, relay/identity revocation and SIGKILL-on-timeout behavior. Current TS platform gates must be integrated by the parent owner; this directory does not enable them.

Manual fixture launch:

```sh
/usr/bin/python3 /absolute/path/linux/fixture.py
/usr/bin/python3 /absolute/path/linux/fixture.py --canvas
/usr/bin/python3 /absolute/path/linux/fixture.py --safe-form
```

The default form includes a password sentinel and therefore yields a partial redacted tree; it is for privacy inspection, not helper-controlled effects. `--safe-form` omits that field for complete-tree lifecycle/action tests. No helper-side completeness bypass exists.

## Verification

Pure contracts/mock guards:

```sh
python3 -m unittest discover -s tests -v
```

Actual backend integration, without bypassing the production helper's safety gates:

```sh
nix-shell --extra-experimental-features 'nix-command flakes' --impure shell.nix \
  --run 'dbus-run-session --config-file="$DBUS_TEST_CONFIG" -- python3 tests/native_xvfb.py'
```

`shell.nix` is a development dependency manifest using the local nixpkgs registry, not a release lockfile. If nix-shell emits a missing `<nixpkgs>` warning while finding its interactive shell, it can use the host bash and still run the tests; set a trusted `NIX_BUILD_SHELL` or configured nixpkgs search path to silence that host issue. Xvfb/Openbox may emit harmless keymap/font/socket warnings. The harness launches only disposable fixture/test processes and never exercises the user's desktop.

Verified actual backend output:

```text
PASS: actual GTK AT-SPI edit/invoke/select, scroll Value and local menu workflow; redaction
PASS: actual XGetImage isolated canvas PNG and 1:1 pixel transform
PASS: actual XI2 raw-input detection using test-only XTest injection
EXPECTED FAIL-CLOSED PROBE: unexpected input sequence
PASS: candidate native click produced non-actionable AX result; cleanup released held input
PASS: stale pixel digest refused before redispatch
PASS: external-client XTEST shares source 4 ; no source-only exemption
PASS: non-XTEST XI2 source 6 cannot match our expected sequence (simulated hardware)
PASS: actual held button released after injected failure; no replay
PASS: pre-existing held input refused without releasing user-owned button
PASS: candidate click rechecks stacking before native input
PASS: actual overlay capture refusal; production logind/lease/watchdog acceptance NOT tested
```

Native integration tests use real GTK, AT-SPI, X11 and XI2, **not mock OS success**. They call the backend directly and are not an end-to-end helper authority/approval acceptance test. Mock guard tests cover takeover decisions and deadlines separately. Remaining release gates: actual logind lock/unlock/suspend, XI2 approval/takeover races, helper hang/kill responsiveness, cross-instance lease races, gedit native tasks, screen rotations/mixed scaling/negative origins, packaged dependencies, real parent dialog/focus integration and security review. No Wayland acceptance or automatic Linux feature enablement is claimed.

## XTest click investigation: input deliberately NOT advertised

`xinput.CanvasInput` is an isolated candidate, not callable from the private pipe.
It uses direct libXtst with a bounded 1:1 frame transform, PID/foreground/geometry/
RANDR/stacking checks, SHA-256 pixel equality and a supplied guard callback. It
holds an X server grab on the same connection used for injection and raw-event
observation. It drains preexisting events and requires an **exact single event**
per request: request serial, XI2 XTEST source ID, master ID, event type, button
number and no `XSendEvent` flag. It never accepts extra, reordered, missing or
physical-source input. Source identity alone is deliberately insufficient.

The native Openbox/Xvfb experiment exposed two concrete blockers:

1. Two separate X clients generate raw motion with the **same** source ID 4
   (`Virtual core XTEST pointer`, master 2). An "ignore XTEST while clicking"
   interval would ignore external input. An expected sequence on that shared
   source alone is not proof of origin.
2. While `XGrabServer` excludes other client requests, Openbox's pointer-grab/
   replay behavior defers the release event. The probe observed motion and down
   with their exact request serials, but **no release event** for expected request
   179. After ungrabbing it observed release at serial 184 (including a cleanup
   release). Those serials are sample run values, not hard-coded expectations.
   Accepting delayed events after releasing the server would discard the very
   provenance guarantee the server grab was intended to provide.

The candidate therefore raises `Takeover`, attempts an up for any own held down,
releases the server grab in `finally`, and never reports successful execution.
The visible click can already have happened: the native test inspects the AX
result rather than replaying it. Actual tests confirm no held button remains,
also when a test-injected failure occurs immediately after a real button-down.
This cleanup is **not a SIGKILL guarantee**; abrupt helper death between flushed
down/up remains another release gate. Production has no such exposure because
`CanvasInput` is never invoked by `Broker`.

Thus `capabilities.input` remains **false** regardless of XTEST availability.
`beginApproval(click)` refuses and `execute(click)` returns unsupported; no
renderer flag, environment toggle or local approval can enable the candidate.
There is deliberately no claim of an approval-through-dispatch CV lane. Exact
local approval, pixel seals through the dialog and dispatch, and independent
physical-input revocation must all be established **together** before wiring this
candidate into the broker. Other window managers and dedicated-device approaches
are not assumed safe merely because this one failed; they require separate
experiments and lifecycle/held-input cleanup design.

The non-XTEST source test routes an XTest-generated event through Xvfb's mouse
(source 6), exercising real XI2 source decoding and rejection. It is **not a real
physical mouse test**. Pure policy tests cover mismatched and interleaved physical
source IDs; existing watchdog logic still revokes on raw input outside the narrow
parent-dialog exception. No blanket takeover suppression was added. The native
harness's guard callback is test-only and does not establish local consent,
logind lock/suspend, parent Stop, desktop-session lease or packaged acceptance.

Current pure verification: **67 tests passed**, including exact approval/no-replay
for semantic scroll and explicit refusal to approve or execute coordinate clicks.
GTK menu warnings about a missing trigger event are emitted by GTK during real
AT-SPI menu invocation; the fresh AX workflow result is verified.

### Completeness and consented focus regression

```sh
nix-shell --extra-experimental-features 'nix-command flakes' --impure shell.nix \
  --run 'dbus-run-session --config-file="$DBUS_TEST_CONFIG" -- python3 tests/native_focus.py'
```

Verified output:

```text
PASS: consented start returns exact selected GTK window to foreground via EWMH
PASS: consented endApproval restores foreground and permits the exact approved semantic effect
PASS: denied approval causes no focus side effect
PASS: stale target identity cannot activate a window
PASS: unrelated same-parent-PID overlay prevents restoration before any focus request
PASS: other-window foreground is neither stolen nor automated
PASS: real long-text suffix mutation yields partial; approval/dispatch/start restoration denied
NOTE: real GTK/EWMH/AT-SPI; simulated guard, no logind/lease/packaged acceptance
```

Pure regressions also cover pre/post-focus content, geometry, identity and overlay mutations; revoked focus guards; clipped names; supplementary Unicode/UTF-16 bounds;
changes from complete prefixes to truncated text at approval end and dispatch,
partial sibling nodes, exact upper limits, generic-focus denial, same-parent other
windows, out-of-dialog pointer input and input revocation during restoration.
The existing native canvas/scroll/menu test still runs; its deliberately rejected
XTest candidate is unchanged and **not enabled**. Real Electron dialog close/input
races, logind, hardware takeover, suspend and packaged acceptance remain pending.

The native harness waits for cold/slow bounded read-only traversals to become
complete and waits for window-manager teardown before the next scenario. It may
repeat start preparation only when the prior call returned before lease acquisition
and any focus request; it never retries an effect after authority/dispatch. The
production 300 ms traversal budget, complete-tree fence and watchdog are unchanged.
The focus suite passed three consecutive fresh Xvfb/D-Bus sessions after these
readiness/teardown races were removed from the harness.

## UTF-16 wire compatibility audit

String limits below are **UTF-16 code units**, matching JavaScript/Zod, not Python
`len()`, UTF-8 bytes or grapheme clusters. `contract.py` owns the limit constants,
strict input measurement and scalar-safe output prefix function. AX uses the same
prefix function for role/name/value and marks **any** changed/clipped field partial;
whole-state approval/dispatch/focus fences are unchanged. AT-SPI text offsets and
`characterCount` remain Unicode **code-point** offsets, so their read-completeness
check intentionally uses Python `len()` before applying the wire limit.

| Wire field | Maximum units |
|---|---:|
| Identity fields, app/process/window IDs, grant/command IDs, refs, observation/frame IDs, layout version | 256 |
| Private request/response correlation ID and lease ID | 256 |
| Grant requester / goal | 200 / 2000 |
| Action text; exported AX name and value | 4096 |
| AX role | 100 |
| Capability limitation entry | 300 |
| Frame base64 data (ASCII) | 3 × 1024 × 1024 |

Enums/protocol/method names use exact closed-set values. Exported identifiers are
bounded generated UUIDs/ASCII hashes, fixed cohort IDs, or echoes of validated
identity/target/command fields. Invalid receipt IDs become the fixed `invalid`
sentinel rather than echoing bad input. Capability prose is fixed and tested
against its own limit. Oversized frame data is refused independently of the larger
message-byte budget. Relay token/status messages are not private-helper methods.

2048 supplementary scalars occupy 4096 units and are accepted; 2049 are rejected
as input or clipped and marked partial as AX output. Clipping never emits half a
surrogate pair. Combining sequences are not normalized: their constituent code
points are preserved and counted individually. A scalar prefix may end before a
combining mark, but then the observation is partial and cannot authorize an effect.
Lone surrogates are an intentionally stricter native-API refusal than JavaScript's
representable-string subset; validators return false without exposing the value
or throwing a Unicode encoder exception. No consent or cohort behavior is widened.

Reproducible cross-language check (Node 22+ with TypeScript stripping, repository
Zod dependency, fixed absolute test interpreter; **test runner only**):

```sh
node --experimental-strip-types tests/zod_unicode_check.mjs /usr/bin/python3
```

On Nix, supply the fixed absolute Python executable from the chosen test closure.
The runner imports the actual shared `protocol.ts` read-only; only boolean results
cross the Python oracle's stdout. Neither assertions nor diagnostics print tested
Unicode strings/AX values. Audit output:

```text
Ran 67 tests in 0.278s
OK
PASS: 52 Python/shared-Zod UTF-16 boundary comparisons; no values logged
PASS: native GTK UTF-16: 2048 supplementary scalars accepted; 2049 denied/partial; combining codepoints preserved; no values logged
```

Both `native_xvfb.py` and `native_focus.py` passed after the backend change. The
latter now tests the real GTK EditableText boundary and complete/partial behavior,
in addition to the earlier focus and scope regressions. Its logind/lease guard is
still simulated; packaged/hardware/logind acceptance remains pending. No new
cohorts or CV input were enabled.


## Real gedit 50.0 cohort evidence

**Historical initial verification:** the authority/timing limitations in this
section describe the initial harness. The latency audit below supersedes its
request-deadline instrumentation and records current failures.

`tests/native_gedit.py` exercises the existing `org.gnome.gedit` cohort against
actual Nix gedit, not a mock or renamed fixture. Reproduce from this directory:

```sh
nix-shell --extra-experimental-features 'nix-command flakes' --impure shell.nix \
  --run 'python3 -m unittest discover -s tests -q && python3 tests/native_gedit.py'
```

The shared supervisor owns authenticated Xvfb, disposable D-Bus and private
HOME/XDG directories; the system bus is unavailable and GSettings is memory-only.
The app is launched with `--standalone --new-window --new-document`, no filename
and no document stdin. All edits affect a fresh **unsaved buffer**. There are no
Save/Open actions, shortcuts, shell action execution or input/CV routing. Process
termination never answers a save prompt. Reopening must produce an empty buffer;
audit of private HOME/XDG regular files checks that tested document contents were
not persisted. Temporary application metadata/configuration is allowed; no user
documents/configuration or host display is used. Text/AX values are not printed.

### Pin and narrow fixes

`dependencies.json` records measured gedit **50.0**, nixpkgs revision
`b6c8664de9b6cc07fe5666a29f91884ba81197c4`, NAR hash
`sha256-k8Fu4c9Z+4Nh7mUr0cfw++ITQiyEhlWxoJBOkI3tOcQ=`, and actual executable:

```text
/nix/store/pbdrndbn9wfzl5j9dhyyykiacrgyia9l-gedit-50.0/bin/.gedit-wrapped
```

The development shell uses that fixed revision and includes gedit. The initial
native run failed because Nix's real wrapped executable was rejected. Admission
now allows only the exact measured immutable Nix binary and the pre-existing
`/usr/bin/gedit` path, not arbitrary store paths, basenames, argv, titles, Python
or shells. Another package build needs an explicit audit/update. This evidence
does not validate arbitrary distro `/usr/bin/gedit` versions.

The real cold tree also exposed passive toggle-button, table-column-header and
icon roles and roughly 230 nodes; a diagnostic full traversal took **1194 ms**.
The original 300 ms traversal correctly returned partial and refused authority.
Those three roles are now readable **only for gedit**, never actionable; unknown
roles and sensitive attributes still redact. The editor traversal budget is
bounded at **1800 ms**; the fixture remains at 300 ms. The 500-node, depth-16,
350000-byte, clipping, whole-tree freshness and independent production watchdog
fences remain intact. No hidden subtree is skipped or declared complete. Slow or
oversized observations remain inspection-only.

### Concrete native verification

```text
Ran 85 tests
OK
PASS: real gedit discovered by exact executable, process and X11 window
PASS: bounded complete gedit AX; exactly one document setValue; no toolbar/menu actions
PASS: real gedit toolbar invoke cannot acquire approval or dispatch
PASS: real approved UTF-16 document assignments and fresh postvalues; 4096 accepted, oversized input denied; no values logged
PASS: >4096-unit gedit text is partial; new approval and already-approved dispatch refused; capture denied throughout
PASS: reopened real gedit has new process/window identities and empty unsaved buffer; stale target refused
```

The actual backend/broker perform discovery, EditableText assignment, exact-command
approval plumbing and pre-dispatch freshness checks. Coverage includes mixed
supplementary/combining characters, the 4096-unit boundary, oversized input,
4098-unit supplementary and 4097-character ASCII observed buffers, and oversize
mutation **after** approval. Capture is refused with `allowCapture=true` in both
complete and partial states; interception asserts XGetImage is never called.
Reopening changes process/window identities; backend and broker reject the old
target. Pure regressions additionally cover executable lookalikes, owner checks,
passive-role sensitivity/action scope and traversal budgets.

**Authority is explicitly simulated:** consent decisions, logind, lock/suspend,
lease ownership, takeover and request-deadline enforcement are not production
checks in this harness. The normal helper has no test bypass. Two native approval
completions in the verification run took 733 ms each; this is **not** a production
watchdog guarantee. A repeat fresh session measured **7833 ms** and 732 ms;
the first exceeds the unchanged **3500 ms production request budget**. Thus
production timing acceptance is specifically **not established** by these passes:
the simulated guard allowed that slow approval, whereas the real watchdog must
refuse/stop an over-budget request. No timeout was relaxed to hide this result.
This validates the tested unsaved-document state, not every gedit plugin/dialog.
Real consent UI, physical input, logind, packaged launch and release acceptance
remain unverified. Both existing native fixture/focus suites passed after the
changes. No new application cohorts, shortcuts or CV input were enabled.


## Linear freshness and guarded latency audit — NOT timing accepted

`unchanged()` now validates each **live immediate parent once**, rather than
walking every ancestor for every node. Its local graph validation rejects empty
or corrupt refs, aliases, missing parents/children, disconnected parent graphs,
cycles, excessive depth and child-list duplicates. Every live child list still
matches exactly, every node is freshly normalized (including truncation), and
`live()` checks the root's application/process/window identity. Validation is
O(nodes + edges), with at most 500 nodes and 1000 enumeration edges.

Real GTK exposes virtual relationships: popovers enumerated under the frame can
have a relative widget/menu as their AT-SPI parent, including parents not exposed
by the frame's child enumeration. Merely trusting traversal parentRef would fail
on real gedit. Observation now captures **actual parentRef** and closes both parent
and child membership under the SAME node/time/size/depth budgets. New ancestors
must first prove their parent chain reaches the selected window, before their
contents are inspected. The reported parent graph is rooted and acyclic; GTK's
enumeration graph may be a DAG but must also be acyclic, bounded and unchanged.
No absent parent is excused using cached data. Sensitive virtual ancestors redact
already-enumerated descendants as well; extra ancestors are inspected top-down.
The existing gedit cohort's observed `tree table` ancestor is passive/read-only,
with sensitive attributes still redacted and no new actions or app cohorts.

`endApproval` now uses private **header** freshness checks around restoration:
scope/observation ID, completeness, existing approval-age rules, identity,
geometry/layout and final foreground remain checked. Restoration retains its
full pre-tree and full post-tree validation, guards before/after those checks,
trusted-parent/overlay rules and final authorization guard. The other two full
passes were redundant with these restoration barriers. Approval only records the
exact command digest; dispatch still performs its own whole-tree freshness and
last authorization guard. Capture/action paths retain their full checks; a later
UI mutation cannot gain dispatch authority through the header-only helper.

### Reproduce and interpret the measurements

```sh
nix-shell --extra-experimental-features 'nix-command flakes' --impure shell.nix \
  --run 'python3 tests/benchmark_gedit.py --sessions 5'
```

`native_gedit.py` now uses `gedit_timing.py`: every start, observe, begin, end,
execute and negative probe gets a real **3500 ms monotonic request deadline** and
independent timer that latches expiry. Guard checks before/after a request and a
final elapsed-time check raise even if Broker caught an internal timeout. Expiry
cannot be cleared to continue. This instruments backend/broker calls, not private
pipe serialization or OS authority. Consent/logind/lease ownership/takeover are
still simulated; the normal helper has no test bypass. The real production
watchdog is unchanged. A timed-out dispatch may have executed before post-state
verification: it is not retried and is not claimed as a rollback/no-effect result.

Cold means first positive lifecycle in each fresh process/disposable session,
with no full AX prewarm before the first observation; it does NOT mean flushing
OS/page caches. Start measures an already-foreground gedit window. Warm means
later valid requests on that process; warm starts use fresh simulated broker
instances. Values below include over-budget failures; deliberate negative tests
are excluded. Quantiles are nearest-rank with the sample counts shown, not a
large-population performance guarantee. All five cold lifecycles completed.

| Phase | Operation | n | Successful | p50 ms | p95 ms | Max ms |
|---|---|---:|---:|---:|---:|---:|
| cold | start | 5 | 5 | 2.502 | 3.289 | 3.289 |
| cold | observe | 5 | 5 | 155.398 | 463.405 | 463.405 |
| cold | begin | 5 | 5 | 138.316 | 564.373 | 564.373 |
| cold | end | 5 | 5 | 284.988 | 1111.417 | 1111.417 |
| cold | execute | 5 | 5 | 520.613 | 2738.354 | 2738.354 |
| warm | start | 16 | 16 | 1.971 | 16.616 | 16.616 |
| warm | observe | 41 | 41 | 140.177 | 1458.665 | 1472.878 |
| warm | begin | 19 | 19 | 132.207 | 1398.767 | 1398.767 |
| warm | end | 19 | 19 | 267.789 | 2821.319 | 2821.319 |
| warm | execute | 19 | 17 | 407.315 | 4269.942 | 4269.942 |

```text
RESULT sessions=5 failed=2 overBudget=2; simulated logind/consent, real 3500ms deadline
```

The latest benchmark exits **1**, not success. Approval-end latency improved, but
warm execute still exceeded the budget (maximum **4269.942 ms**). Earlier optimized
five-session runs also caught 3664.806 ms and 3944.945 ms executes. Thus the overall
latency task remains **incomplete**, not masked by percentiles or simulated guards.
Structured evidence is in `tests/gedit_latency_results.json`. No request timeout,
lease, freshness, truncation, capture or final action guard was relaxed.

The editor traversal limit remains **1800 ms**, not increased. Observations still
showed roughly 1.5-second tails, so restoring 300 ms is not justified by the fast
median. The fixture stays at 300 ms. Final completeness now also checks elapsed
time and serialized-node size after parent normalization/closure.

Regression coverage: 99 unit tests, including linear parent-call counts, graph
corruption/cycles, live reparenting, sensitive virtual ancestry, clipped post-focus
state, exactly two restoration passes, unchanged action final passes, expired or
wrong snapshot headers, and deadline latching. Native fixture/focus, real GTK
evaluation and parallel owned-desktop cleanup suites passed. Production timing,
logind, physical input, real consent UI and packaged acceptance remain unclaimed.

Private-channel revocation is independent of kill, parent death and deadlines:
a dedicated watchdog (no AX/X11/logind call or safety lock) polls stdin/stdout for
HUP/ERR/NVAL. Safety admission, read/capture return, lifecycle focus restoration
and each semantic setter recheck the channel after potentially blocking AT-SPI
lookups. Main closes both peer streams on Stop even if SIGKILL fails. The lease
remains held until confirmed process exit, not stream closure.

`python3 -B -m unittest discover -s tests -p 'test_*.py'` includes real buffered
pipe/socketpair tests, a blocked-worker subprocess watchdog test, writable-output
peer closure, and fake-AX read/capture/focus/setter guards. Desktop helper tests
also exercise real Node inherited stdio with false/throw/error kill attempts.
These are channel/logic tests, not new desktop or physical-input acceptance.


## Single semantic scan / bounded Text read audit — acceptance still FAILS

This source-only follow-up preserves the newer `timed_request` and
`native_api_timing` instrumentation, channel/credential guards, and `input=false`.
No deployment, dependency, schema, watchdog or traversal budget was changed.

### Review and deterministic reductions

Semantic execute previously made two full `fresh(c)` scans separated only by
local approval-digest/ref dictionary checks. It now performs early **header**
scope/age/completeness/context checks, those same local eligibility checks, then
**one full freshness scan immediately before guarded native act**. A changed
snapshot or ref binding across that final scan is rejected. The final authorized
check, the actual setter guard **after** blocking interface/selection/value lookups,
and fresh post-effect observation remain. Capture retains full pre/post checks,
its safe-canvas predicate, and channel guards before/after capture. Returning
`approval_required` without a whole scan is a denial, never freshness evidence.

Before changing Text reads, `tests/native_text_bounds.py` verified actual pinned
GTK fixture and gedit providers clamp `getText(0,4097)` at EOF. It exercised Text
nodes and unsaved empty, combining/supplementary, 4096-, 4097- and 8192-character
buffers. It runs in a separate owned desktop/session, not as benchmark prewarming.
The backend now requests at most 4097 Unicode code points, then fetches ONE fresh
`characterCount`. Complete requires count <=4096, returned length == fresh count,
and unchanged scalar-safe UTF-16 normalization. The extra code point exposes
truncated-prefix/oversize-shrink races. Growth or shrink between read and count,
unknown counts, unsupported bounded offsets, and any UTF-16/name/role clipping
fail closed. Same-length racing edits were not made atomic by the previous
count/read/count scheme either; full live comparison and final guards remain.
Sensitive text is never requested. No unbounded -1 read or stale-data fallback was
introduced; touched gedit assertions now use bounded reads as well.

Tests cover one final scan, fresh postvalues/observations, stale/rebound refs,
clipped siblings, revocation after the scan, setter revocation after lookup,
capture's two scans, Unicode/growth/shrink/sentinel behavior, unsupported providers,
and privacy. Existing source-timing/native-API boundaries are unchanged. The
latency wrapper now calls the real `Broker.request` through `timed_request`,
recording completed request/API durations where available; aborted calls get no
fabricated completed spans. Logind/consent/lease/channel authority is still
simulated in the gedit benchmark; the 3500ms request deadline is enforced.

### All runs and failures (do not pool their quantiles)

Reproduce the strict benchmark inside the pinned development shell:

```sh
python3 tests/benchmark_gedit.py --sessions 5 --json-out /tmp/gedit-new-measurement.json
```

The reporter includes failed expected requests in nearest-rank p50/p95, retains
raw scalar timing samples, and exits nonzero for any failed session, watchdog
expiry or incomplete expected observation. Intentional capture/negative refusals
are not latency successes or failures; their watchdog expiry would still fail.
Counts below matter: downstream operations are unavailable after an earlier
fail-closed abort. Cold is first positive lifecycle after launch, not OS-cache
flushing; no full tree is prewarmed before first observation.

* Historical `tests/gedit_latency_results.json` and the previous README evidence
  remain untouched. This includes the prior 2/5 warm-execute failures and the
  separately user-reported 1905ms cold tree exceeding the 1800ms tree budget.
* **Run 1:** five scripts exited 0, no 3500ms violation, but only **24/25** warm
  execute post-observations were complete. This is NOT accepted as a clean run.
  Cold/warm execute p95 were **307.587 / 2827.425 ms**, max warm **3382.587 ms**.
  The original reporter lost individual samples and failed to reject that partial
  observation; its exact aggregate table is retained in
  `tests/gedit_latency_single_scan_run1_summary.json`, explicitly marked failed.
* **Run 2:** **5/5 sessions failed**: one reopened-empty-document readiness timeout
  and four partial cold observations (**1969.646, 1889.645, 1910.378, 1894.925 ms**
  full request elapsed). No 3500ms violation. Its raw report mistakenly counted
  six intentional capture denials as additional failedExpected requests; those
  are identified as a reporter bug, not real failures, and raw history is NOT
  rewritten. Correct positive-request failure count is four. The first session
  reached the warm operations shown below before its reopening failure.

| Run 2 phase | Operation | n | Complete successes | p50 ms | p95 ms | Max ms |
|---|---|---:|---:|---:|---:|---:|
| cold | start | 5 | 5 | 17.286 | 67.411 | 67.411 |
| cold | observe | 5 | 1 | 1894.925 | 1969.646 | 1969.646 |
| cold | begin | 1 | 1 | 163.833 | 163.833 | 163.833 |
| cold | end | 1 | 1 | 387.500 | 387.500 | 387.500 |
| cold | execute | 1 | 1 | 2977.352 | 2977.352 | 2977.352 |
| warm | start | 4 | 4 | 2.555 | 17.379 | 17.379 |
| warm | observe | 11 | 11 | 221.060 | 1499.324 | 1499.324 |
| warm | begin | 5 | 5 | 180.806 | 1421.865 | 1421.865 |
| warm | end | 5 | 5 | 321.539 | 2901.185 | 2901.185 |
| warm | execute | 5 | 5 | 429.601 | 2964.046 | 2964.046 |

* **Run 3 (latest, corrected reporter): 5/5 sessions failed**. Four cold observations
  returned partial (**1869.021, 1885.366, 1836.873, 1893.428 ms** request elapsed).
  The fifth reached beginApproval, then endApproval exceeded the real request
  deadline at **3910.482 ms** and the guard raised. No semantic execute or warm
  cycle followed this failure; missing measurements are N/A, not synthetic passes.

| Latest phase | Operation | n | Complete successes | p50 ms | p95 ms | Max ms |
|---|---|---:|---:|---:|---:|---:|
| cold | start | 5 | 5 | 14.744 | 68.549 | 68.549 |
| cold | observe | 5 | 1 | 1869.021 | 1893.428 | 1893.428 |
| cold | begin | 1 | 1 | 1943.681 | 1943.681 | 1943.681 |
| cold | end | 1 | 0 | 3910.482 | 3910.482 | 3910.482 |
| cold | execute | 0 | 0 | N/A | N/A | N/A |
| warm | start | 0 | 0 | N/A | N/A | N/A |
| warm | observe | 0 | 0 | N/A | N/A | N/A |
| warm | begin | 0 | 0 | N/A | N/A | N/A |
| warm | end | 0 | 0 | N/A | N/A | N/A |
| warm | execute | 0 | 0 | N/A | N/A | N/A |

Structured evidence: `tests/gedit_latency_single_scan_run2.json`,
`tests/gedit_latency_single_scan_run3.json`, and
`tests/gedit_latency_single_scan_summary.json`. No tested Unicode/AX content is
logged. Partial trees remain inspection-only, and an expired command is not
retried. A timed-out execute would not imply rollback or absence of earlier effects.

### Verification and limits

145 unit tests pass. Real pinned bounded-offset, `native_timing.py`, focus and
fixture harnesses passed. The first fixture attempt exposed a pre-existing test
adapter mismatch (`Broker(..., object())` after request guards began requiring
`check()`); only that test-only readiness stub was fixed, not production guards.
The native timing harness verifies real PNG capture and all four AT-SPI invocation
spans and confirms input remains disabled. Credential/channel/source-timing tests
remain in the unit suite.

**The latency task is not solved.** Deterministic IPC work was reduced safely, but
these native failures still exceed the 1800ms complete-tree budget and/or 3500ms
request deadline. The 300ms fixture budget, 1800ms editor budget, node/depth/byte
limits and final freshness/authority guards are unchanged. No clipping, cache
reuse, deadline relaxation, new app/action/CV capability, production logind or
packaged acceptance is claimed.

### Bounded profiling follow-up: passing batch, no runtime speedup claim

`tests/native_profile.py {gedit|focus}` now profiles the existing real native
harnesses **only inside their owned authenticated Xvfb/D-Bus/HOME supervisor**.
It never imports/connects to AT-SPI before that isolation boundary. Authority is
still simulated. Production/channel/credential guards and `input=false` are
unchanged. SHA-256 comparison before/after this task confirmed **no changes** to
`helper.py`, `atspi_backend.py`, `contract.py`, `safety.py`, `x11.py`, `xinput.py`,
`fixture.py`, `dependencies.json` or `shell.nix`.

Instrumentation records monotonic wall time, process CPU time, aggregate host
load/cgroup counters, at most 64 selected Python function rows, and counters for
10 fixed native API labels. It never records arguments, AX contents, accessible
identifiers, exception text or content-bearing return values. Native GI calls
need separate wrappers because cProfile otherwise attributes their time to the
calling Python function. Wrappers preserve original descriptors/results/errors;
no cached reads, timing subtraction, artificial timing or benchmark prewarming
is used. A real 3500 ms timer/check wraps lifecycle requests, retaining original
guards, and the harness aborts rather than silently dropping requests after
100 reports. Negative tests are retained; profiles are diagnostic, **not latency
acceptance**. Nested cumulative times must not be added together. The 1800 ms
editor tree limit is unchanged. Profile/report overhead perturbs timing; the
acceptance-shaped batch below runs **without** these wrappers.

Evidence retained (including intermediate profiler versions):

- `tests/gedit_profile_baseline.json`: first coarse profile, 60 gedit requests,
  exit 0. Cold observe **1536.073 ms**, CPU **787.679 ms**, tree **1483.477 ms**,
  235 nodes. Cold end **2895.261 ms**, including two `unchanged` scans totaling
  **2806.187 ms**, 470 node reads. This version also exported bounded built-in
  function descriptions; the final tool excludes those descriptions entirely.
- `tests/gedit_profile_detailed.json`: initial fixed-API instrumentation, 60
  gedit + 34 focus requests; both scripts exited 0. Cold observe **1605.480 ms**
  (CPU **840.102 ms**): role 238 calls/**207.506 ms**, state 238/**199.559 ms**,
  interfaces 235/**174.041 ms**, parent 266/**140.958 ms**, child enumeration
  231/**133.910 ms**, child count 235/**116.542 ms**, name 235/**115.354 ms**,
  attributes 235/**112.114 ms**. No cgroup throttling during this cold request.
- `tests/gedit_profile_verification.json`: final profiler and serial verification
  results, native Python version and aggregate scheduling counters. Final gedit
  cold observe **192.442 ms**; cold end **3061.140 ms** (two complete freshness
  scans **2971.732 ms**, 470 node reads). This end's role/state/interface reads
  alone total **418.366/435.308/341.802 ms**. Actual fixture approval-end focus
  transitions took **54.375** and **65.164 ms** (n=2, nearest-rank p50/p95 those
  same values); EWMH request calls were **0.094/0.156 ms**. Both retained two full
  freshness scans. These fixture numbers do not establish gedit focus timing.

**Finding:** synchronous per-node AT-SPI reads dominate both observation and
approval-end, not local graph validation, UTF-16 clipping or the EWMH request.
Identical full scans vary sharply even within a session. Final-profile gedit
had zero cgroup throttling events, while final focus/benchmark runs had 1/2;
benchmark host load changed from **0.801/0.661/1.881** to
**0.955/0.809/1.743** (1/5/15 min). Shared CPU quota was four cores. These are
aggregate counters, not attribution to other jobs; they do **not** establish
that host load caused the earlier failures. No speculative runtime optimization
was landed, and none of the observed improvement is credited to code changes.

#### Unprofiled serial five-session verification

`tests/gedit_latency_profile_verification.json` preserves every timing sample.
All five scripts passed, with zero watchdog overruns or failed expected
requests. Intentional negative tests remain in raw samples, excluded from this
positive-operation table. All quantiles are nearest rank; all times are ms.

| Operation | Cold n/success | p50 | p95 | Warm n/success | p50 | p95 |
|---|---:|---:|---:|---:|---:|---:|
| Start | 5/5 | 2.271 | 3.651 | 20/20 | 2.345 | 17.678 |
| Observe | 5/5 | 167.798 | 265.467 | 55/55 | 157.779 | 1456.076 |
| Begin | 5/5 | 149.008 | 1267.109 | 25/25 | 267.845 | 1385.785 |
| End | 5/5 | 307.346 | 2771.350 | 25/25 | 499.427 | 2816.286 |
| Execute | 5/5 | 316.860 | 1529.859 | 25/25 | 577.142 | 2868.565 |

Warm execute maximum was **2878.966 ms**, n=25. Compare the previous retained
five-session failure: cold observe 5 samples/1 complete, p95 **1893.428 ms**;
end 1 sample/0 successful, **3910.482 ms**; no warm requests reached. The new
JSON's `timingAccepted=true` means **this isolated batch only**. It does not
supersede historical failures or establish reproducible production acceptance.
Moreover, warm observation p95 **1456.076 ms** still exceeds the plan's **250 ms**
local AX target; passing tree/watchdog budgets is not passing that performance gate.
No failed native attempt occurred in this follow-up; earlier failed runs remain
intact. The Nix `<nixpkgs>` interactive-bash warning still occurs; the pinned
shell falls back to host bash and the native commands run successfully.

Verification ran serially: focused profiler unit tests, full Linux unit suite,
`native_text_bounds.py`, `native_timing.py`, `native_focus.py`, `native_xvfb.py`,
profiled gedit, profiled focus, then the unprofiled five-session benchmark.
The final unit suite passes **154 tests**, including a real elapsed-time
watchdog regression (not a native latency sample). Syntax and whitespace checks
also pass. Native authority is simulated throughout; hardware, production
logind/consent, packaged launcher and real transport timing remain unaccepted.

**Concrete next code step:** prototype bounded asynchronous **fresh-read**
batching in `Backend.node/tree/unchanged`, with a small fixed number of in-flight
read-only AT-SPI calls and per-request cancellation. Stage role/state/attribute
reads first; never prefetch sensitive names/text through a broad `GetAll`.
Preserve cache clearing, exact provider/object identity, all node/edge/text/depth
bounds, parent/child closure, partial-on-error semantics, two restoration scans,
pre/post capture, and the final guarded effect barrier. Measure real mutation,
sensitive-subtree, timeout and cancellation races against the synchronous
backend before considering replacement. This is a proposed separately audited
prototype, **not implemented or accepted**; simply removing reads or enabling
the AT-SPI cache would not be an acceptable fix.

Reproduce from this directory (run commands serially):

```sh
python3 -m unittest discover -s tests -q
nix-shell --extra-experimental-features 'nix-command flakes' --impure shell.nix \
  --run 'python3 tests/native_profile.py gedit && python3 tests/native_profile.py focus'
nix-shell --extra-experimental-features 'nix-command flakes' --impure shell.nix \
  --run 'python3 tests/benchmark_gedit.py --sessions 5 --json-out /tmp/gedit-profile-repeat.json'
```
