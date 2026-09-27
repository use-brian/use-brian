# Protected fill (Chromium only)

## Setup

1. Pair this extension to the intended account, workspace and browser profile.
2. Open the extension action popup → **Protected fill**. Enter the deployment's
   canonical API origin in **Trusted API origin**, then Save. Obtain it from the
   administrator / the app's API_URL configuration, **not** from an assistant,
   destination page, app URL or relay URL. Example: `https://api.example.com`.
   Local development explicitly supports `http://localhost:4000`.
3. The API administrator must enable `PROTECTED_BROWSER_FILL_SINGLE_INSTANCE=true`
   (single-instance deployments only) and include `chrome-extension://EXTENSION_ID`
   in `PROTECTED_BROWSER_FILL_EXTENSION_ORIGINS`. The popup shows the extension ID.
   Other existing backend prerequisites (relay and browser profiles) still apply.
   No host permission or wildcard CORS grant is needed/added by this extension.

The model cannot set this configuration. It cannot specify a resolver URL or a
bearer token. The endpoint is pinned in each local lock. If configuration was
missing at dispatch, the popup opens setup and the reserved task must be cleaned
up before retrying with fresh references.

## Disclosure and completion

Select source fields in authenticated first-party UI. Use pre-fill snapshot refs
for the target text inputs. The extension separately asks for disclosure approval,
showing the exact HTTPS destination origin, browser profile and target field refs.
The current relay schema has no authenticated source-field metadata: source field
names must be disclosed in first-party source selection, not invented by the model.

Backend reservation occurs **before dispatch**. Therefore the extension persists a
lock even if preflight fails or approval is denied. No resolution occurs until all
fields preflight and the human approves. Once locked, every relay operation except
Stop is denied, including screenshots, tab enumeration and raw/unknown operations.
Firefox rejects protected fill rather than falling back to native typing.

Finish/submit manually on the destination page. Then use **Finished — close
controlled tabs and unlock** in the extension. This closes all tracked controlled
tabs (including existing full-browser tabs) and their tracked opener descendants,
detaches control, and calls the authenticated completion API. Network errors,
failed closes and failed persistence retain the lock. Stop alone never unlocks.

## Expired pairing while locked

Generate a new pairing token in first-party Settings for the **same account,
workspace and browser profile**, paste it into the extension's Pairing token box,
and Connect. The relay verifies the new pairing token and supplies a new session
JWT. Retry cleanup. Extension claim checks prevent accidental rebinding; relay/API
signature validation remains authoritative. Neither renewal nor reconnect changes
the locked task identity, pinned API origin or disclosure lock.

## Verification boundary

Unit tests exercise coordinator failures, cleanup concurrency, renewal,
preflight/assignment function bodies, and the actual background command dispatcher.
A live Chromium/API/CORS test remains necessary before production rollout,
especially service-worker termination and browser-level popup/navigation races.

## Browser restart / lost cleanup identity

The local disclosure lock stores a random browser-session ID whose counterpart is
held in `chrome.storage.session`. Service-worker restarts preserve it; browser
restart, extension reload/update/disable, or missing/unavailable session storage
invalidates it. Old locks without this marker also require recovery. Numeric tab
IDs from another session are **never** used to close tabs or prove cleanup.

Ordinary completion is disabled if the marker is absent or different. The popup
instead offers a separate warned recovery: check **I approve closing ALL those
tabs** and confirm **Close ALL browser tabs and complete cleanup**. Save unrelated
work first. This closes **all tabs accessible to the extension in this Chrome
profile, across all windows**, including unrelated, pinned, pre-existing and other
extension tabs. Only a newly created, known-clean extension cleanup window remains
(to keep Chrome alive until completion is acknowledged). Other browser profiles
are not affected. There is no silent broad-cleanup fallback.

Failure leaves the original lock/session binding intact; retry requires fresh
explicit approval. A restored page that has a different ID, or an unrelated page
that reuses an old ID, cannot trick ordinary completion into unlocking or closing
the wrong page. Broad recovery is never exposed as a relay command.

Chromium hello advertises `capabilities: { protectedFillV1: true }`; Firefox omits
it. Backend eligibility must require this exact capability, not only a connected
extension ID or a build fingerprint.

## Browser actions blocked, but this popup has no local lock

A command can fail between the API reserving the profile and this extension
receiving it (relay/network failure or profile-policy lookup failure). Open this
extension's popup, verify the trusted API origin and same-profile pairing, then
choose **Recover server reservation** and confirm. This is not an assistant tool
and cannot be invoked by a destination page or relay command.

- If the server has **not started resolution**, it atomically invalidates ALL
  outstanding references for this profile, retires the reserved task, and only
  then cancels the reservation. Late commands/resolver requests cannot disclose
  those fields. No browser tabs need closing. Create a new task/reference batch
  before retrying. Reference expiry alone never unlocks anything.
- If resolution **started or may have disclosed**, the server stays locked and
  returns metadata only. The extension persists a recovered local lock WITHOUT
  tab IDs or a browser-session identity. Use the separate checkbox/confirmation
  for **Close ALL browser tabs and complete cleanup** described above. Ordinary
  task-tab cleanup is deliberately unavailable. This conservatively closes
  restored material-bearing tabs rather than guessing at their identities.
- Failure, timeout or unreadable recovery responses do not clear a local lock.
  Retry with the same paired user/workspace/profile. A locally persisted lock is
  never overwritten by server recovery; use its existing cleanup controls.

## API restart is not browser cleanup

The opt-in server authority is process-local. API restart invalidates references
and may report no server reservation, but does NOT clear the extension's durable
lock. An existing local lock still requires successful tab cleanup; if the browser
session also changed, it requires the broad recovery confirmation. Completion is
idempotent after API restart or a lost completion response only AFTER extension
cleanup. Manual clearing of extension storage is not a supported recovery method.


## Command scheduling and Stop

Relay actions, screenshots, protected fill, and trusted popup recovery/completion
share one bounded, cancellable queue. Screenshots have no parallel/priority path:
an active capture finishes before disclosure begins, and queued captures check the
persisted lock when they execute. Batch field animations are local-page feedback;
relay captures wait for the batch, with no per-field presentation delay.

Stop bypasses that queue: it immediately denies pending approval, invalidates
waiting jobs, and detaches control. Waiting commands cannot re-enter a fresh queue
generation or trigger another consent prompt. The active job retains the queue
barrier until it exits; protected-fill checkpoints prevent a late preflight,
approval, or resolver response from assigning values after cancellation. Already
issued browser/network operations cannot be undone, and cancellation never clears
the disclosure lock. Cleanup still requires the existing trusted human procedure.
Tab helpers check cancellation after asynchronous tab lookups/updates and before
attachment or gate mutations. A tab created after Stop collected its cleanup list
is closed by its cancelled creator; an existing switch/close target is never
closed merely because its command was cancelled.

Approval replies are immediate signals to the active fill (queuing one behind its
own approval wait would deadlock). Recovery and completion are queued operations,
not observation bypasses, and pending recovery/completion jobs are canceled by Stop.
