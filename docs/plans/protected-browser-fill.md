# Protected browser fill

## Scope

Generic opaque data references with CRM scalar fields as the first source. A trusted, authenticated human selects a record and fields in the local computer task UI. Only static field labels and opaque references are copied into the originating assistant conversation. The model maps references to browser element refs; the Chromium extension retrieves values directly from the authenticated API and fills locally after disclosure approval.

This is **not a global no-LLM CRM policy**. Existing raw CRM tools and already-disclosed conversation content remain outside this protected path. The destination website receives values immediately upon filling, before submission.

## Architecture

- `packages/core/src/sandbox/protected-fill.ts`: random 256-bit references, 120-second expiry, exact user/workspace/session/task/profile/HTTPS-origin binding, single-use batch resolution, serialized authorization, reservation/disclosure locks, observation epochs, recovery and completion. References retain source descriptors, never values.
- `packages/api/src/sandbox/protected-fill-crm.ts`: permission-aware CRM adapter. Supported scalar fields are allowlisted; absent, archived, nested and inaccessible fields fail closed. Linked company lookup also checks permissions.
- `packages/api/src/routes/protected-browser-fill.ts`: strict, no-store, fixed-error endpoints. Normal user authentication creates references; only scoped browser-extension session JWTs resolve, complete or recover. Extension origins are explicitly allowlisted.
- `packages/core/src/sandbox/tools.ts`: dedicated `browserFillReference` batch tool. Runtime injects authority scope; the model supplies only destination origin, opaque references and element refs. Unsupported cloud/autonomous execution fails closed. No raw values, follow-up snapshots or fill recordings.
- `packages/api/src/sandbox/relay-transport.ts`: profile-wide reservation before dispatch, guards every local command and suppresses in-flight observations crossing a disclosure epoch. Errors and results are sanitized.
- `apps/browser-extension/src/protected-fill.ts`: direct authenticated resolution using trusted API configuration, human approval, persistent locks, cleanup and recovery.
- `apps/browser-extension/src/executor.ts`: isolated-world preflight and local assignment to supported top-frame editable text inputs/textareas. Origin, document and target identity are rechecked. Unsupported fields and frames fail closed.
- `apps/app-web/src/components/computer/protected-fill-panel.tsx`: trusted source selection, explicit destination disclosure warning, and validated reference-only copy handoff.

The task exposes an exact browser-observed `destinationOrigin`, never an origin inferred from a hostname. New local tasks receive unique IDs. Source issuance and dispatch require current workspace/profile/assistant authorization and a compatible live extension.

## Protocol and compatibility

Chromium advertises `hello.capabilities.protectedFillV1: true`; Firefox does not. Both API eligibility and relay dispatch require that capability plus a configured Chromium extension upgrade origin. Old extensions and relays fail closed. Capability is compatibility metadata, not authorization.

`browserFillReference` carries `{workspaceId, sessionId, taskId, browserProfileId, destinationOrigin, items:[{referenceId,ref}]}`. It never carries a resolver URL, credentials or source values. The extension's trusted configuration supplies its API origin and paired session token.

Protected HTTP routes under `/api/protected-browser-fill`:

- `POST /references`: authenticated UI creates scoped source references.
- `POST /resolve`: extension session authentication; atomic single-use resolution returns values only to the extension.
- `POST /complete`: authenticated extension cleanup retires the task before releasing authority.
- `POST /recover`: authenticated popup recovery returns `none`, `cancelled`, or metadata-only `cleanup_required`.

Reference TTL is 120 seconds. Approval timeout is 90 seconds; protected relay command, API transport and tool budgets are 120, 125 and 140 seconds respectively. Late approval fails closed.

## Disclosure and recovery invariants

Once protected execution begins, ordinary model-driven observations and actions are blocked. No screenshots, snapshots, page URLs, capture, skills, typing, clicks or takeover input are returned through the protected local profile. Stop does not unlock. The user reviews/submits directly in the browser.

The extension persists cleanup state before preflight/approval. Failures and uncertain network outcomes retain protection. Normal completion closes protected task tabs and descendants, detaches control and obtains API completion before removing the lock.

A `chrome.storage.session` browser-session marker prevents stale numeric tab IDs from being trusted after restart/reload. Missing, mismatched or legacy markers prohibit ordinary cleanup. A separate explicitly warned recovery action closes all accessible profile tabs across windows except its new clean cleanup window. It is never a silent fallback.

A command that never reaches the extension can strand a server reservation. Popup-only recovery serializes against resolution: if resolution has not started, it invalidates all profile references and retires the task before cancellation; otherwise it retains the lock and returns cleanup metadata. Recovered uncertain-disclosure locks have no invented browser-session provenance and require explicit broad cleanup. Existing local locks are never replaced or cleared by recovery.

Expired references, generic errors, task completion, disconnects and backend toggles do not unlock disclosure. Epoch guards discard overlapping observations even if cleanup has subsequently completed.

## Deployment

Default disabled. Enable only in a single API process with:

- `PROTECTED_BROWSER_FILL_SINGLE_INSTANCE=true`
- `PROTECTED_BROWSER_FILL_EXTENSION_ORIGINS=chrome-extension://<extension-id>`
- Configured relay/profile storage and the updated capable Chromium extension.

Deploy the updated API, relay and extension together. Configure the trusted API origin in the extension popup. See `.env.example` and extension setup documentation for configuration.

The server authority is in-memory. Multi-instance deployment is unsupported until a shared transactional reference/lock/epoch store exists. API restart invalidates references but does not remove the extension's durable cleanup obligation. This opt-in release still requires live browser verification before production enablement.

## Verification

Latest focused security-remediation run:

- Core sandbox: 242 tests passed.
- API sandbox/computer/auth routes: 77 tests passed.
- Relay: 37 tests passed.
- Extension: 190 tests passed.
- UI computer/protected SDK/panel/CRM adapter verification: 30 tests passed in the preceding integration run.
- Core/API/relay typechecks, extension typecheck, Chromium and Firefox builds/assembly passed.
- Simulated cross-boundary tests run the actual extension coordinator against the authenticated Express resolver and relay transport, including sentinel non-disclosure, failed delivery, recovery races and cleanup.
- `pnpm smoke` passed. Full `pnpm test` encountered an unrelated drawing-test timeout; that test passed on isolated rerun. This OSS checkout has no `pnpm check` command. Full app-web typecheck/lint remain blocked by existing dependency/type/configuration issues.

Live Chromium/CDP, production CORS, browser restart/restored tabs and visual verification remain outstanding. Automated mocks and simulated boundary tests are not a substitute for these release checks.
