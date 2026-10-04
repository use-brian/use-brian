# Mobile login and watch recording API

Clients live in [brian-mobile](https://github.com/use-brian/brian-mobile). All paths below are on the configured HTTPS API origin except the browser login entry.

## Deployment

Apply migrations `653_watch_recording.sql`, `654_mobile_auth.sql` and `657_watch_assistant_destinations.sql`. Configure Files API/storage, ffmpeg/ffprobe, the recording worker and transcription provider, then set:

```env
WATCH_RECORDING_ENABLED=true
```

Device credentials are scoped by database grants and stored token hashes; owner/workspace authorization and the server signing key protect access and upload capabilities.

Live transcription additionally requires enabled voice transcription. Keep the owner PostgreSQL pool at least two connections (`PG_POOL_MAX`, default four). Deploy the web app as well as the API for browser login. Gateway authentication is separate; these credentials do not bypass Cloudflare or other access policies. Never log credentials, authorization query strings or audio bodies.

## Phone login

1. Generate an S256 PKCE verifier/challenge and random state. Open the **app origin** `/mobile/auth?challenge=<challenge>&state=<state>&clientId=brian-ios` using the system authentication browser. Registered clients are `brian-ios` and `brian-android`.
2. Browser login requires explicit account confirmation and a CSRF-protected POST. Accept only `usebrian-mobile://auth` and verify the returned state before handling code/error.
3. Exchange at API `POST /auth/mobile/exchange` with `{code, verifier, clientId, redirectUri:"usebrian-mobile://auth"}`. Response: `{accessToken, refreshToken, user}`. Codes expire after two minutes and are single-use, bound to client, redirect and S256 challenge. Restart login after an ambiguous exchange rather than replaying a consumed code.
4. Refresh via `POST /auth/refresh` with `{refreshToken}`; revoke via `POST /auth/logout` with `{refreshToken}`. Store credentials securely and coordinate refresh between foreground/background work.

The browser bridge uses human-authenticated `GET /auth/mobile/account` and `POST /auth/mobile/code` (`{clientId, redirectUri, challenge}`). Native clients must not import browser cookies or put phone refresh credentials on the watch.

## Watch grants

Base path: `/api/watch/v1`. Human endpoints use the phone's ordinary Bearer access token:

| Method/path | Body / result |
|---|---|
| `POST /grants` | `{deviceId, workspaceId, assistantId, label}` → `{grantId, accessToken, renewalToken, expiresIn, audience}` |
| `GET /grants` | `{grants:[{grantId, deviceId, workspaceId, assistantId, label, revokedAt, expiresAt}]}` |
| `DELETE /grants/:grantId` | Owner-only, idempotent; 204 |

IDs are UUIDs; label is 1–80 characters. The destination is any assistant the owner can use in that workspace: the owner is a current workspace member and not blocked from it, and a non-primary assistant has `internal` or `confidential` clearance (watch audio is `internal`, so a lower-cleared assistant could never read its own recording). Otherwise `403 destination_unavailable`; this is rechecked on every device, relay and upload request. Provisioning is idempotent for owner/device/workspace/assistant while nonrevoked; replay never resets rotated credentials. A changed label conflicts. Another assistant in the same workspace is a separate grant, so changing the selection never revokes a grant with queued captures. After rotation or expiry, recover existing captures through relay rather than provisioning a replacement namespace. Limit: ten active grants/user.

Each capture freezes its scope when created. A primary destination keeps workspace-shared media, as before. Any other assistant scopes the canonical audio file, recording, transcript segments and transcript artifact to that assistant, and Pipeline B extracts into its brain. The recording stays human-authored and visible to workspace members, the primary and that assistant; other assistants cannot retrieve it.

Device access lasts 15 minutes; grants last 90 days. `POST /renew` with `{renewalToken}` returns replacement credentials. The watch alone coordinates rotation and atomically persists replacements. Reuse of a consumed renewal token revokes the grant; an ambiguous successful response requires phone recovery, not repeated renewal. Human tokens cannot substitute on direct device session paths.

## Capture, live transcription and recovery

Device Bearer credentials authorize `/sessions/:clientId` operations. Phone recovery uses its **human Bearer token** and the identical operations under `/relay/:grantId/sessions/:clientId`. Relay preserves the original grant/session identity, checks ownership/current membership, and works after device-grant expiry but not revocation or capture expiry. Workspace/account changes must never redirect queued captures.

| Method/path (relative to session) | Contract |
|---|---|
| `PUT /` | `{capturedAt, title, source:"apple-watch"}` creates/replays the client UUID. ISO timestamp with timezone; title 1–120 characters. Changed metadata conflicts. |
| `GET /` | Reconcile without side effects. Returns IDs, state, page preparation, received windows, missing ranges, full upload and processing status. |
| `PUT /windows?sequence=0&offsetMs=0&durationMs=20000&sha256=…` | Raw independently decodable M4A, `Content-Type: audio/mp4`. Maximum 60 seconds/2 MiB. Response `{received:true, sequence, sha256}` means audio persisted, not transcribed. |
| `POST /retry` | Transcribes up to three pending contiguous windows/call; explicitly invoke during live capture. Provider failure preserves audio. For finalized failed processing, explicitly requeues once; queued/processing/processed jobs are not duplicated. |
| `POST /finalize` | `{source:"windows", expectedWindows, allowIncomplete:false}` seals the intent, publishes one canonical recording/page and queues processing. |

Status includes `{clientId, sessionId, pageId, recordingId, state, pagePrepared, expiresAt, finalization, windows, missingSequences, missingTimeRanges, fullUpload, processing}`. Each window reports sequence, timing, SHA-256, byte count and transcription (`pending`, `failed`, `ready`). Session state is `open`, `sealed` or `finalized`; expiry returns 410. Canonical `processing:"processed"` means ready; `finalized` alone does not. No transcript text/playback URLs are exposed to device credentials; open the page with the phone/web user session.

Persist capture metadata/windows before networking. Exact receipt replay is safe, including after sealing; conflicting checksum/timing/bytes is not. Out-of-order delivery is accepted, but missing earlier windows block live publication. There is no autonomous live drainer; call `/retry` with backoff (maximum five transcription attempts/window). Batch processing can still recover failed live transcription.

Finalize requires all expected windows and no timing gaps unless the user explicitly accepts incomplete audio. Missing time is removed, not filled with silence. Replaying the exact finalized intent is safe; changing it or adding new windows after sealing conflicts. Original capture time is preserved. Prepared destination pages deleted by users are not recreated by retries.

## Full-file fallback and upload-URL renewal

For a stopped complete capture, `POST /sessions/:clientId/full-upload` (or relay equivalent) with immutable `{sha256, bytes, durationMs}` returns:

```json
{
  "uploadUrl":"/api/watch/v1/uploads/<sessionId>?token=<capability>",
  "method":"PUT",
  "uploadHeaders":{"Content-Type":"audio/mp4","Content-Length":"<bytes>"},
  "expiresAt":"<ISO timestamp>",
  "sessionId":"<UUID>",
  "received":false
}
```

Resolve only against the pinned API origin. PUT the exact M4A bytes with the returned headers, **without a Brian Authorization header**. Chunked/compressed transfer is not accepted. The five-minute signed capability binds grant, capture, descriptor and device/relay authority. Membership, revocation and expiry are rechecked before durable receipt. The API enforces length, checksum and probed media duration before storing immutable bytes.

Renew by replaying the same descriptor; it creates no new recording. Reconcile `GET` status `fullUpload:{sha256,bytes,durationMs,received}` after timeouts. Existing URLs remain valid until their original expiry but cannot replace accepted bytes. Configure gateway limits for up to 64 MiB and a five-minute body deadline.

After full receipt, finalize with `{source:"full",expectedWindows:0,allowIncomplete:false}`. This uses the same canonical file/recording/page as window finalization. Freeze source/intent before submission; an already sealed window intent cannot be replaced. Never label partial audio as a complete fallback file.

## Limits and errors

- 180 minutes, 1,080 windows, 64 MiB of windows/capture plus at most one 64 MiB full file. Full-file initialization reserves its bytes immediately. Total retained/reserved audio: 128 MiB/user; three open/sealed captures/user.
- Captures expire after 30 days. Boot and 15-minute bounded cleanup reclaim staging bytes while coordinating with processing locks. Canonical media follows existing workspace retention. Retain local recovery copies through finalization; do not silently discard unsynchronized audio.
- Errors: `{error, detail?}`. 400 malformed input, 401 credentials/expired signed URL, 403 destination unavailable, 404 unknown/unauthorized session or relay grant, 409 conflicting metadata/missing audio/sealed capture, 410 capture expired, 413 quota, 422 invalid media/checksum/duration, 429 active grant/session limit, 503 temporary provider/storage/capacity failure.
- Retry `409 capture_busy` and transient 503 with bounded jittered backoff; reconcile after ambiguous writes. Revocation blocks relay too: drain pending audio before intentionally replacing/revoking a grant.
