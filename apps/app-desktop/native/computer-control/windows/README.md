# Experimental Windows native computer helper

Standalone Windows implementation of `native-computer-v1`. **Disabled pilot, not a release-ready or Windows-tested adapter.** This directory is the complete change scope; the parent must select/package/launch it and separately enable its Windows controller path. Existing macOS-only TypeScript platform checks are intentionally unchanged.

## Coordinate input release defect

The removed `Native.Click` sent an unconditional extra mouse-up in `finally`, potentially releasing a physical user-owned press; termination could bypass `finally` entirely. Batching move/down/up did not prove release ownership. Coordinate input is unconditionally disabled (`input=false`), and raw private `click` execution is refused independently of client filtering, approval and every acceptance/environment flag. Capture and semantic AX/UIA actions remain. P5 is not complete. Before restoring input, implement a surviving release guardian with provable synthetic-versus-physical press ownership, termination-safe handoff/drain and lease fencing. It must release only owned presses, survive helper/parent death, and prevent late events or a new owner until release is confirmed. Test partial delivery, physical press/release overlap, takeover, Stop/kill at every down/up boundary, guardian failure, blocked workers, lock/sleep, deadline/relay loss and lease reacquisition on real native systems. Do not weaken attribution, Stop or lease requirements. Source checks and cross-compilation/parsing are not native acceptance.

## Build and exact launch path

Dependencies: .NET **8 SDK** to build; the **.NET 8 Windows Desktop Runtime x64** to run the framework-dependent output; Windows 10 1809+ / Windows 11 **x64**, an attended local interactive session, standard **medium integrity**, Default input desktop. No third-party NuGet libraries: UI Automation, WinForms, WPF reference assemblies and System.Drawing come from the Windows Desktop framework. First Linux restore downloads Windows targeting/runtime/apphost packs from NuGet. No elevation, UIAccess, shell, network, clipboard or credential APIs are used by the runtime helper.

