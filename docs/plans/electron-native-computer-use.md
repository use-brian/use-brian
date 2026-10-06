# Native computer use: profile + normal chat

## Correct product contract

Create a **computer profile**, grant an assistant access, and use it from a normal authorized chat—like browser profiles. No separate assistant/conversation/task/goal setup is required. The old task-runner UI was the wrong interaction model and is no longer the exposed path.

- Profiles are durable, owner-private workspace resources. They represent a physical device, not an isolated desktop or browser cookie jar.
- Assistant profile access and the `native_computer` capability are separate explicit permissions. Per-assistant grant/note changes are atomic; stale UI cannot restore another assistant's revoked access.
- Chat tools: `listComputerProfiles`, `computerObserve`, `computerAct`, `computerCapture`, `computerRelease`. The server derives caller/chat authority; model arguments cannot supply identities, targets, grants, deadlines or tasks.
- A connected profile advertises availability only. A chat request requires fresh main-process local consent for the exact current window, followed by private PKCE pairing. Every side effect retains exact local approval.
- Known idle Release preserves the profile connection but clears the execution lease. The same or another authorized chat needs fresh consent. Stop/uncertainty disconnect and cannot trigger automatic reconnect/replay.
- Profile identity uses `profileId` instead of `taskId`; grants use `purpose: 'chat-tools'` without `goal`. Legacy task contracts remain diagnostic only, never fake profile tasks.

## Build and permission defects addressed

Composite TypeScript build state now lives inside each package's `dist`. Deleting emitted exports can no longer leave an external incremental cache falsely reporting a successful build. Regression tests reproduce the reported missing `computer-control/protocol.js` error before the fix.

Local Mac packaging uses a fresh output directory, preserves old artifacts, and prints success paths only after success. CI keeps its existing artifact layout but refuses stale output directories. The reported failed build did not establish a new package; launching the old ZIP was not current-source verification.

Connect obtains attended-verification acknowledgment in native main; there is no separate acknowledgment button in the new UI. Fresh TCC/capability checks precede connection. Permission guidance remains usable. With control off, the UI performs and displays a local redacted inspection, not a phantom connection.

Accessibility setup explicitly requests the macOS prompt from the persistent signed Electron main process before opening settings. Existing helpers must stop first. Main revalidates scope after confirmed cleanup and requests permission once, without launching another helper or requiring rollout flags or emergency-shortcut registration. Helper admission still gates discovery and control. Explicit setup requests log receipt, rejection and completion using fixed metadata. Native helper code never prompts. Readiness and automatic window discovery stay silent, and Screen Recording setup only opens its own settings pane.

## Preserved boundaries

- Supported Mac effects remain TextEdit and reviewed fixture AX operations. Signed-helper admission, exact process/window scope, deadlines, local Stop and confirmed teardown remain.
- Screenshot-guided AX uses only the pinned public-shapes renderer. Separate capture consent, Screen Recording permission, exact configured image-route approval and existing conservative budgets apply.
- Screenshot bytes stay in bounded server memory. Chat/history stores opaque references; every actual upload rechecks route, scope, consent, age and budget. Strict image-chat mode does not relax the old strict task-inference contract.
- Inference accounting survives Stop independently of output publication. Only validated counters and observed model provenance are priced; unknown evidence stays unknown. Independently settled image usage is not billed again by ordinary chat consumers.
- Stop is **best-effort through action handoff**: an action may still reach/finish in macOS. Late results cannot restore authority, disclose revoked observations or replay uncertain effects.
- Raw mouse input remains disabled. No-AX canvases, arbitrary apps/screenshots, generic keyboard injection and unattended control remain unsupported. No acceptance or rollout flags are enabled.

## Delivery and verification

Migration `622_computer_profiles.sql` must accompany the updated API. Packaging the desktop does not deploy or migrate a remote backend. No real database migration, deployment or signed-Mac acceptance is claimed here.

The single short operator checklist is [Mac handoff](../native-computer-mac-handoff.md). Source/portable results and failures are recorded in [the evidence ledger](../native-computer-acceptance.md); runtime details are in [native computer use](../native-computer-use.md). Engineering owns any defect found. Feature-branch commits/pushes preserve work, not release acceptance.