From this directory on Windows:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1
# Start a harmless target manually, BEFORE granting a session:
.\out\win-x64\Brian.NativeFixture.exe
# Or, in a separate run, isolated custom-painted canvas:
.\out\win-x64\Brian.NativeFixture.exe --canvas
# Privacy/partial-tree negative test:
.\out\win-x64\Brian.NativeFixture.exe --secure
```

Linux cross-build (also runs portable tests):

```sh
nix --extra-experimental-features 'nix-command flakes' shell nixpkgs#dotnet-sdk_8 --command bash ./build.sh
# Or, with an installed SDK:
bash ./build.sh
```

Equivalent publish commands:

```sh
dotnet run --project BoundaryTests -c Release
dotnet publish Helper/Brian.NativeHelper.csproj -c Release -r win-x64 --self-contained false -p:UseAppHost=true -o out/win-x64
dotnet publish Fixture/Brian.NativeFixture.csproj -c Release -r win-x64 --self-contained false -p:UseAppHost=true -o out/win-x64
```

**Parent launch binary:** absolute path to `out/win-x64/Brian.NativeHelper.exe`, **no arguments**, direct child process (not `dotnet`, PowerShell, `cmd`, a shell script, or an intermediate launcher). Inherit private stdin/stdout pipes; drain stderr without logging. Preserve the published `.dll`, `.deps.json`, `.runtimeconfig.json` and other output dependencies. Keep `Brian.NativeFixture.exe` and its dependencies **adjacent** to the helper. Do not allow a renderer/model to supply executable paths or arguments. Install/sign both in a trusted package directory; this development build is unsigned. The helper recognizes its actual parent PID for local-dialog input exceptions.

A normal console invocation is refused: stdin and stdout must be redirected. Launch non-elevated; RDP/Terminal Services sessions, ARM64, services, non-Default/secure desktops, missing hooks, or non-medium integrity fail closed. Capabilities mean supported implementation paths, **not** permission to execute or proof that native acceptance passed.

## Private wire API

Exactly the existing Swift/TypeScript envelope: four-byte **unsigned big-endian byte length**, then UTF-8 JSON. Frame length must be 1–4,194,304 bytes in both directions. JSON depth is at most 40; duplicate property names, unknown fields, wrong types, unknown actions and oversized values are rejected. One request at a time; no sockets, reconnect, stdout diagnostics, tokens or dynamic method dispatch.

Request: `{ "id": "opaque request id", "method": "...", "payload": { ... } }`

Response: `{ "id": "same id", "ok": true, "result": ... }`

Malformed/untrusted requests or failed method-level safety preconditions produce `ok:false` where possible, then terminate. The parent must treat this as helper death/revocation, not continue on the same grant.

| Method | Exact payload | Result |
| --- | --- | --- |
| `capabilities` | `{}` | Shared `NativeCapabilities`, `platform: "win32"` |
| `listTargets` | `{}` | Up to 128 shared `NativeTarget`s; only before start |
| `start` | `{grant, leaseId}` | `true`; one selected target, fresh enumerated identity, local consent already obtained |
| `beginApproval` | `{command, leaseId}` | `true`; seals exact typed command and fresh complete tree/geometry before the trusted local dialog opens |
| `endApproval` | `{command, leaseId, approved}` | `true` only after exact command and unchanged target/tree revalidation; `approved:false` creates no authority |
| `execute` | `{command, leaseId}` | Shared `NativeReceipt`, optionally with observation/frame |

Grant/identity/target/action/receipt fields match `packages/computer-control/src/protocol.ts`; no extensions to shared types. Strict single-window grant (shared maximum is eight), positive epoch, maximum 15-minute grant, 4,096-character text, bounded ±600 scroll input. `observe` needs no observation ID. Other actions reference the most recent observation, at most five seconds old. `capture` returns the same observation ID with a new frame. Pixel `x/y` are in that frame, not screen coordinates.

Effect sequence (all invoke/value/select/scroll effects, regardless of label):

1. `execute(observe)` and choose an advertised ref, or `execute(capture)` for canvas.
2. `beginApproval` with the **exact eventual command**, lease, command ID, target/ref/frame and payload.
3. Parent displays exact target/action/text, requester and unknown-effect warning in its own trusted **local** dialog. No relay/renderer approval. Parent retains Stop/takeover hooks except interaction with that specific dialog.
4. `endApproval` with the identical command and local boolean result. Foreground restoration is permitted only as part of grant/action consent. If Windows foreground restrictions apply, parent must use its trusted foreground authority (`AllowSetForegroundWindow(helperPid)`) before `start`/`endApproval`; helper never bypasses foreground lock.
5. If approved, `execute` the identical command before deadline. Approval is consumed once. Changed UIA tree, text, geometry, DPI, layout, instance or canvas pixels refuses dispatch. Local dialog time can exceed five seconds, but revalidation renews **only** the exact approved snapshot; deadlines/grant expiry are never extended.

The parent must independently provide visible indicator, emergency Stop, authenticated scope, device lease, trusted consent and input/lock hooks. It must kill the helper immediately on Stop, revocation, relay loss, sign-out or identity change, and await exit before releasing its lease. Do not queue Stop behind UIA or send an unimplemented `stop` method. Helper uses an additional named per-session mutex. **Semantic-only occlusion exception:** invoke/setValue/select/scroll may ignore overlapping windows whose owning PID is exactly the live direct pipe-parent (for example its mandatory always-on-top, nonactivating `This computer` indicator). The PID is obtained from the OS, never a request; window titles alone confer no trust. This exception does not apply to other applications or the target application's own modal dialogs. Live target foreground, enabled window, process/window identity, complete fresh tree, node state, exact approval and deadline checks remain mandatory. Parent approval dialogs must close before `endApproval`; a foreground dialog/disabled target cannot pass. This permits semantic work in maximized Notepad underneath the parent indicator without pretending its pixels are unobscured.

**Pixel paths stay strict:** capture rejects **every** overlapping higher window, even the trusted parent indicator. Click execution is unconditionally unsupported. Arrange the fixture canvas away from the indicator; do not hide the mandatory safety UI or weaken the capture guard.

Exit codes: `73` takeover/foreground loss, `71` window destruction/move/display/session/power transition, `70` watchdog/expiry/parent death/unknown outcome, `72` unavailable or malformed boundary; clean stdin EOF exits 0. Every unexpected death revokes. Resume always requires a new process, enumeration, local grant, epoch and observations. Never replay a possibly delivered command after helper death.

## Supported cohort and concrete implementation

* **Classic Windows Notepad:** exact `%WINDIR%\System32\notepad.exe`, main window class `Notepad`, medium integrity. Read bounded UIA control tree. Only a direct child `Edit`/class `Edit` with writable `ValuePattern` may be changed; this replaces document text under exact local approval. No menus, dialogs, save/open/send shortcuts, capture, coordinates, TextPattern input fallback or Store/packaged Notepad. If a Windows version redirects to the Store app or lacks the required pattern, it is not supported. Notepad document mutation remains in memory unless the human separately saves it.
* **Adjacent `Brian.NativeFixture.exe`:** WinForms draft textbox, color selection, mock send/delete/duplicate-label buttons, status counter, scrollable controls, and explicitly untrusted displayed text. Invoke/Value/SelectionItem/Scroll patterns are used only if advertised and enabled. Effects are local counters/text/selection only; no files, network or clipboard. Scroll maps sign to one UIA `SmallIncrement`/`SmallDecrement` (not a claim of exact pixel scrolling); zero is rejected. Unsupported providers refuse rather than use input fallback.
* **`--secure` fixture:** password sentinel is redacted before export (empty name, no value/actions), never traversed. The tree is partial and effects/capture fail closed. Unknown control types also redact their subtrees and make the observation partial.
* **`--canvas` fixture:** a separate window titled exactly `Brian Safe Canvas`, no password or external data. Bounded `PrintWindow` target rendering into a black-initialized bitmap, PNG ≤3 MiB base64, ≤2 million pixels, ≤one capture/second. No full-screen capture or `CopyFromScreen` background leakage. Capture requires complete safe tree, foreground and conservative top-level-window occlusion checks. Coordinate click emission is removed; the fixture retains its read-only canvas result label for future tests and human interactions.
* Typed `key` and model `focus` actions are recognized but **unsupported**; never converted to arbitrary key strings. Input capability is always false, including with acceptance flags set. Semantic patterns are fixture-only except the Notepad document setter.

UIA traversal is breadth-first control-view, capped at 500 nodes/queued entries, depth 16, roughly 400 KB textual budget and 300 ms cooperative time. A provider call itself can block, so the independent watchdog kills a request after at most three seconds (or earlier command/grant deadline). Long names/values truncate at 4,096 characters and make the tree partial. Only one snapshot/frame is retained. Secure/unknown subtrees have no exported names/values/actions; their children are not accessed. Receipts in the journal retain metadata, not observations or typed text.

Opaque target/ref IDs are helper-lifetime UUIDs; each enumeration replaces the set. Live checks bind PID + process start time + exact executable path/cohort + cached UIA runtime ID + HWND destruction generation. A HWND/PID alone is never authority. Per-monitor-v2 DPI awareness, current foreground, window visibility, physical geometry, display layout, DPI, current Default input desktop, and exact **medium integrity** are checked. Elevated/UIPI boundaries are not bypassed. UIA work and pipe parsing run on a serialized MTA worker; low-level input/WinEvent hooks and the message pump remain separate. All keyboard/mouse input during active control terminates with takeover, except input targeting the trusted parent while its approval is open. The parent must restrict that exception to its local dialog; same-user malicious process injection is outside this pilot's threat model.

A bounded 512-entry, non-evicting command journal seals the canonical command digest. Same-ID/same-command retries return receipt metadata only, never re-dispatch; changed payload is denied. An unknown receipt is recorded before the OS/provider call. Exceptions after dispatch or failed post-observation yield `execution_unknown`, then terminate. Parent must likewise regard timeout/crash/partial write as unknown and **never retry effects**; fresh observation/manual reconciliation is required. Successful API return is not proof of task progress: inspect returned post-action observation.

## Verified here (Linux only)

SDK acquired through Nix: **8.0.425**, MSBuild **17.11.48**, runtime **8.0.31**, Linux x64. Both `dotnet build ... -c Release` commands completed with **0 warnings, 0 errors**. `bash ./build.sh` then successfully cross-published both `win-x64` executables into `out/win-x64/`. Both Windows projects specify `EnableWindowsTargeting=true`; helper uses an asInvoker/`uiAccess=false` manifest and x64 platform.

Portable test output:

```text
19 portable boundary tests passed; no Windows native gates exercised.
Brian.NativeHelper -> .../out/win-x64/
Brian.NativeFixture -> .../out/win-x64/
```

Tests cover frame roundtrip/EOF, zero/oversized/truncated frames, nested duplicate keys, canonical command digests, strict command/identity/target shapes, unknown actions, text and scroll bounds, key allowlist, coordinate types/ranges, grant lifetime and single-target scope. Six additional pure occlusion tests cover exact-parent semantic exemption, strict capture/click behavior, unsupported-action refusal, missing PID identity, target-owned modal/arbitrary-app rejection, and invisible/nonintersecting windows. A source regression additionally checks constant input=false, unconditional private execute refusal before dispatch, absence of coordinate emitters and preserved capture/UIA dispatch. A further source regression forbids self-input marker exemptions while preserving parent-approval checks and native event struct ABI layouts; unused marker generation is removed. These are portable boundary/source tests, **not UIA/Win32 mocks presented as native evidence**.

## Native gates still REQUIRED before enablement

No Windows machine was available for this implementation. None of the following gates is marked passed:

- Run the packaged parent/helper/fixture on supported Windows versions; verify hook installation, runtime detection, direct-child launch, mutex across two parents, trustworthy local consent/indicator/emergency Stop and foreground restoration.
- Inspect normal/secure fixtures; sentinel must never occur in serialized responses, frames or diagnostics. Check unknown role, deep/large/hung providers, 500-node/time/byte caps, stale refs, changed labels/values, duplicate labels and UIA failures.
- Fill draft, select color, scroll supported control, invoke mock send/delete with exact approvals; deny/cancel/change payload/expire approval; verify receipt and effect counter. Test same command twice (exactly one effect), changed payload with same ID (denied), 512-entry cap, provider failure after dispatch, transport loss and crash between dispatch/receipt (unknown, no replay).
- Verify maximized Notepad semantic approval/dispatch with the actual nonactivating parent indicator overlapping it. Third-party overlays and target-owned modal dialogs must still block; active/disabled-target dialogs must not be mistaken for the indicator. Repeat click/capture with the same indicator overlap and confirm refusal.
- Current separate canvas run: inspect→capture, submit a raw private click and verify refusal with an unchanged AX counter. Future approved clicks and fresh AX result verification require the release guardian first. Test screenshot/coordinate alignment at 100/125/150/200% DPI, negative origins, multi-monitor rotation/mixed DPI, move/resize/occlusion/owned popups, stale frame and changed pixels. Confirm PrintWindow content and bounds on every supported OS; any failed transform/rendering gate disables capture/input.
- Verify classic Notepad executable/class/pattern coverage and dialog exclusion. Store Notepad must not appear. Confirm helper and elevated Notepad/UAC/secure desktops reject without prompts or escalation; test UIAccess/non-medium tokens.
- Physical mouse/keyboard, foreground switch, lock/unlock, sleep, RDP connect/disconnect, display changes, window destruction/recreation and PID/HWND reuse must revoke. Test takeover during blocked UIA and approval; no input may remain held. Benchmark Stop independently of the worker.
- Native UIA calls/capture and hardware input can race OS state after the final guard; no claim of atomic OS authorization or generic desktop sandbox. Validate race safety under repeated adverse scheduling and retain the narrow cohort.
- Sign/package helper and fixture, verify installation ACLs/runtime dependency and upgrade behavior, disable debug dumps/raw logs, conduct security review, measure correctness/latency and pass the plan's real-device acceptance suite. No Windows feature gate should be enabled based solely on cross-compilation.

## Private-channel revocation and required libuv-handle gate

Watchdog, request admission, reads/capture, lifecycle foreground restoration and
final effect guards query the inherited handles with
`NtQueryInformationFile(FilePipeLocalInformation)`. Only
`FILE_PIPE_CONNECTED_STATE` (3), complete result length and successful status are
accepted. `CLOSING` (4), disconnected/unknown state, invalid handles and unsupported
or failed queries revoke, even if `ReadDataAvailable` is nonzero. No protocol
reader, peek byte count or zero-byte write is used as a connection probe. The
startup query must succeed before capabilities can be advertised; no alternate
mechanism enables control when that query is unsupported. `input=false` remains.

The state/structure follows WDK `FILE_PIPE_LOCAL_INFORMATION`:
https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_pipe_local_information

**Still unverified on Windows:** run the packaged Node/Electron/libuv launch and
check the actual inherited stdin AND stdout handles, not only synthetic .NET
pipes. Under false/EPERM/thrown kill, close peers while a whole command is buffered
and UIA is blocked; also close the writable output peer independently. Verify
state queries report disconnection without reading queued bytes, do not wait
behind the worker's pending I/O, and prevent later foreground restoration,
read/frame return and setters. Prove helper exit and real-exit-only lease release.
Test query failure/unsupported handles and retain fail-closed startup. This gate
must pass before Windows native acceptance/enablement; source tests and win-x64
cross-publication do **not** establish it. Already-entered OS calls cannot be
retracted, and request issuance is not proof of delivery.

## PRIVATE source timing v1 (not native acceptance)

The private **capabilities response envelope** always advertises
`"diagnosticsVersion":1`, even when timing is disabled. This scalar is not part
of the public capabilities `result`. A private request may add
`"diagnostics":true`; false or omission produces no `diagnostics` data. Null,
strings, numbers, arrays, objects and unknown envelope keys are rejected before
work. No environment setting, grant field, model input or permission bypass is
introduced. The existing single response optionally carries `diagnostics` beside
`id`, `ok` and `result`; no new frames, socket or logging channel exist.

DTO fields match `packages/computer-control/src/helper-timing.ts`: version 1,
helper-generated process-local instance/clock UUIDs, bounded safe request ID,
fixed method, and one request span plus at most one nested API span. Request
phases are `request`, `observe_request` or `capture_request`. Only actual supported
UIA calls have API phases: `api_set_value`, `api_invoke`, `api_select`, `api_scroll`.
Pattern lookup and value/scroll argument preparation precede the final independent
channel guard; timing surrounds the provider invocation after that guard. No
foreground restoration or capture API is mislabelled as a semantic API span.
Retries served by the existing journal have no new API span.

Source intervals use Stopwatch ticks relative to a helper-local origin, converted
with integer arithmetic to monotonic microseconds. End minus start equals duration,
with a 900,000,000-us bound. Status means source returned/threw, not receipt success.
Metadata computation failure omits diagnostics; it never fabricates zero durations,
retries or replays the operation. IDs incompatible with the timing DTO omit timing
rather than exporting raw correlation text. Diagnostics contain no target, label,
ref, value, goal, image, error detail or token. No added waits or native effects.

A returned source API invocation is **not OS delivery, target mutation, completion
or drain evidence**. Lost responses provide no proof at all; absence of an API span
is not proof of non-dispatch. All approval, integrity, foreground, channel,
permission and takeover gates remain; `input=false` remains unconditional.

Verification for this change: Nix `nixpkgs#dotnet-sdk_8`, `bash ./build.sh`:
**27 portable boundary/source tests passed**, and both helper and fixture
cross-published for win-x64. Tests cover strict opt-in, disabled omission, DTO
shape/UUID lifetime/phases/nesting/arithmetic, API exceptions and metadata-failure
no-replay behavior, private-only negotiation, and retained channel/input guards.
These tests do not execute UIA or Win32. Real Windows timing/provider behavior,
actual Electron/libuv handle guards, loss/blocked-provider acceptance, packaging
and signing remain unverified. No Windows enablement or input restoration is
justified by this cross-build.
